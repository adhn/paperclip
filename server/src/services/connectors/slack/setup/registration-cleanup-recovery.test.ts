import { assertNoPendingRegistrationCleanupForDefinition } from "./registration-cleanup-recovery.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const fixture = vi.hoisted(() => ({ root: "", failEncrypt: false }));
vi.mock("../../../../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => fixture.root }));
vi.mock("../../../../secrets/local-encrypted-provider.js", () => ({ localEncryptedProvider: {
  createVersion: async ({ value }: { value: string }) => { if (fixture.failEncrypt) throw new Error("fixture encrypt failed"); return { material: { fixture: Buffer.from(value).toString("base64") } }; },
  resolveVersion: async ({ material }: { material: { fixture: string } }) => Buffer.from(material.fixture, "base64").toString(),
} }));
import { registrationCleanupRecovery, registrationCleanupRecoveryPath, assertNoPendingRegistrationCleanupForActor, assertNoPendingRegistrationCleanupForEndpoint, assertNoPendingRegistrationCleanupForSecret, withRegistrationCleanup, assertRegistrationCleanupSecretRemovalAllowed, type RegistrationCleanupIntent } from "./registration-cleanup-recovery.js";
const company = "00000000-0000-4000-8000-000000000001", endpoint = "00000000-0000-4000-8000-000000000002", bot = "00000000-0000-4000-8000-000000000003", signing = "00000000-0000-4000-8000-000000000004", other = "00000000-0000-4000-8000-000000000005";
const identity = (id: string) => ({ secretId: id, versionId: id, version: 1, authority: { parent: {}, version: {}, definition: null, providerConfig: null } });
const intent: RegistrationCleanupIntent = { schema: 1, kind: "registration-cleanup-intent", family: "slack.registration.staged-cleanup", operationId: "00000000-0000-4000-8000-000000000006", companyId: company, endpointId: endpoint,
  actorUserId: "fixture-user", actorSessionId: "fixture-session",
  originalEndpoint: { id: endpoint, companyId: company, connectionId: "00000000-0000-4000-8000-000000000010", setup: { runtimeGeneration: 0 } }, originalConnection: { id: "00000000-0000-4000-8000-000000000010", companyId: company },
  originalRegistration: { companyId: company, endpointId: endpoint, status: "configured", secretIds: { botToken: bot, signingSecret: signing, clientSecret: other } },
  targets: { [bot]: { key: "botToken", identity: identity(bot), tokenOperationId: "00000000-0000-4000-8000-000000000008" }, [signing]: { key: "signingSecret", identity: identity(signing), tokenOperationId: "00000000-0000-4000-8000-000000000009" } }, nextSecretIds: { clientSecret: other },
};
const reopen = () => registrationCleanupRecovery(company, endpoint), file = () => registrationCleanupRecoveryPath(company, endpoint);
beforeEach(async () => { fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "registration-cleanup-")); fixture.failEncrypt = false; });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.root, { recursive: true, force: true }); });
describe("independent prospective standalone registration cleanup", () => {
  it("retains original intent and guards all original custody after reopen without replay", async () => {
    const entry = await reopen().begin(intent); expect(await reopen().read()).toEqual(entry);
    await expect(reopen().begin(intent)).rejects.toThrow();
    await expect(assertNoPendingRegistrationCleanupForActor(company, intent.actorUserId)).rejects.toThrow();
    await expect(assertNoPendingRegistrationCleanupForEndpoint(company, endpoint)).rejects.toThrow();
    await expect(assertNoPendingRegistrationCleanupForSecret(company, bot)).rejects.toThrow();
    await expect(reopen().clear(entry)).rejects.toThrow();
  });
  it("allows only current original descriptors inside originating scope, preserves independent returns", async () => {
    const entry = await reopen().begin(intent);
    await expect(assertRegistrationCleanupSecretRemovalAllowed(company, bot, identity(bot))).rejects.toThrow();
    await withRegistrationCleanup(entry, async () => {
      await assertRegistrationCleanupSecretRemovalAllowed(company, bot, identity(bot));
      await expect(assertRegistrationCleanupSecretRemovalAllowed(company, bot, { ...identity(bot), version: 2 })).rejects.toThrow();
      const first = await reopen().recordRemovalReturned({ intent, secretId: bot });
      expect(first.acknowledgedRemovalIds).toEqual([bot]);
      await expect(assertRegistrationCleanupSecretRemovalAllowed(company, bot, identity(bot))).rejects.toThrow();
      await expect(reopen().recordRemovalReturned({ intent, secretId: bot })).rejects.toThrow();
      await assertRegistrationCleanupSecretRemovalAllowed(company, signing, identity(signing));
      const last = await reopen().recordRemovalReturned({ intent, secretId: signing });
      expect(last.acknowledgedRemovalIds).toEqual([bot, signing]);
    });
    const retained = (await reopen().read())!;
    await expect(withRegistrationCleanup(retained, async () => {})).rejects.toThrow();
    await reopen().clear(retained); expect(await reopen().read()).toBeNull();
  });
  it("refuses rollback of independently recorded acknowledgement within an active scope", async () => {
    const entry = await reopen().begin(intent), originalBytes = await fs.readFile(file());
    await withRegistrationCleanup(entry, async () => {
      await reopen().recordRemovalReturned({ intent, secretId: bot });
      await fs.writeFile(file(), originalBytes);
      await expect(assertRegistrationCleanupSecretRemovalAllowed(company, signing, identity(signing))).rejects.toThrow();
    });
  });

  it("preserves prior acknowledgement if another removal return cannot be persisted", async () => {
    await reopen().begin(intent); await reopen().recordRemovalReturned({ intent, secretId: bot }); fixture.failEncrypt = true;
    await expect(reopen().recordRemovalReturned({ intent, secretId: signing })).rejects.toThrow("encrypt failed");
    expect((await reopen().read())!.acknowledgedRemovalIds).toEqual([bot]);
    await expect(reopen().begin(intent)).rejects.toThrow();
  });
  it("refuses widening original refs, version identities or intended next registration", async () => {
    await expect(reopen().begin({ ...intent, nextSecretIds: {} })).rejects.toThrow();
    await expect(reopen().begin({ ...intent, targets: { [bot]: { ...intent.targets[bot], identity: identity(other) } } })).rejects.toThrow();
    await expect(reopen().begin({ ...intent, originalRegistration: { ...intent.originalRegistration, status: "ready" } })).rejects.toThrow();
    await expect(reopen().begin({ ...intent, originalRegistration: { ...intent.originalRegistration, secretIds: { botToken: bot, signingSecret: signing, clientSecret: bot } } })).rejects.toThrow();
    expect(await reopen().read()).toBeNull();
  });
  it.each(["return", "throw"] as const)("revokes detached removal permission after callback %s", async mode => {
    const entry = await reopen().begin(intent); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); let detached!: Promise<unknown>;
    await withRegistrationCleanup(entry, async () => {
      detached = gate.then(() => assertRegistrationCleanupSecretRemovalAllowed(company, bot, identity(bot))).catch(error => error);
      if (mode === "throw") throw new Error("fixture callback failed");
    }).catch(() => {});
    release(); expect(await detached).toBeInstanceOf(Error);
  });
  it.each(["symlink", "hardlink", "directory"] as const)("refuses static %s journal aliases", async alias => {
    await reopen().begin(intent); const outside = path.join(fixture.root, "outside"); await fs.rename(file(), outside);
    if (alias === "symlink") await fs.symlink(outside, file()); else if (alias === "hardlink") await fs.link(outside, file()); else await fs.mkdir(file());
    await expect(reopen().read()).rejects.toThrow();
  });
  it("refuses partial temporary occupancy and observed directory disappearance", async () => {
    await reopen().begin(intent); await fs.writeFile(`${file()}.tmp`, "fixture");
    await expect(reopen().read()).rejects.toThrow(); await fs.rm(`${file()}.tmp`);
    const realRead = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementationOnce(async (...args: Parameters<typeof fs.readdir>) => { await fs.rm(path.dirname(file()), { recursive: true }); return realRead(...args); });
    await expect(reopen().read()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("gates reuse after acknowledged clear unlink but failed directory flush", async () => {
    await reopen().begin(intent); await reopen().recordRemovalReturned({ intent, secretId: bot }); const complete = await reopen().recordRemovalReturned({ intent, secretId: signing });
    const realOpen = fs.open.bind(fs); let fail = true;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => { const handle = await realOpen(...args);
      if (String(args[0]) === path.dirname(file()) && fail) handle.sync = async () => { throw new Error("fixture flush failed"); }; return handle; });
    await expect(reopen().clear(complete)).rejects.toThrow("flush failed");
    await expect(reopen().begin(intent)).rejects.toThrow("flush failed"); fail = false; await reopen().begin(intent);
  });
  it("refuses a missing target descriptor and never relabels a configured row as installation evidence", async () => {
    await expect(reopen().begin({ ...intent, targets: { [bot]: intent.targets[bot] }, nextSecretIds: { clientSecret: other, signingSecret: signing } })).rejects.toThrow();
    await expect(reopen().begin({ ...intent, family: "slack.apps.managedInstall" as never })).rejects.toThrow();
    expect(await reopen().read()).toBeNull();
  });
  it("does not infer a live removal permission from journal disappearance inside active ownership", async () => {
    const entry = await reopen().begin(intent);
    await withRegistrationCleanup(entry, async () => {
      await fs.unlink(file());
      await expect(assertRegistrationCleanupSecretRemovalAllowed(company, bot, identity(bot))).rejects.toThrow();
    });
  });
  it("retains preparation sync and close errors plus temporary uncertainty", async () => {
    const open = fs.open.bind(fs), first = new Error("original sync failure"), second = new Error("close failure");
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith(".tmp")) { const close = handle.close.bind(handle); vi.spyOn(handle, "sync").mockRejectedValue(first); vi.spyOn(handle, "close").mockImplementation(async () => { await close(); throw second; }); }
      return handle;
    });
    const error = await reopen().begin(intent).catch(value => value);
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([first, second]);
    vi.restoreAllMocks();
    await expect(reopen().begin(intent)).rejects.toThrow();
    await expect(assertNoPendingRegistrationCleanupForEndpoint(company, endpoint)).rejects.toThrow();
  });

  it.each(["file", "directory"] as const)("retains active original definition occupancy after journal %s disappears", async missing => {
    const definition = "00000000-0000-4000-8000-000000000099", unrelated = "00000000-0000-4000-8000-000000000098", selected = structuredClone(intent);
    selected.targets[bot].identity.authority.definition = { id: definition, key: "original" };
    const saved = await reopen().begin(selected); await expect(assertNoPendingRegistrationCleanupForDefinition(company, definition)).rejects.toThrow();
    await withRegistrationCleanup(saved, async () => {
      await expect(assertNoPendingRegistrationCleanupForDefinition(company, definition)).rejects.toThrow();
      await assertNoPendingRegistrationCleanupForDefinition(company, unrelated);
      if (missing === "directory") await fs.rm(path.dirname(file()), { recursive: true }); else await fs.rm(file());
      await expect(assertNoPendingRegistrationCleanupForDefinition(company, definition)).rejects.toThrow();
      await assertNoPendingRegistrationCleanupForDefinition(company, unrelated);
    });
    // Scope expiry grants no permanent deny when retained original occupancy is absent.
    await assertNoPendingRegistrationCleanupForDefinition(company, definition);
  });

});
