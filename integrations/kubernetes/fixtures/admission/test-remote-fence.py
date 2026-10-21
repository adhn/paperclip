import concurrent.futures
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid

script = Path(__file__).with_name('remote-fence.py')
spec = importlib.util.spec_from_file_location('remote_fence', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='admission-fence-')
        self.root = Path(self.temporary.name)
        self.binding = {k: str(uuid.uuid4()) for k in
                        ['epoch','companyId','agentId','runId','attemptId','environmentId','leaseId','invocationId']}
        module.gate(self.root, 'initialize', self.binding)

    def tearDown(self):
        self.temporary.cleanup()

    def start(self, binding=None):
        return subprocess.run([sys.executable, str(script), str(self.root), 'start',
                               json.dumps(binding or self.binding), sys.executable, '-c',
                               'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.open("a").write("start\\n")',
                               str(self.root / 'starts')], capture_output=True, text=True, timeout=10)

    def test_duplicate_authorization_starts_exactly_once(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.start(), range(8)))
        self.assertEqual(sum(x.returncode == 0 for x in results), 1)
        self.assertEqual((self.root / 'starts').read_text(), 'start\n')

    def test_delayed_old_start_rejected_after_takeover(self):
        new_epoch = str(uuid.uuid4())
        module.gate(self.root, 'takeover', {'previousEpoch': self.binding['epoch'], 'epoch': new_epoch})
        self.assertEqual(self.start().returncode, 125)
        self.assertFalse((self.root / 'starts').exists())
        self.assertEqual(self.start({**self.binding, 'epoch': new_epoch}).returncode, 0)
        with self.assertRaisesRegex(RuntimeError, 'stale_takeover'):
            module.gate(self.root, 'takeover', {'previousEpoch': self.binding['epoch'], 'epoch': str(uuid.uuid4())})

    def test_queued_cancel_tombstone_blocks_late_launch(self):
        module.gate(self.root, 'cancel', self.binding)
        self.assertEqual(self.start().returncode, 125)
        self.assertFalse((self.root / 'starts').exists())
        self.assertFalse((self.root / self.binding['attemptId'] / 'stopped.json').exists())

    def test_same_attempt_cannot_change_binding_or_invocation(self):
        self.assertEqual(self.start().returncode, 0)
        for key in ['companyId','agentId','runId','environmentId','leaseId','invocationId']:
            changed = {**self.binding, key: str(uuid.uuid4())}
            self.assertEqual(self.start(changed).returncode, 125)
            with self.assertRaisesRegex(RuntimeError, 'binding_changed'):
                module.gate(self.root, 'cancel', changed)

    def test_distinct_sibling_attempts_do_not_share_tombstones(self):
        module.gate(self.root, 'cancel', self.binding)
        sibling = {**self.binding, 'attemptId': str(uuid.uuid4()), 'runId': str(uuid.uuid4()), 'invocationId': str(uuid.uuid4())}
        self.assertEqual(self.start(sibling).returncode, 0)
        self.assertEqual(self.start().returncode, 125)

    def test_crash_after_journal_before_spawn_does_not_replay(self):
        directory = self.root / self.binding['attemptId']
        directory.mkdir()
        module.store(directory / 'binding.json', self.binding)
        self.assertEqual(self.start().returncode, 125)
        self.assertFalse((self.root / 'starts').exists())


if __name__ == '__main__':
    unittest.main()
