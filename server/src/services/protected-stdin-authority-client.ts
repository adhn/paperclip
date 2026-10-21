import { createHash } from "node:crypto";
import { request } from "node:https";
import type { ClientRequest } from "node:http";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { ProtectedEnvelope, ProtectedStdinVerification } from "./protected-execution-journal.js";

/** Explicit host transport to an independent current physical/history authority.
 * This implements authentication/transport, never the authority's physical facts.
 * No caller, listener, installer, ambient credentials, discovery or fallback.
 * Missing/unavailable authority remains held; a reply is also cryptographically
 * verified by the native transaction before its durable ticket can be committed.
 */
export function protectedStdinAuthorityClient(options: {
  origin: string; ca: Buffer; certificate: Buffer; key: Buffer;
  authorityFingerprint: string; deadlineMs?: number;
}): { verifyAndPin(value: ProtectedStdinVerification): Promise<ProtectedEnvelope> } {
  let origin: URL;
  try { origin = new URL(options.origin); } catch { throw Error("protected_stdin_authority_origin_required"); }
  const host = origin.hostname.replace(/^\[|\]$/g, "");
  if (origin.protocol !== "https:" || !isIP(host) || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash || !/^[a-f0-9]{64}$/.test(options.authorityFingerprint))
    throw Error("protected_stdin_authority_origin_required");
  const deadlineMs = options.deadlineMs ?? 3000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5000 ||
      [options.ca, options.certificate, options.key].some(value => !Buffer.isBuffer(value) || !value.length))
    throw Error("protected_stdin_authority_configuration_required");
  const ca = Buffer.from(options.ca), cert = Buffer.from(options.certificate), key = Buffer.from(options.key);
  const expectedFingerprint = options.authorityFingerprint;
  return {
    async verifyAndPin(value) {
      let raw: Buffer;
      try {
        const snapshot = structuredClone(value);
        if (snapshot.version !== 1 || !["consumeStdin", "claimStreamTicket"].includes(snapshot.operation) ||
            typeof snapshot.challenge !== "string" || !snapshot.challenge ||
            !/^[a-f0-9]{64}$/.test(snapshot.requestHash) || !/^[a-f0-9]{64}$/.test(snapshot.bindingHash))
          throw Error();
        raw = Buffer.from(JSON.stringify(snapshot));
        if (raw.length > 16384) throw Error();
      } catch { throw Error("protected_stdin_authority_request_invalid"); }
      return new Promise<ProtectedEnvelope>((resolve, reject) => {
        let settled = false;
        let req: ClientRequest | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const fail = () => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          reject(Error("protected_stdin_authority_uncertain"));
          req?.destroy();
        };
        try {
        req = request({ hostname: host, port: origin.port || 443,
          method: "POST", path: "/v1/stdin/verify-and-pin", agent: false,
          ca, cert, key, rejectUnauthorized: true, minVersion: "TLSv1.2",
          checkServerIdentity: (hostname, peer) => {
            const error = checkServerIdentity(hostname, peer);
            if (error) return error;
            if (!peer.raw || createHash("sha256").update(peer.raw).digest("hex") !== expectedFingerprint)
              return Error("protected_stdin_authority_peer_mismatch");
            return undefined;
          }, headers: { "Content-Type": "application/json", "Content-Length": raw.length } }, response => {
          if (response.statusCode !== 200 || response.headers["content-type"] !== "application/json") { fail(); return; }
          const chunks: Buffer[] = []; let bytes = 0;
          response.on("error", fail);
          response.on("aborted", fail);
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 16384) { fail(); return; }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (settled) return;
            try {
              const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProtectedEnvelope;
              if (!result || typeof result !== "object" || Array.isArray(result) ||
                  Object.keys(result).sort().join(",") !== "body,mac" || !result.body ||
                  typeof result.body !== "object" || Array.isArray(result.body) ||
                  typeof result.mac !== "string" || !/^[a-f0-9]{64}$/.test(result.mac)) throw Error();
              settled = true; clearTimeout(timer); resolve(result);
            } catch { fail(); }
          });
        });
        // This is a total elapsed-time deadline, including TCP/TLS/headers/body.
        timer = setTimeout(fail, deadlineMs);
        req.on("error", fail);
        req.end(raw);
        } catch { fail(); }
      });
    },
  };
}
