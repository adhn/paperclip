import copy
import os
from pathlib import Path
import tempfile
import unittest
from authority import Held, digest
from safe_transfer import capture, materialize


class TransferTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ["TEST_ROOT"])
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir(mode=0o700)

    def tearDown(self):
        self.temp.cleanup()

    def test_uncommitted_binary_and_empty_directories_survive(self):
        (self.source / "empty").mkdir()
        (self.source / "uncommitted").write_bytes(b"\x00\xff\x01")
        snapshot = capture(self.source)
        target = self.root / "attempt"
        self.assertEqual(materialize(snapshot, target), snapshot["version"])
        self.assertEqual(capture(target), snapshot)
        self.assertEqual((target / "uncommitted").stat().st_mode & 0o777, 0o600)
        self.assertTrue((target / "empty").is_dir())

    def test_symlink_cannot_read_credential_or_escape(self):
        (self.root / "secret").write_text("not-provider-state")
        (self.source / "escape").symlink_to(self.root / "secret")
        with self.assertRaisesRegex(Held, "unsafe"):
            capture(self.source)

    def test_directory_symlink_refused(self):
        (self.source / "directory").symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(Held, "unsafe"):
            capture(self.source)

    def test_executable_intent_preserved_without_setid(self):
        script = self.source / "script"
        script.write_text("#!/bin/sh\nexit 0\n")
        script.chmod(0o4755)
        snapshot = capture(self.source)
        target = self.root / "attempt"
        materialize(snapshot, target)
        self.assertEqual((target / "script").stat().st_mode & 0o7777, 0o700)

    def test_hardlink_refused(self):
        (self.root / "secret").write_text("not-provider-state")
        os.link(self.root / "secret", self.source / "link")
        with self.assertRaisesRegex(Held, "unsafe"):
            capture(self.source)

    def test_fifo_refused_without_blocking(self):
        os.mkfifo(self.source / "fifo")
        with self.assertRaisesRegex(Held, "unsafe"):
            capture(self.source)

    def test_count_and_size_bounds(self):
        (self.source / "file").write_bytes(b"1234")
        with self.assertRaisesRegex(Held, "byte_limit"):
            capture(self.source, max_bytes=3)
        with self.assertRaisesRegex(Held, "count_limit"):
            capture(self.source, max_files=0)

    def test_existing_destination_never_overwritten(self):
        with self.assertRaises(FileExistsError):
            materialize(capture(self.source), self.source)

    def test_tampered_snapshot_content_refused(self):
        (self.source / "file").write_bytes(b"original")
        snapshot = capture(self.source)
        snapshot["files"]["file"] = b"tampered"
        with self.assertRaisesRegex(Held, "content"):
            materialize(snapshot, self.root / "attempt")
        self.assertEqual((self.source / "file").read_bytes(), b"original")

    def test_forged_snapshot_traversal_refused(self):
        for name in ("../escape", "/absolute", "a//b", "a/./b"):
            manifest = {"directories": [], "files": {name: "a" * 64}}
            snapshot = {"version": digest(manifest), "manifest": manifest, "files": {name: b"unsafe"}}
            with self.subTest(name=name), self.assertRaisesRegex(Held, "path"):
                materialize(snapshot, self.root / "attempt")


if __name__ == "__main__":
    unittest.main(verbosity=2)
