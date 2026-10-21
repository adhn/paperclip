import os
from pathlib import Path
import tempfile
import unittest
from detached_group_fixture import DetachedGroupFixture, InjectedCrash


class DetachedGroupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        canonical = self.base / 'canonical'
        canonical.mkdir()
        self.group = DetachedGroupFixture(canonical)
        self.attempts = {}
        for name in self.group.roots:
            p = self.base / ('attempt-' + name)
            p.mkdir()
            (p / 'value').write_bytes(name.encode() + b'\x00original')
            (p / 'empty').mkdir()
            self.attempts[name] = p

    def tearDown(self):
        for path in self.base.rglob('*'):
            if path.is_dir():
                path.chmod(0o700)
        self.temp.cleanup()

    def prepare(self):
        return self.group.prepare(self.attempts, self.group.head())

    def test_retained_writable_descriptor_cannot_modify_published_group(self):
        with open(self.attempts['workspace'] / 'value', 'r+b', buffering=0) as old:
            version = self.prepare()
            self.group.activate(version)
            canonical = self.group.root / 'versions' / version / 'workspace' / 'value'
            original = canonical.read_bytes()
            self.assertNotEqual(os.fstat(old.fileno()).st_ino, canonical.stat().st_ino)
            old.seek(0)
            old.write(b'STALE-WRITER')
            os.fsync(old.fileno())
            self.assertTrue((self.attempts["workspace"] / "value").read_bytes().startswith(b"STALE-WRITER"))
            self.assertEqual(canonical.read_bytes(), original)
            self.assertEqual(self.group.inspect(version)['state'], 'current')
            self.assertFalse(self.group.inspect(version)['operational_authority'])

    def test_atomic_head_names_complete_group_only(self):
        a = self.prepare()
        self.group.activate(a)
        old_head = self.group.head()
        for name, path in self.attempts.items():
            (path / 'value').write_bytes(b'new-' + name.encode())
        b = self.prepare()
        self.assertEqual(self.group.head(), old_head)
        self.group.activate(b)
        head = self.group.head()
        self.assertEqual(head['generation'], 2)
        for name in self.group.roots:
            self.assertEqual((self.group.root / 'versions' / head['version'] / name / 'value').read_bytes(), b'new-' + name.encode())
            self.assertTrue((self.group.root / 'versions' / a / name / 'value').read_bytes().endswith(b'original'))
        self.assertEqual(self.group.inspect(a)['state'], 'not-current')

    def test_crash_before_head_keeps_previous_group(self):
        v = self.prepare()
        before = self.group.head()
        with self.assertRaises(InjectedCrash):
            self.group.activate(v, 'before_head')
        self.assertEqual(self.group.head(), before)
        self.assertEqual(self.group.inspect(v)['state'], 'not-current')
        self.assertEqual(self.group.inspect(v)['predecessor'], before)

    def test_crash_after_head_inspect_without_replay(self):
        v = self.prepare()
        with self.assertRaises(InjectedCrash):
            self.group.activate(v, 'after_head')
        self.assertEqual(self.group.inspect(v)['state'], 'current')
        with self.assertRaisesRegex(ValueError, 'CAS'):
            self.group.activate(v)
        self.assertEqual(self.group.head()['generation'], 1)

    def test_stale_predecessor_and_full_group_required(self):
        before = self.group.head()
        a, b = self.prepare(), self.prepare()
        self.group.activate(a)
        with self.assertRaises(ValueError):
            self.group.activate(b)
        with self.assertRaises(ValueError):
            self.group.prepare(self.attempts, before)
        with self.assertRaises(ValueError):
            self.group.prepare({'workspace': self.attempts['workspace']}, self.group.head())

    def test_links_refused(self):
        for kind in ('symlink', 'hardlink'):
            link = self.attempts['workspace'] / 'link'
            if kind == 'symlink':
                link.symlink_to(self.attempts['session'] / 'value')
            else:
                os.link(self.attempts['session'] / 'value', link)
            with self.assertRaises(ValueError):
                self.prepare()
            link.unlink()

    def test_mutation_of_version_is_detected_not_accepted(self):
        v = self.prepare()
        file = self.group.root / 'versions' / v / 'workspace' / 'value'
        file.chmod(0o644)  # Same UID can bypass read-only mode: deliberately characterize.
        file.write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'bytes changed'):
            self.group.activate(v)
        self.assertEqual(self.group.head()['generation'], 0)

    def test_refuses_implicit_reprovision_and_version_path_injection(self):
        with self.assertRaises(FileExistsError):
            DetachedGroupFixture(self.group.root)
        with self.assertRaises(ValueError):
            self.group.inspect('../HEAD')


if __name__ == '__main__':
    unittest.main()
