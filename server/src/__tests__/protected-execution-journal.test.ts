import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admissionAttempts, admissionCommands, admissionEpochs, admissionProjects, admissionScheduler, admissionScopes, admissionLegacyHolds, agents, companies,
  createDb, environments, environmentLeases, heartbeatRuns, protectedAuthorityPins, protectedAuthorityRequests, protectedCommandJournals } from "@paperclipai/db";
import { trustedCapacityPolicy, type TrustedCapacityBinding } from "../services/execution-capacity-policy.js";
import { protectedCanonical, protectedCreateEndpoint, protectedExecutionJournal, protectedHash, protectedSign, protectedStdinEndpoint,
  type ProtectedEnvelope, type ProtectedPayload, type ProtectedPolicy, type ProtectedStdinVerification } from "../services/protected-execution-journal.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const requestKey = Buffer.alloc(32, 1), ackKey = Buffer.alloc(32, 2), grantKey = Buffer.alloc(32, 3);
describe("native committed protected execution journal", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let other: ReturnType<typeof createDb>;
  let epoch: string;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("protected-journal-");
    db = createDb(temporary.connectionString); other = createDb(temporary.connectionString);
  }, 120_000);
  afterAll(async () => { await db?.$client.end(); await other?.$client.end(); await temporary?.cleanup(); });
  beforeEach(async () => {
    await db.execute(sql`truncate execution_protected_authority_requests, execution_protected_command_journals, execution_protected_authority_pins,
      execution_admission_legacy_decisions, execution_admission_legacy_holds, execution_admission_restorations, execution_admission_commands,
      execution_admission_runner_epochs, execution_admission_attempts, execution_admission_projects, execution_admission_scopes,
      execution_admission_bootstraps, execution_admission_scheduler, execution_admission_epochs cascade`);
    epoch = randomUUID();
    await db.insert(admissionEpochs).values({ epoch });
    await db.insert(admissionScheduler).values({ epoch, draining: true, pendingLimit: 4 });
  });
  async function fixture(operation = false) {
    const [company] = await db.insert(companies).values({ name: "synthetic", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [env] = await db.insert(environments).values({ name: randomUUID(), driver: "ssh" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "B", adapterType: "codex_local" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running" }).returning();
    const binding: TrustedCapacityBinding = { companyId: company.id, agentId: agent.id, environmentId: env.id, adapterType: "codex_local",
      instance: "original-instance", instanceCapacity: 1, runner: "original-runner", providerAccount: "original-account",
      workspace: "original-workspace", session: "original-session", credential: "original-credential", agentFingerprint: "a".repeat(64),
      environmentFingerprint: "b".repeat(64), workspaceConfigurations: ["c".repeat(64)], runnerCapacity: 1, accountCapacity: 1, fenceRoot: "/fence" };
    const capacity = trustedCapacityPolicy([binding]);
    await db.insert(admissionProjects).values({ companyId: company.id, projectKey: "fixture" });
    const token = randomUUID();
    const [attempt] = await db.insert(admissionAttempts).values({ companyId: company.id, agentId: agent.id, runId: operation ? null : run.id,
      operationKey: operation ? "probe" : null, operationKind: operation ? "probe" : null, projectKey: "fixture", scopes: ["original"],
      state: "starting", ownerEpoch: epoch, token, contract: binding as unknown as Record<string, unknown> }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: company.id, environmentId: env.id, provider: "ssh", status: "active",
      heartbeatRunId: operation ? null : run.id, metadata: { agentId: agent.id, admissionOperationId: operation ? attempt.id : null } }).returning();
    const payload: ProtectedPayload = { command: "python3", args: ["-c", "print('æøå 🧪')"], env: { HOME: "/attempt" }, cwd: "/attempt" };
    const [command] = await db.insert(admissionCommands).values({ attemptId: attempt.id,
      binding: { companyId: company.id, agentId: agent.id, runId: operation ? attempt.id : run.id,
        attemptId: randomUUID(), environmentId: env.id, leaseId: lease.id, invocationId: randomUUID(), epoch },
      fenceRoot: "/fence", commandHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex") }).returning();
    const policy: ProtectedPolicy = { version: 1, instance: "original-instance", pool: "protected-pool", runtimeAuthority: "independent-runtime",
      templates: { codex: { image: "example.invalid/provider@sha256:" + "d".repeat(64), entrypoint: "/fixed-command" } },
      families: [{ runner: binding.runner, account: binding.providerAccount, workspace: binding.workspace, session: binding.session, credential: binding.credential }] };
    const options = { epoch, policy, capacity, requestKey, ackKey, grantKey,
      target: () => ({ storage: "attempt-volume", pvcUid: "exact-volume-uid", pvcName: "attempt-state", image: "example.invalid/provider@sha256:" + "d".repeat(64), template: "codex" }) };
    const service = protectedExecutionJournal(db, options);
    await service.registerHeldPin({ instance: policy.instance, policy: protectedHash(policy), pool: policy.pool, incarnation: "ledger-incarnation" });
    return { company, agent, run, attempt, lease, command, payload, policy, options, service,
      owner: { companyId: company.id, attemptId: attempt.id, token } };
  }
  async function acknowledge(f: Awaited<ReturnType<typeof fixture>>) {
    const sent = await f.service.epochRequest(0);
    // Independent synthetic endpoint key; database pin change only via verifier.
    const body = { requestHash: protectedHash(sent.body), nonce: sent.body.nonce, instance: f.policy.instance, policy: protectedHash(f.policy),
      pool: f.policy.pool, incarnation: "ledger-incarnation", generation: 1, epoch, ledgerWatermark: { sequence: 2, hash: "e".repeat(64) }, result: { status: "acknowledged" } };
    const reply = { body, mac: protectedSign(ackKey, "ack", body) };
    await f.service.acceptAck(reply);
    await db.update(admissionScheduler).set({ draining: false });
    return { sent, reply };
  }
  async function createFixture(operation = false) {
    const f = await fixture(operation); await acknowledge(f);
    const resolved = f.options.capacity.forCleanup(f.attempt.contract);
    await db.update(admissionAttempts).set({ scopes: resolved.scopes.map(s => s.key) }).where(eq(admissionAttempts.id, f.attempt.id));
    await db.insert(admissionScopes).values(resolved.scopes);
    let storageCurrent = true;
    const options = { ...f.options, createAuthority: { cluster: "cluster-original", namespaceUid: "namespace-original",
      webhook: "authenticated-webhook", namespace: "disposable-only", attestStorage: async () => storageCurrent } };
    const service = protectedExecutionJournal(db, options);
    const prepared = await service.prepareCommand(f.owner, f.command.id, f.payload);
    const { journalGrant, ...contract } = prepared.contract;
    const review = { version: 1 as const, cluster: "cluster-original", namespaceUid: "namespace-original", webhook: "authenticated-webhook",
      reviewUid: randomUUID(), podUid: randomUUID(), namespace: "disposable-only", name: "exact-pod", objectHash: "a".repeat(64),
      contract, target: f.options.target() };
    return { ...f, service, options, review, prepared, setStorage: (current: boolean) => { storageCurrent = current; } };
  }
  async function writerFixture(operation = false, consume = true) {
    const f = await createFixture(operation);
    if (consume) await f.service.consumePodCreate(f.review, "authenticated-webhook");
    const physical = { pool: f.policy.pool, uid: f.review.podUid, container: "original-container", node: "original-node", storage: f.review.target.storage };
    const body = { requestHash: protectedHash(f.prepared.request.body), nonce: f.prepared.request.body.nonce,
      instance: f.policy.instance, policy: protectedHash(f.policy), pool: f.policy.pool, incarnation: "ledger-incarnation", epoch,
      generation: 1, ledgerWatermark: { sequence: 3, hash: "f".repeat(64) }, result: { status: "started", physical, observation: null } };
    const ack = { body, mac: protectedSign(ackKey, "ack", body) };
    await f.service.acceptAck(ack);
    const value = { owner: f.owner, commandId: f.command.id, invocation: f.command.binding.invocationId,
      physical, ackNonce: body.nonce };
    return { ...f, value, ack };
  }
  async function stdinFixture(operation = false) {
    const f = await writerFixture(operation);
    const verificationKey = Buffer.alloc(32, 4);
    let revision = 42;
    const consumedIntents = new Set<string>();
    // Synthetic authority verifies native transactional contracts only. It does
    // not establish real runtime/storage authority or deployment acceptance.
    const authority = { gatewayIdentity: "gateway-original", streamIdentity: "stream-original", historyDomain: "independent-history",
      historyIncarnation: "history-original", historyFloor: 42, verificationKey,
      verifyAndPin: async (sent: ProtectedStdinVerification): Promise<ProtectedEnvelope> => {
        if (consumedIntents.has(sent.operationId)) throw Error("synthetic_external_intent_already_consumed");
        consumedIntents.add(sent.operationId);
        const body = { version: 1, operationId: sent.operationId, challenge: sent.challenge, requestHash: sent.requestHash,
          bindingHash: sent.bindingHash, pins: sent.pins, historyRevision: ++revision, runtimeStartHash: "a".repeat(64),
          storageHash: "b".repeat(64), historyHash: "c".repeat(64), expires: Date.now() + 20_000 };
        return { body, mac: protectedSign(verificationKey, "protected-stdin-current-v1", body) };
      } };
    const service = protectedExecutionJournal(db, { ...f.options, stdinAuthority: authority });
    const claim = await service.claimStdin(f.value);
    const pins = { instance: f.policy.instance, pool: f.policy.pool, policy: protectedHash(f.policy), epoch,
      authorityIncarnation: "ledger-incarnation", historyDomain: authority.historyDomain,
      historyIncarnation: authority.historyIncarnation, historyFloor: authority.historyFloor };
    const attach = { version: 1, pins, attach: { commandId: f.command.id, invocation: f.value.invocation,
      physical: f.value.physical, stdin: "exclusive", claim } };
    return { ...f, service, authority, attach, claim };
  }
  it.each([false, true])("durably consumes original run/operation claim and exact stream once: %s", async operation => {
    const f = await stdinFixture(operation);
    const receipt = await f.service.consumeStdin(f.attach, "gateway-original");
    expect(receipt).toMatchObject({ version: 1, status: "committed", requestHash: protectedHash(f.attach), pins: f.attach.pins,
      claim: f.claim, historyRevision: 43 });
    const restarted = protectedExecutionJournal(other, { ...f.options, stdinAuthority: f.authority });
    await expect(restarted.consumeStdin(f.attach, "gateway-original")).rejects.toThrow("already_consumed");
    const stream = { version: 1, receipt, attach: f.attach, streamIncarnation: "stream-incarnation-original" };
    const result = await restarted.claimStreamTicket(stream, "stream-original");
    expect(result).toMatchObject({ version: 1, status: "committed", receiptHash: protectedHash(receipt), attachHash: protectedHash(f.attach),
      streamIncarnation: stream.streamIncarnation, physical: f.value.physical, claim: f.claim, pins: f.attach.pins, historyRevision: 44 });
    await expect(f.service.claimStreamTicket({ ...stream, streamIncarnation: "replacement" }, "stream-original")).rejects.toThrow("already_claimed");
    expect(await f.service.inspectStdinTicket({ ticket: receipt.ticket, requestHash: receipt.requestHash }, "gateway-original"))
      .toMatchObject({ status: "stream-claimed", receipt, streamConsumption: result });
    const rows = (await other.select().from(protectedAuthorityRequests)).filter(row => ["consumeStdin", "claimStreamTicket"].includes(String(row.request.op)));
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.receipt === null && row.expiresAt.getUTCFullYear() === 9999)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(f.owner.token);
  });
  it("serializes competing gateway consumptions and stream ticket claims across DB clients", async () => {
    const f = await stdinFixture();
    const second = protectedExecutionJournal(other, { ...f.options, stdinAuthority: f.authority });
    const results = await Promise.allSettled([f.service.consumeStdin(f.attach, "gateway-original"), second.consumeStdin(f.attach, "gateway-original")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const receipt = (results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof f.service.consumeStdin>>>).value;
    const value = { version: 1, receipt, attach: f.attach, streamIncarnation: "original-stream" };
    const claims = await Promise.allSettled([f.service.claimStreamTicket(value, "stream-original"), second.claimStreamTicket(value, "stream-original")]);
    expect(claims.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it.each(["consume", "stream"])("retains external intent occupancy after simulated native %s history rollback", async stage => {
    const f = await stdinFixture();
    const receipt = await f.service.consumeStdin(f.attach, "gateway-original");
    const request = { version: 1, receipt, attach: f.attach, streamIncarnation: "original-stream" };
    const use = stage === "stream" ? await f.service.claimStreamTicket(request, "stream-original") : null;
    // Disposable privileged offline-snapshot simulation ONLY. Production history
    // triggers remain immutable; this transaction-local fixture bypass models
    // restoring an old snapshot while independent intent memory stays current.
    // It proves neither a supported mutation API nor actual backup restoration.
    await db.transaction(async tx => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.delete(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.nonce, use ? use.consumptionId : receipt.ticket));
    });
    const restarted = protectedExecutionJournal(other, { ...f.options, stdinAuthority: f.authority });
    await expect(stage === "stream" ? restarted.claimStreamTicket(request, "stream-original") : restarted.consumeStdin(f.attach, "gateway-original"))
      .rejects.toThrow("external_intent_already_consumed");
    expect((await db.select().from(protectedAuthorityRequests)).filter(row => row.request.op === (stage === "stream" ? "claimStreamTicket" : "consumeStdin"))).toHaveLength(0);
  });
  it.each(["missing", "role", "pins", "claim", "physical", "cancel", "drain", "scope", "lease", "token", "proof", "challenge", "history"])("fails closed before durable ticket on %s", async failure => {
    const f = await stdinFixture();
    const value = structuredClone(f.attach);
    let peer = "gateway-original";
    let service = f.service;
    if (failure === "missing") service = protectedExecutionJournal(db, f.options);
    if (failure === "role") peer = "stream-original";
    if (failure === "pins") value.pins.historyIncarnation = "replacement-history";
    if (failure === "claim") value.attach.claim.bindingHash = "f".repeat(64);
    if (failure === "physical") value.attach.physical.uid = randomUUID();
    if (failure === "cancel") await db.update(heartbeatRuns).set({ resultJson: { cancellation: { source: "operator", expected: true, initiator: { type: "user" }, recordedAt: new Date().toISOString(), reason: "fixture" } } }).where(eq(heartbeatRuns.id, f.run.id));
    if (failure === "drain") await db.update(admissionScheduler).set({ draining: true });
    if (failure === "scope") await db.update(admissionScopes).set({ draining: true });
    if (failure === "lease") await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, f.lease.id));
    if (failure === "token") await db.update(admissionAttempts).set({ token: null }).where(eq(admissionAttempts.id, f.attempt.id));
    if (["proof", "challenge", "history"].includes(failure)) {
      const verify = f.authority.verifyAndPin;
      service = protectedExecutionJournal(db, { ...f.options, stdinAuthority: { ...f.authority, verifyAndPin: async sent => {
        const proof = await verify(sent);
        if (failure === "proof") proof.mac = "0".repeat(64);
        if (failure === "challenge") proof.body.challenge = randomUUID();
        if (failure === "history") proof.body.historyRevision = 41;
        if (failure !== "proof") proof.mac = protectedSign(f.authority.verificationKey, "protected-stdin-current-v1", proof.body);
        return proof;
      } } });
    }
    await expect(service.consumeStdin(value, peer)).rejects.toThrow();
    expect((await db.select().from(protectedAuthorityRequests)).filter(row => row.request.op === "consumeStdin")).toHaveLength(0);
  });
  it("refuses changed/cancelled stream claims and inspects committed ownership without replay", async () => {
    const f = await stdinFixture();
    const receipt = await f.service.consumeStdin(f.attach, "gateway-original");
    const request = { version: 1, receipt, attach: f.attach, streamIncarnation: "original-stream" };
    await expect(f.service.claimStreamTicket(request, "gateway-original")).rejects.toThrow("peer_refused");
    await expect(f.service.claimStreamTicket({ ...request, receipt: { ...receipt, historyRevision: 999 } }, "stream-original")).rejects.toThrow("binding_mismatch");
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(f.service.claimStreamTicket(request, "stream-original")).rejects.toThrow();
    expect(await f.service.inspectStdinTicket({ ticket: receipt.ticket, requestHash: receipt.requestHash }, "stream-original"))
      .toMatchObject({ status: "consumed", receipt, streamConsumption: null });
    expect((await db.select().from(protectedAuthorityRequests)).filter(row => row.request.op === "claimStreamTicket")).toHaveLength(0);
  });
  it.each(["history", "binding", "expired", "storage", "challenge"])("retains original ticket when stream authority has %s failure", async failure => {
    const f = await stdinFixture();
    const receipt = await f.service.consumeStdin(f.attach, "gateway-original");
    const verify = f.authority.verifyAndPin;
    const service = protectedExecutionJournal(other, { ...f.options, stdinAuthority: { ...f.authority, verifyAndPin: async sent => {
      const proof = await verify(sent);
      if (failure === "history") proof.body.historyRevision = receipt.historyRevision;
      if (failure === "binding") proof.body.bindingHash = "f".repeat(64);
      if (failure === "expired") proof.body.expires = Date.now() - 1;
      if (failure === "storage") proof.body.storageHash = "fixture-string";
      if (failure === "challenge") proof.body.challenge = randomUUID();
      proof.mac = protectedSign(f.authority.verificationKey, "protected-stdin-current-v1", proof.body);
      return proof;
    } } });
    await expect(service.claimStreamTicket({ version: 1, receipt, attach: f.attach, streamIncarnation: "original-stream" }, "stream-original")).rejects.toThrow();
    expect(await f.service.inspectStdinTicket({ ticket: receipt.ticket, requestHash: receipt.requestHash }, "gateway-original"))
      .toMatchObject({ status: "consumed", streamConsumption: null });
    const rows = await db.select().from(protectedAuthorityRequests);
    expect(rows.filter(row => row.request.op === "consumeStdin")).toHaveLength(1);
    expect(rows.filter(row => row.request.op === "claimStreamTicket")).toHaveLength(0);
  });
  it("rechecks ACK lifetime after authority verification without committing a ticket", async () => {
    const f = await stdinFixture();
    let current = Date.now();
    const verify = f.authority.verifyAndPin;
    const service = protectedExecutionJournal(db, { ...f.options, now: () => current, stdinAuthority: { ...f.authority, verifyAndPin: async sent => {
      const proof = await verify(sent);
      current += 31_000;
      proof.body.expires = current + 1000;
      proof.mac = protectedSign(f.authority.verificationKey, "protected-stdin-current-v1", proof.body);
      return proof;
    } } });
    await expect(service.consumeStdin(f.attach, "gateway-original")).rejects.toThrow("current_ack_required");
    expect((await db.select().from(protectedAuthorityRequests)).filter(row => row.request.op === "consumeStdin")).toHaveLength(0);
  });
  it("bounds remote verification, releases native locks and retains late external intent uncertainty", async () => {
    const f = await stdinFixture();
    let finish!: () => void;
    const delayed = new Promise<void>(resolve => { finish = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let retainedProof: ProtectedEnvelope | undefined;
    const service = protectedExecutionJournal(db, { ...f.options, stdinAuthority: { ...f.authority, verificationDeadlineMs: 20,
      verifyAndPin: async sent => {
        // External intent commits before its reply is lost/delayed.
        const proof = await f.authority.verifyAndPin(sent);
        retainedProof = proof;
        started(); await delayed; return proof;
      } } });
    const attempt = service.consumeStdin(f.attach, "gateway-original");
    // Attach the rejection handler immediately, before waiting for the verifier.
    const outcome = expect(attempt).rejects.toThrow("authority_timeout");
    await entered;
    try {
      await outcome;
      expect(retainedProof).toBeDefined();
      // Another connection acquires the scheduler lock after local rollback.
      await other.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '100ms'`);
        await tx.select().from(admissionScheduler).for("update");
      });
    } finally { finish(); }
    await delayed;
    await expect(f.service.consumeStdin(f.attach, "gateway-original")).rejects.toThrow("external_intent_already_consumed");
    expect((await db.select().from(protectedAuthorityRequests)).filter(row => row.request.op === "consumeStdin")).toHaveLength(0);
  });
  it("binds gateway/stream roles to distinct actual mTLS certificates and native DB commits", async () => {
    const f = await stdinFixture();
    const directory = mkdtempSync(join(tmpdir(), "protected-stdin-tls-"));
    for (const name of ["server", "gateway", "stream"]) {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(directory, name + ".key"),
        "-out", join(directory, name + ".crt"), "-subj", "/CN=" + name, "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
    }
    const cert = (name: string) => readFileSync(join(directory, name + ".crt"));
    const key = (name: string) => readFileSync(join(directory, name + ".key"));
    const fingerprint = (name: string) => createHash("sha256").update(new X509Certificate(cert(name)).raw).digest("hex");
    const endpoint = protectedStdinEndpoint({ journal: f.service, key: key("server"), certificate: cert("server"),
      clientCA: Buffer.concat([cert("gateway"), cert("stream")]), gatewayFingerprint: fingerprint("gateway"), gatewayIdentity: "gateway-original",
      streamFingerprint: fingerprint("stream"), streamIdentity: "stream-original" });
    await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
    const address = endpoint.address(); if (!address || typeof address === "string") throw Error("missing fixture endpoint");
    const send = (peer: string | null, path: string, value: unknown, canonical = true) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpsRequest({ host: "127.0.0.1", port: address.port, servername: "localhost", ca: cert("server"),
        ...(peer ? { cert: cert(peer), key: key(peer) } : {}), path, method: "POST", agent: false,
        headers: { "Content-Type": "application/json" } }, response => {
        let body = ""; response.setEncoding("utf8"); response.on("data", data => { body += data; });
        response.on("end", () => resolve({ status: response.statusCode!, body }));
      });
      request.on("error", reject); request.end(canonical ? protectedCanonical(value) : JSON.stringify(value));
    });
    try {
      await expect(send(null, "/v1/stdin/consume", f.attach)).rejects.toThrow();
      expect((await send("stream", "/v1/stdin/consume", f.attach)).status).toBe(403);
      expect((await send("gateway", "/v1/stdin/consume", f.attach, false)).status).toBe(403);
      expect((await send("gateway", "/v1/stdin/exec", f.attach)).status).toBe(403);
      const consumed = await send("gateway", "/v1/stdin/consume", f.attach);
      expect(consumed.status).toBe(200);
      const receipt = JSON.parse(consumed.body);
      expect((await send("gateway", "/v1/stdin/consume", f.attach)).status).toBe(403);
      const stream = { version: 1, receipt, attach: f.attach, streamIncarnation: "stream-original-incarnation" };
      expect((await send("gateway", "/v1/stdin/claim-stream", stream)).status).toBe(403);
      expect((await send("stream", "/v1/stdin/claim-stream", stream)).status).toBe(200);
      expect((await send("stream", "/v1/stdin/claim-stream", stream)).status).toBe(403);
      const inspected = await send("gateway", "/v1/stdin/inspect", { ticket: receipt.ticket, requestHash: receipt.requestHash });
      expect(inspected.status).toBe(200); expect(JSON.parse(inspected.body).status).toBe("stream-claimed");
      expect((await db.select().from(protectedAuthorityRequests)).filter(row => ["consumeStdin", "claimStreamTicket"].includes(String(row.request.op)))).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each([false, true])("permanently claims one native run/operation stdin writer after exact CREATE/ACK: %s", async operation => {
    const f = await writerFixture(operation);
    const claim = await f.service.claimStdin(f.value);
    const rows = (await other.select().from(protectedAuthorityRequests)).filter(row => row.request.op === "claimStdin");
    expect(rows).toHaveLength(1);
    expect(claim).toEqual({ id: rows[0].nonce, bindingHash: protectedHash(rows[0].request.value) });
    expect(rows[0].receipt).toBeNull();
    expect(rows[0].expiresAt.getUTCFullYear()).toBe(9999);
    expect(rows[0].request.value).toMatchObject({ commandId: f.command.id, ownerTokenHash: protectedHash(f.owner),
      invocation: f.command.binding.invocationId, physical: f.value.physical, journalHash: protectedHash(f.prepared.contract), ackHash: protectedHash(f.ack) });
    expect(JSON.stringify(rows[0].request)).not.toContain(f.owner.token);
    const restarted = protectedExecutionJournal(other, f.options);
    await expect(restarted.claimStdin(f.value)).rejects.toThrow("stdin_already_claimed");
    await expect(protectedExecutionJournal(other, { ...f.options, now: () => Date.now() + 86_400_000 }).claimStdin(f.value)).rejects.toThrow();
    expect((await db.select().from(protectedAuthorityRequests)).filter(row => row.request.op === "claimStdin")).toHaveLength(1);
  });
  it("cannot accept a remote ACK against the local permanent writer record", async () => {
    const f = await writerFixture();
    const claim = await f.service.claimStdin(f.value);
    const [record] = await db.select().from(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.nonce, claim.id));
    const body = { ...f.ack.body, nonce: claim.id, requestHash: record.requestHash,
      ledgerWatermark: { sequence: 4, hash: "a".repeat(64) } };
    await expect(f.service.acceptAck({ body, mac: protectedSign(ackKey, "ack", body) })).rejects.toThrow("ack_local_record");
    const [saved] = await db.select().from(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.nonce, claim.id));
    expect(saved.receipt).toBeNull();
    expect((await db.select().from(protectedAuthorityPins))[0].revision).toBe(2);
  });
  it("serializes competing native writer claims across independent database clients", async () => {
    const f = await writerFixture();
    const results = await Promise.allSettled([f.service.claimStdin(f.value), protectedExecutionJournal(other, f.options).claimStdin(f.value)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await db.select().from(protectedAuthorityRequests)).filter(row => row.request.op === "claimStdin")).toHaveLength(1);
  });
  it.each(["token", "invocation", "physical", "ack", "scope", "drain", "lease", "cancel", "stop", "epoch", "legacy"])("rechecks current %s before claiming stdin", async failure => {
    const f = await writerFixture();
    const value = structuredClone(f.value);
    if (failure === "token") value.owner.token = randomUUID();
    if (failure === "invocation") value.invocation = randomUUID();
    if (failure === "physical") value.physical.container = "replacement-container";
    if (failure === "ack") value.ackNonce = randomUUID();
    if (failure === "scope") await db.update(admissionScopes).set({ draining: true });
    if (failure === "drain") await db.update(admissionScheduler).set({ draining: true });
    if (failure === "lease") await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, f.lease.id));
    if (failure === "cancel") await db.update(heartbeatRuns).set({ resultJson: { cancellation: { source: "operator", expected: true, initiator: { type: "user" }, recordedAt: new Date().toISOString(), reason: "fixture" } } }).where(eq(heartbeatRuns.id, f.run.id));
    if (failure === "stop") await db.update(admissionCommands).set({ stopped: true }).where(eq(admissionCommands.id, f.command.id));
    if (failure === "epoch") await db.update(protectedAuthorityPins).set({ generation: 2, revision: 3 });
    if (failure === "legacy") await db.insert(admissionLegacyHolds).values({ source: "lease:" + randomUUID(), companyId: f.company.id,
      agentId: f.agent.id, runId: f.run.id, environmentId: f.lease.environmentId, scopes: f.options.capacity.forCleanup(f.attempt.contract).scopes.map(s => s.key),
      evidence: { synthetic: true }, evidenceHash: "b".repeat(64), policyHash: "c".repeat(64) });
    await expect(f.service.claimStdin(value)).rejects.toThrow();
    expect((await db.select().from(protectedAuthorityRequests)).filter(row => row.request.op === "claimStdin")).toHaveLength(0);
  });
  it("refuses an accepted physical ACK without native Pod CREATE consumption", async () => {
    const f = await writerFixture(false, false);
    await expect(f.service.claimStdin(f.value)).rejects.toThrow("stdin_create_consumption_missing");
  });
  it("holds a formerly current physical ACK after another independently accepted result", async () => {
    const f = await writerFixture();
    const sent = await f.service.inspectCommand(f.command.id, true);
    const body = { ...f.ack.body, nonce: sent.body.nonce, requestHash: protectedHash(sent.body),
      ledgerWatermark: { sequence: 4, hash: "a".repeat(64) }, result: { ...f.ack.body.result, status: "stopped" } };
    await f.service.acceptAck({ body, mac: protectedSign(ackKey, "ack", body) });
    await expect(f.service.claimStdin(f.value)).rejects.toThrow("stdin_current_ack_required");
  });
  it("cancellation ordered before contended claim cannot mint a writer", async () => {
    const f = await writerFixture();
    let acquired!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const holder = other.transaction(async tx => {
      await tx.select().from(admissionScheduler).for("update"); acquired(); await released;
      await tx.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id));
    });
    await ready;
    const claiming = f.service.claimStdin(f.value); release();
    await holder;
    await expect(claiming).rejects.toThrow("native_run_stopped");
    expect((await db.select().from(protectedAuthorityRequests)).filter(row => row.request.op === "claimStdin")).toHaveLength(0);
  });
  it("consumes CREATE exactly once across native clients; supervisor rollback and Pod loss cannot restore permission", async () => {
    const f = await createFixture();
    const result = await f.service.consumePodCreate(f.review, "authenticated-webhook");
    expect(result).toEqual({ consumed: true, bindingHash: protectedHash(f.review) });
    const restarted = protectedExecutionJournal(other, f.options);
    // No retained runtime object/supervisor ledger is consulted. Identical and
    // new API review/Pod UIDs both encounter the independently current history.
    await expect(restarted.consumePodCreate(f.review, "authenticated-webhook")).rejects.toThrow("permit_consumed");
    await expect(restarted.consumePodCreate({ ...f.review, reviewUid: randomUUID(), podUid: randomUUID() }, "authenticated-webhook")).rejects.toThrow("permit_consumed");
    const records = (await db.select().from(protectedAuthorityRequests)).filter(r => r.request.op === "consumePodCreate");
    expect(records).toHaveLength(1);
    expect(records[0].receipt).toBeNull();
  });
  it("exposes current consumption only to the pinned mutual-TLS webhook with no retry/cache allowance", async () => {
    const f = await createFixture();
    const directory = mkdtempSync(join(tmpdir(), "protected-consume-tls-"));
    for (const name of ["server", "client"]) {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(directory, name + ".key"),
        "-out", join(directory, name + ".crt"), "-subj", "/CN=" + name, "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
    }
    const serverCert = readFileSync(join(directory, "server.crt")), clientCert = readFileSync(join(directory, "client.crt"));
    const endpoint = protectedCreateEndpoint({ journal: f.service, certificate: serverCert, key: readFileSync(join(directory, "server.key")),
      webhookCA: clientCert, webhookFingerprint: createHash("sha256").update(new X509Certificate(clientCert).raw).digest("hex"), webhookIdentity: "authenticated-webhook" });
    await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
    const address = endpoint.address(); if (!address || typeof address === "string") throw Error("missing fixture endpoint");
    const send = (certificate = true) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpsRequest({ host: "127.0.0.1", port: address.port, servername: "localhost", ca: serverCert,
        ...(certificate ? { cert: clientCert, key: readFileSync(join(directory, "client.key")) } : {}),
        path: "/consume-pod-create", method: "POST", agent: false, headers: { "Content-Type": "application/json" } }, response => {
        let body = ""; response.setEncoding("utf8"); response.on("data", data => { body += data; });
        response.on("end", () => resolve({ status: response.statusCode!, body }));
      });
      request.on("error", reject); request.end(JSON.stringify(f.review));
    });
    try {
      await expect(send(false)).rejects.toThrow();
      expect((await db.select().from(protectedAuthorityRequests)).filter(r => r.request.op === "consumePodCreate")).toHaveLength(0);
      const accepted = await send(); expect(accepted.status).toBe(200);
      expect(JSON.parse(accepted.body)).toEqual({ consumed: true, bindingHash: protectedHash(f.review) });
      expect((await send()).status).toBe(403);
      expect((await db.select().from(protectedAuthorityRequests)).filter(r => r.request.op === "consumePodCreate")).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("serializes competing API CREATEs to one permanent consumption", async () => {
    const f = await createFixture();
    const otherService = protectedExecutionJournal(other, f.options);
    const results = await Promise.allSettled([
      f.service.consumePodCreate(f.review, "authenticated-webhook"),
      otherService.consumePodCreate({ ...f.review, podUid: randomUUID(), reviewUid: randomUUID() }, "authenticated-webhook"),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it.each(["drain", "cancel", "lease", "scope", "storage", "epoch"])("rechecks current %s before irreversible native consumption", async failure => {
    const f = await createFixture();
    if (failure === "drain") await db.update(admissionScheduler).set({ draining: true });
    if (failure === "cancel") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id));
    if (failure === "lease") await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, f.lease.id));
    if (failure === "scope") await db.update(admissionScopes).set({ draining: true });
    if (failure === "storage") f.setStorage(false);
    if (failure === "epoch") await db.update(protectedAuthorityPins).set({ generation: 2, revision: 2 });
    await expect(f.service.consumePodCreate(f.review, "authenticated-webhook")).rejects.toThrow();
    expect((await db.select().from(protectedAuthorityRequests)).filter(r => r.request.op === "consumePodCreate")).toHaveLength(0);
  });
  it("denies expired committed grants without consuming native authority", async () => {
    const f = await createFixture();
    const late = protectedExecutionJournal(other, { ...f.options, now: () => Date.now() + 60_000 });
    await expect(late.consumePodCreate(f.review, "authenticated-webhook")).rejects.toThrow("grant_expired");
    expect((await db.select().from(protectedAuthorityRequests)).filter(r => r.request.op === "consumePodCreate")).toHaveLength(0);
  });
  it("retains every shared historical hold at CREATE even after the command was prepared", async () => {
    const f = await createFixture();
    const scopes = f.options.capacity.forCleanup(f.attempt.contract).scopes.map(s => s.key);
    await db.insert(admissionLegacyHolds).values({ source: "lease:" + randomUUID(), companyId: f.company.id,
      agentId: f.agent.id, runId: f.run.id, environmentId: f.lease.environmentId, scopes,
      evidence: { synthetic: true }, evidenceHash: "b".repeat(64), policyHash: "c".repeat(64) });
    await expect(f.service.consumePodCreate(f.review, "authenticated-webhook")).rejects.toThrow("legacy_occupancy_unreconciled");
    expect((await db.select().from(protectedAuthorityRequests)).filter(r => r.request.op === "consumePodCreate")).toHaveLength(0);
    expect(await db.select().from(admissionLegacyHolds)).toHaveLength(1);
  });
  it.each(["cluster", "namespaceUid", "webhook", "namespace", "objectHash"])("refuses altered CREATE %s authority", async field => {
    const f = await createFixture();
    await expect(f.service.consumePodCreate({ ...f.review, [field]: "changed" }, "authenticated-webhook")).rejects.toThrow();
    await expect(f.service.consumePodCreate(f.review, "untrusted-json-claimed-peer")).rejects.toThrow();
  });
  it("keeps Unicode wire canonicalization deterministic and rejects unsafe number/key values", () => {
    expect(protectedCanonical({ z: "æøå 🧪", a: [true, null, 1] })).toBe('{"a":[true,null,1],"z":"æøå 🧪"}');
    expect(() => protectedCanonical({ float: 0.5 })).toThrow();
    expect(() => protectedCanonical({ "é": 1 })).toThrow();
  });
  it("uses the same Unicode JSON/hash/MAC bytes as the independent Python verifier", () => {
    const value = { argv: ["æøå 🧪", "a\nb", "\u2028"], owner: { agent: "synthetic" }, generation: 1 };
    const output = JSON.parse(execFileSync("python3", ["-c", "import json,hashlib,hmac,sys; v=json.loads(sys.argv[1]); b=json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode(); print(json.dumps({'hash':hashlib.sha256(b).hexdigest(),'mac':hmac.new(bytes([3])*32,b'native-journal-grant-v1\\0'+b,hashlib.sha256).hexdigest()}))", JSON.stringify(value)], { encoding: "utf8" }));
    expect(output.hash).toBe(protectedHash(value));
    expect(output.mac).toBe(protectedSign(grantKey, "native-journal-grant-v1", value));
  });
  it("persists challenge before transport and an authenticated high-water pin across clients/restart", async () => {
    const f = await fixture();
    const { sent, reply } = await acknowledge(f);
    expect((await other.select().from(protectedAuthorityRequests))[0].nonce).toBe(sent.body.nonce);
    expect((await other.select().from(protectedAuthorityPins))[0]).toMatchObject({ generation: 1, epoch, revision: 1 });
    await protectedExecutionJournal(other, f.options).acceptAck(reply);
    expect((await db.select().from(protectedAuthorityPins))[0].revision).toBe(1);
  });
  it("snapshots signed ACK bytes before awaiting a contended database lock", async () => {
    const f = await fixture(); const sent = await f.service.epochRequest(0);
    const body = { requestHash: protectedHash(sent.body), nonce: sent.body.nonce, instance: f.policy.instance, policy: protectedHash(f.policy),
      pool: f.policy.pool, incarnation: "ledger-incarnation", generation: 1, epoch,
      ledgerWatermark: { sequence: 2, hash: "e".repeat(64) }, result: { status: "acknowledged" } };
    const reply = { body, mac: protectedSign(ackKey, "ack", body) };
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const holder = other.transaction(async tx => { await tx.select().from(admissionScheduler).for("update"); locked(); await blocked; });
    await acquired;
    const pending = f.service.acceptAck(reply);
    reply.body.result.status = "forged-stopped";
    reply.body.generation = 999;
    release();
    await holder;
    const accepted = await pending;
    expect(accepted.body).toMatchObject({ generation: 1, result: { status: "acknowledged" } });
    expect(protectedSign(ackKey, "ack", accepted.body)).toBe(accepted.mac);
    expect((await db.select().from(protectedAuthorityPins))[0].generation).toBe(1);
  });
  it("rejects forged ACK without changing pin", async () => {
    const f = await fixture(); const sent = await f.service.epochRequest(0);
    const body = { nonce: sent.body.nonce, requestHash: protectedHash(sent.body), generation: 1 };
    await expect(f.service.acceptAck({ body, mac: protectedSign(requestKey, "ack", body) })).rejects.toThrow("authentication");
    expect((await db.select().from(protectedAuthorityPins))[0].generation).toBe(0);
  });
  it.each(["incarnation", "pool", "instance", "policy"])("rejects signed wrong %s identity", async key => {
    const f = await fixture(); const sent = await f.service.epochRequest(0);
    const body = { nonce: sent.body.nonce, requestHash: protectedHash(sent.body), instance: f.policy.instance, policy: protectedHash(f.policy),
      pool: f.policy.pool, incarnation: "ledger-incarnation", generation: 1, epoch, ledgerWatermark: { sequence: 2, hash: "e".repeat(64) }, result: { status: "acknowledged" }, [key]: "wrong" };
    await expect(f.service.acceptAck({ body, mac: protectedSign(ackKey, "ack", body) })).rejects.toThrow();
    expect((await db.select().from(protectedAuthorityPins))[0].generation).toBe(0);
  });
  it("never overwrites the external ledger-incarnation pin", async () => {
    const f = await fixture();
    await expect(f.service.registerHeldPin({ instance: f.policy.instance, policy: protectedHash(f.policy), pool: f.policy.pool, incarnation: "new-ledger" })).rejects.toThrow("identity");
  });
  it.each([false, true])("commits a run/probe command contract and independently keyed workload grant before handoff: %s", async operation => {
    const f = await fixture(operation); await acknowledge(f);
    const prepared = await f.service.prepareCommand(f.owner, f.command.id, f.payload);
    const stored = (await other.select().from(protectedCommandJournals))[0];
    expect(stored.contract).toEqual(prepared.contract);
    expect(protectedHash(stored.contract)).toBe(stored.contractHash);
    const owner = prepared.contract.owner as Record<string, unknown>;
    expect(owner).toMatchObject({ attempt: f.attempt.id, account: "original-account", credential: "original-credential", nativeKind: operation ? "operation" : "run" });
    const grant = prepared.contract.journalGrant as { body: unknown; mac: string };
    expect(grant.mac).toBe(protectedSign(grantKey, "native-journal-grant-v1", grant.body));
    expect((await other.select().from(protectedAuthorityRequests).where(eq(protectedAuthorityRequests.nonce, prepared.request.body.nonce)))).toHaveLength(1);
  });
  it("reuses immutable original contract and only inspects after ambiguous transport", async () => {
    const f = await fixture(); await acknowledge(f);
    const first = await f.service.prepareCommand(f.owner, f.command.id, f.payload);
    const replay = await protectedExecutionJournal(other, f.options).prepareCommand(f.owner, f.command.id, f.payload);
    expect(first.contract).toEqual(replay.contract);
    expect(replay.request.body.op).toBe("inspect");
    expect(replay.request.body.highWater).toEqual({ sequence: 2, hash: "e".repeat(64) });
    const inspection = await f.service.inspectCommand(f.command.id);
    expect(inspection.body.op).toBe("inspect");
    expect(inspection.body.value).toEqual(first.contract);
    expect(await db.select().from(protectedCommandJournals)).toHaveLength(1);
  });
  it("refuses unpublished command, changed body, sibling owner, changed lease and stopped native run", async () => {
    const f = await fixture(); await acknowledge(f);
    await expect(f.service.prepareCommand(f.owner, randomUUID(), f.payload)).rejects.toThrow("committed_command");
    await expect(f.service.prepareCommand(f.owner, f.command.id, { ...f.payload, command: "changed" })).rejects.toThrow("committed_command");
    await expect(f.service.prepareCommand({ ...f.owner, companyId: randomUUID() }, f.command.id, f.payload)).rejects.toThrow("ownership");
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() }).where(eq(environmentLeases.id, f.lease.id));
    await expect(f.service.prepareCommand(f.owner, f.command.id, f.payload)).rejects.toThrow("lease_mismatch");
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(f.service.prepareCommand(f.owner, f.command.id, f.payload)).rejects.toThrow("native_run_stopped");
    expect(await db.select().from(protectedCommandJournals)).toHaveLength(0);
  });
  it.each(["drain", "command_stop", "native_cancel", "lease_release"])("rechecks %s across the commit-to-request boundary", async kind => {
    const f = await fixture(); await acknowledge(f);
    let calls = 0;
    const original = db.transaction.bind(db);
    const wrapped = new Proxy(db, { get(target, property) {
      if (property !== "transaction") return Reflect.get(target, property);
      return async (body: Parameters<typeof original>[0]) => {
        const result = await original(body);
        if (++calls === 1) {
          if (kind === "drain") await db.update(admissionScheduler).set({ draining: true });
          if (kind === "command_stop") await db.update(admissionCommands).set({ stopped: true }).where(eq(admissionCommands.id, f.command.id));
          if (kind === "native_cancel") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id));
          if (kind === "lease_release") await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() }).where(eq(environmentLeases.id, f.lease.id));
        }
        return result;
      };
    } });
    const service = protectedExecutionJournal(wrapped, f.options);
    await expect(service.prepareCommand(f.owner, f.command.id, f.payload)).rejects.toThrow();
    expect(await db.select().from(protectedCommandJournals)).toHaveLength(1);
    const requests = await db.select().from(protectedAuthorityRequests);
    expect(requests.filter(r => r.request.op === "authorizeInvocation")).toHaveLength(0);
  });
  it("binds auxiliary leases to the exact operation", async () => {
    const f = await fixture(true); await acknowledge(f);
    await db.update(environmentLeases).set({ metadata: { agentId: f.agent.id, admissionOperationId: randomUUID() } }).where(eq(environmentLeases.id, f.lease.id));
    await expect(f.service.prepareCommand(f.owner, f.command.id, f.payload)).rejects.toThrow("lease_mismatch");
  });
  it("rejects changed target image even when it has a digest", async () => {
    const f = await fixture(); await acknowledge(f);
    const bad = protectedExecutionJournal(db, { ...f.options, target: () => ({ ...f.options.target(), image: "example.invalid/other@sha256:" + "e".repeat(64) }) });
    await expect(bad.prepareCommand(f.owner, f.command.id, f.payload)).rejects.toThrow("target_unattested");
  });
  it("pins same-epoch remote event history on every request and rejects an authenticated ledger rollback", async () => {
    const f = await fixture(); await acknowledge(f);
    const prepared = await f.service.prepareCommand(f.owner, f.command.id, f.payload);
    expect(prepared.request.body.highWater).toEqual({ sequence: 2, hash: "e".repeat(64) });
    const body = { nonce: prepared.request.body.nonce, requestHash: protectedHash(prepared.request.body), instance: f.policy.instance,
      policy: protectedHash(f.policy), pool: f.policy.pool, incarnation: "ledger-incarnation", generation: 1, epoch,
      ledgerWatermark: { sequence: 1, hash: "f".repeat(64) }, result: { status: "started" } };
    await expect(f.service.acceptAck({ body, mac: protectedSign(ackKey, "ack", body) })).rejects.toThrow("high_water_rollback");
    expect((await db.select().from(protectedAuthorityPins))[0].revision).toBe(1);
    const inspection = await f.service.prepareCommand(f.owner, f.command.id, f.payload);
    expect(inspection.request.body.op).toBe("inspect");
  });
  it("requires durable epoch ACK and preserves held startup", async () => {
    const f = await fixture();
    await expect(f.service.prepareCommand(f.owner, f.command.id, f.payload)).rejects.toThrow("draining");
    await db.update(admissionScheduler).set({ draining: false });
    await expect(f.service.prepareCommand(f.owner, f.command.id, f.payload)).rejects.toThrow("unacknowledged");
  });
  it("CAS rejects an older concurrent ACK challenge and stale/rollback epochs", async () => {
    const f = await fixture();
    const old = await f.service.epochRequest(0);
    await acknowledge(f);
    const body = { nonce: old.body.nonce, requestHash: protectedHash(old.body), instance: f.policy.instance, policy: protectedHash(f.policy), pool: f.policy.pool,
      incarnation: "ledger-incarnation", generation: 1, epoch, ledgerWatermark: { sequence: 2, hash: "e".repeat(64) }, result: { status: "acknowledged" } };
    await expect(f.service.acceptAck({ body, mac: protectedSign(ackKey, "ack", body) })).rejects.toThrow("stale_challenge");
    await db.update(admissionScheduler).set({ epoch: randomUUID() }).where(eq(admissionScheduler.singleton, true)).catch(() => undefined);
    const inspect = await f.service.epochRequest(1);
    const rollback = { ...body, nonce: inspect.body.nonce, requestHash: protectedHash(inspect.body), generation: 0 };
    await expect(f.service.acceptAck({ body: rollback, mac: protectedSign(ackKey, "ack", rollback) })).rejects.toThrow("rollback");
  });
});
