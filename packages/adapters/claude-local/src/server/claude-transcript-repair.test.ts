import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const processBoundary = vi.hoisted(() => ({ run: vi.fn(), restore: vi.fn(), stop: vi.fn(), materialize: vi.fn(), managedHome: false, bridgeEnv: {} as Record<string, string> }));
vi.mock("./acp.js", () => ({ createClaudeAcpExecutor: () => vi.fn(), resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }) }));
vi.mock("@paperclipai/adapter-utils/execution-target", async importOriginal => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return { ...actual, ensureAdapterExecutionTargetCommandResolvable: async () => undefined, ensureAdapterExecutionTargetRuntimeCommandInstalled: async () => undefined,
    resolveAdapterExecutionTargetCommandForLogs: async () => "claude", runAdapterExecutionTargetProcess: processBoundary.run,
    adapterExecutionTargetUsesManagedHome: () => processBoundary.managedHome, adapterExecutionTargetUsesPaperclipBridge: () => true,
    prepareAdapterExecutionTargetRuntime: async () => ({ workspaceRemoteDir: "/remote/workspace", runtimeRootDir: "/remote/runtime", assetDirs: { skills: "/remote/skills", "mcp-config": "/remote/mcp" }, restoreWorkspace: processBoundary.restore }),
    startAdapterExecutionTargetPaperclipBridge: async () => ({ env: processBoundary.bridgeEnv, stop: processBoundary.stop }) };
});
vi.mock("./claude-config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./claude-config.js")>();
  return { ...actual, materializeRemoteClaudeConfig: processBoundary.materialize };
});
import { retirePoisonedLocalTranscript } from "./claude-transcript-repair.js";
import { execute, ClaudeLocalCleanupPendingError } from "./execute.js";
describe("local poisoned transcript admission barrier", () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-transcript-repair-")); vi.clearAllMocks(); processBoundary.restore.mockResolvedValue(undefined); processBoundary.stop.mockResolvedValue(undefined); processBoundary.materialize.mockResolvedValue(undefined); processBoundary.managedHome = false; processBoundary.bridgeEnv = {}; });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
  async function fixture() {
    const claudeConfigDir = path.join(root, "claude"), cwd = path.join(root, "workspace"), sessionId = randomUUID();
    const parent = path.join(claudeConfigDir, "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-")), file = path.join(parent, `${sessionId}.jsonl`);
    await fs.mkdir(cwd); await fs.mkdir(parent, { recursive: true }); await fs.writeFile(file, "original poisoned transcript");
    return { claudeConfigDir, cwd, sessionId, parent, file, run: () => retirePoisonedLocalTranscript({ claudeConfigDir, cwd, sessionId }) };
  }
  it("unlinks actual original file and flushes the same current parent before local acknowledgement", async () => {
    const f = await fixture(); expect(await f.run()).toBe("local-unlink-returned"); await expect(fs.lstat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.run()).toBe("local-absence-observed");
  });
  it("requires a directory flush even for observed local absence", async () => {
    const f = await fixture(); await fs.unlink(f.file); const open = fs.open.bind(fs), failure = new Error("absence barrier sync failed");
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => { const handle = await open(...args); if (String(args[0]) === f.parent) vi.spyOn(handle, "sync").mockRejectedValue(failure); return handle; });
    await expect(f.run()).rejects.toBe(failure);
    vi.restoreAllMocks(); expect(await f.run()).toBe("local-absence-observed");
  });
  it("refuses missing parent rather than asserting an original deletion or starting anew", async () => {
    const f = await fixture(); await fs.rm(f.parent, { recursive: true }); const unlink = vi.spyOn(fs, "unlink");
    await expect(f.run()).rejects.toMatchObject({ code: "ENOENT" }); expect(unlink).not.toHaveBeenCalled();
  });
  it.each(["symlink", "hardlink", "directory"] as const)("refuses known %s target without destructive use", async kind => {
    const f = await fixture(), original = path.join(root, "retained-original"); await fs.rename(f.file, original);
    if (kind === "symlink") await fs.symlink(original, f.file); else if (kind === "hardlink") await fs.link(original, f.file); else await fs.mkdir(f.file);
    const unlink = vi.spyOn(fs, "unlink"); await expect(f.run()).rejects.toThrow("target requires inspection"); expect(unlink).not.toHaveBeenCalled(); expect(await fs.readFile(original, "utf8")).toBe("original poisoned transcript");
  });
  it.each(["../escape", "a/b", "a\\b", "nul\0leaf", "", ".", ".."])("refuses unsafe session leaf %j before destructive use", async sessionId => {
    const f = await fixture(), unlink = vi.spyOn(fs, "unlink");
    await expect(retirePoisonedLocalTranscript({ ...f, sessionId })).rejects.toThrow("identity requires inspection"); expect(unlink).not.toHaveBeenCalled();
  });
  it("preserves original unlink error before an independent descriptor close error", async () => {
    const f = await fixture(), unlinkFailure = new Error("original unlink denied"), closeFailure = new Error("descriptor close uncertain"), open = fs.open.bind(fs);
    vi.spyOn(fs, "unlink").mockRejectedValue(unlinkFailure);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => { const handle = await open(...args), close = handle.close.bind(handle); vi.spyOn(handle, "close").mockImplementation(async () => { await close(); throw closeFailure; }); return handle; });
    const failure = await f.run().catch(error => error); expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toEqual([unlinkFailure, closeFailure]); expect(await fs.readFile(f.file, "utf8")).toBe("original poisoned transcript");
  });
  it("retains uncertain unlink outcome after fsync failure and only later observes flushed local absence", async () => {
    const f = await fixture(), open = fs.open.bind(fs), failure = new Error("post unlink sync failure");
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => { const handle = await open(...args); vi.spyOn(handle, "sync").mockRejectedValue(failure); return handle; });
    await expect(f.run()).rejects.toBe(failure); await expect(fs.lstat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    vi.restoreAllMocks(); expect(await f.run()).toBe("local-absence-observed");
  });
  it("refuses a changed parent after actual unlink without acknowledging cleanup", async () => {
    const f = await fixture(), unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async file => { await unlink(file); await fs.rename(f.parent, `${f.parent}-original`); await fs.mkdir(f.parent); });
    await expect(f.run()).rejects.toThrow("parent changed");
  });
  it("preserves an actual undefined unlink rejection rather than replacing it with a property access error", async () => {
    const f = await fixture(); vi.spyOn(fs, "unlink").mockRejectedValue(undefined);
    let rejected = false, reason: unknown = "not caught";
    try { await f.run(); } catch (error) { rejected = true; reason = error; }
    expect(rejected).toBe(true); expect(reason).toBeUndefined(); expect(await fs.readFile(f.file, "utf8")).toBe("original poisoned transcript");
  });
  it("actual execute refuses a fresh process and retry log when poisoned local unlink fails", async () => {
    const f = await fixture(), failure = new Error("original local transcript unlink failed");
    vi.stubEnv("PAPERCLIP_HOME", root); vi.stubEnv("CLAUDE_CONFIG_DIR", f.claudeConfigDir);
    processBoundary.run.mockResolvedValue({ exitCode: 1, signal: null, timedOut: false,
      stdout: JSON.stringify({ type: "result", is_error: true, result: "diagnostics.previous_message_id must be a string that starts with `msg_`" }), stderr: "", pid: 123, startedAt: new Date().toISOString() });
    const unlink = fs.unlink.bind(fs); vi.spyOn(fs, "unlink").mockImplementation(async file => { if (String(file) === f.file) throw failure; return unlink(file); });
    const onLog = vi.fn(async () => undefined);
    const context = { runId: randomUUID(), agent: { id: randomUUID(), companyId: randomUUID(), name: "Fixture", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: f.sessionId, sessionParams: { sessionId: f.sessionId, cwd: f.cwd }, sessionDisplayId: null, taskKey: null }, config: { engine: "cli", cwd: f.cwd }, context: {}, onLog };
    await expect(execute(context as never)).rejects.toBe(failure);
    expect(processBoundary.run).toHaveBeenCalledOnce();
    expect(onLog.mock.calls.some(args => args.some(value => String(value).includes("retrying with a fresh session")))).toBe(false);
    expect(await fs.readFile(f.file, "utf8")).toBe("original poisoned transcript");
  });
  async function executeFixture(remote = false) {
    const f = await fixture(); vi.stubEnv("PAPERCLIP_HOME", root); vi.stubEnv("CLAUDE_CONFIG_DIR", f.claudeConfigDir);
    const onLog = vi.fn(async (..._args: unknown[]) => undefined);
    const context = { runId: randomUUID(), agent: { id: randomUUID(), companyId: randomUUID(), name: "Fixture", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: remote ? null : f.sessionId, sessionParams: remote ? null : { sessionId: f.sessionId, cwd: f.cwd }, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", cwd: f.cwd }, context: {}, onLog, onProviderStopped: vi.fn(async () => undefined),
      ...(remote ? { executionTransport: { remoteExecution: { host: "fixture.invalid", port: 2222, username: "fixture", remoteWorkspacePath: "/remote/workspace", remoteCwd: "/remote/workspace", privateKey: "PRIVATE-FIXTURE-NOT-PUBLIC", knownHosts: "fixture-host-key", strictHostKeyChecking: true } } } : {}) };
    return { ...f, context, onLog };
  }
  it("retains primary poisoned repair and undefined collector failure privately without starting fresh", async () => {
    const f = await executeFixture(), primary = new Error("private original transcript failure"), unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async file => { if (String(file) === f.file) throw primary; return unlink(file); });
    f.context.onProviderStopped.mockRejectedValue(undefined);
    processBoundary.run.mockImplementation(async (...args: unknown[]) => {
      (args[4] as { onProcessStopped?: () => void }).onProcessStopped?.();
      return { exitCode: 1, signal: null, timedOut: false, stdout: JSON.stringify({ type: "result", is_error: true, result: "diagnostics.previous_message_id must be a string that starts with `msg_`" }), stderr: "", pid: 123, startedAt: new Date().toISOString() };
    });
    const failure = await execute(f.context as never).catch(error => error);
    expect(failure).toBeInstanceOf(ClaudeLocalCleanupPendingError);
    expect(ClaudeLocalCleanupPendingError.inspect(failure)?.failures).toEqual([{ phase: "invocation", error: primary }, { phase: "provider-stop-collection", error: undefined }]);
    expect(processBoundary.run).toHaveBeenCalledOnce(); expect(processBoundary.stop).not.toHaveBeenCalled(); expect(processBoundary.restore).not.toHaveBeenCalled();
    expect(Object.hasOwn(failure, "cause")).toBe(false); expect(Object.hasOwn(failure, "errors")).toBe(false); expect(JSON.stringify(failure)).not.toContain("private original");
    expect(await fs.readFile(f.file, "utf8")).toBe("original poisoned transcript");
  });
  it("actual remote invocation attempts bridge cleanup after collector failure, retains ordered causes and restoration handle", async () => {
    const f = await executeFixture(true), primary = new Error("PRIVATE-primary"), collector = new Error("PRIVATE-collector"), bridge = new Error("PRIVATE-bridge");
    f.context.onProviderStopped.mockRejectedValue(collector); processBoundary.stop.mockRejectedValue(bridge);
    processBoundary.run.mockImplementation(async (...args: unknown[]) => { (args[4] as { onProcessStopped?: () => void }).onProcessStopped?.(); throw primary; });
    const failure = await execute(f.context as never).catch(error => error), inspection = ClaudeLocalCleanupPendingError.inspect(failure);
    expect(failure).toBeInstanceOf(ClaudeLocalCleanupPendingError);
    expect(inspection?.failures).toEqual([{ phase: "invocation", error: primary }, { phase: "provider-stop-collection", error: collector }, { phase: "bridge-stop", error: bridge }]);
    expect(inspection?.restoreRemoteWorkspace).toBeTypeOf("function"); expect(inspection?.executionTarget).toBeTruthy();
    expect(processBoundary.stop).toHaveBeenCalledOnce(); expect(processBoundary.restore).not.toHaveBeenCalled(); expect(processBoundary.run).toHaveBeenCalledOnce();
    expect(Object.hasOwn(failure, "cause")).toBe(false); expect(Object.hasOwn(failure, "errors")).toBe(false); expect(JSON.stringify(failure)).not.toContain("PRIVATE");
  });
  it("does not let restore logging failure prevent gated restoration and retains restoration failure", async () => {
    const f = await executeFixture(true), logFailure = new Error("private restore log failure"), restoreFailure = new Error("private restore failed");
    processBoundary.run.mockImplementation(async (...args: unknown[]) => { (args[4] as { onProcessStopped?: () => void }).onProcessStopped?.(); return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 123, startedAt: new Date().toISOString() }; });
    f.onLog.mockImplementation(async (...args: unknown[]) => { if (args.some(value => String(value).includes("Restoring workspace changes."))) throw logFailure; });
    processBoundary.restore.mockRejectedValue(restoreFailure);
    const failure = await execute(f.context as never).catch(error => error);
    expect(ClaudeLocalCleanupPendingError.inspect(failure)?.failures).toEqual([{ phase: "restore-log", error: logFailure }, { phase: "workspace-restore", error: restoreFailure }]);
    expect(f.context.onProviderStopped).toHaveBeenCalledOnce(); expect(processBoundary.stop).toHaveBeenCalledOnce(); expect(processBoundary.restore).toHaveBeenCalledOnce();
  });

  it("actual execute restores acquired remote preparation after materialization fails before process admission", async () => {
    const f = await executeFixture(true), primary = new Error("private materialization failed");
    processBoundary.managedHome = true; processBoundary.materialize.mockRejectedValue(primary);
    Object.assign(f.context.config, { managedAiConnection: true, env: { CLAUDE_CONFIG_DIR: f.claudeConfigDir } });
    await expect(execute(f.context as never)).rejects.toBe(primary);
    expect(processBoundary.materialize).toHaveBeenCalledOnce(); expect(processBoundary.run).not.toHaveBeenCalled();
    expect(processBoundary.stop).not.toHaveBeenCalled(); expect(processBoundary.restore).toHaveBeenCalledOnce();
  });
  it.each(["error", "undefined"] as const)("joins acquired bridge and restoration after a later %s initialization failure", async kind => {
    const f = await executeFixture(true), primary = kind === "error" ? new Error("private bridge environment initialization failed") : undefined;
    Object.defineProperty(processBoundary.bridgeEnv, "FIXTURE_INITIALIZATION", { enumerable: true, get() { throw primary; } });
    let rejected = false, reason: unknown = "not caught";
    try { await execute(f.context as never); } catch (error) { rejected = true; reason = error; }
    expect(rejected).toBe(true); expect(reason).toBe(primary);
    expect(processBoundary.run).not.toHaveBeenCalled(); expect(processBoundary.stop).toHaveBeenCalledOnce(); expect(processBoundary.restore).toHaveBeenCalledOnce();
  });
  it("holds acquired restoration handle after undefined initialization failure and independent bridge-stop failure", async () => {
    const f = await executeFixture(true), bridgeError = new Error("private early bridge stop failed");
    Object.defineProperty(processBoundary.bridgeEnv, "FIXTURE_INITIALIZATION", { enumerable: true, get() { throw undefined; } });
    processBoundary.stop.mockRejectedValue(bridgeError);
    const failure = await execute(f.context as never).catch(error => error), inspection = ClaudeLocalCleanupPendingError.inspect(failure);
    expect(inspection?.failures).toEqual([{ phase: "invocation", error: undefined }, { phase: "bridge-stop", error: bridgeError }]);
    expect(inspection?.restoreRemoteWorkspace).toBeTypeOf("function");
    expect(processBoundary.run).not.toHaveBeenCalled(); expect(processBoundary.stop).toHaveBeenCalledOnce(); expect(processBoundary.restore).not.toHaveBeenCalled();
    expect(JSON.stringify(failure)).not.toContain("private");
  });

});
