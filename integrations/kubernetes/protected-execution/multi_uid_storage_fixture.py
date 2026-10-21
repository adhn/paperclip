"""Root-coordinated disposable container only. Never production acceptance."""
import errno
import hashlib
import json
import os
from pathlib import Path
import signal

CANONICAL = Path('/canonical')
ATTEMPTS = Path('/attempts')


def require_disposable():
    if os.getuid() != 0 or os.environ.get('PAPERCLIP_DISPOSABLE_FIXTURE') != '1':
        raise RuntimeError('explicit disposable-container root invocation required')
    mounts = {}
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left, right = line.split(' - ', 1)
        mounts[left.split()[4]] = right.split()[0]
    for path in (CANONICAL, ATTEMPTS):
        if path.is_symlink() or mounts.get(str(path)) != 'tmpfs' or any(path.iterdir()):
            raise RuntimeError('fresh exact separate tmpfs mountpoints required')
    if CANONICAL.stat().st_dev == ATTEMPTS.stat().st_dev:
        raise RuntimeError('attempt and canonical require distinct mounted filesystems')


def child_call(uid, action, controlled_fds=(), keep=()):
    """Small bounded UID child; no subprocess, transport or external command."""
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        signal.alarm(10)
        try:
            for fd in controlled_fds:
                if fd not in keep:
                    os.close(fd)
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)
            result = {'ok': True, 'uid': os.getuid(), 'value': action()}
        except BaseException as exc:
            result = {'ok': False, 'error': type(exc).__name__ + ': ' + str(exc)}
        encoded = json.dumps(result).encode()
        if len(encoded) > 4096:
            encoded = b'{"ok":false,"error":"oversized child result"}'
        os.write(write_fd, encoded)
        os.close(write_fd)
        os._exit(0)
    os.close(write_fd)
    chunks = []
    try:
        while block := os.read(read_fd, 4096):
            chunks.append(block)
            if sum(map(len, chunks)) > 8192:
                raise RuntimeError('unbounded child result')
    finally:
        os.close(read_fd)
        _, status = os.waitpid(pid, 0)
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        raise RuntimeError('child failed or timed out')
    result = json.loads(b''.join(chunks))
    if not result.get('ok') or result.get('uid') != uid:
        raise RuntimeError('UID child failed: ' + str(result))
    return result['value']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def denied_paths():
    observations = {}
    actions = {
        'traverse': lambda: list(CANONICAL.iterdir()),
        'read': lambda: (CANONICAL / 'version').read_bytes(),
        'write': lambda: (CANONICAL / 'version').write_bytes(b'forbidden'),
        'create': lambda: (CANONICAL / 'forbidden').write_bytes(b'forbidden'),
    }
    for name, action in actions.items():
        try:
            action()
        except OSError as exc:
            if exc.errno != errno.EACCES:
                raise
            observations[name] = 'EACCES'
        else:
            raise AssertionError('provider unexpectedly accessed canonical: ' + name)
    return observations


def run():
    require_disposable()
    descriptors = []
    try:
        # Root opens two deliberately controlled descriptors before transferring
        # ownership. The first belongs to the detached attempt, the second is
        # deliberately unsafe inherited canonical access characterized below.
        attempt = ATTEMPTS / 'value'
        attempt.write_bytes(b'synthetic-detached-attempt-original')
        attempt_fd = os.open(attempt, os.O_RDWR)
        descriptors.append(attempt_fd)
        attempt.chmod(0o644)
        os.chown(attempt, 1000, 1000)
        danger = CANONICAL / 'inherited-danger'
        danger.write_bytes(b'synthetic-canonical-original')
        danger_fd = os.open(danger, os.O_RDWR)
        descriptors.append(danger_fd)
        danger.chmod(0o600)
        os.chown(danger, 2000, 2000)
        CANONICAL.chmod(0o700)
        os.chown(CANONICAL, 2000, 2000)
        ATTEMPTS.chmod(0o755)
        os.chown(ATTEMPTS, 1000, 1000)

        def publish_copy():
            data = attempt.read_bytes()
            target = CANONICAL / 'version'
            with open(target, 'xb') as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            target.chmod(0o400)
            return {'sha256': digest(target), 'inode': target.stat().st_ino,
                    'device': target.stat().st_dev}
        published = child_call(2000, publish_copy, descriptors)
        denied = child_call(1000, denied_paths, descriptors)

        def stale_attempt_write():
            os.lseek(attempt_fd, 0, os.SEEK_SET)
            os.write(attempt_fd, b'STALE-ATTEMPT-WRITER')
            os.fsync(attempt_fd)
            return {'changed': attempt.read_bytes().startswith(b'STALE-ATTEMPT-WRITER')}
        stale = child_call(1000, stale_attempt_write, descriptors, (attempt_fd,))
        retained = child_call(2000, lambda: digest(CANONICAL / 'version'), descriptors)
        if not stale['changed'] or retained != published['sha256']:
            raise AssertionError('detached copy isolation failed')

        def inherited_write():
            os.lseek(danger_fd, 0, os.SEEK_SET)
            os.write(danger_fd, b'INHERITED-FD-BYPASS')
            os.fsync(danger_fd)
            return {'write_succeeded': True}
        inherited = child_call(1000, inherited_write, descriptors, (danger_fd,))
        danger_changed = child_call(2000, lambda: danger.read_bytes().startswith(b'INHERITED-FD-BYPASS'), descriptors)
        if not inherited['write_succeeded'] or not danger_changed:
            raise AssertionError('expected inherited-FD vulnerability was not reproduced')
        return {'fixture_pass': True, 'synthetic': True, 'operational_acceptance': False,
                'provider_path_denials': denied,
                'old_attempt_descriptor_changed_attempt': stale['changed'],
                'detached_canonical_hash_unchanged': retained == published['sha256'],
                'separate_filesystems': True,
                'expected_vulnerability': {'inherited_canonical_fd_bypasses_uid_path_isolation': True},
                'production_mount_isolation_proven': False,
                'legacy_writer_transition_proven': False,
                'current_history_proven': False}
    finally:
        for fd in descriptors:
            os.close(fd)


if __name__ == '__main__':
    print(json.dumps(run(), indent=2, sort_keys=True))
