"""Real subreaper/epoch regressions; no provider, credentials or cluster."""
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

PACKAGE = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('assemble', PACKAGE / 'images/controller/ssh-admission/assemble.py')
assembly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assembly)
SOURCES = assembly.sources()


class SupervisorFenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='supervisor-fence-')
        self.directory = Path(self.temporary.name)
        self.fence = self.directory / 'runner-control'
        self.binding = {key: str(uuid.uuid4()) for key in
                        ['epoch','companyId','agentId','runId','attemptId','environmentId','leaseId','invocationId']}
        self.processes = []
        self.assertEqual(self.epoch('initialize').returncode, 0)

    def tearDown(self):
        for proc, binding in self.processes:
            if proc.poll() is None:
                self.stop(binding)
                proc.wait(timeout=5)
            proc.stdout.close()
            proc.stderr.close()
        self.temporary.cleanup()

    def arguments(self, source, *args):
        return [sys.executable, '-I', '-c', SOURCES[source], str(self.fence), *args]

    def epoch(self, operation, envelope=None):
        return subprocess.run(self.arguments('epoch', operation, json.dumps(envelope or self.binding)),
                              capture_output=True, text=True, timeout=5)

    def start(self, binding=None, code=None, source=None):
        binding = binding or self.binding
        code = code or f'from pathlib import Path;Path({str(self.directory / "starts")!r}).open("a").write("start\\n")'
        args = self.arguments('supervisor', shlex.join([sys.executable, '-c', code]), json.dumps(binding))
        if source:
            args[3] = source
        proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append((proc, binding))
        return proc

    def stop(self, binding=None):
        return subprocess.run(self.arguments('stop', json.dumps(binding or self.binding)),
                              capture_output=True, text=True, timeout=15)

    def wait_for(self, predicate):
        until = time.monotonic() + 5
        while not predicate():
            self.assertLess(time.monotonic(), until, 'condition not reached')
            time.sleep(.02)

    def changed(self, **values):
        return {**self.binding, **values}

    def sibling(self):
        return self.changed(attemptId=str(uuid.uuid4()), invocationId=str(uuid.uuid4()), runId=str(uuid.uuid4()))

    def test_duplicate_launch_consumed_once_even_after_natural_exit(self):
        processes = [self.start() for _ in range(8)]
        codes = [proc.wait(timeout=5) for proc in processes]
        self.assertEqual(codes.count(0), 1)
        self.assertEqual((self.directory / 'starts').read_text(), 'start\n')
        self.assertNotEqual(self.start().wait(timeout=5), 0)

    def test_takeover_rejects_old_start_allows_fresh_attempt(self):
        epoch = str(uuid.uuid4())
        self.assertEqual(self.epoch('takeover', {'previousEpoch': self.binding['epoch'], 'epoch': epoch}).returncode, 0)
        self.assertNotEqual(self.start().wait(timeout=5), 0)
        self.assertEqual(self.start(self.changed(epoch=epoch)).wait(timeout=5), 0)
        self.assertEqual((self.directory / 'starts').read_text(), 'start\n')

    def test_takeover_is_compare_and_set_and_epochs_cannot_be_reused(self):
        new_epoch = str(uuid.uuid4())
        value = {'previousEpoch': self.binding['epoch'], 'epoch': new_epoch}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.epoch('takeover', value), range(4)))
        self.assertEqual(sum(result.returncode == 0 for result in results), 1)
        reused = self.epoch('takeover', {'previousEpoch': new_epoch, 'epoch': self.binding['epoch']})
        self.assertIn('epoch_reused', reused.stderr)
        self.assertNotEqual(self.epoch('initialize').returncode, 0)

    def test_stop_before_start_blocks_every_late_duplicate(self):
        result = self.stop()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['binding'], self.binding)
        self.assertNotEqual(self.start().wait(timeout=5), 0)
        self.assertFalse((self.directory / 'starts').exists())

    def test_changed_binding_cannot_stop_or_replay_an_attempt(self):
        self.assertEqual(self.start().wait(timeout=5), 0)
        for field in self.binding:
            if field == 'attemptId':
                continue
            value = self.changed(**{field: str(uuid.uuid4())})
            self.assertNotEqual(self.start(value).wait(timeout=5), 0, field)
            self.assertNotEqual(self.stop(value).returncode, 0, field)

    def test_invocation_cannot_be_reused_under_a_different_attempt(self):
        self.assertEqual(self.start().wait(timeout=5), 0)
        binding = self.changed(attemptId=str(uuid.uuid4()))
        self.assertNotEqual(self.start(binding).wait(timeout=5), 0)
        self.assertNotEqual(self.stop(binding).returncode, 0)

    def test_detached_child_cancel_after_takeover_preserves_sibling(self):
        pid_file = self.directory / 'detached.pid'
        code = f'''import os,signal,time,pathlib
pid=os.fork()
if pid==0:
 os.setsid();signal.signal(signal.SIGTERM,signal.SIG_IGN)
 pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()))
while True:time.sleep(.02)
'''
        a = self.start(code=code)
        ticks = self.directory / 'ticks'
        b = self.start(self.sibling(), f'import pathlib,time\np=pathlib.Path({str(ticks)!r})\nwhile True:\n p.write_text(str(time.monotonic()));time.sleep(.02)')
        self.wait_for(lambda: pid_file.exists() and pid_file.stat().st_size and ticks.exists() and ticks.stat().st_size)
        pid = int(pid_file.read_text())
        self.assertEqual(self.epoch('takeover', {'previousEpoch': self.binding['epoch'], 'epoch': str(uuid.uuid4())}).returncode, 0)
        result = self.stop()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['binding'], self.binding)
        a.wait(timeout=5)
        self.assertFalse(Path('/proc', str(pid)).exists())
        self.assertIsNone(b.poll())
        before = ticks.read_text()
        self.wait_for(lambda: ticks.read_text() != before)

    def test_epoch_lock_covers_actual_popen(self):
        ready, release = self.directory / 'at-popen', self.directory / 'release'
        source = SOURCES['supervisor'].replace(
            "    child = subprocess.Popen(",
            f"    Path({str(ready)!r}).touch()\n    while not Path({str(release)!r}).exists(): time.sleep(.01)\n    child = subprocess.Popen(")
        self.assertNotEqual(source, SOURCES['supervisor'])
        proc = self.start(source=source)
        self.wait_for(ready.exists)
        takeover = subprocess.Popen(self.arguments('epoch', 'takeover', json.dumps({
            'previousEpoch': self.binding['epoch'], 'epoch': str(uuid.uuid4())})), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            time.sleep(.15)
            self.assertIsNone(takeover.poll(), 'takeover crossed the Popen lock')
            release.touch()
            self.assertEqual(proc.wait(timeout=5), 0)
            self.assertEqual(takeover.wait(timeout=5), 0)
        finally:
            release.touch()
            takeover.communicate(timeout=5)

    def test_crash_after_consumption_is_not_replayed(self):
        self.assertEqual(self.stop().returncode, 0)
        directory = self.fence / 'attempts' / self.binding['attemptId']
        (directory / 'requested').unlink()
        (directory / 'stopped.json').unlink()
        (directory / 'started.json').write_text('{}')
        (directory / 'error.json').write_text('{}')
        self.assertNotEqual(self.start().wait(timeout=5), 0)
        self.assertNotEqual(self.stop().returncode, 0)
        self.assertFalse((directory / 'stopped.json').exists())
        self.assertFalse((self.directory / 'starts').exists())

    def test_missing_epoch_never_initializes_on_start(self):
        (self.fence / 'epoch.json').unlink()
        self.assertNotEqual(self.start().wait(timeout=5), 0)
        self.assertFalse((self.directory / 'starts').exists())

    def test_noncanonical_identity_and_unknown_fields_fail_closed(self):
        for binding in [self.changed(attemptId='../escape'), self.changed(epoch=self.binding['epoch'].upper()),
                        {**self.binding, 'unexpected': 'value'}]:
            self.assertNotEqual(self.start(binding).wait(timeout=5), 0)
        self.assertFalse((self.directory / 'starts').exists())

    def test_provider_stdin_output_exit_and_receipt_are_preserved(self):
        command = shlex.join([sys.executable, '-c', 'import sys;print(sys.stdin.read());sys.exit(7)'])
        result = subprocess.run(self.arguments('supervisor', command, json.dumps(self.binding)),
                                input='original input', text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual(result.stdout, 'original input\n')
        self.assertEqual(json.loads(self.stop().stdout)['binding'], self.binding)


if __name__ == '__main__':
    unittest.main(verbosity=2)
