"""Disposable single-filesystem prototype; not a production storage authority.

Only synthetic temporary roots belong here. The caller controls the directory;
read-only modes model immutability but do not protect against the owning UID.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid


class InjectedCrash(RuntimeError):
    pass


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json(path, value):
    with open(path, 'x', encoding='utf-8') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())


def inventory(root):
    """No links or special files; complete directory and byte inventory."""
    result = {}
    def visit(path, relative):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError('symlink refused')
        if stat.S_ISDIR(info.st_mode):
            result[relative] = {'kind': 'directory'}
            for child in sorted(path.iterdir()):
                visit(child, relative + '/' + child.name)
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            result[relative] = {'kind': 'file', 'bytes': info.st_size,
                                'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        else:
            raise ValueError('hardlink or special file refused')
    visit(Path(root), '.')
    return result


class DetachedGroupFixture:
    """Local flock/CAS, copied versions, and one atomic full-group HEAD."""
    def __init__(self, root, roots=('workspace', 'session', 'credentials')):
        self.root = Path(root)
        if self.root.is_symlink() or not self.root.is_dir():
            raise ValueError('existing disposable directory required')
        self.roots = tuple(roots)
        if (not self.roots or len(set(self.roots)) != len(self.roots)
                or any(not re.fullmatch('[a-z][a-z0-9_-]*', name) for name in self.roots)):
            raise ValueError('exact distinct simple root names required')
        # Explicit fresh provisioning only. Ordinary open never invents history.
        (self.root / 'versions').mkdir()
        write_json(self.root / 'HEAD', {'generation': 0, 'version': None})
        write_json(self.root / 'GROUP', {'roots': list(self.roots)})
        (self.root / 'LOCK').touch(exist_ok=False)
        sync_dir(self.root)

    def head(self):
        return json.loads((self.root / 'HEAD').read_text())

    def prepare(self, attempts, expected):
        if set(attempts) != set(self.roots):
            raise ValueError('complete root group required')
        if self.head() != expected:
            raise ValueError('stale predecessor')
        version = uuid.uuid4().hex
        target = self.root / 'versions' / version
        target.mkdir()
        records = {}
        for name in self.roots:
            source = Path(attempts[name])
            before = inventory(source)
            dest = target / name
            dest.mkdir()
            for rel, entry in before.items():
                if rel == '.':
                    continue
                suffix = rel[2:]
                output = dest / suffix
                if entry['kind'] == 'directory':
                    output.mkdir()
                else:
                    # Real independent inodes: never hardlink or rename attempt data.
                    fd = os.open(source / suffix, os.O_RDONLY | os.O_NOFOLLOW)
                    try:
                        info = os.fstat(fd)
                        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                            raise ValueError('source identity changed')
                        with os.fdopen(os.dup(fd), 'rb') as inp, open(output, 'xb') as out:
                            while block := inp.read(65536):
                                out.write(block)
                            out.flush()
                            os.fsync(out.fileno())
                    finally:
                        os.close(fd)
            after = inventory(dest)
            if inventory(source) != before or after != before:
                raise ValueError('attempt changed during snapshot')
            records[name] = after
        write_json(target / 'INTENT', {'version': version, 'predecessor': expected,
                                      'roots': list(self.roots), 'inventory': records})
        # Freeze model content before publication. Not an OS security boundary.
        for path in sorted(target.rglob('*'), reverse=True):
            if path.is_file():
                path.chmod(0o444)
            elif path.is_dir():
                sync_dir(path)
                path.chmod(0o555)
        sync_dir(target)
        target.chmod(0o555)
        sync_dir(target.parent)
        return version

    def inspect(self, version):
        if not re.fullmatch('[0-9a-f]{32}', version):
            raise ValueError('invalid version')
        directory = self.root / 'versions' / version
        intent = json.loads((directory / 'INTENT').read_text())
        if intent['version'] != version or intent['roots'] != list(self.roots):
            raise ValueError('intent identity mismatch')
        if set(intent['inventory']) != set(self.roots):
            raise ValueError('incomplete group')
        for name in self.roots:
            if inventory(directory / name) != intent['inventory'][name]:
                raise ValueError('version bytes changed')
        current = self.head()
        return {'version': version, 'head': current, 'predecessor': intent['predecessor'],
                'state': 'current' if current['version'] == version else 'not-current',
                'operational_authority': False}

    def activate(self, version, crash=None):
        if crash not in (None, 'before_head', 'after_head'):
            raise ValueError('unknown crash point')
        with open(self.root / 'LOCK', 'r+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            inspected = self.inspect(version)
            if inspected['head'] != inspected['predecessor']:
                raise ValueError('predecessor CAS failed; inspect, never replay')
            successor = {'generation': inspected['head']['generation'] + 1, 'version': version}
            pending = self.root / ('pending-' + uuid.uuid4().hex)
            write_json(pending, successor)
            if crash == 'before_head':
                raise InjectedCrash('before HEAD switch')
            os.replace(pending, self.root / 'HEAD')
            sync_dir(self.root)
            if crash == 'after_head':
                raise InjectedCrash('after durable HEAD switch; reply lost')
            return successor
