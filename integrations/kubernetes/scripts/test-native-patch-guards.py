"""Real filesystem patch/refusal tests; mock only the VCS revision read.

Actual 64-file Git reconstruction is verified separately. These subprocess cases
prove that interpreter optimization cannot strip the preflight/refusal guards.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class NativePatchGuards(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory)
        script = root / 'package/scripts/patch-native-admission.py'
        script.parent.mkdir(parents=True)
        shutil.copyfile(Path(__file__).with_name('patch-native-admission.py'), script)
        overlay = script.parent.parent / 'images/controller/admission-native'
        (overlay / 'source').mkdir(parents=True)
        context = root / 'context'
        context.mkdir()
        baseline = {'tracked.txt': b'original', 'obsolete.txt': b'original snapshot'}
        candidate = {'tracked.txt': b'candidate', 'new.txt': b'new source'}
        for name, data in baseline.items(): (context / name).write_bytes(data)
        for name, data in candidate.items(): (overlay / 'source' / name).write_bytes(data)
        fingerprint = lambda values: {n: hashlib.sha256(v).hexdigest() for n, v in values.items()}
        manifest = dict(sourceRevision='a' * 40, baselineSha256=fingerprint(baseline),
                        filesSha256=fingerprint(candidate), remove=['obsolete.txt'])
        (overlay / 'manifest.json').write_text(json.dumps(manifest))
        return script, overlay, context

    def run_patch(self, script, context, mode, head='a' * 40):
        code = ("import runpy,sys\nfrom unittest.mock import patch\n"
                "script,context,head=sys.argv[1:]\nsys.argv=[script,context]\n"
                "with patch('subprocess.check_output',return_value=head+'\\n'):\n"
                " runpy.run_path(script,run_name='__main__')\n")
        env = {**os.environ}
        env.pop('PYTHONOPTIMIZE', None)
        if mode == 'environment': env['PYTHONOPTIMIZE'] = '1'
        args = [sys.executable, *(['-O'] if mode == 'flag' else []), '-c', code, str(script), str(context), head]
        return subprocess.run(args, env=env, capture_output=True, timeout=5)

    @staticmethod
    def snapshot(context):
        return {str(p.relative_to(context)): p.read_bytes() for p in context.rglob('*') if p.is_file()}

    def exercise(self, change, *, positive=False, reapply=False):
        for mode in ('normal', 'flag', 'environment'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix='native-patch-guard-') as directory:
                script, overlay, context = self.fixture(directory)
                head = change(overlay, context) or 'a' * 40
                before = self.snapshot(context)
                result = self.run_patch(script, context, mode, head)
                if positive or reapply:
                    self.assertEqual(result.returncode, 0, result.stderr.decode())
                    self.assertEqual(self.snapshot(context), {'tracked.txt': b'candidate', 'new.txt': b'new source'})
                    if not reapply: continue
                    before = self.snapshot(context)
                    result = self.run_patch(script, context, mode, head)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.snapshot(context), before)

    def test_valid_patch_is_identical_in_all_interpreter_modes(self):
        self.exercise(lambda *_: None, positive=True)

    def test_wrong_revision_refuses_before_any_write(self):
        self.exercise(lambda *_: 'b' * 40)

    def test_changed_baseline_refuses_before_any_write(self):
        self.exercise(lambda _overlay, context: (context / 'tracked.txt').write_bytes(b'foreign') and None)

    def test_changed_candidate_refuses_before_any_write(self):
        self.exercise(lambda overlay, _context: (overlay / 'source/new.txt').write_bytes(b'altered') and None)

    def test_preexisting_new_source_refuses_before_any_write(self):
        self.exercise(lambda _overlay, context: (context / 'new.txt').write_bytes(b'foreign') and None)

    def test_missing_baseline_refuses_before_any_write(self):
        self.exercise(lambda _overlay, context: (context / 'obsolete.txt').unlink())

    def test_reapply_refuses_atomically_in_all_interpreter_modes(self):
        self.exercise(lambda *_: None, reapply=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
