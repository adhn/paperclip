"""Trusted-host protocol prepended to the existing descendant supervisor/stop client.

No commands or secrets enter the journal. The runner UID is a cooperative trust
boundary, not isolation from hostile sibling code. All mutations take epoch.lock;
start holds it until Popen returns. Uncertain consumption is never replayed.
"""
import fcntl
import json
import os
from pathlib import Path
import uuid

FIELDS = ('epoch', 'companyId', 'agentId', 'runId', 'attemptId',
          'environmentId', 'leaseId', 'invocationId')


def identity(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('noncanonical_identity')
    return value


def binding_from(value):
    if not isinstance(value, dict) or set(value) != set(FIELDS):
        raise ValueError('invalid_binding')
    return {key: identity(value[key]) for key in FIELDS}


def durable_store(destination, value):
    temporary = destination.with_name(destination.name + '.tmp')
    with temporary.open('w') as file:
        json.dump(value, file, sort_keys=True)
        file.flush()
        os.fsync(file.fileno())
    temporary.replace(destination)
    directory = os.open(destination.parent, os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def durable_directory(destination):
    destination.mkdir(mode=0o700, exist_ok=True)
    parent = os.open(destination.parent, os.O_DIRECTORY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def epoch_change(fence, operation, envelope):
    # Root is an absolute, canonical path resolved from server-owned runner policy.
    if not fence.is_absolute() or fence.resolve() != fence:
        raise ValueError('noncanonical_fence_root')
    if operation == 'initialize':
        fence.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (fence / 'epoch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        epoch = identity(envelope['epoch'])
        current = json.loads((fence / 'epoch.json').read_text()) if (fence / 'epoch.json').exists() else None
        if operation == 'initialize':
            if current is not None:
                raise ValueError('already_initialized')
        elif operation == 'takeover':
            if current != {'epoch': identity(envelope['previousEpoch'])}:
                raise ValueError('stale_takeover')
        else:
            raise ValueError('unknown_epoch_operation')
        durable_directory(fence / 'epochs')
        if (fence / 'epochs' / epoch).exists():
            raise ValueError('epoch_reused')
        # A crash between history and current update requires explicit recovery;
        # retaining a consumed epoch is safer than permitting an ABA takeover.
        durable_store(fence / 'epochs' / epoch, {'epoch': epoch})
        durable_store(fence / 'epoch.json', {'epoch': epoch})


def attempt_directory(fence, binding, operation):
    """Caller holds epoch.lock, including across the eventual Popen.

    Stop deliberately ignores current epoch so takeover cannot strand old work.
    It may only touch the exact retained binding, and never proves stop itself.
    """
    if operation == 'start' and json.loads((fence / 'epoch.json').read_text()) != {'epoch': binding['epoch']}:
        raise ValueError('stale_start')
    durable_directory(fence / 'attempts')
    durable_directory(fence / 'invocations')
    control = fence / 'attempts' / binding['attemptId']
    durable_directory(control)
    journal = control / 'binding.json'
    invocation = fence / 'invocations' / binding['invocationId']
    for record in (journal, invocation):
        if record.exists() and json.loads(record.read_text()) != binding:
            raise ValueError('binding_changed')
    if operation == 'start' and (journal.exists() or invocation.exists()):
        raise ValueError('attempt_consumed')
    # Either partial journal is enough to deny replay after a crash.
    if not invocation.exists():
        durable_store(invocation, binding)
    if not journal.exists():
        durable_store(journal, binding)
    return control
