// Real credential-free SSH test of the candidate transport, outside heartbeat.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildSshSpawnTarget, runSshCommand, shellQuote, updateSshAdmissionEpoch } from '/app/packages/adapter-utils/src/ssh.ts';
const spec = JSON.parse(await fs.readFile('/fixture/spec.json', 'utf8'));
const fenceRoot = '/home/node/admission-fixture';
const binding = Object.fromEntries(['epoch','companyId','agentId','runId','attemptId','environmentId','leaseId','invocationId'].map(key => [key, randomUUID()]));
const admission = { fenceRoot, binding };
const command = async script => (await runSshCommand(spec, script)).stdout;
const target = async (authorization = admission, script = 'printf provider-ok') => buildSshSpawnTarget({
  spec, command: 'sh', args: ['-c', script], env: {}, admission: authorization,
});
const launch = transport => {
  const proc = spawn(transport.command, transport.args, {stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  proc.stdout.on('data', chunk => { stdout += chunk; });
  proc.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => resolve({code, stdout, stderr}));
  });
};
await updateSshAdmissionEpoch({ spec, fenceRoot, epoch: binding.epoch });
await assert.rejects(updateSshAdmissionEpoch({ spec, fenceRoot, epoch: binding.epoch }));
await assert.rejects(target({ fenceRoot, binding: {...binding, attemptId: '../escape'} }));
const first = await target();
try {
  assert.equal(first.sshInvocationId, binding.invocationId);
  const results = await Promise.all([launch(first), launch(first)]);
  assert.equal(results.filter(result => result.code === 0).length, 1);
  assert.equal(results.find(result => result.code === 0).stdout, 'provider-ok');
} finally { await first.cleanup(); }
const prevented = {...admission, binding: {...binding, attemptId: randomUUID(), invocationId: randomUUID()}};
const cancelled = await target(prevented, 'touch /home/node/forbidden-late-launch');
try {
  await cancelled.stopRemote();
  assert.notEqual((await launch(cancelled)).code, 0);
  await command('test ! -e /home/node/forbidden-late-launch');
} finally { await cancelled.cleanup(); }
// The transport snapshots journal authority before createSshAuthArgs awaits.
const originalInvocation = randomUUID();
const mutable = {...admission, binding: {...binding, attemptId: randomUUID(), invocationId: originalInvocation}};
const pending = target(mutable);
mutable.binding.invocationId = randomUUID();
mutable.fenceRoot = '/home/node/wrong-root';
const snapshot = await pending;
try {
  assert.equal(snapshot.sshInvocationId, originalInvocation);
  assert.equal((await launch(snapshot)).code, 0);
} finally { await snapshot.cleanup(); }
const stale = await target({...admission, binding: {...binding, attemptId: randomUUID(), invocationId: randomUUID()}});
const nextEpoch = randomUUID();
try {
  await updateSshAdmissionEpoch({spec, fenceRoot, epoch: nextEpoch, previousEpoch: binding.epoch});
  assert.notEqual((await launch(stale)).code, 0);
  // Old-epoch stop remains available, even for an attempt denied before launch.
} finally { await stale.cleanup(); }
await assert.rejects(updateSshAdmissionEpoch({spec, fenceRoot, epoch: randomUUID(), previousEpoch: binding.epoch}));
// Reject a forged/mismatched receipt even when `stopped` is true.
const mismatchAuth = {...admission, binding: {...binding, epoch: nextEpoch, attemptId: randomUUID(), invocationId: randomUUID()}};
const mismatch = await target(mismatchAuth);
try {
  assert.equal((await launch(mismatch)).code, 0);
  const control = `${fenceRoot}/attempts/${mismatchAuth.binding.attemptId}`;
  await command(`printf '%s' ${shellQuote(JSON.stringify({stopped:true,binding:{...mismatchAuth.binding, leaseId:randomUUID()}}))} > ${shellQuote(control + '/stopped.json')}; touch ${shellQuote(control + '/error.json')}`);
  await assert.rejects(mismatch.stopRemote());
} finally {
  await assert.rejects(mismatch.cleanup());
}
// Existing unadmitted path is retained while native policy remains disabled.
const legacy = await buildSshSpawnTarget({spec, command:'printf', args:['legacy-ok'], env:{}});
try { assert.equal((await launch(legacy)).stdout, 'legacy-ok'); }
finally { await legacy.cleanup(); }
console.log('PASS: real SSH transport fixed journal identity, duplicate denial, pre-start cancellation, snapshot, epoch CAS/stale rejection, exact receipt validation and legacy cancellation compatibility');
