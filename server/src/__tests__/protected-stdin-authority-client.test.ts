import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectedStdinAuthorityClient } from "../services/protected-stdin-authority-client.js";
import type { ProtectedStdinVerification } from "../services/protected-execution-journal.js";

describe("independent stdin authority transport, synthetic authority only", () => {
  let directory: string;
  let ca: Buffer, certificate: Buffer, key: Buffer, peer: Buffer, peerKey: Buffer;
  let fingerprint: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "pc-stdin-mtls-"));
    const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1",
      "-subj", "/CN=disposable-ca", "-keyout", "ca.key", "-out", "ca.crt", "-addext", "basicConstraints=critical,CA:TRUE");
    for (const role of ["server", "client"]) {
      openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
        "-subj", `/CN=synthetic-${role}`, "-keyout", `${role}.key`, "-out", `${role}.csr`);
      writeFileSync(join(directory, `${role}.ext`), role === "server" ? "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" : "extendedKeyUsage=clientAuth\n");
      openssl("x509", "-req", "-in", `${role}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
        "-days", "1", "-extfile", `${role}.ext`, "-out", `${role}.crt`);
    }
    const read = (path: string) => readFileSync(join(directory, path));
    ca = read("ca.crt"); certificate = read("client.crt"); key = read("client.key");
    peer = read("server.crt"); peerKey = read("server.key");
    fingerprint = new X509Certificate(peer).fingerprint256.replaceAll(":", "").toLowerCase();
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  const value = () => ({ version: 1, operation: "consumeStdin", operationId: "original-operation",
    challenge: "fresh-challenge", requestHash: "a".repeat(64), bindingHash: "b".repeat(64), binding: {},
    pins: { instance: "original", pool: "codex", policy: "original-policy", epoch: "held",
      authorityIncarnation: "authority", historyDomain: "external", historyIncarnation: "current", historyFloor: 1 },
  } satisfies ProtectedStdinVerification);
  async function fixture(handler: Parameters<typeof createServer>[1], run: (origin: string, server: Server) => Promise<void>) {
    const server = createServer({ key: peerKey, cert: peer, ca, requestCert: true, rejectUnauthorized: true }, handler);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("test_address");
      await run(`https://127.0.0.1:${address.port}`, server);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
  it("uses actual mutual TLS and fixed operation; returns no physical acceptance", async () => {
    let calls = 0;
    await fixture((request, response) => {
      calls++; expect(request.method).toBe("POST"); expect(request.url).toBe("/v1/stdin/verify-and-pin");
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(value());
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ body: { synthetic: true }, mac: "a".repeat(64) }));
      });
    }, async origin => {
      const client = protectedStdinAuthorityClient({ origin, ca, certificate, key, authorityFingerprint: fingerprint });
      expect(await client.verifyAndPin(value())).toEqual({ body: { synthetic: true }, mac: "a".repeat(64) });
    });
    expect(calls).toBe(1);
  });
  it("rejects a different peer pin before HTTP effects", async () => {
    let calls = 0;
    await fixture((_request, response) => { calls++; response.end(); }, async origin => {
      const client = protectedStdinAuthorityClient({ origin, ca, certificate, key, authorityFingerprint: "0".repeat(64) });
      await expect(client.verifyAndPin(value())).rejects.toThrow("protected_stdin_authority_uncertain");
    });
    expect(calls).toBe(0);
  });
  it("holds a dropped response without retry", async () => {
    let calls = 0;
    await fixture((request) => { calls++; request.socket.destroy(); }, async origin => {
      const client = protectedStdinAuthorityClient({ origin, ca, certificate, key, authorityFingerprint: fingerprint });
      await expect(client.verifyAndPin(value())).rejects.toThrow("protected_stdin_authority_uncertain");
    });
    expect(calls).toBe(1);
  });
  it("applies a total deadline to an unanswered peer", async () => {
    await fixture(() => {}, async origin => {
      const client = protectedStdinAuthorityClient({ origin, ca, certificate, key, authorityFingerprint: fingerprint, deadlineMs: 50 });
      await expect(client.verifyAndPin(value())).rejects.toThrow("protected_stdin_authority_uncertain");
    });
  });
  it.each([302, 403])("refuses HTTP %s without following or retrying", async status => {
    let calls = 0;
    await fixture((_request, response) => { calls++; response.writeHead(status, { Location: "/other" }); response.end(); }, async origin => {
      await expect(protectedStdinAuthorityClient({ origin, ca, certificate, key, authorityFingerprint: fingerprint })
        .verifyAndPin(value())).rejects.toThrow("protected_stdin_authority_uncertain");
    });
    expect(calls).toBe(1);
  });
  it.each([["invalid", "secret-peer-data"], ["oversized", "x".repeat(16385)]])("redacts %s response", async (_label, raw) => {
    await fixture((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(raw); }, async origin => {
      await expect(protectedStdinAuthorityClient({ origin, ca, certificate, key, authorityFingerprint: fingerprint })
        .verifyAndPin(value())).rejects.toThrow(/^protected_stdin_authority_uncertain$/);
    });
  });
  it("refuses DNS, HTTP, URL credentials and unbounded deadlines", () => {
    for (const origin of ["https://ambient.example", "http://127.0.0.1", "https://secret@127.0.0.1", "https://127.0.0.1/path"])
      expect(() => protectedStdinAuthorityClient({ origin, ca, certificate, key, authorityFingerprint: fingerprint })).toThrow();
    expect(() => protectedStdinAuthorityClient({ origin: "https://127.0.0.1", ca, certificate, key,
      authorityFingerprint: fingerprint, deadlineMs: 10000 })).toThrow();
  });
});
