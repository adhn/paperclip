#!/usr/bin/env python3
"""Apply a fail-closed, exact-source SSH cancellation backport to the pinned build."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
context = Path(sys.argv[1])
expected = json.loads((root / 'images/controller/ssh-cancellation/source-sha256.json').read_text())
for name, digest in expected.items():
    assert hashlib.sha256((context / name).read_bytes()).hexdigest() == digest, 'Unexpected upstream source: ' + name

def edit(name, replacements):
    p = context / name
    value = p.read_text()
    for before, after in replacements:
        assert value.count(before) == 1, 'Patch anchor changed: ' + name + ': ' + before[:80]
        value = value.replace(before, after, 1)
    p.write_text(value)

supervisor = (root / 'images/controller/ssh-cancellation/supervisor.py').read_text()
stop = (root / 'images/controller/ssh-cancellation/stop.py').read_text()
ssh = 'packages/adapter-utils/src/ssh.ts'
edit(ssh, [
 ('export async function buildSshSpawnTarget(input:', 'const EVALUATION_SSH_SUPERVISOR = ' + json.dumps(supervisor) + ';\nconst EVALUATION_SSH_STOP = ' + json.dumps(stop) + ';\n\nexport async function buildSshSpawnTarget(input:'),
 ('  cleanup: () => Promise<void>;\n}> {\n  for (const key of Object.keys(input.env))', '  cleanup: () => Promise<void>;\n  stopRemote: () => Promise<void>;\n}> {\n  for (const key of Object.keys(input.env))'),
 ('  const remoteCommandParts = [shellQuote(input.command), ...input.args.map((arg) => shellQuote(arg))].join(" ");', '''  const invocationDir = path.posix.join(input.spec.remoteCwd, ".paperclip-runtime", "process-control", randomUUID());
  const providerCommand = [shellQuote(input.command), ...input.args.map((arg) => shellQuote(arg))].join(" ");
  // Linux/Python are explicit prerequisites of these pinned evaluation runners.
  const remoteCommandParts = ["python3", "-I", "-c", shellQuote(EVALUATION_SSH_SUPERVISOR), shellQuote(invocationDir), shellQuote(providerCommand)].join(" ");
  let stopPromise: Promise<void> | undefined;
  const stopRemote = () => {
    if (!stopPromise) {
      stopPromise = runSshCommand(input.spec,
        ["python3", "-I", "-c", shellQuote(EVALUATION_SSH_STOP), shellQuote(invocationDir)].join(" "),
        { timeoutMs: 20_000 }).then(({ stdout }) => {
          if (JSON.parse(stdout).stopped !== true) throw new Error("Remote descendant stop is unverified");
        }).catch((error) => { stopPromise = undefined; throw error; });
    }
    return stopPromise;
  };'''),
 ('    cleanup: auth.cleanup,\n  };\n}\n\nexport async function syncDirectoryToSsh', '''    stopRemote,
    cleanup: async () => {
      try { await stopRemote(); } finally { await auth.cleanup(); }
    },
  };
}

export async function syncDirectoryToSsh''')])
edit('packages/adapter-utils/src/server-utils.ts', [
 ('export interface RunProcessResult {', 'export interface RunProcessResult {\n  remoteProcessStopped?: boolean;'),
 ('interface RunningProcess {\n  child: ChildProcess;', 'interface RunningProcess {\n  stopRemote?: () => Promise<void>;\n  child: ChildProcess;'),
 ('interface SpawnTarget {\n  command: string;', 'interface SpawnTarget {\n  stopRemote?: () => Promise<void>;\n  command: string;'),
 ('      cleanup: spawnTarget.cleanup,', '      cleanup: spawnTarget.cleanup,\n      stopRemote: spawnTarget.stopRemote,'),
 ('          void target.cleanup?.();', '          void Promise.resolve().then(() => target.cleanup?.()).catch((error) => {\n            onLogError(error, runId, "failed to verify command cleanup after spawn error");\n          });'),
 ('        runningProcesses.set(runId, {\n          child,', '        runningProcesses.set(runId, {\n          stopRemote: target.stopRemote,\n          child,'),
 ('''            runningProcesses.delete(runId);
            void logChain.finally(() => {
              void Promise.resolve()
                .then(() => target.cleanup?.())
                .finally(() => {
                  resolve({''', '''            // Keep ownership until remote descendants are verified stopped.
            // Cleanup failure rejects execution instead of becoming a false receipt.
            void logChain.then(() => target.cleanup?.()).then(() => {
                  runningProcesses.delete(runId);
                  resolve({
                    remoteProcessStopped: Boolean(target.stopRemote),'''),
 ('''                  });
                });
            });
          },
        );''', '''                  });
            }).catch(reject);
          },
        );''')])
edit('packages/adapter-utils/src/execution-target.ts', [
 ('(!result.timedOut && !result.signal && result.exitCode !== null && result.exitCode >= 0 && result.exitCode < 255))', '(result.remoteProcessStopped || (!result.timedOut && !result.signal && result.exitCode !== null && result.exitCode >= 0 && result.exitCode < 255)))')])
edit('server/src/adapters/utils.ts', [(
    'Map<string, { child: ChildProcess; graceSec: number; processGroupId: number | null }>',
    'Map<string, { child: ChildProcess; graceSec: number; processGroupId: number | null; stopRemote?: () => Promise<void> }>'
)])
edit('server/src/services/heartbeat/run-control.ts', [(
    '''            if (running) {
              await terminateHeartbeatRunProcess({
                pid: running.child.pid,
                processGroupId: running.processGroupId,
                // Codex handles Ctrl-C by cancelling its tool sessions. SIGTERM
                // can leave commands in their separate process groups alive.
                signal: !control && agent?.adapterType === "codex_local" ? "SIGINT" : undefined,
                graceMs: cancellationTerminationGraceMs(
                  running.graceSec,
                  options.terminationGraceMs,
                ),
              });
            }''',
    '''            if (running) {
              // Do not acknowledge cancellation on local SSH-client exit alone.
              // Failure leaves cancellation unverified and propagates to the operator.
              await running.stopRemote?.();
              // Remote proof can arrive after SSH exits. Never signal its old PID.
              if (!running.stopRemote || (running.child.exitCode == null && running.child.signalCode == null)) {
                await terminateHeartbeatRunProcess({
                  pid: running.child.pid,
                  processGroupId: running.processGroupId,
                  // Codex handles Ctrl-C by cancelling its tool sessions. SIGTERM
                  // can leave commands in their separate process groups alive.
                  signal: !control && agent?.adapterType === "codex_local" ? "SIGINT" : undefined,
                  graceMs: cancellationTerminationGraceMs(
                    running.graceSec,
                    options.terminationGraceMs,
                  ),
                });
              }
            }'''
)])
edit('server/src/services/heartbeat/run-control.test.ts', [(
    '  it("constructs without database access, cancellation, or cleanup",',
    (root / 'images/controller/ssh-cancellation/run-control-test.ts.txt').read_text() + '  it("constructs without database access, cancellation, or cleanup",'
), (
    '  it("reports a missing run without entering cancellation",',
    (root / 'images/controller/ssh-cancellation/run-control-exited-test.ts.txt').read_text() + '\n  it("reports a missing run without entering cancellation",'
)])
print('Applied exact-source SSH descendant cancellation backport')
