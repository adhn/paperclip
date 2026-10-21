import base64
from contextlib import contextmanager
import os
from pathlib import Path
import tempfile
import unittest
from canonical_tree import (TreeError, ROOTS, capture_group, capture_root, encode,
                            materialize, validate, validate_application_subset)


def tree(entries):
    return encode({'schema': 1, 'entries': entries})


def directory(path='.'):
    return {'path': path, 'kind': 'dir', 'mode': 0o700}


def file(path, data=b'value', mode=0o600):
    return {'path': path, 'kind': 'file', 'mode': mode, 'data': base64.b64encode(data).decode()}


class TreeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def capture(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            return capture_root(fd)
        finally:
            os.close(fd)

    def test_real_directory_roundtrip_executable_git_and_confined_symlink(self):
        source = self.base / 'source'
        source.mkdir()
        (source / '.git').mkdir()
        (source / '.git' / 'HEAD').write_bytes(b'ref: refs/heads/main\n')
        (source / '!first').write_bytes(b'\x00binary\xff')
        (source / 'bin').mkdir()
        (source / 'bin' / 'run').write_bytes(b'#!/bin/sh\n')
        (source / 'bin' / 'run').chmod(0o755)
        (source / 'run').symlink_to('bin/run')
        payload = self.capture(source)
        fd = os.open(self.base, os.O_RDONLY | os.O_DIRECTORY)
        try:
            materialize(payload, fd, 'copy')
        finally:
            os.close(fd)
        self.assertEqual(self.capture(self.base / 'copy'), payload)
        self.assertEqual((self.base / 'copy/bin/run').stat().st_mode & 0o777, 0o700)
        self.assertNotEqual((source / '!first').stat().st_ino, (self.base / 'copy/!first').stat().st_ino)

    def test_standalone_git_safe_config_roundtrip_and_sample_hook(self):
        source = self.base / 'source'
        source.mkdir()
        (source / '.git').mkdir()
        (source / '.git/config').write_bytes(b'[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n')
        (source / '.git/hooks').mkdir()
        (source / '.git/hooks/pre-commit.sample').write_bytes(b'ignored sample')
        payload = self.capture(source)
        self.assertEqual(validate(payload)['entries'][0], directory())
        fd = os.open(self.base, os.O_RDONLY | os.O_DIRECTORY)
        try:
            materialize(payload, fd, 'copy')
        finally:
            os.close(fd)
        self.assertEqual(self.capture(self.base / 'copy'), payload)

    def test_network_remote_branch_config_roundtrip(self):
        source = self.base / 'source'
        (source / '.git').mkdir(parents=True)
        for url in ('https://example.invalid/team/repo.git',
                    'http://example.invalid:8080/team/repo.git',
                    'ssh://git@example.invalid:2222/team/repo.git'):
            config = ('[core]\nrepositoryformatversion = 0\nbare = false\n'
                      '[remote "origin"]\nurl = ' + url + '\n'
                      'fetch = +refs/heads/*:refs/remotes/origin/*\n'
                      '[branch "feature/topic"]\nremote = origin\nmerge = refs/heads/feature/topic\n').encode()
            (source / '.git/config').write_bytes(config)
            payload = self.capture(source)
            self.assertEqual(validate_application_subset(payload)['entries'][-1], file('.git/config', config))
            with tempfile.TemporaryDirectory(dir=self.base) as target:
                fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    materialize(payload, fd, 'copy')
                finally:
                    os.close(fd)
                self.assertEqual(self.capture(Path(target) / 'copy'), payload)

    def test_remote_local_helper_credentials_and_escaping_forms_refuse(self):
        urls = ('file:///outside/repo', '/outside/repo', '../repo', 'git@example.invalid:repo',
                'ext::command', 'helper::repo', 'ssh://-option/repo',
                'https://user@example.invalid/repo', 'https://user:password@example.invalid/repo',
                'ssh://git@example.invalid/../repo', 'ssh://git@example.invalid/repo%2fescape',
                'https://example.invalid/repo?option=x', 'https://example.invalid/repo#fragment',
                'https://example..invalid/repo', 'https://example.invalid:0/repo',
                'https://example.invalid:65536/repo', '"https://example.invalid/repo"')
        for url in urls:
            config = ('[remote "origin"]\nurl = ' + url + '\n').encode()
            with self.subTest(url=url), self.assertRaises(TreeError):
                validate_application_subset(tree([directory(), directory('.git'), file('.git/config', config)]))

    def test_remote_branch_cross_references_and_extra_options_refuse(self):
        safe_remote = '[remote "origin"]\nurl = https://example.invalid/repo\n'
        configs = ('[remote "origin"]\nfetch = +refs/heads/*:refs/remotes/origin/*\n',
                   safe_remote + 'fetch = +refs/*:refs/*\n',
                   safe_remote + 'pushurl = https://example.invalid/other\n',
                   safe_remote + 'uploadpack = command\n',
                   safe_remote + '[branch "main"]\nremote = missing\nmerge = refs/heads/main\n',
                   safe_remote + '[branch "main"]\nremote = .\nmerge = refs/heads/main\n',
                   safe_remote + '[branch "main"]\nremote = origin\n',
                   safe_remote + '[branch "main"]\nremote = origin\nmerge = refs/heads/../outside\n',
                   safe_remote + '[branch "main"]\nremote = origin\nmerge = refs/heads/main\nrebase = true\n')
        for config in configs:
            with self.subTest(config=config), self.assertRaises(TreeError):
                validate_application_subset(tree([directory(), directory('.git'), file('.git/config', config.encode())]))

    def test_git_external_reference_paths_refuse_validation_and_capture(self):
        for relative in ('commondir', 'gitdir', 'worktrees/other', 'modules/sub',
                         'config.worktree', 'objects/info/alternates',
                         'objects/info/http-alternates', 'hooks/pre-commit'):
            with self.subTest(relative=relative):
                entries = [directory(), directory('.git')]
                parts = relative.split('/')
                for index in range(1, len(parts)):
                    entries.append(directory('.git/' + '/'.join(parts[:index])))
                entries.append(file('.git/' + relative, b'../../outside'))
                with self.assertRaises(TreeError):
                    validate_application_subset(tree(entries))
                with tempfile.TemporaryDirectory(dir=self.base) as temporary:
                    source = Path(temporary)
                    target = source / '.git' / relative
                    target.parent.mkdir(parents=True)
                    target.write_bytes(b'../../outside')
                    with self.assertRaises(TreeError):
                        self.capture(source)

    def test_git_config_unknown_or_escaping_syntax_refuses_validation_and_capture(self):
        cases = (b'[include]\npath = ../../outside\n',
                 b'[includeIf "gitdir:here"]\npath = outside\n',
                 b'[core]\nworktree = ../../outside\n',
                 b'[core]\nhooksPath = ../../outside\n',
                 b'[remote "origin"]\nurl = /outside\n',
                 b'[branch "main"]\nremote = origin\n',
                 b'[core]\nfilemode = "true"\n',
                 b'[core]\nfilemode = true\\\nworktree = outside\n',
                 b'[core]\nfilemode = true\nfilemode = false\n',
                 b'[core]\nrepositoryformatversion = 1\n',
                 b'[core]\nbare = true\n', b'[core]\nfilemode = true # comment\n',
                 b'[core]\nfilemode = tr\x00ue\n')
        source = self.base / 'source'
        (source / '.git').mkdir(parents=True)
        for config in cases:
            with self.subTest(config=config):
                with self.assertRaises(TreeError):
                    validate_application_subset(tree([directory(), directory('.git'), file('.git/config', config)]))
                (source / '.git/config').write_bytes(config)
                with self.assertRaises(TreeError):
                    self.capture(source)

    def test_retained_tree_v1_integrity_remains_inspectable_without_new_use(self):
        config = b'[core]\nworktree = ../../outside\n'
        payload = tree([directory(), directory('.git'), file('.git/config', config)])
        self.assertEqual(validate(payload)['entries'][-1], file('.git/config', config))
        source = self.base / 'source'
        (source / '.git').mkdir(parents=True)
        (source / '.git/config').write_bytes(config)
        fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
        try:
            self.assertEqual(capture_root(fd, application_subset=False), payload)
            with self.assertRaises(TreeError):
                capture_root(fd)
        finally:
            os.close(fd)
        parent = os.open(self.base, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with self.assertRaises(TreeError):
                validate_application_subset(payload)
            # Low-level format materialization is not application policy. This
            # reconstructs retained state; new owner publish/export gates refuse.
            materialize(payload, parent, 'retained-copy')
            copy = os.open(self.base / 'retained-copy', os.O_RDONLY | os.O_DIRECTORY)
            try:
                self.assertEqual(capture_root(copy, application_subset=False), payload)
            finally:
                os.close(copy)
        finally:
            os.close(parent)

    def test_git_repository_inside_metadata_refuses_new_validation_and_capture(self):
        for config in (b'[core]\nworktree = ../../outside\n',
                       b'[include]\npath = /outside\n',
                       b'[core]\nfilemode = true\n'):
            entries = [directory(), directory('.git'), directory('.git/nested'),
                       directory('.git/nested/.git'), file('.git/nested/.git/config', config)]
            with self.subTest(config=config), self.assertRaisesRegex(TreeError, 'nested inside Git metadata'):
                validate_application_subset(tree(entries))
        source = self.base / 'source'
        inner = source / '.git/nested/.git'
        inner.mkdir(parents=True)
        (inner / 'config').write_bytes(b'[core]\nworktree = ../../outside\n')
        with self.assertRaisesRegex(TreeError, 'nested inside Git metadata'):
            self.capture(source)

    def test_git_ordinary_nested_workspace_repositories_remain_supported(self):
        config = b'[core]\nfilemode = true\n'
        source = self.base / 'source'
        (source / '.git').mkdir(parents=True)
        (source / '.git/config').write_bytes(config)
        (source / 'nested/.git').mkdir(parents=True)
        (source / 'nested/.git/config').write_bytes(config)
        payload = self.capture(source)
        self.assertEqual(validate_application_subset(payload), validate(payload))
        (source / 'nested/.git/config').write_bytes(b'[include]\npath = /outside\n')
        with self.assertRaisesRegex(TreeError, 'unsupported Git config'):
            self.capture(source)

    def test_retained_nested_git_metadata_remains_structurally_reconstructible(self):
        entries = [directory(), directory('.git'), directory('.git/nested'),
                   directory('.git/nested/.git'),
                   file('.git/nested/.git/config', b'[include]\npath = /outside\n')]
        payload = tree(entries)
        self.assertEqual(validate(payload)['entries'], entries)
        parent = os.open(self.base, os.O_RDONLY | os.O_DIRECTORY)
        try:
            materialize(payload, parent, 'retained')
            retained = os.open(self.base / 'retained', os.O_RDONLY | os.O_DIRECTORY)
            try:
                self.assertEqual(capture_root(retained, application_subset=False), payload)
                with self.assertRaisesRegex(TreeError, 'nested inside Git metadata'):
                    capture_root(retained)
            finally:
                os.close(retained)
        finally:
            os.close(parent)

    def test_git_internal_symlink_refuses_even_when_confined(self):
        entries = [directory(), directory('.git'),
                   {'path': '.git/config', 'kind': 'symlink', 'target': 'safe'},
                   file('.git/safe', b'[core]\nfilemode = true\n')]
        with self.assertRaisesRegex(TreeError, 'Git metadata symlinks'):
            validate_application_subset(tree(entries))

    def test_directory_scan_stops_at_remaining_entry_budget(self):
        from types import SimpleNamespace
        from unittest.mock import MagicMock, patch
        source = self.base / 'source'
        source.mkdir()
        consumed = []
        def enormous_directory():
            for index in range(1000000):
                consumed.append(index)
                yield SimpleNamespace(name='entry-' + str(index))
        scan = MagicMock()
        scan.__enter__.return_value = enormous_directory()
        with patch('canonical_tree.MAX_ENTRIES', 4), patch('canonical_tree.os.scandir', return_value=scan):
            with self.assertRaisesRegex(TreeError, 'directory entry bound'):
                self.capture(source)
        # Root uses one slot: three remaining names plus one rejecting entry.
        self.assertEqual(len(consumed), 4)
        scan.__exit__.assert_called_once()

    def test_capture_preserves_shared_descriptor_offset(self):
        source = self.base / 'file'
        source.write_bytes(b'complete content')
        fd = os.open(source, os.O_RDONLY)
        try:
            os.lseek(fd, 5, os.SEEK_SET)
            self.assertEqual(validate(capture_root(fd))['entries'][0], file('.', b'complete content'))
            self.assertEqual(os.lseek(fd, 0, os.SEEK_CUR), 5)
        finally:
            os.close(fd)

    def test_file_mutation_during_capture_refuses(self):
        from unittest.mock import patch
        source = self.base / 'file'
        source.write_bytes(b'original')
        original = os.pread
        mutated = False
        def mutate(fd, count, offset):
            nonlocal mutated
            result = original(fd, count, offset)
            if not mutated:
                mutated = True
                source.write_bytes(b'replacement larger')
            return result
        with patch('canonical_tree.os.pread', side_effect=mutate):
            with self.assertRaisesRegex(TreeError, 'changed during capture'):
                self.capture(source)

    def test_entry_replacement_between_stat_and_open_refuses(self):
        from unittest.mock import patch
        source = self.base / 'source'
        source.mkdir()
        (source / 'file').write_bytes(b'original')
        (self.base / 'replacement').write_bytes(b'replacement')
        original = os.open
        def replace(name, flags, *args, **kwargs):
            if name == 'file':
                os.replace(self.base / 'replacement', source / 'file')
            return original(name, flags, *args, **kwargs)
        with patch('canonical_tree.os.open', side_effect=replace):
            with self.assertRaisesRegex(TreeError, 'changed during capture'):
                self.capture(source)

    def test_single_file_config_roundtrip(self):
        source = self.base / 'config'
        source.write_bytes(b'{"preferences":1}')
        payload = self.capture(source)
        fd = os.open(self.base, os.O_RDONLY | os.O_DIRECTORY)
        try:
            materialize(payload, fd, 'copy')
        finally:
            os.close(fd)
        self.assertEqual(self.capture(self.base / 'copy'), payload)

    def test_capture_uses_one_explicit_group_boundary(self):
        for name in ROOTS:
            (self.base / name).mkdir()
        events = []
        @contextmanager
        def trusted_fixture_snapshot():
            # Fixture has no hostile writer; this is not a production freeze.
            fds = {name: os.open(self.base / name, os.O_RDONLY | os.O_DIRECTORY) for name in ROOTS}
            events.append('entered')
            try:
                yield fds
            finally:
                events.append('exited')
                for fd in fds.values():
                    os.close(fd)
        result = capture_group(trusted_fixture_snapshot())
        self.assertEqual(set(result), set(ROOTS))
        self.assertEqual(events, ['entered', 'exited'])
        with self.assertRaises(TypeError):
            capture_group({name: 0 for name in ROOTS})

    def test_group_duplicate_root_descriptor_and_separate_alias_refuse(self):
        source = self.base / 'source'
        source.mkdir()
        first = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
        second = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
        try:
            for other in (first, second):
                @contextmanager
                def aliased():
                    yield {'workspace': first, 'session': other, 'config': second}
                with self.subTest(other=other), self.assertRaisesRegex(TreeError, 'distinct inode'):
                    capture_group(aliased())
        finally:
            os.close(first)
            os.close(second)

    def test_group_workspace_session_require_directories_but_config_file_remains_supported(self):
        for name in ROOTS:
            (self.base / name).mkdir()
        fds = {name: os.open(self.base / name, os.O_RDONLY | os.O_DIRECTORY) for name in ROOTS}
        config = self.base / 'single-config'
        config.write_bytes(b'preferences')
        file_fd = os.open(config, os.O_RDONLY)
        @contextmanager
        def boundary(values):
            yield values
        try:
            result = capture_group(boundary(dict(fds, config=file_fd)))
            self.assertEqual(validate(result['config'])['entries'], [file('.', b'preferences')])
            for root in ('workspace', 'session'):
                with self.subTest(root=root), self.assertRaisesRegex(TreeError, 'must be directories'):
                    capture_group(boundary(dict(fds, **{root: file_fd})))
        finally:
            os.close(file_fd)
            for fd in fds.values():
                os.close(fd)

    def test_group_rechecks_earlier_root_after_later_root_capture(self):
        from unittest.mock import patch
        for name in ROOTS:
            (self.base / name).mkdir()
        fds = {name: os.open(self.base / name, os.O_RDONLY | os.O_DIRECTORY) for name in ROOTS}
        @contextmanager
        def boundary():
            yield fds
        def mutate_after_workspace(fd):
            result = capture_root(fd)
            if fd == fds['config']:
                # Observable metadata change in a root whose own scan finished.
                os.chmod(self.base / 'workspace', 0o750)
            return result
        try:
            with patch('canonical_tree.capture_root', side_effect=mutate_after_workspace):
                with self.assertRaisesRegex(TreeError, 'changed during group capture'):
                    capture_group(boundary())
        finally:
            for fd in fds.values():
                os.close(fd)

    def test_partial_boundary_refused(self):
        @contextmanager
        def incomplete():
            yield {'workspace': 0}
        with self.assertRaises(TreeError):
            capture_group(incomplete())

    def test_traversal_duplicate_noncanonical_and_missing_parent_refuse(self):
        cases = ([directory(), file('../outside')], [directory(), file('a'), file('a')],
                 [directory(), file('a/b')], [directory(), file('b'), file('a')],
                 [directory(), file('/absolute')], [directory(), file('a//b')])
        for entries in cases:
            with self.subTest(entries=entries), self.assertRaises(TreeError):
                validate(tree(entries))
        with self.assertRaises(TreeError):
            validate(b'{"schema": 1, "entries": []}')

    def test_symlink_original_traversal_cannot_escape_before_normalization(self):
        entries = [directory(), {'path': 'alias', 'kind': 'symlink', 'target': '.'},
                   {'path': 'attack', 'kind': 'symlink', 'target': 'alias/../secret'}, file('secret')]
        with self.assertRaisesRegex(TreeError, 'parent traversal'):
            validate(tree(entries))

    def test_symlink_external_chained_dangling_refuse(self):
        for target in ('/outside', '../outside', 'missing', 'link', 'file/.', 'file/', './file', 'file//child'):
            entries = [directory(), {'path': 'link', 'kind': 'symlink', 'target': target}]
            with self.subTest(target=target), self.assertRaises(TreeError):
                validate(tree(entries))

    def test_directory_mode_mismatch_refuses_before_materialization(self):
        with self.assertRaises(TreeError):
            validate(tree([{'path': '.', 'kind': 'dir', 'mode': 0o600}]))

    def test_special_hardlink_and_git_indirection_refuse(self):
        source = self.base / 'source'
        source.mkdir()
        os.mkfifo(source / 'pipe')
        with self.assertRaises(TreeError):
            self.capture(source)
        (source / 'pipe').unlink()
        (source / 'file').write_bytes(b'x')
        os.link(source / 'file', source / 'hard')
        with self.assertRaises(TreeError):
            self.capture(source)
        (source / 'hard').unlink()
        (source / '.git').write_bytes(b'gitdir: ../external')
        with self.assertRaises(TreeError):
            self.capture(source)

    def test_xattrs_refuse_instead_of_loss(self):
        path = self.base / 'file'
        path.write_bytes(b'x')
        os.setxattr(path, 'user.fixture', b'value')
        with self.assertRaises(TreeError):
            self.capture(path)

    def test_existing_destination_and_symlink_parent_not_followed(self):
        payload = tree([directory(), directory('a'), file('a/data')])
        (self.base / 'occupied').symlink_to('/tmp')
        fd = os.open(self.base, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with self.assertRaises(FileExistsError):
                materialize(payload, fd, 'occupied')
            with self.assertRaises(TreeError):
                materialize(payload, fd, '../outside')
        finally:
            os.close(fd)


if __name__ == '__main__':
    unittest.main()
