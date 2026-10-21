"""Disposable kernel fixture: root schedules execution; import has no effects."""
import errno
import hashlib
import json
import os
from pathlib import Path
import resource
import signal
import sys

CANONICAL = Path('/canonical')
ATTEMPTS = Path('/attempts')
ROOTS = ('workspace', 'session', 'config')


def require_disposable():
    if os.getuid() != 0 or os.environ.get('PAPERCLIP_DISPOSABLE_FIXTURE') != '1':
        raise RuntimeError('explicit disposable root invocation required')
    mounts = {}
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left, right = line.split(' - ', 1)
        mounts[left.split()[4]] = right.split()[0]
    for path in (CANONICAL, ATTEMPTS):
        if path.is_symlink() or mounts.get(str(path)) != 'tmpfs' or any(path.iterdir()):
            raise RuntimeError('fresh exact tmpfs mounts required')
    if CANONICAL.stat().st_dev == ATTEMPTS.stat().st_dev:
        raise RuntimeError('distinct mounted filesystems required')


def close_except_report(report_fd):
    """Child-only, before dropping UID/exec: close *all* other descriptors.

    Fixed RLIMIT prevents an unbounded close loop; proc enumeration covers already
    open descriptors above a subsequently lowered soft limit. FD3 is output-only.
    """
    if report_fd != 3:
        os.dup2(report_fd, 3)
    os.set_inheritable(3, True)
    # Linux proc is required by this fixture. Fail closed if unavailable.
    descriptors = [int(name) for name in os.listdir('/proc/self/fd')]
    for fd in descriptors:
        if fd > 3:
            try:
                os.close(fd)
            except OSError as exc:
                if exc.errno != errno.EBADF:
                    raise
    for fd in (0, 1, 2):
        try:
            os.close(fd)
        except OSError as exc:
            if exc.errno != errno.EBADF:
                raise
    null_fd = os.open('/dev/null', os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null_fd, fd)
    if null_fd > 3:
        os.close(null_fd)


PROVIDER = r'''
import errno, json, os
from pathlib import Path
assert os.getuid() == 1000 and os.getgroups() == []
# Examine descriptors before opening attacker files. No inherited writable
# regular canonical file or directory is permitted, including unknown high FDs.
fds = []
for name in os.listdir('/proc/self/fd'):
    try:
        target = os.readlink('/proc/self/fd/' + name)
    except FileNotFoundError:
        continue
    assert not target.startswith('/canonical'), (name, target)
    fds.append(target)
try:
    os.write(200, b'INHERITED-FD-BYPASS')
except OSError as exc:
    assert exc.errno == errno.EBADF, exc
else:
    raise AssertionError('inherited writable FD200 survived exec')
try:
    os.open('/proc/' + str(os.getppid()) + '/fd/200', os.O_WRONLY)
except OSError as exc:
    assert exc.errno in (errno.EACCES, errno.EPERM), exc
else:
    raise AssertionError('provider reacquired parent canonical descriptor')
for path in ('/canonical', '/canonical/HEAD', '/canonical/danger'):
    try:
        os.listdir(path) if path == '/canonical' else os.open(path, os.O_RDWR)
    except OSError as exc:
        assert exc.errno == errno.EACCES, (path, exc)
    else:
        raise AssertionError('canonical path accessible')
for root in ('workspace', 'session', 'config'):
    Path('/attempts/' + root).write_bytes(b'provider-stale-change')
os.write(3, json.dumps({'uid':os.getuid(), 'no_canonical_descriptors':True,
    'path_denied':True, 'parent_proc_fd_reopen_denied':True, 'inherited_fd_write_ebadf':True, 'attempts_changed':True}).encode())
'''


def child(uid, action=None, exec_provider=False):
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            signal.alarm(10)
            close_except_report(write_fd)
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)
            if exec_provider:
                # No user startup/env hooks and no trusted parent bytecode state.
                os.execve(sys.executable, [sys.executable, '-I', '-B', '-c', PROVIDER], {})
            value = action()
            os.write(3, json.dumps(value).encode())
            os._exit(0)
        except BaseException:
            os._exit(1)
    os.close(write_fd)
    try:
        data = os.read(read_fd, 8193)
        if len(data) > 8192:
            raise RuntimeError('oversized child output')
    finally:
        os.close(read_fd)
        _, status = os.waitpid(pid, 0)
    if status != 0:
        raise RuntimeError('isolated child failed or timed out: ' + str(status))
    return json.loads(data)


def owner_publish():
    version = CANONICAL / 'version-1'
    version.mkdir(mode=0o700)
    manifest = {}
    for root in ROOTS:
        data = (ATTEMPTS / root).read_bytes()
        target = version / root
        with target.open('xb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        target.chmod(0o400)
        manifest[root] = hashlib.sha256(data).hexdigest()
    directory = os.open(version, os.O_RDONLY | os.O_DIRECTORY)
    os.fsync(directory)
    os.close(directory)
    head = {'generation': 1, 'version': version.name, 'roots': manifest}
    with (CANONICAL / 'HEAD.pending').open('x') as output:
        json.dump(head, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(CANONICAL / 'HEAD.pending', CANONICAL / 'HEAD')
    directory = os.open(CANONICAL, os.O_RDONLY | os.O_DIRECTORY)
    os.fsync(directory)
    os.close(directory)
    return head


def owner_inspect():
    head = json.loads((CANONICAL / 'HEAD').read_text())
    for root, expected in head['roots'].items():
        assert hashlib.sha256((CANONICAL / head['version'] / root).read_bytes()).hexdigest() == expected
    assert (CANONICAL / 'danger').read_bytes() == b'canonical-original'
    return head


def run():
    require_disposable()
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    for root in ROOTS:
        path = ATTEMPTS / root
        path.write_bytes(('original-' + root).encode())
        path.chmod(0o644)
        os.chown(path, 1000, 1000)
    ATTEMPTS.chmod(0o755)
    os.chown(ATTEMPTS, 1000, 1000)
    danger = CANONICAL / 'danger'
    danger.write_bytes(b'canonical-original')
    # Deliberately inheritable and unknown to the child launcher: regression
    # against enumerating only a caller-provided list of dangerous descriptors.
    danger_fd = os.open(danger, os.O_RDWR)
    high_fd = 200
    os.dup2(danger_fd, high_fd, inheritable=True)
    os.set_inheritable(danger_fd, True)
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 256))
    danger.chmod(0o600)
    os.chown(danger, 2000, 2000)
    CANONICAL.chmod(0o700)
    os.chown(CANONICAL, 2000, 2000)
    try:
        head = child(2000, owner_publish)
        provider = child(1000, exec_provider=True)
        retained = child(2000, owner_inspect)
        assert retained == head and set(head['roots']) == set(ROOTS)
        return {'fixture_pass': True, 'synthetic': True, 'operational_acceptance': False,
                'provider_exec': provider, 'whole_group_head': retained,
                'unknown_inheritable_canonical_fds_closed': True,
                'canonical_bytes_unchanged': True,
                'legacy_writer_retirement_proven': False,
                'production_mount_isolation_proven': False,
                'cross_authority_atomicity_proven': False}
    finally:
        os.close(high_fd)
        os.close(danger_fd)


if __name__ == '__main__':
    print(json.dumps(run(), indent=2, sort_keys=True))
