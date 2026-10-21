import json
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from production import detached_exec


class DetachedExecTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.module = Path(detached_exec.__file__).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def run_child(self, arguments, **options):
        return subprocess.run([sys.executable, '-I', '-B', *arguments],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=4, **options)

    def test_actual_exec_has_detached_cwd_minimal_environment_and_no_new_privileges(self):
        provider = "import os,json,pathlib;print(json.dumps({'cwd':os.getcwd(),'env':dict(os.environ),'mode':os.umask(0o077),'nnp':[x for x in pathlib.Path('/proc/self/status').read_text().splitlines() if x.startswith('NoNewPrivs:')]}))"
        result = self.run_child([str(self.module), str(self.directory), sys.executable, '-I', '-B', '-c', provider],
                                env={**os.environ, 'PAPERCLIP_OWNER_SECRET_SENTINEL': 'must-not-inherit'})
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value['cwd'], str(self.directory))
        self.assertNotIn('PAPERCLIP_OWNER_SECRET_SENTINEL', value['env'])
        self.assertEqual(set(value['env']), {'PATH', 'HOME', 'LANG'})
        self.assertEqual(value['mode'], 0o077)
        self.assertEqual(value['nnp'], ['NoNewPrivs:\t1'])

    def test_unknown_inheritable_descriptor_above_lowered_soft_limit_is_closed(self):
        danger = self.directory / 'canonical-sentinel'
        danger.write_bytes(b'original')
        fd = os.open(danger, os.O_RDWR)
        high = fcntl.fcntl(fd, fcntl.F_DUPFD, 200)
        provider = f"import os,errno;\ntry: os.write({high},b'bad')\nexcept OSError as e: assert e.errno==errno.EBADF\nelse: raise AssertionError('inherited FD survived')\nprint('closed')"
        wrapper = "import sys,os,resource;sys.path.insert(0,sys.argv[1]);from production.detached_exec import main;resource.setrlimit(resource.RLIMIT_NOFILE,(128,resource.getrlimit(resource.RLIMIT_NOFILE)[1]));main(sys.argv[2:])"
        try:
            result = self.run_child(['-c', wrapper, str(self.module.parent.parent), str(self.directory), sys.executable, '-I', '-B', '-c', provider], pass_fds=(high,))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b'closed\n')
            self.assertEqual(danger.read_bytes(), b'original')
            os.write(fd, b'parent')  # child closure never closes parent custody
        finally:
            os.close(high)
            os.close(fd)

    def test_regular_file_stdio_refused_before_provider_effect(self):
        marker = self.directory / 'must-not-exist'
        with (self.directory / 'unsafe-stdout').open('wb') as output:
            result = subprocess.run([sys.executable, '-I', '-B', str(self.module), str(self.directory), sys.executable,
                                     '-I', '-B', '-c', f"open({str(marker)!r},'w').write('bad')"],
                                    stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.PIPE, timeout=4)
        self.assertEqual(result.returncode, 125)
        self.assertFalse(marker.exists())

    def test_rejected_regular_stderr_is_never_written_even_for_refusal(self):
        sentinel = self.directory / 'canonical-stderr'
        sentinel.write_bytes(b'unchanged')
        with sentinel.open('r+b') as error_output:
            result = subprocess.run([sys.executable, '-I', '-B', str(self.module), str(self.directory),
                                     sys.executable, '-c', "print('bad')"], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=error_output, timeout=4)
        self.assertEqual(result.returncode, 125)
        self.assertEqual(sentinel.read_bytes(), b'unchanged')
        self.assertEqual(result.stdout, b'')

    def test_cloexec_stdio_refuses_before_provider_effect(self):
        wrapper = "import sys,os;sys.path.insert(0,sys.argv[1]);from production.detached_exec import main;os.set_inheritable(2,False);main(sys.argv[2:])"
        marker = self.directory / 'must-not-run'
        result = self.run_child(['-c', wrapper, str(self.module.parent.parent), str(self.directory),
                                 sys.executable, '-c', f"open({str(marker)!r},'w').write('bad')"])
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())

    def test_shared_or_symlink_directory_refused_before_exec(self):
        shared = self.directory / 'shared'
        shared.mkdir(mode=0o755)
        shared.chmod(0o755)
        link = self.directory / 'link'
        link.symlink_to(shared)
        for directory in (shared, link):
            result = self.run_child([str(self.module), str(directory), sys.executable, '-c', "print('bad')"])
            self.assertEqual(result.returncode, 125)
            self.assertEqual(result.stdout, b'')

    def test_canonical_publication_export_and_exec_preserve_selected_group(self):
        from canonical_owner import CanonicalOwner
        from canonical_tree import capture_root, ROOTS
        canonical = self.directory / 'canonical'
        canonical.mkdir(mode=0o700)
        detached = self.directory / 'detached'
        detached.mkdir(mode=0o700)
        roots = {}
        for root in ROOTS:
            source = self.directory / ('source-' + root)
            source.mkdir(mode=0o700)
            (source / 'original').write_bytes(root.encode())
            fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
            try:
                roots[root] = capture_root(fd)
            finally:
                os.close(fd)
        owner = CanonicalOwner(canonical)
        try:
            owner.publish_trees('export-exec', 0, roots)
            before = owner.snapshot()
            owner.export_trees(1, detached)
            result = self.run_child([str(self.module), '--group', str(detached),
                                     sys.executable, '-I', '-B', '-c',
                                     "import os;from pathlib import Path;Path('original').write_bytes(b'detached-only');Path(os.environ['HOME'],'original').write_bytes(b'session-only');Path(os.environ['XDG_CONFIG_HOME'],'original').write_bytes(b'config-only');print('executed')"])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b'executed\n')
            self.assertEqual((detached / 'workspace' / 'original').read_bytes(), b'detached-only')
            self.assertEqual((detached / 'session' / 'original').read_bytes(), b'session-only')
            self.assertEqual((detached / 'config' / 'original').read_bytes(), b'config-only')
            self.assertEqual(owner.snapshot(), before)
            for root in ROOTS:
                self.assertEqual((canonical / before['version'] / 'trees' / root / 'original').read_bytes(), root.encode())
        finally:
            owner.close()
        # This proves copy/FD/exec behavior only. Export is not a launch permit;
        # no runtime acceptance, deny-to-exec ordering or physical fence exists.

    def test_group_file_config_refuses_without_fabricating_provider_profile(self):
        group = self.directory / 'file-config-group'
        group.mkdir(mode=0o700)
        for root in ('workspace', 'session'):
            (group / root).mkdir(mode=0o700)
        (group / 'config').write_bytes(b'file-based-application-config')
        marker = self.directory / 'must-not-run'
        result = self.run_child([str(self.module), '--group', str(group), sys.executable, '-c',
                                 f"open({str(marker)!r},'w').write('bad')"])
        self.assertEqual(result.returncode, 125)
        self.assertFalse(marker.exists())
        self.assertEqual((group / 'config').read_bytes(), b'file-based-application-config')

    def test_relative_command_and_failed_exec_do_not_report_success(self):
        for command in ('python3', '/nonexistent-paperclip-detached-executable'):
            result = self.run_child([str(self.module), str(self.directory), command])
            self.assertEqual(result.returncode, 125)
            self.assertEqual(result.stdout, b'')


if __name__ == '__main__':
    unittest.main()
