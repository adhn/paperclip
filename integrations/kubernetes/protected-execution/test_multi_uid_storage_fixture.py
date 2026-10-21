"""Pure shape/guard tests; never fork, chown, setuid, or execute fixture."""
import ast
from pathlib import Path
import unittest
from unittest.mock import patch
import multi_uid_storage_fixture as fixture


class MultiUidShapeTests(unittest.TestCase):
    def test_nonroot_refused_before_mount_or_file_access(self):
        with patch.object(fixture.os, 'getuid', return_value=1000), patch.object(fixture.Path, 'read_text', side_effect=AssertionError('must not read')):
            with self.assertRaises(RuntimeError):
                fixture.require_disposable()

    def test_missing_optin_refused(self):
        with patch.object(fixture.os, 'getuid', return_value=0), patch.dict(fixture.os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                fixture.require_disposable()

    def test_module_import_does_not_call_run(self):
        tree = ast.parse(Path(fixture.__file__).read_text())
        for item in tree.body:
            if isinstance(item, ast.Expr):
                self.assertFalse(isinstance(item.value, ast.Call))
        self.assertEqual(str(fixture.CANONICAL), '/canonical')
        self.assertEqual(str(fixture.ATTEMPTS), '/attempts')

    def test_no_external_command_or_network_library(self):
        tree = ast.parse(Path(fixture.__file__).read_text())
        modules = {alias.name.split('.')[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
        self.assertFalse(modules & {'subprocess', 'socket', 'requests', 'urllib'})
        self.assertNotIn('os.system(', Path(fixture.__file__).read_text())


if __name__ == '__main__':
    unittest.main()
