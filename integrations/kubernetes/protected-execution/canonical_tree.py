"""Bounded real tree transport; no hostile-writer freeze authority is supplied.

capture_group takes a TRUSTED context manager, installed by the owner, which must
hold one immutable snapshot or exclusion boundary over every root until __exit__.
A caller's read-only fd, local flock, repeated scan or detached copy cannot satisfy
that contract. It is deliberately absent from the untrusted socket request API.
"""
import base64
import json
import os
import re
import stat

ROOTS = ('workspace', 'session', 'config')
MAX_BYTES = 1024 * 1024
MAX_ENTRIES = 4096
MAX_DEPTH = 32


class TreeError(ValueError):
    pass


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def _path(value):
    if not isinstance(value, str) or not value or '\x00' in value or len(value.encode()) > 4096:
        raise TreeError('invalid tree path')
    if value == '.':
        return ()
    parts = value.split('/')
    if len(parts) > MAX_DEPTH or any(part in ('', '.', '..') or len(part.encode()) > 255 for part in parts):
        raise TreeError('noncanonical or deep tree path')
    return tuple(parts)


def _link(path, target):
    if not isinstance(target, str) or not target or '\x00' in target or target.startswith('/') or len(target.encode()) > 4096:
        raise TreeError('only confined relative symlinks supported')
    # Lexical confinement is insufficient if another symlink is traversed. The
    # validator below additionally requires every target prefix to be a directory.
    if target != '.' and any(part in ('', '.', '..') for part in target.split('/')):
        raise TreeError('noncanonical or parent traversal symlink unsupported')
    parts = list(_path(path)[:-1])
    for part in target.split('/'):
        if part in ('', '.'):
            continue
        if part == '..':
            raise TreeError('parent traversal symlinks unsupported')
        else:
            parts.append(part)
    return '/'.join(parts) or '.'


def _git_name(value):
    return (re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*', value) is not None
            and all(part not in ('', '.', '..') and not part.endswith(('.', '.lock'))
                    for part in value.split('/')) and '..' not in value)


def _git_network_url(value):
    match = re.fullmatch(r'(https?|ssh)://(?:([A-Za-z][A-Za-z0-9_-]*)@)?'
                         r'([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(/[A-Za-z0-9._~/-]+)', value)
    if match is None:
        return False
    scheme, user, host, port, path = match.groups()
    return (not (user and scheme != 'ssh')
            and all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?', label)
                    for label in host.split('.'))
            and (port is None or 1 <= int(port) <= 65535)
            and all(part not in ('', '.', '..') for part in path[1:].split('/')))


def _git_config_subset(text):
    section = None
    settings = {}
    for line in text.split('\n'):
        line = line.strip(' \t\r')
        if not line or line.startswith(('#', ';')):
            continue
        if line.lower() == '[core]':
            section = ('core', '')
            continue
        header = re.fullmatch(r'\[(remote|branch) "([A-Za-z0-9][A-Za-z0-9._/-]*)"\]', line)
        if header:
            kind, name = header.groups()
            if not _git_name(name) or (kind == 'remote' and '/' in name):
                raise TreeError('unsupported Git subsection name')
            section = (kind, name)
            settings.setdefault(section, {})
            continue
        match = re.fullmatch(r'([A-Za-z][A-Za-z0-9]*)[ \t]*=[ \t]*([^ \t\r\n]+)', line)
        if section is None or match is None:
            raise TreeError('unsupported Git config syntax or section')
        key, value = match.groups()
        key = key.lower()
        values = settings.setdefault(section, {})
        if key in values:
            raise TreeError('duplicate Git config key')
        kind, name = section
        allowed = {'repositoryformatversion': ('0',), 'bare': ('false',),
                   'filemode': ('true', 'false'), 'logallrefupdates': ('true', 'false'),
                   'ignorecase': ('true', 'false'), 'precomposeunicode': ('true', 'false')}
        valid = (kind == 'core' and value.lower() in allowed.get(key, ()))
        if kind == 'remote':
            valid = ((key == 'url' and _git_network_url(value)) or
                     (key == 'fetch' and value == '+refs/heads/*:refs/remotes/' + name + '/*'))
        elif kind == 'branch':
            valid = ((key == 'remote' and _git_name(value) and '/' not in value) or
                     (key == 'merge' and value.startswith('refs/heads/') and _git_name(value[11:])))
        if not valid:
            raise TreeError('unsupported Git config key/value')
        values[key] = value
    for (kind, name), values in settings.items():
        if kind == 'remote' and 'url' not in values:
            raise TreeError('Git remote requires explicit network URL')
        if kind == 'branch' and (set(values) != {'remote', 'merge'} or
                                 ('remote', values.get('remote')) not in settings):
            raise TreeError('Git branch requires declared network remote and merge ref')


def _git_subset(seen):
    """Conservative standalone Git metadata only; never resolve external roots.

    This is intentionally not a Git config parser. Unknown syntax/keys refuse;
    ambient Git environment/global config must be excluded by the launcher.
    """
    for path, entry in seen.items():
        parts = _path(path)
        if '.git' not in parts:
            continue
        # A repository inside another repository's metadata would otherwise
        # have its config interpreted relative to only the FIRST .git below,
        # bypassing that inner repository's config/external-root policy.
        # Refuse this unsupported relationship for new application use only.
        if parts.count('.git') > 1:
            raise TreeError('repositories nested inside Git metadata unsupported')
        relative = parts[parts.index('.git') + 1:]
        if not relative:
            continue
        if entry['kind'] == 'symlink':
            raise TreeError('Git metadata symlinks unsupported')
        if relative[0] in ('commondir', 'gitdir', 'worktrees', 'modules', 'config.worktree') or relative[:3] in (
                ('objects', 'info', 'alternates'), ('objects', 'info', 'http-alternates')):
            raise TreeError('Git external-root metadata unsupported')
        if relative[0] == 'hooks' and len(relative) > 1 and (len(relative) != 2 or not relative[1].endswith('.sample') or entry['kind'] != 'file'):
            raise TreeError('active Git hooks unsupported')
        if relative == ('config',):
            if entry['kind'] != 'file':
                raise TreeError('regular Git config required')
            try:
                text = base64.b64decode(entry['data'], validate=True).decode('ascii')
            except (ValueError, UnicodeError) as exc:
                raise TreeError('ASCII Git config subset required') from exc
            _git_config_subset(text)


def validate(payload):
    if type(payload) is not bytes or len(payload) > MAX_BYTES:
        raise TreeError('bounded immutable tree bytes required')
    try:
        value = json.loads(payload)
        if type(value) is not dict or set(value) != {'schema', 'entries'} or type(value['schema']) is not int or value['schema'] != 1:
            raise TreeError('unsupported tree schema')
        entries = value['entries']
        if type(entries) is not list or not 1 <= len(entries) <= MAX_ENTRIES:
            raise TreeError('invalid entry count')
        seen = {}
        for entry in entries:
            if type(entry) is not dict:
                raise TreeError('invalid entry')
            path = entry.get('path')
            parts = _path(path)
            kind = entry.get('kind')
            fields = {'path', 'kind', 'mode', 'data'} if kind == 'file' else {'path', 'kind', 'target'} if kind == 'symlink' else {'path', 'kind', 'mode'}
            if set(entry) != fields or kind not in ('file', 'dir', 'symlink') or path in seen:
                raise TreeError('invalid or duplicate entry')
            if kind != 'symlink' and (type(entry['mode']) is not int or entry['mode'] not in ((0o700,) if kind == 'dir' else (0o600, 0o700))):
                raise TreeError('only private regular/executable modes supported')
            if kind == 'file':
                data = base64.b64decode(entry['data'], validate=True)
                if base64.b64encode(data).decode() != entry['data']:
                    raise TreeError('noncanonical file encoding')
            if parts and seen.get('/'.join(parts[:-1]) or '.', {}).get('kind') != 'dir':
                raise TreeError('parent missing or not a directory')
            if not parts and kind == 'symlink':
                raise TreeError('symlink roots unsupported')
            if parts and parts[-1] == '.git' and kind != 'dir':
                raise TreeError('Git indirection roots unsupported')
            seen[path] = entry
        if entries[0]['path'] != '.' or [e['path'] for e in entries] != ['.'] + sorted(key for key in seen if key != '.'):
            raise TreeError('entries must be canonical sorted root-first')
        for entry in entries:
            if entry['kind'] == 'symlink':
                target = _link(entry['path'], entry['target'])
                parts = _path(target)
                # No symlink chaining or dangling links: explicit supported subset.
                if target not in seen or seen[target]['kind'] == 'symlink':
                    raise TreeError('dangling or chained symlink unsupported')
                for index in range(1, len(parts)):
                    if seen.get('/'.join(parts[:index]), {}).get('kind') != 'dir':
                        raise TreeError('symlink target crosses non-directory')
        if encode(value) != payload:
            raise TreeError('tree encoding is not canonical')
        return value
    except (KeyError, TypeError, UnicodeError, ValueError, RecursionError) as exc:
        if isinstance(exc, TreeError):
            raise
        raise TreeError('invalid tree encoding') from exc


def validate_application_subset(payload):
    """Refuse unsupported NEW application use; retained tree-v1 stays inspectable."""
    value = validate(payload)
    _git_subset({entry['path']: entry for entry in value['entries']})
    return value


def capture_root(fd, *, application_subset=True):
    """Read only under owner's trusted immutable group boundary, never freeze it.

    Reject metadata we cannot preserve and unsupported inode relationships. Mode
    normalization is explicit: owner-private 0600/0700 retains executable intent;
    UID/GID, mtime and group/other permissions are outside this format.
    Observable substitution/mutation refuses, but these checks do not establish
    hostile-writer exclusion or a coherent application snapshot.
    """
    entries = []
    size = 0
    root_dev = os.fstat(fd).st_dev

    def append(entry):
        nonlocal size
        size += len(encode(entry))
        if size > MAX_BYTES:
            raise TreeError('tree encoding budget exceeded')
        entries.append(entry)

    def signature(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
                info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def unchanged(before, after):
        if signature(before) != signature(after):
            raise TreeError('tree changed during capture')

    def walk(current, path):
        info = os.fstat(current)
        _path(path)
        if len(entries) >= MAX_ENTRIES or info.st_dev != root_dev or info.st_mode & 0o7000 or os.listxattr(current):
            raise TreeError('entry bound, nested mount or extended metadata unsupported')
        if stat.S_ISDIR(info.st_mode):
            append({'path': path, 'kind': 'dir', 'mode': 0o700})
            names = []
            remaining = MAX_ENTRIES - len(entries)
            with os.scandir(current) as scan:
                for entry in scan:
                    if len(names) >= remaining:
                        raise TreeError('directory entry bound exceeded')
                    names.append(entry.name)
            for name in sorted(names):
                child_path = name if path == '.' else path + '/' + name
                _path(child_path)
                child_info = os.stat(name, dir_fd=current, follow_symlinks=False)
                if stat.S_ISLNK(child_info.st_mode):
                    if len(entries) >= MAX_ENTRIES or child_info.st_nlink != 1:
                        raise TreeError('entry bound or hardlinked symlink unsupported')
                    # Python's fd xattr API cannot open a symlink without following.
                    # Refuse any symlink xattrs via a proc-anchored lstat operation.
                    if os.listxattr('/proc/self/fd/' + str(current) + '/' + name, follow_symlinks=False):
                        raise TreeError('symlink extended metadata unsupported')
                    target = os.readlink(name, dir_fd=current)
                    unchanged(child_info, os.stat(name, dir_fd=current, follow_symlinks=False))
                    append({'path': child_path, 'kind': 'symlink', 'target': target})
                else:
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
                    try:
                        unchanged(child_info, os.fstat(child))
                        walk(child, child_path)
                        unchanged(child_info, os.stat(name, dir_fd=current, follow_symlinks=False))
                    finally:
                        os.close(child)
        elif stat.S_ISREG(info.st_mode):
            if info.st_nlink != 1 or info.st_size > MAX_BYTES or info.st_mode & 0o7000:
                raise TreeError('hardlinks, large files and privileged modes unsupported')
            data = bytearray()
            while True:
                block = os.pread(current, min(65536, MAX_BYTES + 1 - len(data)), len(data))
                if not block:
                    break
                data.extend(block)
                if len(data) > MAX_BYTES:
                    raise TreeError('file too large')
            append({'path': path, 'kind': 'file', 'mode': 0o700 if info.st_mode & 0o111 else 0o600,
                            'data': base64.b64encode(data).decode()})
        else:
            raise TreeError('special inode unsupported')
        unchanged(info, os.fstat(current))
        if os.listxattr(current):
            raise TreeError('extended metadata changed during capture')
    walk(fd, '.')
    payload = encode({'schema': 1, 'entries': sorted(entries, key=lambda entry: (entry['path'] != '.', entry['path']))})
    if application_subset:
        validate_application_subset(payload)
    else:
        # Integrity-only recapture of retained accepted tree-v1. Never use this
        # bypass to publish/export/launch unsupported application state.
        validate(payload)
    return payload


def capture_group(snapshot_boundary):
    """Trusted owner dependency; caller-controlled context managers are forbidden."""
    with snapshot_boundary as fds:
        if type(fds) is not dict or set(fds) != set(ROOTS) or any(type(fd) is not int or fd < 0 for fd in fds.values()):
            raise TreeError('complete three-root snapshot descriptors required')
        # These are observable descriptor-shape checks, not evidence of physical
        # alias exclusion or a trusted snapshot. In particular, distinct inodes
        # can still contain overlapping bind-mounted subtrees or active writers.
        before = {root: os.fstat(fds[root]) for root in ROOTS}
        identities = {(info.st_dev, info.st_ino) for info in before.values()}
        if len(identities) != len(ROOTS):
            raise TreeError('snapshot roots must have distinct inode identities')
        if any(not stat.S_ISDIR(before[root].st_mode) for root in ('workspace', 'session')):
            raise TreeError('workspace and session snapshot roots must be directories')
        if not (stat.S_ISDIR(before['config'].st_mode) or stat.S_ISREG(before['config'].st_mode)):
            raise TreeError('config snapshot root must be a directory or regular file')
        result = {root: capture_root(fds[root]) for root in ROOTS}
        # A root captured first must also remain observably unchanged while the
        # remaining roots are read. This closes a check gap but cannot prove
        # coherence of descendants or application transactions across roots.
        for root in ROOTS:
            first, last = before[root], os.fstat(fds[root])
            fields = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_uid',
                      'st_gid', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
            if any(getattr(first, field) != getattr(last, field) for field in fields):
                raise TreeError('snapshot root changed during group capture')
        if sum(map(len, result.values())) > MAX_BYTES:
            raise TreeError('complete tree group too large')
        return result


def materialize(payload, parent_fd, name):
    """Create fresh owner-private independent inodes under a protected parent fd.

    Parent must remain exclusively owner-controlled. Never use a provider-owned
    parent or hand these descriptors to provider code. Failure leaves an unselected
    partial tree; no cleanup/replay or success is inferred from its existence.
    """
    value = validate(payload)
    if not isinstance(name, str) or len(_path(name)) != 1:
        raise TreeError('one fresh root name required')
    root = value['entries'][0]
    if root['kind'] == 'file':
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
        try:
            _write_file(fd, root)
        finally:
            os.close(fd)
    else:
        os.mkdir(name, 0o700, dir_fd=parent_fd)
        root_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            for entry in value['entries'][1:]:
                parts = _path(entry['path'])
                destination = os.dup(root_fd)
                try:
                    for part in parts[:-1]:
                        next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=destination)
                        os.close(destination)
                        destination = next_fd
                    if entry['kind'] == 'dir':
                        os.mkdir(parts[-1], 0o700, dir_fd=destination)
                        child = os.open(parts[-1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=destination)
                        try:
                            os.fsync(child)
                        finally:
                            os.close(child)
                    elif entry['kind'] == 'symlink':
                        os.symlink(entry['target'], parts[-1], dir_fd=destination)
                    else:
                        fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=destination)
                        try:
                            _write_file(fd, entry)
                        finally:
                            os.close(fd)
                    os.fsync(destination)
                finally:
                    os.close(destination)
            os.fsync(root_fd)
        finally:
            os.close(root_fd)
    os.fsync(parent_fd)


def _write_file(fd, entry):
    data = base64.b64decode(entry['data'], validate=True)
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError('short tree write')
        view = view[written:]
    os.fchmod(fd, entry['mode'])
    os.fsync(fd)
