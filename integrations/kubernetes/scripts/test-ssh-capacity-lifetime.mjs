import { createServer } from "node:http";
import { verifyLocalAgentJwt } from "/app/server/src/agent-auth-jwt.ts";
// Disposable PostgreSQL + actual restricted SSH. No model or provider credentials.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, and } from '/app/server/node_modules/drizzle-orm/index.js';
import { createDb, startEmbeddedPostgresTestDatabase, admissionAttempts, admissionCommands, admissionRestorations,
  admissionEpochs, admissionScheduler, environmentLeases, agents, companies, companySecretBindings, environments, heartbeatRuns, agentWakeupRequests } from '/app/packages/db/src/index.ts';
import { heartbeatService } from "/app/server/src/services/heartbeat.ts";
import { buildExecutionWorkspaceAdapterConfig, resolveExecutionWorkspaceMode } from "/app/server/src/services/execution-workspace-policy.ts";
import { executionAdmissionService } from '/app/server/src/services/execution-admission.ts';
import { capacityAgentContract, capacityEnvironmentContract, capacityWorkspaceContract, capacityFingerprint, trustedCapacityPolicy } from '/app/server/src/services/execution-capacity-policy.ts';
import { withCapacityOperation, stopCapacityAgentOperations, reconcileCapacityReservation } from '/app/server/src/services/execution-capacity-lifetime.ts';
import { requireExecutionStateRestoration } from '/app/packages/adapter-utils/src/execution-state-journal.ts';
import { runSshCommand, shellQuote, buildSshSpawnTarget, updateSshAdmissionEpoch, prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution, syncDirectoryToSsh, syncDirectoryFromSsh } from '/app/packages/adapter-utils/src/ssh.ts';
import { probeEnvironment } from '/app/server/src/services/environment-probe.ts';
import { agentHarnessVerificationService } from '/app/server/src/services/agent-harness-verification.ts';
import { environmentService } from '/app/server/src/services/environments.ts';
import { secretService } from '/app/server/src/services/secrets.ts';

process.env.PAPERCLIP_HOME = '/tmp/capacity-fixture';
process.env.CODEX_HOME = '/tmp/capacity-host-codex';
await fs.mkdir('/tmp/capacity-run-source', { recursive: true });
await fs.writeFile('/tmp/capacity-run-source/input-marker', 'original-bytes\n');
process.env.PAPERCLIP_SECRETS_MASTER_KEY = randomBytes(32).toString('hex');
process.env.PAPERCLIP_AGENT_JWT_SECRET = randomBytes(32).toString('hex');
const spec = JSON.parse(await fs.readFile('/fixture/spec.json', 'utf8'));
spec.knownHosts = spec.knownHosts.trim();
const command = async script => (await runSshCommand(spec, script)).stdout;
const fenceRoot = '/home/node/capacity-fence';
const sessionRoot = '/home/node/capacity-session';
const credentialRoot = '/home/node/capacity-credential';
const syntheticCli = "#!/bin/sh\nset -eu\nif [ \"$1\" = \"--version\" ]; then echo \"codex-cli 0.123.0\"; exit 0; fi\nif [ \"${PAPERCLIP_API_BRIDGE_MODE-}\" = \"queue_v1\" ]; then\npython3 - <<'CALLBACK'\nimport json,os,urllib.request\nrequest=urllib.request.Request(os.environ['PAPERCLIP_API_URL']+'/api/agents/me',headers={'Authorization':'Bearer '+os.environ['PAPERCLIP_API_KEY']})\nassert json.load(urllib.request.urlopen(request,timeout=20))['callback']=='ok'\nCALLBACK\nfi\nif [ -f /home/node/native-provider-hold ]; then\npython3 - <<'HOLD'\nimport pathlib,subprocess,time\nchild=subprocess.Popen(['sleep','60'],start_new_session=True)\npathlib.Path('/home/node/native-provider-ready').write_text(str(child.pid))\ntime.sleep(60)\nHOLD\nfi\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}'\n";
await command(`mkdir -p ${sessionRoot} ${credentialRoot} /tmp/capacity-host-codex; printf '%s' ${shellQuote(syntheticCli)} > /home/node/codex; chmod 700 /home/node/codex`);
const temporary = await startEmbeddedPostgresTestDatabase('capacity-ssh-');
const db = createDb(temporary.connectionString);
try {
  const epoch = randomUUID();
  await db.insert(admissionEpochs).values({ epoch });
  await db.insert(admissionScheduler).values({ epoch, pendingLimit: 30, draining: false, evaluationExemptionUntil: new Date(Date.now() + 300_000) });
  const [company] = await db.insert(companies).values({ name: 'SSH fixture', issuePrefix: 'SSH' }).returning();
  const secret = await secretService(db).create(company.id, { name: 'fixture-ssh', provider: 'local_encrypted', value: spec.privateKey });
  const { remoteCwd, privateKey, ...savedConfig } = spec;
  const [environment] = await db.insert(environments).values({ name: 'SSH fixture', driver: 'ssh',
    config: { ...savedConfig, privateKey: null, privateKeySecretRef: { type: 'secret_ref', secretId: secret.id, version: 1 } } }).returning();
  await db.insert(companySecretBindings).values({ companyId: company.id, secretId: secret.id, targetType: 'environment',
    targetId: environment.id, configPath: 'privateKeySecretRef', versionSelector: '1' });
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'fixture', adapterType: 'codex_local',
    defaultEnvironmentId: environment.id, adapterConfig: { engine: 'cli', command: '/home/node/codex', cwd: '/tmp/capacity-run-source',
      env: { CODEX_HOME: '/tmp/capacity-host-codex' } } }).returning();
  await fs.mkdir('/tmp/capacity-host-codex', { recursive: true });
  await fs.writeFile('/tmp/capacity-host-codex/auth.json', JSON.stringify({ tokens: { id_token: 'synthetic-id', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', account_id: 'fixture-account' }, last_refresh: '2026-07-09T02:00:00Z' }));
  const binding = { companyId: company.id, agentId: agent.id, environmentId: environment.id, adapterType: agent.adapterType,
    instance: 'fixture', instanceCapacity: 1, runner: 'fixture-runner', runnerCapacity: 1, providerAccount: 'fixture-account', accountCapacity: 1,
    workspace: 'fixture-workspace', session: 'fixture-session', credential: 'fixture-credential', fenceRoot, sessionRoot, credentialRoot,
    agentFingerprint: capacityFingerprint(capacityAgentContract(agent)), environmentFingerprint: capacityFingerprint(capacityEnvironmentContract(environment)),
    workspaceConfigurations: [capacityFingerprint({}), capacityFingerprint(capacityWorkspaceContract({
      sourceWorkspaceConfig: buildExecutionWorkspaceAdapterConfig({ agentConfig: agent.adapterConfig, projectPolicy: null,
        issueSettings: null, mode: resolveExecutionWorkspaceMode({ projectPolicy: null, issueSettings: null }), legacyUseProjectWorkspace: null }),
    }))] };
  const admission = executionAdmissionService(db, epoch, trustedCapacityPolicy([binding]));
  const ack = await updateSshAdmissionEpoch({ spec, fenceRoot, epoch });
  await admission.acknowledgeRunnerEpoch({ companyId: company.id, agentId: agent.id, ...ack });
  const input = { companyId: company.id, agentId: agent.id, environmentId: environment.id, kind: 'adapter_test' };
  const operation = (key, body) => withCapacityOperation(db, { ...input, key }, body);
  const attempts = () => db.select().from(admissionAttempts);
  const byKey = async key => (await attempts()).find(row => row.operationKey === key);
  const queryCommands = id => db.select().from(admissionCommands).where(eq(admissionCommands.attemptId, id));
  const finish = async owner => {
    await admission.beginRestoration(owner);
    for (const kind of ['workspace', 'session', 'credential']) await admission.recordRestoration({ ...owner, kind, success: true });
    await admission.releaseCapacity(owner);
  };
  const savedEnvironment = await environmentService(db).getById(environment.id);
  const probe = await probeEnvironment(db, savedEnvironment, { companyId: company.id });
  assert.equal(probe.ok, true);
  const verification = agentHarnessVerificationService(db, {});
  assert.equal(await verification.verify(agent), 'complete');
  assert.equal((await db.select().from(heartbeatRuns)).length, 0);
  assert((await attempts()).every(row => row.state === 'released'));
  assert((await db.select().from(admissionCommands)).every(row => row.stopped));

  // Save the successful lifecycle result before cleanup. A later retry repairs
  // failed state finalization and returns that result without another turn.
  await db.update(agents).set({ lifecycleVersion: 1 }).where(eq(agents.id, agent.id));
  let lifecycleTurns = 0;
  const lifecycleInput = { ...input, kind: 'lifecycle', key: 'verify:1' };
  await assert.rejects(withCapacityOperation(db, lifecycleInput, async () => {
    lifecycleTurns++;
    await runSshCommand(spec, `rmdir ${credentialRoot}`);
    return 'complete';
  }), /state_root_changed/);
  assert.equal((await byKey('verify:1')).operationResult, 'complete');
  assert.equal((await byKey('verify:1')).state, 'stopping');
  await command(`mkdir -p ${credentialRoot}`);
  assert.equal(await withCapacityOperation(db, lifecycleInput, async () => { lifecycleTurns++; return 'complete'; }), 'complete');
  assert.equal(lifecycleTurns, 1);
  assert.equal((await byKey('verify:1')).state, 'released');
  console.log('PASS phase: probe/lifecycle');
  const wakeId = randomUUID(), nativeRunId = randomUUID();
  await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: company.id, agentId: agent.id,
    source: 'on_demand', triggerDetail: 'manual', status: 'queued', runId: nativeRunId,
    requestedByActorType: 'user', requestedByActorId: 'fixture-board-user', payload: { manualUserWake: true } });
  await db.insert(heartbeatRuns).values({ id: nativeRunId, companyId: company.id, agentId: agent.id,
    invocationSource: 'on_demand', triggerDetail: 'manual', status: 'queued', wakeupRequestId: wakeId });
  const heartbeat = heartbeatService(db, { executionAdmission: admission });
  let callbackCount = 0;
  let callbackRunId = nativeRunId;
  const api = createServer((request, response) => {
    try {
      assert.equal(request.url, '/api/agents/me');
      const claims = verifyLocalAgentJwt(String(request.headers.authorization).replace(/^Bearer /, ''));
      assert.equal(claims?.run_id, callbackRunId);
      assert.equal(claims?.sub, agent.id);
      assert.equal(claims?.company_id, company.id);
      assert.equal(request.headers['x-paperclip-run-id'], callbackRunId);
      callbackCount++;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ callback: 'ok' }));
    } catch (error) { console.error('fixture callback rejected:', error.message); response.writeHead(403); response.end(); }
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  process.env.PAPERCLIP_LISTEN_HOST = '127.0.0.1';
  process.env.PAPERCLIP_LISTEN_PORT = String(api.address().port);
  try {
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const [firstNative] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, nativeRunId));
    assert.equal(firstNative.status, 'succeeded', JSON.stringify({ code: firstNative.errorCode, error: firstNative.error, stderr: firstNative.stderrExcerpt }));
    assert.equal(callbackCount, 1);
    const cancelRunId = randomUUID(), cancelWakeId = randomUUID();
    callbackRunId = cancelRunId;
    await command('touch /home/node/native-provider-hold');
    await db.insert(agentWakeupRequests).values({ id: cancelWakeId, companyId: company.id, agentId: agent.id,
      source: 'on_demand', triggerDetail: 'manual', status: 'queued', runId: cancelRunId,
      requestedByActorType: 'user', requestedByActorId: 'fixture-board-user', payload: { manualUserWake: true } });
    await db.insert(heartbeatRuns).values({ id: cancelRunId, companyId: company.id, agentId: agent.id,
      invocationSource: 'on_demand', triggerDetail: 'manual', status: 'queued', wakeupRequestId: cancelWakeId });
    await heartbeat.resumeQueuedRuns();
    let providerReady = false;
    for (let i = 0; i < 100; i++) {
      if ((await command('test -s /home/node/native-provider-ready && echo ready').catch(() => '')).trim() === 'ready') { providerReady = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(providerReady, true);
    const nativeDescendant = Number((await command('cat /home/node/native-provider-ready')).trim());
    await heartbeat.cancelRun(cancelRunId, 'bounded synthetic descendant cancellation');
    await heartbeat.drainActiveRunExecutions();
    const [cancelledNative] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, cancelRunId));
    assert.equal(cancelledNative.status, 'cancelled');
    const [cancelledAttempt] = await db.select().from(admissionAttempts).where(eq(admissionAttempts.runId, cancelRunId));
    assert.equal(cancelledAttempt.state, 'released');
    assert((await queryCommands(cancelledAttempt.id)).every(row => row.stopped));
    await command(`test ! -d /proc/${nativeDescendant}; rm /home/node/native-provider-hold`);
  } finally { await new Promise(resolve => api.close(resolve)); }
  assert.equal(callbackCount, 2);
  const [nativeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, nativeRunId));
  assert.equal(nativeRun.status, 'succeeded', JSON.stringify({ status: nativeRun.status, errorCode: nativeRun.errorCode, error: nativeRun.error }));
  const [nativeAttempt] = await db.select().from(admissionAttempts).where(eq(admissionAttempts.runId, nativeRunId));
  assert.equal(nativeAttempt.state, 'released');
  assert((await queryCommands(nativeAttempt.id)).length > 5);
  assert((await queryCommands(nativeAttempt.id)).every(row => row.stopped));
  console.log('PASS phase: assembled native scheduler/CLI/authenticated callbacks/cancellation/settlement');

  let automaticTurns = 0;
  await assert.rejects(operation('automatic-finalization-recovery', async () => {
    automaticTurns++;
    await runSshCommand(spec, `rmdir ${credentialRoot}`);
  }), /state_root_changed/);
  await command(`mkdir -p ${credentialRoot}`);
  let recoveredAutomatically = false;
  for (let i = 0; i < 100; i++) {
    if ((await byKey('automatic-finalization-recovery')).state === 'released') { recoveredAutomatically = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(recoveredAutomatically, true);
  assert.equal(automaticTurns, 1);
  const automaticAttempt = await byKey('automatic-finalization-recovery');
  assert.deepEqual(automaticAttempt.restoration, { workspace: true, session: true, credential: true });
  assert((await queryCommands(automaticAttempt.id)).every(row => row.stopped));
  console.log('PASS phase: automatic finalization recovery without provider replay');

  // Both tar and Git bundle paths must use a new durable child per SSH launch.
  const local = await fs.mkdtemp('/tmp/capacity-source-');
  await fs.writeFile(local + '/marker', 'byte-identical\n');
  await operation('tar-transfer', async () => {
    const restore = await requireExecutionStateRestoration('workspace', { localDir: local, remoteDir: spec.remoteCwd + '/tar' });
    await prepareWorkspaceForSshExecution({ spec, localDir: local, remoteDir: spec.remoteCwd + '/tar', workspaceFileMode: 'all' });
    await runSshCommand(spec, `printf 'restored\\n' >> ${shellQuote(spec.remoteCwd + '/tar/marker')}`);
    await restore(() => restoreWorkspaceFromSshExecution({ spec, localDir: local, remoteDir: spec.remoteCwd + '/tar' }));
  });
  assert.equal(await fs.readFile(local + '/marker', 'utf8'), 'byte-identical\nrestored\n');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  await exec('git', ['init', local]);
  await exec('git', ['-C', local, 'add', '.']);
  await exec('git', ['-C', local, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  await operation('git-transfer', async () => {
    const restore = await requireExecutionStateRestoration('workspace', { localDir: local, remoteDir: spec.remoteCwd + '/git' });
    await prepareWorkspaceForSshExecution({ spec, localDir: local, remoteDir: spec.remoteCwd + '/git' });
    await runSshCommand(spec, `printf 'git-restored\\n' >> ${shellQuote(spec.remoteCwd + '/git/marker')}`);
    await restore(() => restoreWorkspaceFromSshExecution({ spec, localDir: local, remoteDir: spec.remoteCwd + '/git' }));
  });
  assert((await fs.readFile(local + '/marker', 'utf8')).endsWith('git-restored\n'));
  for (const key of ['tar-transfer', 'git-transfer']) {
    const commands = await queryCommands((await byKey(key)).id);
    assert(commands.length >= 5);
    assert.equal(new Set(commands.map(c => c.binding.attemptId)).size, commands.length);
    assert(commands.every(c => c.stopped));
  }

  console.log('PASS phase: tar/Git transfers');
  // A swallowed restoration failure remains durable and prevents release.
  await assert.rejects(operation('partial-restore', async () => {
    const restore = await requireExecutionStateRestoration('credential', { source: 'synthetic' });
    await restore(async () => { throw Error('injected restore failure'); }).catch(() => {});
  }), /admission_restoration_unverified/);
  let held = await byKey('partial-restore');
  assert.equal(held.state, 'stopping');
  await assert.rejects(operation('blocked-sibling', async () => { throw Error('must not execute'); }), /Waiting for execution capacity/);
  const [obligation] = await db.select().from(admissionRestorations).where(eq(admissionRestorations.attemptId, held.id));
  const owner = { companyId: company.id, attemptId: held.id, token: held.token };
  await reconcileCapacityReservation(db, company.id, held.id, async descriptor => {
    assert.equal(descriptor.source, 'synthetic');
    await runSshCommand(spec, `printf restored > ${credentialRoot}/recovery-marker`);
    assert.equal((await runSshCommand(spec, `cat ${credentialRoot}/recovery-marker`)).stdout, 'restored');
  });
  assert.equal((await byKey('partial-restore')).state, 'released');
  const waiting = await byKey('blocked-sibling');
  await admission.cancel(company.id, waiting.id);

  console.log('PASS phase: partial restoration recovery');
  const authRecoveryHome = await fs.mkdtemp('/tmp/capacity-auth-recovery-');
  const originalAuth = await fs.readFile('/tmp/capacity-host-codex/auth.json', 'utf8');
  const recoveredAuth = JSON.stringify({ ...JSON.parse(originalAuth), last_refresh: '2026-07-10T02:00:00Z' });
  await fs.writeFile(authRecoveryHome + '/auth.json', originalAuth, { mode: 0o600 });
  const authRemoteDir = credentialRoot + '/auth-recovery';
  await command(`umask 077; mkdir -p ${authRemoteDir}; printf '%s' ${shellQuote(recoveredAuth)} > ${authRemoteDir}/auth.json`);
  await assert.rejects(operation('credential-recovery', async () => {
    const restore = await requireExecutionStateRestoration('credential', { operation: 'codex_auth',
      remoteDir: authRemoteDir, hostAuthPath: authRecoveryHome + '/auth.json' });
    // Keep automatic cleanup blocked until this missing asset is repaired.
    await runSshCommand(spec, `rm ${authRemoteDir}/auth.json`);
    await restore(async () => { throw Error('injected interrupted auth copy-back'); }).catch(() => {});
  }), /admission_restoration_unverified/);
  const interruptedAuth = await byKey('credential-recovery');
  assert.equal(interruptedAuth.state, 'stopping');
  assert.equal(await fs.readFile(authRecoveryHome + '/auth.json', 'utf8'), originalAuth);
  await command(`umask 077; printf '%s' ${shellQuote(recoveredAuth)} > ${authRemoteDir}/auth.json`);
  await reconcileCapacityReservation(db, company.id, interruptedAuth.id);
  assert.equal(await fs.readFile(authRecoveryHome + '/auth.json', 'utf8'), recoveredAuth);
  assert.equal((await fs.stat(authRecoveryHome + '/auth.json')).mode & 0o777, 0o600);
  assert.equal((await byKey('credential-recovery')).state, 'released');

  // Cancellation stops the exact child and descendants during setup, before
  // any final provider turn exists. A subsequent operation can progress.
  const pending = operation('cancel-setup', () => runSshCommand(spec,
    `python3 -c ${shellQuote('import subprocess,time,pathlib; p=subprocess.Popen(["sleep","60"], start_new_session=True); pathlib.Path("/home/node/descendant-ready").write_text(str(p.pid)); time.sleep(60)')}`, { timeoutMs: 70_000 }));
  for (let i = 0; i < 100; i++) {
    held = await byKey('cancel-setup');
    if (held && (await command("test -s /home/node/descendant-ready && echo ready").catch(() => "")).trim() === "ready") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const descendant = Number((await command("cat /home/node/descendant-ready")).trim());
  assert(descendant > 1);
  const rejection = assert.rejects(pending);
  await stopCapacityAgentOperations(db, [agent.id]);
  await rejection;
  await command(`test ! -d /proc/${descendant}`);
  assert.equal((await byKey('cancel-setup')).state, 'released');
  await operation('sibling-progress', () => runSshCommand(spec, 'printf sibling-ok'));
  assert.equal((await byKey('sibling-progress')).state, 'released');
  console.log('PASS phase: ready descendant cancellation');
  // Disconnect the actual SSH client in each streaming direction after the
  // remote tar descendant is confirmed alive. This is a transfer interruption,
  // not a mocked rejection or pre-launch cancellation.
  await command(`mkdir -p /home/node/fault-bin; printf '%s' ${shellQuote('#!/bin/sh\nif [ -f /home/node/fault-transfer ]; then echo $$ > /home/node/transfer-ready; sleep 60; fi\nexec /usr/bin/tar "$@"\n')} > /home/node/fault-bin/tar; chmod 700 /home/node/fault-bin/tar; printf '%s\n' 'export PATH=/home/node/fault-bin:$PATH' > /home/node/.profile`);
  const faultBin = await fs.mkdtemp('/tmp/capacity-ssh-fault-');
  await fs.writeFile(faultBin + '/ssh', '#!/bin/sh\ncase "$*" in *"tar "*) ;; *) exec /usr/bin/ssh "$@" ;; esac\nif [ -f /tmp/capacity-disconnect-next ]; then rm /tmp/capacity-disconnect-next; /usr/bin/ssh "$@" &\np=$!; echo "$p" > /tmp/capacity-disconnect-pid; wait "$p"\nelse exec /usr/bin/ssh "$@"; fi\n', { mode: 0o700 });
  const normalPath = process.env.PATH;
  for (const direction of ['upload', 'download']) {
    await command('rm -f /home/node/transfer-ready; touch /home/node/fault-transfer');
    await fs.rm('/tmp/capacity-disconnect-pid', { force: true });
    const transferLocal = await fs.mkdtemp('/tmp/capacity-transfer-');
    await fs.writeFile(transferLocal + '/marker', 'local-before-disconnect\n');
    const transferRemote = spec.remoteCwd + '/disconnect-transfer';
    if (direction === 'download') {
      // Outside the operation, only disposable fixture setup.
      await command(`mkdir -p ${transferRemote}; printf 'remote-after-recovery\n' > ${transferRemote}/marker`);
    }
    await fs.writeFile('/tmp/capacity-disconnect-next', '1');
    process.env.PATH = faultBin + ':' + normalPath;
    const transfer = operation('disconnect-' + direction, () => direction === 'upload'
      ? syncDirectoryToSsh({ spec, localDir: transferLocal, remoteDir: transferRemote })
      : syncDirectoryFromSsh({ spec, localDir: transferLocal, remoteDir: transferRemote, onProgress: () => {} }));
    const rejected = assert.rejects(transfer);
    for (let i = 0; i < 100; i++) {
      if ((await command('test -s /home/node/transfer-ready && echo ready').catch(() => '')).trim() === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const tarPid = Number((await command('cat /home/node/transfer-ready')).trim());
    const sshPid = Number((await fs.readFile('/tmp/capacity-disconnect-pid', 'utf8')).trim());
    assert(tarPid > 1 && sshPid > 1);
    // Keep download recovery unavailable while inspecting the failed transfer.
    // Automatic cleanup must not race the local-data/staging assertions.
    if (direction === 'download') await command(`mv ${transferRemote} ${transferRemote}-unavailable`);
    process.kill(sshPid, 'SIGKILL');
    await rejected;
    process.env.PATH = normalPath;
    await command(`test ! -d /proc/${tarPid}; rm /home/node/fault-transfer`);
    const transferAttempt = await byKey('disconnect-' + direction);
    assert((await queryCommands(transferAttempt.id)).every(row => row.stopped));
    assert.equal(await fs.readFile(transferLocal + '/marker', 'utf8'), 'local-before-disconnect\n');
    if (direction === 'download') {
      assert.equal(transferAttempt.state, 'stopping');
      const obligations = await admission.restorationObligations({ companyId: company.id, attemptId: transferAttempt.id, token: transferAttempt.token });
      const pendingCopy = obligations.find(row => row.descriptor.operation === 'directory_copy_back' && row.status !== 'success');
      assert(pendingCopy);
      await fs.stat(pendingCopy.descriptor.stagingDir); // failed staging survives
      await command(`mv ${transferRemote}-unavailable ${transferRemote}`);
      await reconcileCapacityReservation(db, company.id, transferAttempt.id);
      assert.equal(await fs.readFile(transferLocal + '/marker', 'utf8'), 'remote-after-recovery\n');
    }
    assert.equal((await byKey('disconnect-' + direction)).state, 'released');
  }

  console.log('PASS phase: upload/download disconnect recovery');
  // A committed launch whose reply/host is lost: a fresh controller fences
  // the runner before adopting cleanup. The original child identity is retained.
  const operationRow = await admission.registerOperation({ ...input, key: 'lost-launch' });
  const reservation = await admission.claimOperation(company.id, operationRow.id);
  const [lease] = await db.insert(environmentLeases).values({ companyId: company.id, environmentId: environment.id,
    provider: 'ssh', status: 'active', metadata: { agentId: agent.id, admissionOperationId: operationRow.id,
      admissionAttemptId: operationRow.id } }).returning();
  const lostOwner = { companyId: company.id, attemptId: operationRow.id, token: reservation.token };
  const authorization = await admission.journalCommand({ ...lostOwner, leaseId: lease.id, commandHash: 'e'.repeat(64) });
  const target = await buildSshSpawnTarget({ spec, admission: authorization, command: 'python3',
    args: ['-c', 'import pathlib,subprocess,time; p=subprocess.Popen(["sleep","60"],start_new_session=True); pathlib.Path("/home/node/lost-ready").write_text(str(p.pid)); time.sleep(60)'], env: {} });
  const { spawn } = await import('node:child_process');
  const ssh = spawn(target.command, target.args, { stdio: 'ignore' });
  const closed = new Promise(resolve => ssh.once('close', resolve));
  for (let i = 0; i < 100; i++) {
    if ((await command('test -s /home/node/lost-ready && echo ready').catch(() => '')).trim() === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const lostDescendant = Number((await command('cat /home/node/lost-ready')).trim());
  const nextEpoch = randomUUID();
  await admission.takeover(nextEpoch);
  const successorDb = createDb(temporary.connectionString);
  try {
    const successor = executionAdmissionService(successorDb, nextEpoch, trustedCapacityPolicy([binding]));
    await assert.rejects(successor.adoptReservation(company.id, operationRow.id), /capacity_runner_epoch_unacknowledged/);
    const nextAck = await updateSshAdmissionEpoch({ spec, fenceRoot, epoch: nextEpoch, previousEpoch: epoch });
    await successor.acknowledgeRunnerEpoch({ companyId: company.id, agentId: agent.id, ...nextAck });
    // The SSH client is severed; no in-memory finally block records its stop.
    ssh.kill('SIGKILL');
    await closed;
    await reconcileCapacityReservation(successorDb, company.id, operationRow.id);
    const [settled] = await successorDb.select().from(admissionAttempts).where(eq(admissionAttempts.id, operationRow.id));
    assert.equal(settled.state, 'released');
    const [retained] = await successorDb.select().from(admissionCommands).where(eq(admissionCommands.id, authorization.binding.attemptId));
    assert.deepEqual(retained.binding, authorization.binding);
    assert.equal(retained.stopped, true);
    await command(`test ! -d /proc/${lostDescendant}`);
    const replay = await buildSshSpawnTarget({ spec, admission: authorization, command: 'touch', args: ['/home/node/replayed'], env: {} });
    await assert.rejects(exec(replay.command, replay.args));
    await replay.cleanup();
    await command('test ! -e /home/node/replayed');
    await reconcileCapacityReservation(successorDb, company.id, operationRow.id); // settled retry is inert
    // Abrupt runner loss deliberately lacks a descendant-stop receipt. Persisted
    // journals must retain capacity; neither a fresh process list nor the
    // runner's successful restart may manufacture historical stop evidence.
    await successorDb.update(admissionScheduler).set({ draining: false });
    const restartOperation = await successor.registerOperation({ ...input, key: 'runner-restart' });
    const restartReservation = await successor.claimOperation(company.id, restartOperation.id);
    assert(restartReservation?.token);
    const [restartLease] = await successorDb.insert(environmentLeases).values({ companyId: company.id, environmentId: environment.id,
      provider: 'ssh', status: 'active', metadata: { agentId: agent.id, admissionOperationId: restartOperation.id,
        admissionAttemptId: restartOperation.id } }).returning();
    const restartOwner = { companyId: company.id, attemptId: restartOperation.id, token: restartReservation.token };
    const restartAuthorization = await successor.journalCommand({ ...restartOwner, leaseId: restartLease.id, commandHash: 'f'.repeat(64) });
    const restartTarget = await buildSshSpawnTarget({ spec, admission: restartAuthorization, command: 'sh',
      args: ['-c', 'echo ready > /home/node/restart-ready; sleep 60'], env: {} });
    const restartSsh = spawn(restartTarget.command, restartTarget.args, { stdio: 'ignore' });
    const restartClosed = new Promise(resolve => restartSsh.once('close', resolve));
    try {
      for (let i = 0; i < 100; i++) {
        if ((await command('test -s /home/node/restart-ready && echo ready').catch(() => '')).trim() === 'ready') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const controlRoot = fenceRoot + '/attempts/' + restartAuthorization.binding.attemptId;
      await command(`python3 -c ${shellQuote('import os,json,signal; os.kill(json.load(open("' + controlRoot + '/started.json"))["pid"],signal.SIGSTOP)')}`);
      await command('touch /home/node/.capacity-restart-request').catch(() => {});
      let restarted = false;
      for (let i = 0; i < 100; i++) {
        if ((await command('test -e /home/node/.capacity-restarted && echo ready').catch(() => '')).trim() === 'ready') { restarted = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(restarted, true);
      await restartClosed;
      await command(`test ! -e ${controlRoot}/stopped.json`);
      await assert.rejects(reconcileCapacityReservation(successorDb, company.id, restartOperation.id), /unverified/);
      const [unresolved] = await successorDb.select().from(admissionAttempts).where(eq(admissionAttempts.id, restartOperation.id));
      assert.equal(unresolved.state, 'stopping');
      assert.equal((await queryCommands(restartOperation.id))[0].stopped, false);
      const waitingOperation = await successor.registerOperation({ ...input, key: 'blocked-after-restart' });
      assert.equal(await successor.claimOperation(company.id, waitingOperation.id), null);
    } finally {
      restartSsh.kill('SIGKILL');
      await restartClosed;
      await assert.rejects(restartTarget.cleanup(), /unverified/);
    }

  } finally {
    await target.cleanup();
    await successorDb.$client.end();
  }
  console.log('PASS: actual durable environment probe/lifecycle with no heartbeat rows, tar/Git journalling and copy-back, partial-restoration hold, exact setup descendant cancellation, partial-state recovery, lost-client/launch-response epoch adoption without replay and subsequent progress');
} finally {
  await db.$client.end();
  await temporary.cleanup();
}
