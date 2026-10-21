/** DISPOSABLE ONLY: real native journal/PG + mTLS endpoint for actual kind CREATE.
 * Synthetic storage attestor is NOT physical storage/retirement authority.
 * stdin controls only an internally created ephemeral database, never DATABASE_URL.
 */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { eq } from "drizzle-orm";
import { admissionAttempts, admissionCommands, admissionEpochs, admissionProjects, admissionScheduler, admissionScopes, agents, companies,
  createDb, environments, environmentLeases, heartbeatRuns, protectedAuthorityRequests } from "@paperclipai/db";
import { trustedCapacityPolicy, type TrustedCapacityBinding } from "../../services/execution-capacity-policy.js";
import { protectedCreateEndpoint, protectedExecutionJournal, protectedHash, protectedSign, type ProtectedPayload, type ProtectedPolicy } from "../../services/protected-execution-journal.js";
import { startEmbeddedPostgresTestDatabase } from "../helpers/embedded-postgres.js";

if (process.env.PAPERCLIP_DISPOSABLE_NATIVE_LAUNCH !== "yes" || process.env.DATABASE_URL || process.getuid?.() !== 2000)
  throw Error("disposable_nonroot_native_fixture_only");
const requestKey = Buffer.alloc(32, 1), ackKey = Buffer.alloc(32, 2), grantKey = Buffer.alloc(32, 3);
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let endpoint: ReturnType<typeof protectedCreateEndpoint> | undefined;
let restart: (() => Promise<void>) | undefined;
let cancel: (() => Promise<void>) | undefined;
let prepare: (() => Promise<unknown>) | undefined;
let storageCurrent = true;
async function initialize(input: any) {
  if (db || input.policy?.templates?.synthetic?.entrypoint !== "/bin/true" || Object.keys(input.policy.templates).length !== 1)
    throw Error("single_synthetic_create_fixture_required");
  temporary = await startEmbeddedPostgresTestDatabase("kind-native-create-");
  db = createDb(temporary.connectionString);
  const epoch = randomUUID();
  await db.insert(admissionEpochs).values({ epoch });
  await db.insert(admissionScheduler).values({ epoch, draining: true, pendingLimit: 4 });
    const [company] = await db.insert(companies).values({ name: "synthetic", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [env] = await db.insert(environments).values({ name: randomUUID(), driver: "ssh" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "B", adapterType: "codex_local" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running" }).returning();
    const binding: TrustedCapacityBinding = { companyId: company.id, agentId: agent.id, environmentId: env.id, adapterType: "codex_local",
      instance: input.policy.instance, instanceCapacity: 1, runner: "original-runner", providerAccount: "original-account",
      workspace: "original-workspace", session: "original-session", credential: "original-credential", agentFingerprint: "a".repeat(64),
      environmentFingerprint: "b".repeat(64), workspaceConfigurations: ["c".repeat(64)], runnerCapacity: 1, accountCapacity: 1, fenceRoot: "/fence" };
    const capacity = trustedCapacityPolicy([binding]);
    await db.insert(admissionProjects).values({ companyId: company.id, projectKey: "fixture" });
    const token = randomUUID();
    const [attempt] = await db.insert(admissionAttempts).values({ companyId: company.id, agentId: agent.id, runId: run.id,
      operationKey: null, operationKind: null, projectKey: "fixture", scopes: ["original"],
      state: "starting", ownerEpoch: epoch, token, contract: binding as unknown as Record<string, unknown> }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: company.id, environmentId: env.id, provider: "ssh", status: "active",
      heartbeatRunId: run.id, metadata: { agentId: agent.id, admissionOperationId: null } }).returning();
    const payload: ProtectedPayload = { command: "python3", args: ["-c", "print('æøå 🧪')"], env: { HOME: "/attempt" }, cwd: "/attempt" };
    const [command] = await db.insert(admissionCommands).values({ attemptId: attempt.id,
      binding: { companyId: company.id, agentId: agent.id, runId: run.id,
        attemptId: randomUUID(), environmentId: env.id, leaseId: lease.id, invocationId: randomUUID(), epoch },
      fenceRoot: "/fence", commandHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex") }).returning();
    const policy = input.policy as ProtectedPolicy;

    const options = { epoch, policy, capacity, requestKey, ackKey, grantKey, target: () => input.target,
      createAuthority: { ...input.context, namespace: input.namespace, attestStorage: async () => storageCurrent } };
    let service = protectedExecutionJournal(db, options);
    await service.registerHeldPin({ instance: policy.instance, policy: protectedHash(policy), pool: policy.pool, incarnation: "synthetic-native-fixture-ledger" });
    const sent = await service.epochRequest(0);
    const body = { requestHash: protectedHash(sent.body), nonce: sent.body.nonce, instance: policy.instance, policy: protectedHash(policy),
      pool: policy.pool, incarnation: "synthetic-native-fixture-ledger", generation: 1, epoch,
      ledgerWatermark: { sequence: 2, hash: "e".repeat(64) }, result: { status: "acknowledged" } };
    await service.acceptAck({ body, mac: protectedSign(ackKey, "ack", body) });
    await db.update(admissionScheduler).set({ draining: false });
    const resolved = capacity.forCleanup(attempt.contract);
    await db.update(admissionAttempts).set({ scopes: resolved.scopes.map(s => s.key) }).where(eq(admissionAttempts.id, attempt.id));
    await db.insert(admissionScopes).values(resolved.scopes);
    prepare = async () => (await service.prepareCommand({ companyId: company.id, attemptId: attempt.id, token }, command.id, payload)).contract;
    const owner = { company: company.id, agent: agent.id, nativeKind: "run", nativeId: run.id,
      environment: env.id, lease: lease.id, attempt: attempt.id, runner: binding.runner, account: binding.providerAccount,
      workspace: binding.workspace, session: binding.session, credential: binding.credential };
    const clientCert = readFileSync("/fixture/native-client.crt");
    const endpointOptions = { journal: service, certificate: readFileSync("/fixture/native-server.crt"), key: readFileSync("/fixture/native-server.key"),
      webhookCA: clientCert, webhookFingerprint: createHash("sha256").update(new X509Certificate(clientCert).raw).digest("hex"), webhookIdentity: input.context.webhook };
    restart = async () => {
      if (endpoint) {
        await new Promise<void>((resolve, reject) => endpoint!.close(error => error ? reject(error) : resolve()));
        await db!.$client.end();
        db = createDb(temporary!.connectionString);
        service = protectedExecutionJournal(db, options);
        endpointOptions.journal = service;
      }
      endpoint = protectedCreateEndpoint(endpointOptions);
      await new Promise<void>(resolve => endpoint!.listen(8444, "0.0.0.0", resolve));
    };
    cancel = async () => { await db!.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id)); };
    await restart();
    return { contract: { owner }, journalKeyHex: grantKey.toString("hex"), storageAttestor: "synthetic_boolean_only", retirementAuthority: false };
}
const reply = (value: unknown) => console.log("PC_NATIVE_JSON " + JSON.stringify(value));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    try {
      const input = JSON.parse(line);
      if (input.op === "initialize") reply(await initialize(input));
      else if (input.op === "prepare" && prepare) reply(await prepare());
      else if (input.op === "history" && db) reply((await db.select().from(protectedAuthorityRequests)).filter(row => row.request.op === "consumePodCreate").map(row => row.request.value));
      else if (input.op === "cancel" && cancel) { await cancel(); reply({ cancelled: true }); }
      else if (input.op === "restart" && restart) { await restart(); reply({ restarted: true, journalConnectionRecreated: true }); }
      else if (input.op === "storage" && typeof input.current === "boolean") { storageCurrent = input.current; reply({ storageCurrent }); }
      else if (input.op === "destroyDatabase" && temporary) {
        await temporary.cleanup(); temporary = undefined;
        reply({ destroyed: true, scope: "only_internal_ephemeral_postgresql", recoveryVerified: false });
      }
      else if (input.op === "shutdown") { reply({ shutdown: true }); break; }
      else throw Error("unsupported_disposable_fixture_control");
    } catch (error) { reply({ error: String(error) }); }
  }
} finally {
  if (endpoint) await new Promise<void>(resolve => endpoint!.close(() => resolve()));
  await db?.$client.end(); await temporary?.cleanup();
}
