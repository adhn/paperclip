import fs from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

// A shared handle so the managed-config test can force the runtime preparation
// step to throw an error that carries untrusted markers.
const { prepareAdapterExecutionTargetRuntime, runAdapterExecutionTargetShellCommand } = vi.hoisted(() => ({
  prepareAdapterExecutionTargetRuntime: vi.fn(), runAdapterExecutionTargetShellCommand: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    adapterExecutionTargetUsesManagedHome: () => true,
    maybeRunSandboxInstallCommand: async () => null,
    prepareAdapterExecutionTargetRuntime,
    runAdapterExecutionTargetShellCommand,
  };
});

import { ClaudeProbeCleanupError, prepareClaudeConfigSeed, prepareSandboxClaudeProbeRuntime, writePaperclipClaudeMcpConfig, buildRemoteClaudeConfigMaterializationCommand } from "./claude-config.js";

describe("prepareClaudeConfigSeed", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createEnv(root: string, sourceDir: string): NodeJS.ProcessEnv {
    return {
      HOME: root,
      PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      PAPERCLIP_INSTANCE_ID: "test-instance",
      CLAUDE_CONFIG_DIR: sourceDir,
    };
  }

  it("reuses the same snapshot path when the seeded files are unchanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-seed-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      theme: "light",
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), JSON.stringify({ token: "local" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);

    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(first).toBe(second);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.access(path.join(first, ".credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an existing snapshot intact when the seeded files change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-race-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");

    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(second).not.toBe(first);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.readFile(path.join(second, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "dark", permissions: { defaultMode: "default" } }));
  });

  it("strips local-only settings from remote Claude config seeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-boundary-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      permissions: {
        defaultMode: "dontAsk",
        allow: ["Bash(op item *)"],
      },
      hooks: { PreToolUse: [{ matcher: "*" }] },
      mcpServers: { local: { command: "secret-local-server" } },
      permissionMode: "dontAsk",
      skipDangerousModePermissionPrompt: true,
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "settings.local.json"), JSON.stringify({
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "credentials.json"), JSON.stringify({ token: "local" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "local instructions", "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const seedDir = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const remoteSettings = JSON.parse(await fs.readFile(path.join(seedDir, "settings.json"), "utf8"));

    expect(remoteSettings.permissions).toEqual({ defaultMode: "default" });
    expect(remoteSettings.hooks).toBeUndefined();
    expect(remoteSettings.mcpServers).toBeUndefined();
    expect(remoteSettings.permissionMode).toBeUndefined();
    expect(remoteSettings.skipDangerousModePermissionPrompt).toBeUndefined();
    await expect(fs.access(path.join(seedDir, "settings.local.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(seedDir, "credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(seedDir, "CLAUDE.md"), "utf8"))
      .resolves.toBe("local instructions");
  });
});

describe("private Claude config materialization", () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });
  async function setup() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-private-"));
    roots.push(root);
    const source = path.join(root, "source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "settings.json"), JSON.stringify({ env: { EXAMPLE: "test-only" } }));
    await fs.writeFile(path.join(source, "CLAUDE.md"), "instructions");
    const env = { PAPERCLIP_HOME: path.join(root, "managed"), PAPERCLIP_INSTANCE_ID: "test", CLAUDE_CONFIG_DIR: source };
    return { root, env };
  }
  async function mode(file: string) { return (await fs.stat(file)).mode & 0o777; }

  it("creates private snapshots and normalizes reused loose permissions", async () => {
    const { env } = await setup();
    const target = await prepareClaudeConfigSeed(env, async () => {}, "company");
    expect(await mode(target)).toBe(0o700);
    expect(await mode(path.dirname(target))).toBe(0o700);
    for (const name of ["settings.json", "CLAUDE.md"]) expect(await mode(path.join(target, name))).toBe(0o600);
    await fs.chmod(target, 0o755);
    await fs.chmod(path.dirname(target), 0o755);
    await fs.chmod(path.join(target, "settings.json"), 0o644);
    expect(await prepareClaudeConfigSeed(env, async () => {}, "company")).toBe(target);
    expect(await mode(target)).toBe(0o700);
    expect(await mode(path.dirname(target))).toBe(0o700);
    expect(await mode(path.join(target, "settings.json"))).toBe(0o600);
  });

  it("refuses reuse on permission failure and repairs on exact retry", async () => {
    const { env } = await setup();
    const target = await prepareClaudeConfigSeed(env, async () => {}, "company");
    const settings = path.join(target, "settings.json");
    await fs.chmod(settings, 0o644);
    const original = fs.chmod;
    const failure = Object.assign(new Error("injected chmod failure"), { code: "EACCES" });
    vi.spyOn(fs, "chmod").mockImplementation(async (name, permissions) => {
      if (name === settings) throw failure;
      return original(name, permissions);
    });
    await expect(prepareClaudeConfigSeed(env, async () => {}, "company")).rejects.toBe(failure);
    vi.restoreAllMocks();
    expect(await prepareClaudeConfigSeed(env, async () => {}, "company")).toBe(target);
    expect(await mode(settings)).toBe(0o600);
  });

  it("cleans an unpublished snapshot on file-permission failure and retries", async () => {
    const { env } = await setup();
    const original = fs.chmod;
    vi.spyOn(fs, "chmod").mockImplementation(async (name, permissions) => {
      if (String(name).includes(".tmp-") && String(name).endsWith("settings.json")) throw new Error("injected file chmod failure");
      return original(name, permissions);
    });
    await expect(prepareClaudeConfigSeed(env, async () => {}, "company")).rejects.toThrow("injected file chmod failure");
    vi.restoreAllMocks();
    const target = await prepareClaudeConfigSeed(env, async () => {}, "company");
    expect((await fs.readdir(path.dirname(target))).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    expect(await mode(path.join(target, "settings.json"))).toBe(0o600);
  });

  it("normalizes fresh and reused MCP files without writing on failed permission preparation", async () => {
    const { root } = await setup();
    const input = { stateDir: root, runId: "run", servers: [] };
    const config = await writePaperclipClaudeMcpConfig(input);
    expect(await mode(config)).toBe(0o600);
    expect(await mode(path.dirname(config))).toBe(0o700);
    await fs.writeFile(config, "prior content");
    await fs.chmod(config, 0o644);
    await fs.chmod(path.dirname(config), 0o755);
    const original = fs.chmod;
    const failure = new Error("injected MCP chmod failure");
    vi.spyOn(fs, "chmod").mockImplementation(async (name, permissions) => {
      if (name === config) throw failure;
      return original(name, permissions);
    });
    await expect(writePaperclipClaudeMcpConfig(input)).rejects.toBe(failure);
    expect(await fs.readFile(config, "utf8")).toBe("prior content");
    vi.restoreAllMocks();
    await writePaperclipClaudeMcpConfig(input);
    expect(await mode(config)).toBe(0o600);
    expect(await mode(path.dirname(config))).toBe(0o700);
    expect(JSON.parse(await fs.readFile(config, "utf8"))).toEqual({ mcpServers: {} });
  });

  for (const failure of ["write", "rename"] as const) {
    it(`retains prior MCP bytes on prepared ${failure} failure and retries`, async () => {
      const { root } = await setup();
      const input = { stateDir: root, runId: "run", servers: [] };
      const config = await writePaperclipClaudeMcpConfig(input);
      await fs.writeFile(config, "prior content");
      const error = Object.assign(new Error("injected MCP replacement failure"), { code: "EIO" });
      if (failure === "write") vi.spyOn(fs, "writeFile").mockRejectedValueOnce(error);
      else vi.spyOn(fs, "rename").mockRejectedValueOnce(error);
      await expect(writePaperclipClaudeMcpConfig(input)).rejects.toBe(error);
      expect(await fs.readFile(config, "utf8")).toBe("prior content");
      expect((await fs.readdir(path.dirname(config))).filter((name) => name.startsWith(".mcp-"))).toEqual([]);
      await writePaperclipClaudeMcpConfig(input);
      expect(JSON.parse(await fs.readFile(config, "utf8"))).toEqual({ mcpServers: {} });
      expect(await mode(config)).toBe(0o600);
    });
  }

  it("exposes MCP cleanup failure after rename and permits exact retry", async () => {
    const { root } = await setup();
    const input = { stateDir: root, runId: "run", servers: [] };
    const config = await writePaperclipClaudeMcpConfig(input);
    await fs.writeFile(config, "prior content");
    const failure = Object.assign(new Error("injected cleanup failure"), { code: "EACCES" });
    vi.spyOn(fs, "rm").mockRejectedValueOnce(failure);
    await expect(writePaperclipClaudeMcpConfig(input)).rejects.toBe(failure);
    expect(JSON.parse(await fs.readFile(config, "utf8"))).toEqual({ mcpServers: {} });
    const residue = (await fs.readdir(path.dirname(config))).filter((name) => name.startsWith(".mcp-"));
    expect(residue).toHaveLength(1);
    expect(await fs.readdir(path.join(path.dirname(config), residue[0]!))).toEqual([]);
    await writePaperclipClaudeMcpConfig(input);
    expect(JSON.parse(await fs.readFile(config, "utf8"))).toEqual({ mcpServers: {} });
    expect((await fs.readdir(path.dirname(config))).filter((name) => name.startsWith(".mcp-"))).toEqual(residue);
  });

  for (const corruption of ["bytes", "missing", "extra"] as const) {
    it(`refuses ${corruption} corruption in an existing seed snapshot without replacing it`, async () => {
      const { env } = await setup();
      const target = await prepareClaudeConfigSeed(env, async () => {}, "company");
      const settings = path.join(target, "settings.json");
      if (corruption === "bytes") await fs.writeFile(settings, "corrupt bytes");
      else if (corruption === "missing") await fs.unlink(settings);
      else await fs.writeFile(path.join(target, "unexpected"), "preserved extra");
      await expect(prepareClaudeConfigSeed(env, async () => {}, "company")).rejects.toThrow("do not match the selected seed");
      if (corruption === "bytes") expect(await fs.readFile(settings, "utf8")).toBe("corrupt bytes");
      else if (corruption === "missing") await expect(fs.stat(settings)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await fs.readFile(path.join(target, "unexpected"), "utf8")).toBe("preserved extra");
    });
  }

  it("validates a raced-in snapshot before returning it", async () => {
    const { env } = await setup();
    let racedTarget = "";
    vi.spyOn(fs, "rename").mockImplementationOnce(async (_from, target) => {
      racedTarget = String(target);
      await fs.mkdir(target);
      await fs.writeFile(path.join(String(target), "settings.json"), "raced corrupt settings");
      await fs.writeFile(path.join(String(target), "CLAUDE.md"), "instructions");
      throw Object.assign(new Error("competing snapshot publication"), { code: "EEXIST" });
    });
    await expect(prepareClaudeConfigSeed(env, async () => {}, "company")).rejects.toThrow("contents do not match");
    expect(await fs.readFile(path.join(racedTarget, "settings.json"), "utf8")).toBe("raced corrupt settings");
    expect((await fs.readdir(path.dirname(racedTarget))).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    vi.restoreAllMocks();
    // Repeated attempts retain the existing mismatched snapshot for inspection.
    await expect(prepareClaudeConfigSeed(env, async () => {}, "company")).rejects.toThrow("contents do not match");
  });

  it("refuses a symlinked cached seed file without chmodding its external target", async () => {
    const { root, env } = await setup();
    const target = await prepareClaudeConfigSeed(env, async () => {}, "company");
    const external = path.join(root, "external");
    await fs.writeFile(external, "external state", { mode: 0o644 });
    await fs.chmod(external, 0o644);
    await fs.unlink(path.join(target, "settings.json"));
    await fs.symlink(external, path.join(target, "settings.json"));
    await expect(prepareClaudeConfigSeed(env, async () => {}, "company")).rejects.toThrow("must be a regular file");
    expect(await mode(external)).toBe(0o644);
    expect(await fs.readFile(external, "utf8")).toBe("external state");
  });
});

describe("remote managed Claude credential permissions", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });
  async function setup() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-remote-modes-"));
    roots.push(root);
    const home = path.join(root, "home");
    const source = path.join(home, ".claude");
    const target = path.join(root, "managed");
    const seed = path.join(root, "seed");
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(seed);
    for (const file of [".credentials.json", "credentials.json"]) {
      await fs.writeFile(path.join(source, file), "test-only-source");
      await fs.chmod(path.join(source, file), 0o644);
    }
    const command = buildRemoteClaudeConfigMaterializationCommand({ remoteClaudeConfigDir: target, remoteClaudeConfigSeedDir: seed });
    const run = (extra: NodeJS.ProcessEnv = {}, prelude = "") => promisify(execFile)("/bin/sh", ["-c", `${prelude}${command}`], {
      env: { ...process.env, HOME: home, ...extra }, timeout: 5_000,
    });
    return { root, source, target, run };
  }
  it("copies readable source credentials privately without changing their source", async () => {
    const { source, target, run } = await setup();
    await run();
    expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
    for (const file of [".credentials.json", "credentials.json"]) {
      expect((await fs.stat(path.join(target, file))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.join(source, file))).mode & 0o777).toBe(0o644);
      expect(await fs.readFile(path.join(target, file), "utf8")).toBe("test-only-source");
    }
  });
  it("normalizes existing managed credentials without replacing them", async () => {
    const { target, run } = await setup();
    await fs.mkdir(target, { mode: 0o755 });
    await fs.chmod(target, 0o755);
    await fs.writeFile(path.join(target, "credentials.json"), "prior-managed");
    await fs.chmod(path.join(target, "credentials.json"), 0o644);
    await run();
    expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(target, "credentials.json"))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path.join(target, "credentials.json"), "utf8")).toBe("prior-managed");
  });
  for (const alias of ["directory", "credential"] as const) {
    it(`refuses a managed ${alias} symlink before changing shared source modes`, async () => {
      const { source, target, run } = await setup();
      await fs.chmod(source, 0o755);
      if (alias === "directory") await fs.symlink(source, target);
      else {
        await fs.mkdir(target);
        await fs.symlink(path.join(source, ".credentials.json"), path.join(target, ".credentials.json"));
      }
      await expect(run()).rejects.toMatchObject({ code: 1 });
      expect((await fs.stat(source)).mode & 0o777).toBe(0o755);
      expect((await fs.stat(path.join(source, ".credentials.json"))).mode & 0o777).toBe(0o644);
      expect(await fs.readFile(path.join(source, ".credentials.json"), "utf8")).toBe("test-only-source");
    });
  }

  for (const kind of ["directory", "fifo", "hardlink", "cross-name-hardlink"] as const) {
    it(`refuses a credential ${kind} without copying or changing the shared inode`, async () => {
      const { source, target, run } = await setup();
      await fs.mkdir(target);
      const leaf = path.join(target, "credentials.json");
      if (kind === "directory") await fs.mkdir(leaf);
      else if (kind === "fifo") await promisify(execFile)("mkfifo", [leaf], { timeout: 5_000 });
      else await fs.link(path.join(source, kind === "cross-name-hardlink" ? ".credentials.json" : "credentials.json"), leaf);
      await expect(run()).rejects.toMatchObject({ code: 1 });
      // Both selected leaves are validated before the first credential copy.
      await expect(fs.stat(path.join(target, ".credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
      for (const name of [".credentials.json", "credentials.json"]) {
        expect((await fs.stat(path.join(source, name))).mode & 0o777).toBe(0o644);
        expect(await fs.readFile(path.join(source, name), "utf8")).toBe("test-only-source");
      }
      if (kind === "directory") expect((await fs.lstat(leaf)).isDirectory()).toBe(true);
      if (kind === "fifo") expect((await fs.lstat(leaf)).isFIFO()).toBe(true);
    });
  }

  it("refuses a managed config root that is the shared source itself", async () => {
    const { root, source } = await setup();
    await fs.chmod(source, 0o755);
    const command = buildRemoteClaudeConfigMaterializationCommand({ remoteClaudeConfigDir: source, remoteClaudeConfigSeedDir: path.join(root, "seed") });
    await expect(promisify(execFile)("/bin/sh", ["-c", command], {
      env: { ...process.env, HOME: path.dirname(source) }, timeout: 5_000,
    })).rejects.toMatchObject({ code: 1 });
    expect((await fs.stat(source)).mode & 0o777).toBe(0o755);
    expect((await fs.stat(path.join(source, "credentials.json"))).mode & 0o777).toBe(0o644);
    expect(await fs.readFile(path.join(source, "credentials.json"), "utf8")).toBe("test-only-source");
  });

  it("fails on permission normalization and repairs existing credentials on retry", async () => {
    const { root, target, run } = await setup();
    const faultMarker = path.join(root, "chmod-fault-observed");
    // A shell function intercepts the generated command's real chmod call even
    // when the target shell resolves built-in applets ahead of PATH wrappers.
    const prelude = 'chmod() { if [ "$1" = 600 ]; then printf fault > "$PAPERCLIP_TEST_CHMOD_FAULT"; return 23; fi; command chmod "$@"; }; ';
    await expect(run({ PAPERCLIP_TEST_CHMOD_FAULT: faultMarker }, prelude)).rejects.toMatchObject({ code: 23 });
    expect(await fs.readFile(faultMarker, "utf8")).toBe("fault");
    const copied = path.join(target, ".credentials.json");
    expect(await fs.readFile(copied, "utf8")).toBe("test-only-source");
    await fs.chmod(copied, 0o644);
    await run();
    expect((await fs.stat(copied)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(target, "credentials.json"))).mode & 0o777).toBe(0o600);
  });
});

describe("prepareSandboxClaudeProbeRuntime managed-config diagnostics", () => {
  const cleanupDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  const sandboxTarget: AdapterExecutionTarget = {
    kind: "remote",
    transport: "sandbox",
    providerKey: "daytona",
    remoteCwd: "/home/daytona/paperclip-workspace",
    runner: {
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      }),
    },
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps a thrown config-materialization error out of every check and the log", async () => {
    // The runtime preparation throws an error that carries two untrusted values:
    // an opaque credential marker and a proxy marker. Neither may reach a check
    // or the server log. The log carries only the fixed context, the allowlisted
    // classification, and the safe error class name.
    const opaqueCredMarker = "OPAQUECREDMARKERconfig";
    const proxyMarker = "http://user:pass@proxy.corp.internal:3128";

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-mgmt-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });

    for (const key of ["CLAUDE_CONFIG_DIR", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.CLAUDE_CONFIG_DIR = sourceDir;
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    prepareAdapterExecutionTargetRuntime.mockRejectedValueOnce(
      new Error(`materialize failed with ${opaqueCredMarker} via ${proxyMarker}`),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const checks = await prepareSandboxClaudeProbeRuntime({
      runId: "run-1",
      target: sandboxTarget,
      // The probe passes no CLAUDE_CONFIG_DIR, so the managed branch runs.
      cwd: "/home/daytona/paperclip-workspace",
      companyId: "company-1",
      env: {},
      installCommand: "install-claude",
      detectCommand: "claude",
      targetIsRemote: true,
      targetIsSandbox: true,
      helloProbeTimeoutSec: 30,
    });

    const failed = checks.find((check) => check.code === "claude_managed_config_dir_failed");
    expect(failed).toBeTruthy();
    const checkText = JSON.stringify(checks);
    expect(checkText).not.toContain(opaqueCredMarker);
    expect(checkText).not.toContain("proxy.corp.internal");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(opaqueCredMarker);
    expect(loggedText).not.toContain("proxy.corp.internal");
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
      classification: "spawn_error",
      errorClass: "Error",
    });
    warnSpy.mockRestore();
  });
  async function cleanupFixture() {
    let workspace = "";
    const marker = "unknown-recovered-credential-marker";
    const restore = vi.fn(async () => {});
    const prepared = { runtimeRootDir: "/remote-fixture-root", assetDirs: { "config-seed": "/remote-fixture-seed" }, restoreWorkspace: restore };
    prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async ({ workspaceLocalDir }) => {
      workspace = workspaceLocalDir; cleanupDirs.push(workspace);
      await fs.writeFile(path.join(workspace, "credential-recovery"), marker);
      return prepared;
    });
    runAdapterExecutionTargetShellCommand.mockResolvedValueOnce(undefined);
    const invoke = () => prepareSandboxClaudeProbeRuntime({ managedAiConnection: true, runId: "cleanup-fixture-run", target: sandboxTarget,
      cwd: "/remote-fixture-cwd", env: { CLAUDE_CONFIG_DIR: "/fixture-original-seed" }, installCommand: "", detectCommand: "claude",
      targetIsRemote: true, targetIsSandbox: true, helloProbeTimeoutSec: 1 });
    return { invoke, workspace: () => workspace, marker, restore, prepared };
  }
  it("retains recovered credential workspace and exact runtime after failed restore instead of reporting success", async () => {
    const f = await cleanupFixture(), failure = new Error("opaque restore credential");
    f.restore.mockRejectedValueOnce(failure);
    const error = await f.invoke().catch(error => error);
    expect(error).toBeInstanceOf(ClaudeProbeCleanupError);
    expect(ClaudeProbeCleanupError.inspect(error)!.orderedFailures).toEqual([failure]);
    expect(ClaudeProbeCleanupError.inspect(error)!.recovery).toMatchObject({ runId: "cleanup-fixture-run", tempWorkspaceDir: f.workspace(), restoreFailed: true, cleanupFailed: false });
    expect(ClaudeProbeCleanupError.inspect(error)!.recovery.preparedRuntime).toBe(f.prepared);
    expect(await fs.readFile(path.join(f.workspace(), "credential-recovery"), "utf8")).toBe(f.marker);
    expect(error.message).not.toContain(f.workspace()); expect(error.message).not.toContain("opaque restore credential");
    expect(JSON.stringify(error)).not.toContain(f.workspace()); expect(JSON.stringify(error)).not.toContain(f.marker);
    const ownValues = Object.getOwnPropertyNames(error).map(key => String((error as Record<string, unknown>)[key])).join("\n");
    expect(ownValues).not.toContain(f.workspace()); expect(ownValues).not.toContain("opaque restore credential");
    expect(Object.getOwnPropertyNames(error)).not.toContain("errors"); expect(Object.getOwnPropertyNames(error)).not.toContain("cause"); expect(Object.getOwnPropertyNames(error)).not.toContain("recovery");
  });
  it.each(["error", "undefined"] as const)("preserves original materialization %s before independent restore failure", async kind => {
    const f = await cleanupFixture(), original = kind === "undefined" ? undefined : new Error("opaque materialization failure"), restore = new Error("opaque restore failure");
    // Replace only the queued shell outcome, never run a remote command.
    runAdapterExecutionTargetShellCommand.mockReset(); runAdapterExecutionTargetShellCommand.mockRejectedValueOnce(original);
    f.restore.mockRejectedValueOnce(restore);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = await f.invoke().catch(error => error);
    expect(error).toBeInstanceOf(ClaudeProbeCleanupError); expect(ClaudeProbeCleanupError.inspect(error)!.orderedFailures).toEqual([original, restore]);
    expect(await fs.readFile(path.join(f.workspace(), "credential-recovery"), "utf8")).toBe(f.marker);
  });
  it("surfaces failed temporary removal after acknowledged restore with exact retained identity", async () => {
    const f = await cleanupFixture(), originalRm = fs.rm.bind(fs), failure = new Error("opaque removal failure");
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target) === f.workspace()) throw failure;
      return originalRm(target, options);
    });
    const error = await f.invoke().catch(error => error);
    expect(error).toBeInstanceOf(ClaudeProbeCleanupError); expect(ClaudeProbeCleanupError.inspect(error)!.orderedFailures).toEqual([failure]);
    expect(f.restore).toHaveBeenCalledOnce(); expect(ClaudeProbeCleanupError.inspect(error)!.recovery).toMatchObject({ tempWorkspaceDir: f.workspace(), restoreFailed: false, cleanupFailed: true });
    expect(await fs.readFile(path.join(f.workspace(), "credential-recovery"), "utf8")).toBe(f.marker);
  });
  it("reports materialization success only after restore and actual temporary removal return", async () => {
    const f = await cleanupFixture();
    const checks = await f.invoke();
    expect(f.restore).toHaveBeenCalledOnce(); expect(checks.some(check => check.code === "claude_managed_config_dir" && check.level === "info")).toBe(true);
    await expect(fs.stat(f.workspace())).rejects.toMatchObject({ code: "ENOENT" });
  });

});
