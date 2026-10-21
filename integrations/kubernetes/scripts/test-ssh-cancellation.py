#!/usr/bin/env python3
"""Real Linux subprocess regression tests; no models, cluster or credentials."""
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest

scripts = Path(__file__).resolve().parents[1] / 'images/controller/ssh-cancellation'
SUPERVISOR = scripts / 'supervisor.py'
STOP = scripts / 'stop.py'

class CancellationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.processes = []

    def tearDown(self):
        for proc, control in self.processes:
            if proc.poll() is None:
                subprocess.run([sys.executable, str(STOP), str(control)], capture_output=True, timeout=15)
                proc.wait(timeout=5)
            proc.stdout.close()
            proc.stderr.close()
        self.temp.cleanup()

    def start(self, label, code):
        control = self.root / label
        command = shlex.join([sys.executable, '-c', code])
        proc = subprocess.Popen([sys.executable, str(SUPERVISOR), str(control), command],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append((proc, control))
        return proc, control

    def wait_for(self, predicate):
        deadline = time.monotonic() + 5
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail('condition not reached')
            time.sleep(.02)

    def stop(self, control):
        start = time.monotonic()
        result = subprocess.run([sys.executable, str(STOP), str(control)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['stopped'])
        self.assertLess(time.monotonic() - start, 6)

    def test_natural_exit_preserves_output_and_stdin(self):
        root = self.root / 'normal'
        result = subprocess.run([sys.executable, str(SUPERVISOR), str(root),
                                 shlex.join([sys.executable, '-c', 'import sys;print(sys.stdin.read());sys.exit(7)'])],
                                input='original input', text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual(result.stdout, 'original input\n')
        self.stop(root)

    def test_cancel_detached_term_ignoring_child_leaves_sibling_alive(self):
        pid_file = self.root / 'detached.pid'
        code = f'''import os,signal,time,pathlib
pid=os.fork()
if pid==0:
 os.setsid();signal.signal(signal.SIGTERM,signal.SIG_IGN)
 pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()))
 while True:time.sleep(.02)
else:
 while True:time.sleep(.02)
'''
        a, control_a = self.start('a', code)
        ticks = self.root / 'b-ticks'
        b, control_b = self.start('b', f'import pathlib,time\np=pathlib.Path({str(ticks)!r})\nwhile True:\n p.write_text(str(time.monotonic()));time.sleep(.02)')
        self.wait_for(lambda: pid_file.exists() and pid_file.stat().st_size > 0 and ticks.exists() and ticks.stat().st_size > 0)
        pid = int(pid_file.read_text())
        before = ticks.read_text()
        self.stop(control_a)
        a.wait(timeout=5)
        self.assertFalse(Path('/proc', str(pid)).exists(), 'detached child survived/reaped too early')
        self.assertIsNone(b.poll(), 'sibling stopped')
        self.wait_for(lambda: ticks.read_text() != before)
        self.stop(control_b)
        b.wait(timeout=5)
        self.stop(control_a)  # idempotence

    def test_stop_before_late_start_prevents_execution(self):
        control = self.root / 'late'
        marker = self.root / 'must-not-exist'
        self.stop(control)
        result = subprocess.run([sys.executable, str(SUPERVISOR), str(control),
                                 shlex.join([sys.executable, '-c', f'open({str(marker)!r},"w").write("bad")'])],
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 125)
        self.assertFalse(marker.exists())

    def test_normal_leader_exit_drains_background_child(self):
        pid_file = self.root / 'background.pid'
        proc, control = self.start('background', f'''import os,time,pathlib
pid=os.fork()
if pid==0:
 os.setsid();pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()))
 while True:time.sleep(.02)
time.sleep(.1)
''')
        self.wait_for(lambda: pid_file.exists() and pid_file.stat().st_size > 0)
        pid = int(pid_file.read_text())
        proc.wait(timeout=5)
        self.assertEqual(proc.returncode, 0, proc.stderr.read())
        self.assertFalse(Path('/proc', str(pid)).exists())
        self.assertTrue(json.loads((control/'stopped.json').read_text())['stopped'])

    def test_supervisor_ignores_workspace_python_module_shadows(self):
        (self.root/'ctypes.py').write_text('raise RuntimeError("workspace module loaded")')
        (self.root/'json.py').write_text('raise RuntimeError("workspace module loaded")')
        result = subprocess.run([sys.executable, '-I', '-c', SUPERVISOR.read_text(),
                                 str(self.root/'isolated'), 'printf provider-works'],
                                cwd=self.root, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'provider-works')

    def test_supervisor_error_is_not_a_stop_receipt(self):
        control = self.root / 'failed'
        control.mkdir()
        (control/'started.json').write_text('{}')
        (control/'error.json').write_text('{}')
        result = subprocess.run([sys.executable,str(STOP),str(control)],capture_output=True,timeout=3)
        self.assertNotEqual(result.returncode,0)
        self.assertFalse((control/'stopped.json').exists())

if __name__ == '__main__':
    unittest.main(verbosity=2)
