"""Disposable pure filesystem tests; no host/runtime/process/network access."""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import runtime_provenance_inventory as provenance


class RuntimeProvenanceInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'saved.json').write_bytes(b'{"snapRevision":"8702"}\n')

    def inventory(self, paths=(('saved.json', 'saved-observation'),)):
        return provenance.inventory(self.root, paths)

    def test_exact_hash_determinism_and_observation_class(self):
        one = self.inventory(); self.assertEqual(one, self.inventory())
        row = one['files'][0]
        self.assertEqual(row['sha256'], hashlib.sha256((self.root / 'saved.json').read_bytes()).hexdigest())
        self.assertFalse(row['verifiedRuntimeProvenance'])
        self.assertFalse(one['runtimeProvenanceVerified'])
        self.assertFalse(one['operationalAcceptance'])

    def test_source_and_build_labels_never_verify_provenance(self):
        for label in ('runtime-source-candidate', 'build-provenance-candidate'):
            self.assertFalse(self.inventory((('saved.json', label),))['files'][0]['verifiedRuntimeProvenance'])

    def test_missing_is_explicit_without_claiming_global_absence(self):
        row = self.inventory((('missing/file', 'runtime-source-candidate'),))['files'][0]
        self.assertEqual(row['status'], 'missing'); self.assertNotIn('sha256', row)

    def test_noncanonical_absolute_and_escape_paths_refuse(self):
        for path in ('/etc/passwd', '../saved.json', 'x/../saved.json', './saved.json',
                     'x//saved.json', '', 'saved.json/', 'x\\y', '\x00'):
            with self.subTest(path=path), self.assertRaises(provenance.InventoryError):
                self.inventory(((path, 'saved-observation'),))

    def test_symlink_file_or_parent_refuses(self):
        (self.root / 'link').symlink_to('saved.json')
        (self.root / 'parent').symlink_to(self.root, target_is_directory=True)
        for path in ('link', 'parent/saved.json'):
            with self.assertRaises(provenance.InventoryError):
                self.inventory(((path, 'saved-observation'),))

    def test_special_files_refuse_without_blocking(self):
        os.mkfifo(self.root / 'fifo')
        for path in ('fifo', 'directory'):
            if path == 'directory': (self.root / path).mkdir()
            with self.assertRaises(provenance.InventoryError):
                self.inventory(((path, 'saved-observation'),))

    def test_file_and_total_byte_bounds(self):
        with patch.object(provenance, 'MAX_FILE_BYTES', 8):
            with self.assertRaises(provenance.InventoryError): self.inventory()
        with patch.object(provenance, 'MAX_TOTAL_BYTES', 8):
            with self.assertRaises(provenance.InventoryError): self.inventory()

    def test_duplicate_unknown_or_unbounded_selections_refuse(self):
        for paths in ((), (('saved.json', 'source-proven'),),
                      (('saved.json', 'saved-observation'),)*2,
                      tuple(('missing' + str(i), 'saved-observation') for i in range(33)),
                      (('saved.json',),)):
            with self.assertRaises(provenance.InventoryError): self.inventory(paths)

    def test_only_selected_file_read_not_recursive_scan(self):
        (self.root / 'unselected').mkdir(); os.mkfifo(self.root / 'unselected' / 'fifo')
        self.assertEqual(len(self.inventory()['files']), 1)
