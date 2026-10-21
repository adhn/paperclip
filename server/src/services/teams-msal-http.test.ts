import { ConsoleLogger } from "chat";
import { inspect } from "node:util";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const packageRoot = process.env.PAPERCLIP_TEST_MSAL_NODE_ROOT ?? path.dirname(require.resolve("@azure/msal-node/package.json"));
type Client = {
  sendGetRequestAsync(url: string, options?: unknown): Promise<unknown>;
  sendPostRequestAsync(url: string, options?: unknown): Promise<unknown>;
};
const { HttpClient } = await import(pathToFileURL(path.join(packageRoot, "dist/network/HttpClient.mjs")).href) as { HttpClient: new () => Client };
const cjs = require(path.join(packageRoot, "lib/msal-node.cjs")) as { ConfidentialClientApplication: new (configuration: unknown) => { config: { system: { networkClient: Client } } } };
const clients = [
  { name: "ESM actual HttpClient", create: () => new HttpClient() },
  { name: "CJS actual selected default HttpClient", create: () => new cjs.ConfidentialClientApplication({ auth: { clientId: "fixture-client-id", clientSecret: "fixture-constructor-only-secret" }, system: { loggerOptions: { loggerCallback: () => {}, piiLoggingEnabled: false } } }).config.system.networkClient },
];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
for (const candidate of clients) describe(candidate.name, () => {
  for (const method of ["GET", "POST"] as const) it.each([307, 308])(`refuses ${method} credential forwarding on redirect %s without retry`, async status => {
    const credential = method === "POST" ? "client_secret=fixture-sensitive-secret&grant_type=client_credentials" : "Bearer fixture-sensitive-token";
    const forwarded: string[] = [];
    // Model fetch's default 307/308 preservation of method and sensitive body.
    // No sockets/provider are used; actual class must explicitly refuse it.
    const request = vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.redirect === "error") throw new TypeError(`redirect ${status} refused`);
      forwarded.push(String(options?.body ?? new Headers(options?.headers).get("authorization")));
      return Response.json({ access_token: "unexpected-redirect-target-result" });
    });
    vi.stubGlobal("fetch", request);
    const client = candidate.create();
    const operation = method === "POST"
      ? client.sendPostRequestAsync("https://login.fixture.invalid/token", { body: credential, headers: { "content-type": "application/x-www-form-urlencoded" } })
      : client.sendGetRequestAsync("https://login.fixture.invalid/metadata", { headers: { authorization: credential } });
    await expect(operation).rejects.toMatchObject({ errorCode: "network_error", errorMessage: expect.stringContaining(`redirect ${status} refused`) });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][1]).toMatchObject({ method, redirect: "error" });
    expect(forwarded).toEqual([]);
  });
  it("never attaches malformed response credential prefixes to parser errors or actual Teams console logs", async () => {
    const marker = "FRESHXYZ";
    const malformed = `${marker}-newly-issued-secret-response-not-json`;
    const parserError = await new Response(malformed).json().catch(error => error);
    // Prove the platform parser itself exposes these unknown response bytes.
    expect(parserError).toBeInstanceOf(SyntaxError);
    expect(parserError.message).toContain(marker);
    const request = vi.fn(async (_url: unknown, _options?: RequestInit) => new Response(malformed));
    vi.stubGlobal("fetch", request);
    const error = await candidate.create().sendPostRequestAsync("https://login.fixture.invalid/token", { body: "client_secret=fixture-original" }).catch(error => error);
    expect(error).toMatchObject({ errorCode: "token_parsing_error", errorMessage: expect.stringContaining("Failed to parse response") });
    const allOwnProperties = Object.fromEntries(Reflect.ownKeys(error).map(key => [String(key), Reflect.get(error, key)]));
    expect(inspect(allOwnProperties, { depth: 20 })).not.toContain(marker);
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    // Same actual ConsoleLogger method and whole-error payload as Teams SDK.
    new ConsoleLogger("info").child("teams").error("Teams API: send failed", { conversationId: "fixture", error });
    expect(output).toHaveBeenCalledOnce();
    expect(inspect(output.mock.calls, { depth: 20 })).not.toContain(marker);
    expect(request).toHaveBeenCalledOnce();
  });
  it("retains ordinary direct successful token response behavior", async () => {
    const request = vi.fn(async (_url: unknown, _options?: RequestInit) => Response.json({ access_token: "fixture-direct-token" }, { headers: { "x-fixture": "exact" } }));
    vi.stubGlobal("fetch", request);
    const result = await candidate.create().sendPostRequestAsync("https://login.fixture.invalid/token", { body: "client_secret=fixture-original" });
    expect(result).toMatchObject({ body: { access_token: "fixture-direct-token" }, status: 200, headers: { "x-fixture": "exact" } });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });
});
