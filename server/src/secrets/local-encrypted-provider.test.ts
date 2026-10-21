import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const faults = vi.hoisted(() => ({
  files: new Map<number, string>(), events: [] as string[],
  fail: "" as "" | "temporary" | "winner" | "directory",
  competitor: false, chmodFailure: false,
  closeFailure: "", unlinkFailure: false, closes: [] as string[],
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args);
      faults.files.set(descriptor, String(args[0]));
      return descriptor;
    },
    closeSync: (descriptor: number) => {
      const file = faults.files.get(descriptor)!;
      const kind = actual.fstatSync(descriptor).isDirectory() ? "directory" : file.endsWith(".tmp") ? "temporary" : "winner";
      faults.files.delete(descriptor);
      faults.closes.push(file);
      actual.closeSync(descriptor);
      if (faults.closeFailure === kind) throw new Error(`injected ${kind} close failure`);
    },
    unlinkSync: (file: fs.PathLike) => {
      actual.unlinkSync(file);
      if (faults.unlinkFailure) throw new Error("injected unlink acknowledgement failure");
    },
    fchmodSync: (descriptor: number, mode: number) => {
      if (faults.chmodFailure) throw new Error("injected chmod failure");
      return actual.fchmodSync(descriptor, mode);
    },
    fsyncSync: (descriptor: number) => {
      const file = faults.files.get(descriptor)!;
      const kind = actual.fstatSync(descriptor).isDirectory() ? "directory" : file.endsWith(".tmp") ? "temporary" : "winner";
      faults.events.push(`sync:${file}`);
      if (faults.fail === kind) throw new Error(`injected ${kind} sync failure`);
      return actual.fsyncSync(descriptor);
    },
    linkSync: (from: fs.PathLike, to: fs.PathLike) => {
      faults.events.push(`link:${String(to)}`);
      if (faults.competitor) {
        faults.competitor = false;
        actual.writeFileSync(to, Buffer.alloc(32, 7).toString("base64"), { flag: "wx", mode: 0o600 });
      }
      return actual.linkSync(from, to);
    },
  };
});
import { localEncryptedProvider } from "./local-encrypted-provider.js";

let root: string;
let keyPath: string;
const input = { companyId: "company", secretId: "secret", secretKey: "test", version: 1, value: "isolated-test-value" };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-key-durability-"));
  keyPath = path.join(root, "new", "nested", "master.key");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", keyPath);
  faults.events = [];
  faults.fail = "";
  faults.competitor = false;
  faults.chmodFailure = false;
  faults.closeFailure = "";
  faults.unlinkFailure = false;
  faults.closes = [];
});
afterEach(() => {
  faults.fail = "";
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("local master key durability barriers", () => {
  it("syncs the prepared key before publication, then winner and complete directory ancestry", async () => {
    const prepared = await localEncryptedProvider.createSecret(input);
    const link = faults.events.indexOf(`link:${keyPath}`);
    expect(link).toBeGreaterThan(0);
    expect(faults.events[link - 1]).toMatch(/\.tmp$/);
    expect(faults.events.indexOf(`sync:${keyPath}`)).toBeGreaterThan(link);
    for (let directory = path.dirname(keyPath); ; directory = path.dirname(directory)) {
      expect(faults.events).toContain(`sync:${directory}`);
      if (directory === path.dirname(directory)) break;
    }
    expect(await localEncryptedProvider.resolveVersion({ ...input, material: prepared.material, externalRef: null })).toBe(input.value);
  });

  it("refuses publication after temporary fsync failure and removes the unpublished file", async () => {
    faults.fail = "temporary";
    await expect(localEncryptedProvider.createSecret(input)).rejects.toThrow("temporary sync failure");
    expect(fs.existsSync(keyPath)).toBe(false);
    expect(fs.readdirSync(path.dirname(keyPath))).toEqual([]);
    expect(faults.events.some((event) => event.startsWith("link:"))).toBe(false);
  });

  it("retains a published winner after directory sync failure and repairs durability on retry", async () => {
    faults.fail = "directory";
    await expect(localEncryptedProvider.createSecret(input)).rejects.toThrow("directory sync failure");
    const winner = fs.readFileSync(keyPath);
    faults.fail = "";
    faults.events = [];
    const prepared = await localEncryptedProvider.createSecret(input);
    expect(fs.readFileSync(keyPath).equals(winner)).toBe(true);
    expect(faults.events).toContain(`sync:${keyPath}`);
    expect(faults.events.some((event) => event.startsWith("link:"))).toBe(false);
    expect(await localEncryptedProvider.resolveVersion({ ...input, material: prepared.material, externalRef: null })).toBe(input.value);
  });

  it("requires an existing exact winner to sync before use and never replaces it after failure", async () => {
    await localEncryptedProvider.createSecret(input);
    const winner = fs.readFileSync(keyPath);
    faults.fail = "winner";
    await expect(localEncryptedProvider.createSecret(input)).rejects.toThrow("winner sync failure");
    expect(fs.readFileSync(keyPath).equals(winner)).toBe(true);
    faults.fail = "";
    const prepared = await localEncryptedProvider.createSecret(input);
    expect(fs.readFileSync(keyPath).equals(winner)).toBe(true);
    expect(await localEncryptedProvider.resolveVersion({ ...input, material: prepared.material, externalRef: null })).toBe(input.value);
  });

  it("uses and syncs the no-overwrite competitor winner", async () => {
    faults.competitor = true;
    const prepared = await localEncryptedProvider.createSecret(input);
    expect(fs.readFileSync(keyPath).equals(Buffer.from(Buffer.alloc(32, 7).toString("base64")))).toBe(true);
    expect(faults.events).toContain(`sync:${keyPath}`);
    expect(fs.readdirSync(path.dirname(keyPath))).toEqual(["master.key"]);
    expect(await localEncryptedProvider.resolveVersion({ ...input, material: prepared.material, externalRef: null })).toBe(input.value);
  });

  it("refuses a public key when permission correction fails and preserves it for retry", async () => {
    await localEncryptedProvider.createSecret(input);
    const winner = fs.readFileSync(keyPath);
    fs.chmodSync(keyPath, 0o644);
    faults.chmodFailure = true;
    await expect(localEncryptedProvider.createSecret(input)).rejects.toThrow("chmod failure");
    expect(fs.readFileSync(keyPath).equals(winner)).toBe(true);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o644);
    faults.chmodFailure = false;
    const prepared = await localEncryptedProvider.createSecret(input);
    expect(fs.readFileSync(keyPath).equals(winner)).toBe(true);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(await localEncryptedProvider.resolveVersion({ ...input, material: prepared.material, externalRef: null })).toBe(input.value);
  });

  it("refuses a non-regular key without replacing it", async () => {
    fs.mkdirSync(keyPath, { recursive: true });
    await expect(localEncryptedProvider.createSecret(input)).rejects.toThrow("owned regular file");
    expect(fs.statSync(keyPath).isDirectory()).toBe(true);
  });

  it("retains configured symlink keys while checking their actual target", async () => {
    const physical = path.join(root, "physical.key");
    fs.writeFileSync(physical, Buffer.alloc(32, 9).toString("base64"), { mode: 0o600 });
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.symlinkSync(physical, keyPath);
    const prepared = await localEncryptedProvider.createSecret(input);
    expect(fs.lstatSync(keyPath).isSymbolicLink()).toBe(true);
    expect(await localEncryptedProvider.resolveVersion({ ...input, material: prepared.material, externalRef: null })).toBe(input.value);
    expect(faults.events).toContain(`sync:${root}`);
  });

  for (const kind of ["winner", "directory"] as const) {
    it(`preserves ${kind} sync and close failures without replacing the selected key`, async () => {
      await localEncryptedProvider.createSecret(input);
      const winner = fs.readFileSync(keyPath);
      faults.fail = kind;
      faults.closeFailure = kind;
      faults.closes = [];
      const failure = await localEncryptedProvider.createSecret(input).catch((error) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors.map((error: Error) => error.message)).toEqual([
        `injected ${kind} sync failure`, `injected ${kind} close failure`,
      ]);
      expect(new Set(faults.closes).size).toBe(faults.closes.length);
      expect(fs.readFileSync(keyPath).equals(winner)).toBe(true);
      faults.fail = "";
      faults.closeFailure = "";
      const prepared = await localEncryptedProvider.createSecret(input);
      expect(await localEncryptedProvider.resolveVersion({ ...input, material: prepared.material, externalRef: null })).toBe(input.value);
    });
  }

  it("retains temporary sync, close and unlink errors in causal order without publication", async () => {
    faults.fail = "temporary";
    faults.closeFailure = "temporary";
    faults.unlinkFailure = true;
    const failure = await localEncryptedProvider.createSecret(input).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors[0]).toBeInstanceOf(AggregateError);
    expect(failure.errors[0].errors.map((error: Error) => error.message)).toEqual([
      "injected temporary sync failure", "injected temporary close failure",
    ]);
    expect(failure.errors[1].message).toBe("injected unlink acknowledgement failure");
    expect(faults.closes).toHaveLength(1);
    expect(fs.existsSync(keyPath)).toBe(false);
    expect(fs.readdirSync(path.dirname(keyPath))).toEqual([]);
    faults.fail = "";
    faults.closeFailure = "";
    faults.unlinkFailure = false;
    await localEncryptedProvider.createSecret(input);
  });

  it("preserves environment-key mode without creating or syncing a file", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", Buffer.alloc(32, 11).toString("base64"));
    const prepared = await localEncryptedProvider.createSecret(input);
    expect(fs.existsSync(keyPath)).toBe(false);
    expect(faults.events).toEqual([]);
    expect(await localEncryptedProvider.resolveVersion({ ...input, material: prepared.material, externalRef: null })).toBe(input.value);
  });
});
