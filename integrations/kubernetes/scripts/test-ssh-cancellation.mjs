// Runs inside the patched controller against a credential-free rootless runner.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { runChildProcess, runningProcesses } from '/app/packages/adapter-utils/src/server-utils.ts';
import { runSshCommand } from '/app/packages/adapter-utils/src/ssh.ts';
const spec = JSON.parse(await fs.readFile('/fixture/spec.json', 'utf8'));
const command = async script => (await runSshCommand(spec, script)).stdout;
const waitFor = async check => {
  const until = Date.now() + 15000;
  while (!(await check())) {
    assert(Date.now() < until, 'Timed out waiting for remote fixture');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
const opts = { cwd: '/tmp', env: {}, timeoutSec: 30, graceSec: 2,
  onLog: async () => {}, remoteExecution: spec };
const aCode = `import os,signal,time,pathlib
p=os.fork()
if p==0:
 os.setsid();signal.signal(signal.SIGTERM,signal.SIG_IGN)
 pathlib.Path('a.pid').write_text(str(os.getpid()))
 while True:time.sleep(.05)
else:
 while True:time.sleep(.05)
`;
const bCode = `import os,time,pathlib
pathlib.Path('b.pid').write_text(str(os.getpid()))
for i in range(70):
 pathlib.Path('b.ticks').write_text(str(i));time.sleep(.1)
print('sibling-complete')`;
await command('mkdir -p /home/node/workspaces/cancellation-fixture');
spec.remoteCwd = '/home/node/workspaces/cancellation-fixture';
const a = runChildProcess('fixture-a', 'python3', ['-c', aCode], opts);
const b = runChildProcess('fixture-b', 'python3', ['-c', bCode], opts);
// opts retains spec by reference; both runs deliberately share a cwd, proving
// invocation ownership rather than workspace-based kill selection.
await waitFor(async () => (await command('test -s /home/node/workspaces/cancellation-fixture/a.pid && test -s /home/node/workspaces/cancellation-fixture/b.pid && echo ready').catch(() => '')) === 'ready\n');
const before = await command('cat /home/node/workspaces/cancellation-fixture/b.ticks');
assert(runningProcesses.get('fixture-a')?.stopRemote);
const start = Date.now();
await runningProcesses.get('fixture-a').stopRemote();
const stopped = await a;
assert(stopped.remoteProcessStopped, 'No verified remote stop');
assert.match(stopped.sshInvocationId, /^[0-9a-f-]{36}$/);
assert(Date.now() - start < 6000, 'Remote stop exceeded six seconds');
await command('test ! -e /proc/$(cat /home/node/workspaces/cancellation-fixture/a.pid)');
await command('test -d /proc/$(cat /home/node/workspaces/cancellation-fixture/b.pid)');
assert.notEqual(await command('cat /home/node/workspaces/cancellation-fixture/b.ticks'), before);
const completed = await b;
assert.equal(completed.exitCode, 0);
assert(completed.remoteProcessStopped);
assert.notEqual(completed.sshInvocationId, stopped.sshInvocationId);
assert.match(completed.stdout, /sibling-complete/);
assert(!runningProcesses.has('fixture-a') && !runningProcesses.has('fixture-b'));
// Timeout must execute the same verified remote descendant cleanup.
const timeout = await runChildProcess('fixture-timeout', 'python3', ['-c', aCode], {...opts, timeoutSec: 1});
assert(timeout.timedOut);
assert(timeout.remoteProcessStopped);
await command('test ! -e /proc/$(cat /home/node/workspaces/cancellation-fixture/a.pid)');
// A locally resolvable SSH executable with a missing interpreter emits spawn
// ENOENT. Its subsequent remote-cleanup failure must be handled, not crash Node.
const broken = await fs.mkdtemp('/tmp/cancellation-broken-ssh-');
await fs.writeFile(broken + '/ssh', '#!/missing-evaluation-interpreter\n', {mode: 0o755});
const cleanupErrors = [];
try {
  await assert.rejects(runChildProcess('fixture-spawn-error', 'python3', ['-c', 'pass'], {
    ...opts, env: { PATH: broken + ':' + process.env.PATH },
    remoteExecution: { ...spec, host: '127.0.0.1', port: 1, privateKey: null, knownHosts: null },
    onLogError: (_error, _runId, message) => cleanupErrors.push(message),
  }));
  await waitFor(async () => cleanupErrors.includes('failed to verify command cleanup after spawn error'));
} finally { await fs.rm(broken, {recursive: true, force: true}); }
console.log('PASS: real SSH simultaneous processes, detached TERM-ignoring descendant stop, same-cwd sibling survival/completion, verified timeout and spawn-error cleanup');
