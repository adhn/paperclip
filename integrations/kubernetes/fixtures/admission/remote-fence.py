"""Fixture-only launch fence. No credentials, provider commands or cluster access.

The production SSH supervisor must take this fence around its own Popen, not
call this as a preliminary shell command and later launch outside the lock.
The current runner UID is trusted against sibling code, as in the accepted design.
"""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


def identity(value):
    if str(uuid.UUID(value)) != value:
        raise ValueError('noncanonical identity')
    return value


def store(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as file:
        json.dump(value, file)
        file.flush()
        os.fsync(file.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def gate(root, operation, envelope, command=None):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (root / 'epoch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        epoch_path = root / 'epoch.json'
        current = json.loads(epoch_path.read_text()) if epoch_path.exists() else None
        if operation == 'initialize':
            if current is not None:
                raise RuntimeError('already_initialized')
            store(epoch_path, {'epoch': identity(envelope['epoch'])})
            return
        if operation == 'takeover':
            # Compare-and-set prevents a delayed old takeover undoing a new epoch.
            if current != {'epoch': identity(envelope['previousEpoch'])}:
                raise RuntimeError('stale_takeover')
            store(epoch_path, {'epoch': identity(envelope['epoch'])})
            return
        required = ['epoch', 'companyId', 'agentId', 'runId', 'attemptId', 'environmentId', 'leaseId', 'invocationId']
        binding = {key: identity(envelope[key]) for key in required}
        if current != {'epoch': binding['epoch']}:
            raise RuntimeError('stale_start')
        directory = root / binding['attemptId']
        directory.mkdir(mode=0o700, exist_ok=True)
        if operation == 'cancel':
            journal = directory / 'binding.json'
            if journal.exists() and json.loads(journal.read_text()) != binding:
                raise RuntimeError('binding_changed')
            if not journal.exists():
                store(journal, binding)
            store(directory / 'cancel.json', binding)
            # This is a late-start tombstone, NOT proof of descendant stop.
            return
        if operation != 'start':
            raise RuntimeError('unknown_operation')
        if (directory / 'binding.json').exists() or (directory / 'cancel.json').exists():
            raise RuntimeError('attempt_consumed')
        # Persist before Popen. A crash in between consumes this authorization.
        # Its reconciliation must prove no live process before releasing capacity.
        store(directory / 'binding.json', binding)
        child = subprocess.Popen(command, start_new_session=True)
        store(directory / 'spawned.json', {**binding, 'pid': child.pid})
    # Test harness only: the production subreaper owns descendant stop receipts.
    return child.wait()


if __name__ == '__main__':
    try:
        code = gate(Path(sys.argv[1]), sys.argv[2], json.loads(sys.argv[3]), sys.argv[4:])
        sys.exit(code or 0)
    except (ValueError, KeyError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(125)
