import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ root: "", failResult: false }));
vi.mock("./idle-local-work.js", () => ({ idleQuotaRecoveryPath: () => settings.root }));
// Reversible fixture encoding only; no real master key or provider credentials.
vi.mock("../secrets/local-encrypted-provider.js", () => ({ localEncryptedProvider: {
  createVersion: async ({ value }: { value: string }) => {
    if (settings.failResult && JSON.parse(value).kind === "exchange-result") throw new Error("injected result journal failure");
    return { material: { fixture: Buffer.from(value).toString("base64") } };
  },
  resolveVersion: async ({ material }: { material: { fixture: string } }) => Buffer.from(material.fixture, "base64").toString(),
} }));
import { exchangeQuotaCredential } from "./quota-credential-exchange.js";
import { quotaCredentialRecovery, quotaCredentialRecoveryPath, isQuotaExchangeIntent, type QuotaExchangeIntent } from "./quota-credential-recovery.js";

const identity = {
  companyId: "00000000-0000-4000-8000-000000000001",
  grantId: "00000000-0000-4000-8000-000000000002",
  connectionId: "00000000-0000-4000-8000-000000000003",
  secretId: "00000000-0000-4000-8000-000000000004",
};
const originalOwnerIdentity = {
  connection: { id: identity.connectionId, companyId: identity.companyId, provider: "codex", status: "active", authConfig: { mode: "oauth" } },
  grant: { id: identity.grantId, companyId: identity.companyId, connectionId: identity.connectionId, status: "active", credentialSecretId: identity.secretId, scopes: ["quota:read"] },
};
const originalSecretIdentity = {
  secretId: identity.secretId, versionId: "00000000-0000-4000-8000-000000000006", version: 3,
  authority: { parent: { provider: "local_encrypted", latestVersion: 3 },
    version: { material: { ciphertext: "original-fixture", scheme: "fixture" } }, definition: null, providerConfig: null },
};
const current = JSON.stringify({ tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh" } });
const tokenResponse = () => new Response(JSON.stringify({ access_token: "fixture-new-access", refresh_token: "fixture-new-refresh" }));
function reopen() { return quotaCredentialRecovery(identity.companyId, identity.grantId); }
function input(fetchImpl: typeof fetch, signal = new AbortController().signal) {
  return { ...identity, originalSecretIdentity, originalOwnerIdentity, current, recovery: reopen(), signal, fetchImpl };
}
beforeEach(async () => {
  settings.root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-quota-exchange-"));
  settings.failResult = false;
});
afterEach(async () => {
  vi.restoreAllMocks();
  settings.failResult = false;
  await fs.rm(settings.root, { recursive: true, force: true });
});

describe("prospective single-use quota exchange ownership", () => {
  it("refuses mismatched original owner company/connection before fetch or publication", async () => {
    const request = vi.fn(async () => tokenResponse());
    for (const owner of [
      { ...originalOwnerIdentity, connection: { ...originalOwnerIdentity.connection, companyId: "00000000-0000-4000-8000-000000000099" } },
      { ...originalOwnerIdentity, grant: { ...originalOwnerIdentity.grant, connectionId: "00000000-0000-4000-8000-000000000099" } },
    ]) await expect(exchangeQuotaCredential({ ...input(request as typeof fetch), originalOwnerIdentity: owner })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(await reopen().read()).toBeNull();
  });
  it("publishes exact intent before fetch and retains it in the durable result", async () => {
    let observed: QuotaExchangeIntent | undefined;
    const request = vi.fn(async () => {
      const retained = await reopen().read();
      expect(retained && isQuotaExchangeIntent(retained)).toBe(true);
      observed = retained as QuotaExchangeIntent;
      expect(retained).toMatchObject({ ...identity, schema: 1, kind: "exchange-intent" });
      return tokenResponse();
    });
    const result = await exchangeQuotaCredential(input(request as typeof fetch));
    expect(request).toHaveBeenCalledOnce();
    expect(result.intent).toEqual(observed);
    expect(result.originalSecretIdentity).toEqual(originalSecretIdentity);
    expect(result.originalOwnerIdentity).toEqual(originalOwnerIdentity);
    expect(result.intent.originalOwnerIdentity).toEqual(originalOwnerIdentity);
    expect(result.intent.originalSecretIdentity).toEqual(originalSecretIdentity);
    expect(result.operationId).toBe(observed!.operationId);
    expect(await reopen().read()).toEqual(result);
    expect(JSON.parse(result.value).tokens.refresh_token).toBe("fixture-new-refresh");
  });

  for (const fault of ["transport", "body", "invalid-result", "journal"] as const) {
    it(`retains unresolved intent across ${fault} failure and refuses same/different-operation replay`, async () => {
      if (fault === "journal") settings.failResult = true;
      const request = vi.fn(async () => {
        if (fault === "transport") throw new Error("injected transport failure after submission");
        if (fault === "body") return { ok: true, json: async () => { throw new Error("injected body failure"); } } as Response;
        if (fault === "invalid-result") return new Response(JSON.stringify({ refresh_token: "fixture-next" }));
        return tokenResponse();
      });
      await expect(exchangeQuotaCredential(input(request as typeof fetch))).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
      const retained = await reopen().read();
      expect(retained && isQuotaExchangeIntent(retained)).toBe(true);
      const intent = retained as QuotaExchangeIntent;
      expect(intent.originalSecretIdentity).toEqual(originalSecretIdentity);
      expect(intent.originalOwnerIdentity).toEqual(originalOwnerIdentity);
      settings.failResult = false;
      await expect(reopen().beginExchange(intent)).rejects.toThrow("exchange_pending");
      await expect(reopen().beginExchange({ ...intent, operationId: "00000000-0000-4000-8000-000000000005" })).rejects.toThrow("exchange_pending");
      await expect(exchangeQuotaCredential(input(request as typeof fetch))).rejects.toThrow("exchange_pending");
      expect(request).toHaveBeenCalledOnce();
      await expect(reopen().clear(intent)).rejects.toThrow("exchange_pending");
      await expect(reopen().write({ ...identity, baseHash: intent.baseHash, value: "fixture-legacy" })).rejects.toThrow("exchange_pending");
      expect(await reopen().read()).toEqual(intent);
    });
  }

  it("does not invoke fetch when intent publication fails", async () => {
    const request = vi.fn(async () => tokenResponse());
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("injected intent rename failure"));
    await expect(exchangeQuotaCredential(input(request as typeof fetch))).rejects.toThrow("intent rename failure");
    expect(request).not.toHaveBeenCalled();
    expect(await reopen().read()).toBeNull();
    vi.restoreAllMocks();
    await exchangeQuotaCredential(input(request as typeof fetch));
    expect(request).toHaveBeenCalledOnce();
  });

  it("retains a published intent when publication acknowledgement fails before fetch", async () => {
    const request = vi.fn(async () => tokenResponse());
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      await rename(from, to);
      throw new Error("injected lost publication acknowledgement");
    });
    await expect(exchangeQuotaCredential(input(request as typeof fetch))).rejects.toThrow("lost publication acknowledgement");
    expect(request).not.toHaveBeenCalled();
    expect(isQuotaExchangeIntent((await reopen().read())!)).toBe(true);
    await expect(exchangeQuotaCredential(input(request as typeof fetch))).rejects.toThrow("exchange_pending");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps exact published result after lost result acknowledgement and refuses reexchange", async () => {
    const request = vi.fn(async () => tokenResponse());
    const rename = fs.rename.bind(fs);
    let publications = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (++publications === 2) throw new Error("injected lost result acknowledgement");
    });
    await expect(exchangeQuotaCredential(input(request as typeof fetch))).rejects.toThrow("lost result acknowledgement");
    const result = await reopen().read();
    expect(result).toMatchObject({ kind: "exchange-result", ...identity });
    expect(result && "value" in result && JSON.parse(result.value).tokens.access_token).toBe("fixture-new-access");
    await expect(exchangeQuotaCredential(input(request as typeof fetch))).rejects.toThrow("exchange_pending");
    expect(request).toHaveBeenCalledOnce();
    await expect(reopen().clear()).rejects.toThrow("exchange_pending");
  });

  it("does not publish intent or call fetch when already canceled before exchange", async () => {
    const dashboard = new AbortController();
    dashboard.abort();
    const request = vi.fn(async () => tokenResponse());
    await expect(exchangeQuotaCredential(input(request as typeof fetch, dashboard.signal))).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(await reopen().read()).toBeNull();
  });

  it("refuses submission after caller abort during durable intent publication", async () => {
    const dashboard = new AbortController();
    const request = vi.fn(async () => tokenResponse());
    const recovery = reopen();
    let entered!: () => void;
    let release!: () => void;
    const published = new Promise<void>((resolve) => { entered = resolve; });
    const publicationReturned = new Promise<void>((resolve) => { release = resolve; });
    const delayed = { ...recovery, beginExchange: async (intent: QuotaExchangeIntent) => {
      await recovery.beginExchange(intent);
      entered();
      await publicationReturned;
    } };
    const exchange = exchangeQuotaCredential({ ...input(request as typeof fetch, dashboard.signal), recovery: delayed });
    await published;
    expect(isQuotaExchangeIntent((await reopen().read())!)).toBe(true);
    expect(request).not.toHaveBeenCalled();
    dashboard.abort();
    release();
    await expect(exchange).rejects.toThrow();
    const retained = await reopen().read();
    expect(isQuotaExchangeIntent(retained!)).toBe(true);
    await expect(exchangeQuotaCredential(input(request as typeof fetch))).rejects.toThrow("exchange_pending");
    expect(request).not.toHaveBeenCalled();
    expect(await reopen().read()).toEqual(retained);
  });

  it("rechecks current authority after durable publication and retains intent on refusal", async () => {
    const request = vi.fn().mockResolvedValue(tokenResponse());
    const denied = new Error("current caller denied");
    const beforeDispatch = vi.fn(async () => {
      expect(isQuotaExchangeIntent(await reopen().read())).toBe(true);
      expect(request).not.toHaveBeenCalled();
      throw denied;
    });
    await expect(exchangeQuotaCredential({ ...input(request as typeof fetch), beforeDispatch })).rejects.toBe(denied);
    expect(beforeDispatch).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
    expect(isQuotaExchangeIntent(await reopen().read())).toBe(true);
    await expect(exchangeQuotaCredential(input(request as typeof fetch))).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the exchange request independent of dashboard cancellation after durable intent", async () => {
    const dashboard = new AbortController();
    const request = vi.fn(async (_url: unknown, options?: RequestInit) => {
      dashboard.abort();
      expect(options!.signal).not.toBe(dashboard.signal);
      expect(options!.signal!.aborted).toBe(false);
      return tokenResponse();
    });
    const result = await exchangeQuotaCredential(input(request as typeof fetch, dashboard.signal));
    expect(dashboard.signal.aborted).toBe(true);
    expect(await reopen().read()).toEqual(result);
  });

  it("requires exact result settlement and flushes deletion even on absent-file retry", async () => {
    const result = await exchangeQuotaCredential(input(vi.fn(async () => tokenResponse()) as typeof fetch));
    await expect(reopen().clear()).rejects.toThrow("exchange_pending");
    await expect(reopen().clear({ ...result, value: "stale-result" })).rejects.toThrow("exchange_pending");
    await expect(reopen().write({ ...identity, baseHash: result.baseHash, value: "legacy-overwrite" })).rejects.toThrow("exchange_pending");
    await expect(reopen().completeExchange({ ...result, value: "different-result" })).rejects.toThrow("identity_mismatch");
    expect(await reopen().read()).toEqual(result);
    const directory = path.dirname(quotaCredentialRecoveryPath(identity.companyId, identity.grantId));
    const open = fs.open.bind(fs);
    const flushed = vi.fn();
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]) === directory) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => { flushed(); await sync(); });
      }
      return handle;
    });
    // Schema parsing normalizes caller property order before exact comparison.
    const { value, intent, ...rest } = result;
    await reopen().clear({ value, intent, ...rest });
    expect(await reopen().read()).toBeNull();
    expect(flushed).toHaveBeenCalledTimes(2);
    await reopen().clear(result);
    expect(flushed).toHaveBeenCalledTimes(4);
  });
});
