"""Pure guard tests: no fork, exec, descriptor mutation or fixture invocation."""
import ast
from pathlib import Path
import unittest
from unittest.mock import patch
import descriptor_safe_storage_fixture as fixture


class DescriptorSafeTests(unittest.TestCase):
    def test_nonroot_refused_before_mount_read(self):
        with patch.object(fixture.os, 'getuid', return_value=1000), patch.object(fixture.Path, 'read_text', side_effect=AssertionError):
            with self.assertRaises(RuntimeError):
                fixture.require_disposable()

    def test_explicit_optin_required(self):
        with patch.object(fixture.os, 'getuid', return_value=0), patch.dict(fixture.os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                fixture.require_disposable()

    def test_unknown_high_descriptor_closed_and_report_retained(self):
        with patch.object(fixture.os, 'listdir', return_value=['0', '1', '2', '3', '6', '200']), patch.object(fixture.os, 'close') as close, patch.object(fixture.os, 'dup2') as dup, patch.object(fixture.os, 'set_inheritable'), patch.object(fixture.os, 'open', return_value=0):
            fixture.close_except_report(6)
        self.assertIn(unittest.mock.call(200), close.call_args_list)
        self.assertIn(unittest.mock.call(6), close.call_args_list)
        self.assertNotIn(unittest.mock.call(3), close.call_args_list)
        self.assertEqual(dup.call_args_list[0], unittest.mock.call(6, 3))

    def test_report_already_fd3_not_overwritten(self):
        with patch.object(fixture.os, 'listdir', return_value=['0', '1', '2', '3']), patch.object(fixture.os, 'close') as close, patch.object(fixture.os, 'dup2') as dup, patch.object(fixture.os, 'set_inheritable'), patch.object(fixture.os, 'open', return_value=0):
            fixture.close_except_report(3)
        self.assertNotIn(unittest.mock.call(3), close.call_args_list)
        self.assertTrue(all(call.args[1] != 3 for call in dup.call_args_list))

    def test_missing_proc_fails_closed(self):
        with patch.object(fixture.os, 'listdir', side_effect=FileNotFoundError), patch.object(fixture.os, 'set_inheritable'), patch.object(fixture.os, 'dup2'):
            with self.assertRaises(FileNotFoundError):
                fixture.close_except_report(6)

    def test_no_import_execution_or_external_library(self):
        tree = ast.parse(Path(fixture.__file__).read_text())
        for node in tree.body:
            self.assertFalse(isinstance(node, ast.Expr) and isinstance(node.value, ast.Call))
        modules = {a.name for node in ast.walk(tree) if isinstance(node, ast.Import) for a in node.names}
        self.assertFalse(modules & {'subprocess', 'socket', 'requests'})
        compile(fixture.PROVIDER, '<isolated-provider>', 'exec')


if __name__ == '__main__':
    unittest.main()
