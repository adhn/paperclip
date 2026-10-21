"""Kernel regressions for detached group preparation; root schedules execution."""
import fcntl
import json
import os
import socket
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from production import detached_exec


class DetachedGroupAdversarialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.group = self.base / 'group'
        self.group.mkdir(mode=0o700)
        for name in ('workspace', 'session', 'config'):
            (self.group / name).mkdir(mode=0o700)
        self.module = Path(detached_exec.__file__).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def child(self, code, *, group=None, env=None, pass_fds=()):
        return subprocess.run([sys.executable, '-I', '-B', str(self.module), '--group',
                               str(group or self.group), sys.executable, '-I', '-B', '-c', code],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, env=env, pass_fds=pass_fds, timeout=4)

    def refused_without_effect(self, *, group=None):
        marker = self.base / 'forbidden-provider-effect'
        result = self.child(f"open({str(marker)!r},'w').write('bad')", group=group)
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertFalse(marker.exists())
        self.assertEqual(result.stdout, b'')
        self.assertEqual(result.stderr, b'')

    def test_group_pins_all_roots_and_erases_inherited_git_authority(self):
        environment = dict(os.environ, HOME='/forbidden-home', XDG_CONFIG_HOME='/forbidden-config',
                           GIT_DIR='/forbidden-git', GIT_WORK_TREE='/forbidden-work',
                           GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='core.hooksPath',
                           GIT_CONFIG_VALUE_0='/forbidden-hook', GIT_CONFIG_GLOBAL='/forbidden-global',
                           GIT_CONFIG_SYSTEM='/forbidden-system', PAPERCLIP_OWNER_SENTINEL='secret')
        result = self.child("import os,json;print(json.dumps({'cwd':os.getcwd(),'env':dict(os.environ)}))",
                            env=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value['cwd'], str(self.group / 'workspace'))
        self.assertEqual(value['env'], {'PATH': '/usr/local/bin:/usr/bin:/bin',
                                      'HOME': str(self.group / 'session'),
                                      'XDG_CONFIG_HOME': str(self.group / 'config'),
                                      'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
                                      'GIT_CONFIG_GLOBAL': '/dev/null'})

    def test_each_symlink_member_refuses_without_provider_effect(self):
        outside = self.base / 'outside'
        outside.mkdir(mode=0o700)
        for name in ('workspace', 'session', 'config'):
            with self.subTest(member=name):
                member = self.group / name
                member.rmdir()
                member.symlink_to(outside, target_is_directory=True)
                self.refused_without_effect()
                member.unlink()
                member.mkdir(mode=0o700)

    def test_each_nonprivate_member_refuses_without_provider_effect(self):
        for name in ('workspace', 'session', 'config'):
            with self.subTest(member=name):
                member = self.group / name
                member.chmod(0o755)
                self.refused_without_effect()
                member.chmod(0o700)

    def test_nonprivate_group_refuses_before_provider_effect(self):
        self.group.chmod(0o755)
        self.refused_without_effect()

    def test_each_regular_file_root_refuses_before_provider_effect(self):
        for name in ('workspace', 'session', 'config'):
            with self.subTest(member=name):
                member = self.group / name
                member.rmdir()
                member.write_bytes(b'not-a-directory')
                member.chmod(0o600)
                self.refused_without_effect()
                self.assertEqual(member.read_bytes(), b'not-a-directory')
                member.unlink()
                member.mkdir(mode=0o700)

    def test_group_child_cannot_use_inherited_connected_socket(self):
        # A connected stream is authority even without any discoverable pathname.
        # The provider must lose it; the fixture parent retains its original pair.
        parent, inherited = socket.socketpair()
        high = fcntl.fcntl(inherited.fileno(), fcntl.F_DUPFD, 200)
        try:
            code = ("import os,errno;\ntry: os.write(" + str(high) + ",b'forbidden')"
                    "\nexcept OSError as e: assert e.errno==errno.EBADF"
                    "\nelse: raise AssertionError('inherited control socket survived')\nprint('closed')")
            result = self.child(code, pass_fds=(high,))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b'closed\n')
            parent.setblocking(False)
            with self.assertRaises(BlockingIOError):
                parent.recv(32)
            inherited.sendall(b'parent-retained')
            self.assertEqual(parent.recv(32), b'parent-retained')
        finally:
            os.close(high)
            inherited.close()
            parent.close()

    def test_missing_member_refuses_without_provider_effect(self):
        (self.group / 'config').rmdir()
        self.refused_without_effect()

    def test_extra_group_entry_refuses_before_provider_effect(self):
        (self.group / 'unowned-root').write_bytes(b'unsupported')
        self.refused_without_effect()

    def test_symlink_ancestor_refuses_before_provider_effect(self):
        alias = self.base / 'alias'
        alias.symlink_to(self.base, target_is_directory=True)
        self.refused_without_effect(group=alias / 'group')

    def test_noncanonical_group_path_refuses_before_provider_effect(self):
        marker = self.base / 'forbidden-provider-effect'
        for suffix in ('/../group', '/.'):
            with self.subTest(suffix=suffix):
                result = subprocess.run([sys.executable, '-I', '-B', str(self.module), '--group',
                                         str(self.group) + suffix, sys.executable, '-c',
                                         f"open({str(marker)!r},'w').write('bad')"],
                                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, timeout=4)
                self.assertEqual(result.returncode, 125)
                self.assertFalse(marker.exists())

    def test_group_child_cannot_use_inherited_canonical_directory_capability(self):
        canonical = self.base / 'canonical'
        canonical.mkdir(mode=0o700)
        sentinel = canonical / 'sentinel'
        sentinel.write_bytes(b'original')
        original = os.open(canonical, os.O_RDONLY | os.O_DIRECTORY)
        high = fcntl.fcntl(original, fcntl.F_DUPFD, 200)
        try:
            code = ("import os,errno;\ntry: os.open('sentinel',os.O_WRONLY,dir_fd=" + str(high)
                    + ")\nexcept OSError as e: assert e.errno==errno.EBADF\n"
                      "else: raise AssertionError('canonical directory capability survived')\nprint('closed')")
            result = self.child(code, pass_fds=(high,))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b'closed\n')
            self.assertEqual(sentinel.read_bytes(), b'original')
            self.assertTrue(os.path.isdir(f'/proc/self/fd/{original}'))
        finally:
            os.close(high)
            os.close(original)


if __name__ == '__main__':
    unittest.main()
