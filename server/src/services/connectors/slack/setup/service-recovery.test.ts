import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatEndpoints } from "@paperclipai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ root: "", store: {} as any, failResult: false, expectIntent: true, resume: vi.fn(), managerToken: vi.fn(), hold: "", realLocks: false }));
vi.mock("../../../../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => fixture.root }));
vi.mock("../../../../secrets/local-encrypted-provider.js", () => ({ localEncryptedProvider: {
  createVersion: async ({ value }: { value: string }) => {
    if (fixture.failResult && JSON.parse(value).kind === "slack-install-result") throw new Error("fixture result journal failure");
    return { material: { fixture: Buffer.from(value).toString("base64") } };
  },
  resolveVersion: async ({ material }: { material: { fixture: string } }) => Buffer.from(material.fixture, "base64").toString(),
} }));
vi.mock("@paperclipai/adapter-codex-local/server", (importOriginal) => ({ withAccountHomeSecretMutationLock: async (env: unknown, company: string, work: () => Promise<unknown>) => {
  if (!fixture.realLocks) return work();
  const actual = await importOriginal<typeof import("@paperclipai/adapter-codex-local/server")>();
  return actual.withAccountHomeSecretMutationLock(env as undefined, company, work);
} }));
vi.mock("@paperclipai/shared", async (importOriginal) => ({ ...await importOriginal<typeof import("@paperclipai/shared")>(), isProvisionedSlackSetup: () => true, slackRegistrationErrorMessage: (code: string) => code }));
vi.mock("./registration.js", () => ({
  createSlackRegistrationStore: () => fixture.store,
  object: (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value : {},
  providerFailure: (code: string) => Object.assign(new Error(code), { details: { code } }),
}));
vi.mock("./new-use-guard.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./new-use-guard.js")>();
  return { ...actual, assertSlackSetupNewUse: async (input: Parameters<typeof actual.assertSlackSetupNewUse>[0]) => {
    if (fixture.hold) throw new Error(`fixture retained ${fixture.hold}`);
    return actual.assertSlackSetupNewUse(input);
  } };
});
vi.mock("./customer-owned.js", () => ({ createCustomerOwnedSetup: () => ({ create: vi.fn() }) }));
vi.mock("./completion.js", () => ({ createSlackCompletion: () => ({ resumeLocked: fixture.resume, notifyVerified: vi.fn(), processPendingVerificationMessages: vi.fn(), nextVerificationMessageAt: vi.fn() }) }));
vi.mock("./manager-grants.js", () => ({ createSlackManagerGrants: () => ({ token: fixture.managerToken }) }));
vi.mock("./managed.js", () => ({ createManagedSlackSetup: () => ({}) }));
vi.mock("../../../chat-slack-registration-cleanup.js", () => ({ removeSlackRegistration: vi.fn() }));
import { slackChatRegistrationService } from "./service.js";
import { createSlackSetupClient } from "./provider-client.js";
import { slackInstallRecovery } from "./install-recovery.js";
const company = "00000000-0000-4000-8000-000000000001";
const endpoint = "00000000-0000-4000-8000-000000000002";
const connection = "00000000-0000-4000-8000-000000000003";
const requestId = "00000000-0000-4000-8000-000000000004";
const secret = "00000000-0000-4000-8000-000000000005";
const state = `slack-install.${"a".repeat(43)}`;
const actor = { userId: "fixture-actor", sessionId: "fixture-session", bypassPermissionCheck: true };
const success = { ok: true, app_id: "A123", token_type: "bot", access_token: "xoxb-fixture", team: { id: "T123" }, bot_user_id: "U123", authed_user: { id: "U999" }, scope: "chat:write" };
let attempt: any;
let row: any;
let claimed: boolean;
let events: string[];
let save: ReturnType<typeof vi.fn>;
let request: ReturnType<typeof vi.fn>;
let service: ReturnType<typeof slackChatRegistrationService>;
let assertLease: ReturnType<typeof vi.fn>;
let endpointRow: any;
let credentials: Record<string, string>;
let identityRevision: number;
let resumeProvider: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "slack-install-service-"));
  fixture.failResult = false; fixture.expectIntent = true; fixture.hold = ""; fixture.realLocks = false; claimed = false; events = [];
  row = { companyId: company, endpointId: endpoint, requestId, appId: "A123", clientId: "123.456", callbackUri: "https://fixture.invalid/callback", status: "install", secretIds: { clientSecret: secret }, manifest: {}, workspaceId: null, botUserId: null };
  attempt = { companyId: company, connectionId: connection, createdByActorId: actor.userId, createdBySessionId: actor.sessionId, expiresAt: new Date(Date.now() + 60_000), requestedScopes: ["chat:write"],
    codeVerifier: JSON.stringify({ endpointId: endpoint, requestId, appId: row.appId, callbackUri: row.callbackUri, endpointStatus: "active", runtimeGeneration: 1 }) };
  const db: any = {
    select: () => ({ from: (table: unknown) => {
      const query: any = { innerJoin: (..._args: unknown[]) => query, where: async () => table === chatEndpoints ? [{ prefix: "FIXTURE" }] : claimed ? [] : [attempt] };
      return query;
    } }),
    transaction: vi.fn(async (action: (tx: any) => Promise<unknown>) => action(db)),
    insert: vi.fn(() => ({ values: async () => { events.push("insert"); } })),
    update: vi.fn(() => ({ set: () => ({ where: async () => { events.push("update"); } }) })),
    delete: vi.fn(() => ({ where: () => ({ returning: async () => {
      const retained = await slackInstallRecovery(company, endpoint).read();
      if (fixture.expectIntent) expect(retained?.kind).toBe("slack-install-intent");
      else expect(retained).toBeNull();
      events.push("claim"); claimed = true; return [attempt];
    } }) })),
  };
  request = vi.fn(async () => { events.push("fetch"); expect((await slackInstallRecovery(company, endpoint).read())?.kind).toBe("slack-install-intent"); return Response.json(success); });
  endpointRow = { id: endpoint, companyId: company, publicId: "fixture", status: "active", setup: { runtimeGeneration: 1, slackSetupMethod: "fixture" } };
  credentials = { [secret]: "fixture-client-secret" }; identityRevision = 1;
  fixture.managerToken.mockReset(); fixture.resume.mockReset(); resumeProvider = fixture.resume;
  save = vi.fn(async (_row, values, _actor, _lease, patch, account) => {
    events.push("save"); expect((await slackInstallRecovery(company, endpoint).read())?.kind).toBe("slack-install-result");
    Object.assign(row, patch);
    row.secretIds = { ...row.secretIds, botToken: row.secretIds.botToken ?? "00000000-0000-4000-8000-000000000009" };
    credentials[row.secretIds.botToken] = values.botToken;
    endpointRow.setup.slackAccount = account;
  });
  fixture.store = { db, options: {}, endpoint: async () => ({ endpoint: endpointRow, connection: { id: connection } }),
    registration: async () => row, assertOrigins: () => {}, callbackUri: () => row.callbackUri, audit: vi.fn(),
    readSecretIdentity: async (selected: any, key: string) => ({ secretId: selected.secretIds[key], versionId: "00000000-0000-4000-8000-000000000011", version: identityRevision, authority: { parent: { provider: "fixture" }, version: { revision: identityRevision }, definition: null, providerConfig: null } }),
    api: createSlackSetupClient(request as typeof fetch), readSecret: async (selected: any, key: string) => {
      const value = credentials[selected.secretIds[key]];
      if (value === undefined) throw new Error("fixture original credential unavailable");
      return value;
    }, saveSecrets: save, setFailure: vi.fn(), close: vi.fn() };
  assertLease = vi.fn(async () => {});
  service = slackChatRegistrationService(db as never, { withLock: async (_id: string, action: any) => action({ assertOwned: assertLease }) } as never);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.root, { recursive: true, force: true }); });
describe("Slack install actual exchange recovery boundaries", () => {
  it("retains intent before SQL claim and raw response before credential save", async () => {
    await service.complete(state, "fixture-code", null, actor);
    expect(events).toEqual(["claim", "fetch", "save"]);
    expect(await slackInstallRecovery(company, endpoint).read()).toBeNull();
  });
  it("refuses a lost lease before prospective intent or SQL state consumption", async () => {
    const failure = new Error("fixture pre-intent lost lease"); assertLease.mockRejectedValueOnce(failure);
    await expect(service.complete(state, "fixture-code", null, actor)).rejects.toBe(failure);
    expect(claimed).toBe(false); expect(events).toEqual([]); expect(request).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    expect(await slackInstallRecovery(company, endpoint).read()).toBeNull(); expect(fixture.store.db.delete).not.toHaveBeenCalled();
  });
  it("retains exact original intent after a post-intent lease loss and refuses provider replay", async () => {
    const failure = new Error("fixture post-intent lost lease");
    assertLease.mockImplementation(async () => { if (await slackInstallRecovery(company, endpoint).read()) throw failure; });
    await service.complete(state, "fixture-code", null, actor);
    expect(claimed).toBe(true); expect(events).toEqual(["claim"]); expect(request).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    const retained = await slackInstallRecovery(company, endpoint).read(); expect(retained).toMatchObject({ kind: "slack-install-intent", endpointId: endpoint, actorUserId: actor.userId });
    await expect(service.install(endpoint, actor)).rejects.toMatchObject({ code: "slack_install_recovery_pending" });
    expect(await slackInstallRecovery(company, endpoint).read()).toEqual(retained); expect(fixture.store.db.transaction).not.toHaveBeenCalled(); expect(fixture.managerToken).not.toHaveBeenCalled();
  });
  it("does not overwrite saved SQL state after its commit response is lost", async () => {
    save.mockImplementationOnce(async () => {
      row.status = "credentials_saved";
      throw new Error("fixture lost SQL commit response");
    });
    await service.complete(state, "fixture-code", null, actor);
    expect(row.status).toBe("credentials_saved");
    expect(fixture.store.setFailure).not.toHaveBeenCalled();
    expect(fixture.store.audit).toHaveBeenCalledWith(expect.anything(), actor, "installation_uncertain", expect.any(String));
    expect((await slackInstallRecovery(company, endpoint).read())?.kind).toBe("slack-install-result");
    await expect(service.install(endpoint, actor)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
  it("does not create provider intent or submit for explicit authorization decline", async () => {
    fixture.expectIntent = false;
    await service.complete(state, null, "access_denied", actor);
    expect(events).toEqual(["claim"]);
    expect(request).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(await slackInstallRecovery(company, endpoint).read()).toBeNull();
  });
  it("keeps acknowledged credential save distinct from failed result cleanup", async () => {
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("fixture cleanup unlink failure"));
    await expect(service.complete(state, "fixture-code", null, actor)).rejects.toThrow("cleanup unlink failure");
    expect(save).toHaveBeenCalledOnce();
    expect(fixture.store.setFailure).not.toHaveBeenCalled();
    expect((await slackInstallRecovery(company, endpoint).read())?.kind).toBe("slack-install-result");
    await expect(service.install(endpoint, actor)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
  it("does not claim SQL state or submit after prospective journal publication fails", async () => {
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("fixture intent publication failure"));
    await expect(service.complete(state, "fixture-code", null, actor)).rejects.toThrow("intent publication failure");
    expect(events).toEqual([]);
    expect(claimed).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await expect(service.complete(state, "fixture-code", null, actor)).rejects.toThrow();
    expect(claimed).toBe(false);
  });
  it("retains transport uncertainty and refuses fresh install or callback replay", async () => {
    request.mockRejectedValueOnce(new Error("fixture transport uncertainty"));
    await service.complete(state, "fixture-code", null, actor);
    expect((await slackInstallRecovery(company, endpoint).read())?.kind).toBe("slack-install-intent");
    expect(save).not.toHaveBeenCalled();
    const retained = await slackInstallRecovery(company, endpoint).read(), deletions = fixture.store.db.delete.mock.calls.length;
    await expect(service.install(endpoint, actor)).rejects.toMatchObject({ code: "slack_install_recovery_pending" });
    await expect(service.complete(state, "fixture-code", null, actor)).rejects.toMatchObject({ status: 403 });
    expect(request).toHaveBeenCalledOnce(); expect(fixture.store.db.transaction).not.toHaveBeenCalled(); expect(fixture.store.db.delete).toHaveBeenCalledTimes(deletions);
    expect(await slackInstallRecovery(company, endpoint).read()).toEqual(retained);
  });
  for (const failure of ["invalid-json", "invalid-utf8", "http-status", "identity", "save", "journal"] as const) {
    it(`retains exact ${failure} outcome instead of losing issued credential authority`, async () => {
      let body = JSON.stringify(success);
      let status = 200;
      if (failure === "invalid-json") body = "{incomplete-provider-json";
      if (failure === "http-status") { status = 500; body = JSON.stringify({ ok: false, error: "fixture-error", access_token: "fixture-unknown-token" }); }
      if (failure === "identity") body = JSON.stringify({ ...success, app_id: "A999" });
      const bytes = failure === "invalid-utf8" ? Buffer.from([0xff, 0xfe]) : Buffer.from(body);
      request.mockImplementationOnce(async () => new Response(bytes, { status, headers: { "x-fixture": "retained" } }));
      if (failure === "save") save.mockRejectedValueOnce(new Error("fixture SQL save uncertainty"));
      if (failure === "journal") fixture.failResult = true;
      await service.complete(state, "fixture-code", null, actor);
      const retained = await slackInstallRecovery(company, endpoint).read();
      expect(retained?.kind).toBe(failure === "journal" ? "slack-install-intent" : "slack-install-result");
      if (retained?.kind === "slack-install-result") {
        expect(retained.raw.status).toBe(status);
        expect(retained.raw.headers["x-fixture"]).toBe("retained");
        expect(retained.raw.bodyBase64).toBe(bytes.toString("base64"));
      }
      expect(save).toHaveBeenCalledTimes(failure === "save" ? 1 : 0);
      fixture.failResult = false;
      await expect(service.install(endpoint, actor)).rejects.toThrow();
      await expect(service.complete(state, "fixture-code", null, actor)).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    });
  }
  it("retains a lost SQL acknowledgement for inspection without inferring a committed outcome", async () => {
    const commit = save.getMockImplementation()!;
    save.mockImplementationOnce(async (...args) => { await commit(...args); throw new Error("fixture lost SQL acknowledgement"); });
    await service.complete(state, "fixture-code", null, actor);
    const retained = await slackInstallRecovery(company, endpoint).read();
    expect(retained?.kind).toBe("slack-install-result");
    expect(save).toHaveBeenCalledOnce();
    await expect(service.resume(endpoint, { ...actor, sessionId: "new-authorized-session" })).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(row.status).toBe("credentials_saved");
    expect(await slackInstallRecovery(company, endpoint).read()).toEqual(retained);
    expect(resumeProvider).not.toHaveBeenCalled();
  });
  it("saves a retained result after SQL rollback on resume without OAuth replay", async () => {
    save.mockRejectedValueOnce(new Error("fixture SQL rollback"));
    await service.complete(state, "fixture-code", null, actor);
    expect(row.status).toBe("install");
    expect((await slackInstallRecovery(company, endpoint).read())?.kind).toBe("slack-install-result");
    await service.resume(endpoint, actor);
    expect(row.status).toBe("credentials_saved");
    expect(save).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledOnce();
    expect(await slackInstallRecovery(company, endpoint).read()).toBeNull();
    expect(resumeProvider).toHaveBeenCalledOnce();
  });
  for (const mismatch of ["actor", "request", "reference", "client-value", "workspace", "same-value-version"] as const) {
    it(`retains result without provider effects on resume ${mismatch} mismatch`, async () => {
      save.mockRejectedValueOnce(new Error("fixture SQL rollback"));
      await service.complete(state, "fixture-code", null, actor);
      const retained = await slackInstallRecovery(company, endpoint).read();
      if (mismatch === "request") row.requestId = "00000000-0000-4000-8000-000000000007";
      if (mismatch === "reference") row.secretIds.clientSecret = "00000000-0000-4000-8000-000000000008";
      if (mismatch === "client-value") credentials[secret] = "fixture-changed-client";
      if (mismatch === "workspace") row.workspaceId = "T999";
      if (mismatch === "same-value-version") identityRevision++;
      await expect(service.resume(endpoint, mismatch === "actor" ? { ...actor, userId: "other-actor" } : actor)).rejects.toThrow();
      expect(save).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledOnce();
      expect(resumeProvider).not.toHaveBeenCalled();
      expect(await slackInstallRecovery(company, endpoint).read()).toEqual(retained);
    });
  }
  it("does not resume provider work or save credentials while original intent is unresolved", async () => {
    request.mockRejectedValueOnce(new Error("fixture transport uncertainty"));
    await service.complete(state, "fixture-code", null, actor);
    await expect(service.resume(endpoint, actor)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(resumeProvider).not.toHaveBeenCalled();
    expect((await slackInstallRecovery(company, endpoint).read())?.kind).toBe("slack-install-intent");
  });
  for (const retainedKind of ["intent", "result"] as const) {
    it(`refuses valid callback retry before manager token work with retained ${retainedKind}`, async () => {
      if (retainedKind === "intent") request.mockRejectedValueOnce(new Error("fixture uncertain exchange"));
      else save.mockRejectedValueOnce(new Error("fixture SQL rollback"));
      await service.complete(state, "fixture-code", null, actor);
      const retained = await slackInstallRecovery(company, endpoint).read();
      claimed = false; // Valid, unconsumed SQL state must not bypass independent occupancy.
      row.managerGrantId = "00000000-0000-4000-8000-000000000010";
      await expect(service.complete(state, "fixture-code", null, actor)).rejects.toThrow();
      expect(fixture.managerToken).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledOnce();
      expect(await slackInstallRecovery(company, endpoint).read()).toEqual(retained);
    });
  }
  it.each(["message", "cleanup", "claim", "revoke"])("refuses retained %s before OAuth state mutation or callback submission", async family => {
    fixture.hold = family;
    await expect(service.install(endpoint, actor)).rejects.toThrow(`retained ${family}`);
    await expect(service.complete(state, "fixture-code", null, actor)).rejects.toThrow(`retained ${family}`);
    expect(claimed).toBe(false); expect(events).toEqual([]); expect(request).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    expect(fixture.managerToken).not.toHaveBeenCalled();
  });
  it("inspects pending binding without refreshing manager credentials", async () => {
    row.managerGrantId = "00000000-0000-4000-8000-000000000010";
    await service.pending(state, actor);
    expect(fixture.managerToken).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(claimed).toBe(false);
  });
  it("refuses expired-state cleanup while exact exchange remains occupied", async () => {
    request.mockRejectedValueOnce(new Error("fixture transport uncertainty"));
    await service.complete(state, "fixture-code", null, actor);
    claimed = false; attempt.expiresAt = new Date(Date.now() - 1);
    const retained = await slackInstallRecovery(company, endpoint).read(), deletions = fixture.store.db.delete.mock.calls.length;
    await expect(service.expiredReturn(state, actor)).rejects.toMatchObject({ code: "slack_install_recovery_pending" });
    expect(request).toHaveBeenCalledOnce(); expect(claimed).toBe(false);
    expect(fixture.store.db.delete).toHaveBeenCalledTimes(deletions); expect(fixture.store.db.transaction).not.toHaveBeenCalled();
    expect(fixture.store.db.insert).not.toHaveBeenCalled(); expect(fixture.store.db.update).not.toHaveBeenCalled();
    expect(await slackInstallRecovery(company, endpoint).read()).toEqual(retained);
  });
  it("releases the real company lock before joining an admitted callback while retaining the endpoint lease", async () => {
    fixture.realLocks = true;
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-codex-local/server")>("@paperclipai/adapter-codex-local/server");
    let beginCallback!: () => void;
    const callbackMayAcquire = new Promise<void>(resolve => { beginCallback = resolve; });
    let leaseHeld = false, callbackAcquired = false, abandonJoin!: () => void;
    const joinMayFinish = new Promise<void>(resolve => { abandonJoin = resolve; });
    // This task is admitted BEFORE complete enters the real lock's ALS scope.
    // It cannot use originating reentrancy to conceal a lock/shutdown deadlock.
    const admittedCallback = callbackMayAcquire.then(() => actual.withAccountHomeSecretMutationLock(undefined, company, async () => {
      expect(leaseHeld).toBe(true);
      callbackAcquired = true;
      events.push("callback-settled");
    }));
    fixture.resume.mockImplementationOnce(async () => {
      expect(leaseHeld).toBe(true);
      expect(await slackInstallRecovery(company, endpoint).read()).toBeNull();
      beginCallback();
      // Models the actual shutdown join, not an immediately successful stub.
      await Promise.race([admittedCallback, joinMayFinish]);
      expect(callbackAcquired).toBe(true);
    });
    const priorHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = fixture.root;
    let operation: Promise<unknown> | undefined;
    try {
      const selected = slackChatRegistrationService(fixture.store.db, { withLock: async (_id: string, action: any) => {
        leaseHeld = true;
        try { return await action({ assertOwned: async () => { expect(leaseHeld).toBe(true); } }); }
        finally { leaseHeld = false; }
      } } as never);
      operation = selected.complete(state, "fixture-code", null, actor);
      void operation.catch(() => undefined);
      await vi.waitFor(() => expect(callbackAcquired).toBe(true), { timeout: 3000 });
      await expect(operation).resolves.toBe(endpoint);
      expect(callbackAcquired).toBe(true); expect(leaseHeld).toBe(false);
      expect(events).toEqual(["claim", "fetch", "save", "callback-settled"]);
    } finally {
      abandonJoin(); beginCallback(); await Promise.allSettled([operation, admittedCallback]);
      if (priorHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = priorHome;
    }
  });

});
