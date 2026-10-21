"""Inactive local canonical effect owner. No mount, retirement or high-water claims.

The service takes exact immutable bytes, never attacker-selected filesystem paths.
Its private directory must be provisioned outside every caller's authority.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import threading
import time
import uuid
from production.descriptor_paths import open_directory, DescriptorPathError
from canonical_tree import capture_root, materialize, validate as validate_tree, validate_application_subset, TreeError

ROOTS = ('workspace', 'session', 'config')
MAX_GROUP = 1024 * 1024
MAX_REQUEST = 2 * MAX_GROUP
MAX_OPERATIONS = 1024


class OwnerError(RuntimeError):
    pass


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class CanonicalOwner:
    """One process owns a private canonical directory until close/crash.

    Crash after HEAD rename has an uncertain result; inspect the exact operation.
    Orphan staging/version directories are never taken as committed receipts.
    """
    def __init__(self, directory, fault=None):
        self.directory = Path(directory)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise OwnerError('private owner-owned directory required')
        self.lock = os.open(self.directory / '.owner-lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(self.lock)
            raise OwnerError('another canonical owner is active')
        self.mutex = threading.Lock()
        self.fault = fault or (lambda phase: None)
        self.closed = False
        self.poisoned = False

    def close(self):
        with self.mutex:
            if not self.closed:
                self.closed = True
                os.close(self.lock)

    def _head(self):
        path = self.directory / 'HEAD'
        if not path.exists():
            return {'generation': 0, 'operations': {}, 'version': None, 'roots': {}}
        if path.is_symlink() or path.stat().st_size > MAX_REQUEST:
            raise OwnerError('invalid HEAD')
        head = json.loads(path.read_bytes())
        # Verify the selected group, including every root, on each operation.
        if set(head['roots']) != set(ROOTS) or not re.fullmatch(r'v-[0-9a-f]{32}', head['version']):
            raise OwnerError('invalid complete root group')
        for root in ROOTS:
            source = self.directory / head['version'] / root
            fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                content = os.read(fd, MAX_GROUP + 1)
                if not stat.S_ISREG(os.fstat(fd).st_mode) or hashlib.sha256(content).hexdigest() != head['roots'][root]:
                    raise OwnerError('canonical integrity failure')
            finally:
                os.close(fd)
        if head.get('format', 'bytes') not in ('bytes', 'tree-v1'):
            raise OwnerError('unsupported canonical format')
        if head.get('format') == 'tree-v1':
            for root in ROOTS:
                fd = os.open(self.directory / head['version'] / 'trees' / root,
                             os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                try:
                    # Trusted private canonical owner, not a hostile mutable scan.
                    if hashlib.sha256(capture_root(fd, application_subset=False)).hexdigest() != head['roots'][root]:
                        raise OwnerError('materialized canonical tree integrity failure')
                finally:
                    os.close(fd)
        return head

    def _ready(self):
        if self.closed or self.poisoned:
            raise OwnerError('owner unavailable; reopen and inspect after uncertain write')

    def snapshot(self):
        with self.mutex:
            self._ready()
            return self._head()

    def inspect(self, operation_id):
        if not isinstance(operation_id, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,96}', operation_id):
            raise OwnerError('invalid operation identity')
        with self.mutex:
            self._ready()
            receipt = self._head()['operations'].get(operation_id)
            if receipt:
                try:
                    sync_directory(self.directory)
                except BaseException:
                    self.poisoned = True
                    raise
                return {'state': 'published', 'receipt': receipt}
            intent = self.directory / ('intent-' + operation_id)
            return {'state': 'uncertain', 'intent': json.loads(intent.read_bytes())} if intent.exists() else {'state': 'absent'}

    def deny(self, expected_generation):
        """Durable irreversible local future-publication deny; inspect remains open."""
        if type(expected_generation) is not int or expected_generation < 0:
            raise OwnerError('invalid generation')
        with self.mutex:
            self._ready()
            if self._head()['generation'] != expected_generation:
                raise OwnerError('stale deny generation')
            try:
                pending = self.directory / 'DENY.pending'
                denied = self.directory / 'DENIED'
                if not denied.exists():
                    with pending.open('xb') as output:
                        output.write(encoded({'generation': expected_generation, 'denied': True}))
                        output.flush()
                        os.fsync(output.fileno())
                    sync_directory(self.directory)
                    os.replace(pending, denied)
                sync_directory(self.directory)
                return {'denied': True, 'generation': expected_generation}
            except BaseException:
                self.poisoned = True
                raise

    def publish_trees(self, operation_id, expected_generation, roots):
        return self.publish(operation_id, expected_generation, roots, root_format='tree-v1')

    def export_trees(self, expected_generation, destination):
        """Materialize a complete detached launch group; no canonical FD escapes.

        Destination must be a fresh owner-private directory under a trusted parent,
        never a provider-controlled alias. Caller transfers ownership only after
        success and closes every inherited canonical FD before provider exec.
        This method does not launch providers or certify their old writers stopped.
        """
        if type(expected_generation) is not int or expected_generation < 0:
            raise OwnerError('invalid generation')
        with self.mutex:
            self._ready()
            head = self._head()
            if head['generation'] != expected_generation or head.get('format') != 'tree-v1':
                raise OwnerError('exact current tree generation required')
            if (self.directory / 'DENIED').exists() or (self.directory / 'DENY.pending').exists():
                raise OwnerError('local launch export denied or deny uncertain')
            if any(path.name[7:] not in head['operations'] for path in self.directory.glob('intent-*')):
                raise OwnerError('unresolved retained intent holds launch export')
            # Policy tightening must not erase accepted historical inspection.
            # Refuse the complete new export before touching its destination.
            payloads = {root: (self.directory / head['version'] / root).read_bytes() for root in ROOTS}
            try:
                for payload in payloads.values():
                    validate_application_subset(payload)
            except TreeError as exc:
                raise OwnerError('unsupported application tree for new export') from exc
            # Trusted path custody remains external, but no ancestor symlink or
            # lexical alias may redirect the actual materialization descriptor.
            try:
                fd = open_directory(os.fspath(destination))
            except (DescriptorPathError, OSError) as exc:
                raise OwnerError('canonical nofollow detached destination required') from exc
            try:
                info = os.fstat(fd)
                if info.st_uid != os.getuid() or info.st_mode & 0o077 or os.listdir(fd):
                    raise OwnerError('fresh owner-private detached destination required')
                # Do not materialize inside canonical custody itself.
                canonical_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    canonical_info = os.fstat(canonical_fd)
                    canonical_identity = (canonical_info.st_dev, canonical_info.st_ino)
                    ancestor = os.dup(fd)
                    try:
                        while True:
                            ancestor_info = os.fstat(ancestor)
                            identity = (ancestor_info.st_dev, ancestor_info.st_ino)
                            if identity == canonical_identity:
                                raise OwnerError('detached destination outside canonical custody required')
                            parent = os.open('..', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=ancestor)
                            parent_info = os.fstat(parent)
                            if (parent_info.st_dev, parent_info.st_ino) == identity:
                                os.close(parent)
                                break
                            os.close(ancestor)
                            ancestor = parent
                    finally:
                        os.close(ancestor)
                finally:
                    os.close(canonical_fd)
                for root in ROOTS:
                    materialize(payloads[root], fd, root)
                os.fsync(fd)
                return {'generation': head['generation'], 'version': head['version'], 'roots': dict(head['roots'])}
            finally:
                os.close(fd)

    def publish(self, operation_id, expected_generation, roots, *, root_format='bytes'):
        if not isinstance(operation_id, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,96}', operation_id):
            raise OwnerError('invalid operation identity')
        if type(expected_generation) is not int or expected_generation < 0:
            raise OwnerError('invalid generation')
        if type(roots) is not dict or set(roots) != set(ROOTS) or any(type(value) is not bytes for value in roots.values()):
            raise OwnerError('exact complete immutable root bytes required')
        if sum(map(len, roots.values())) > MAX_GROUP:
            raise OwnerError('root group too large')
        if root_format not in ('bytes', 'tree-v1'):
            raise OwnerError('unsupported root format')
        roots = dict(roots)
        if root_format == 'tree-v1':
            try:
                for value in roots.values():
                    validate_tree(value)
            except TreeError as exc:
                raise OwnerError('unsupported or invalid root tree') from exc
        hashes = {root: hashlib.sha256(roots[root]).hexdigest() for root in ROOTS}
        intent_identity = {'expected_generation': expected_generation, 'roots': hashes}
        if root_format != 'bytes':
            intent_identity['format'] = root_format
        digest = hashlib.sha256(encoded(intent_identity)).hexdigest()
        with self.mutex:
            self._ready()
            head = self._head()
            prior = head['operations'].get(operation_id)
            if prior:
                if prior['digest'] != digest:
                    raise OwnerError('operation identity conflict')
                try:
                    sync_directory(self.directory)
                except BaseException:
                    self.poisoned = True
                    raise
                return prior
            if (self.directory / 'DENIED').exists() or (self.directory / 'DENY.pending').exists():
                raise OwnerError('local publication denied or deny uncertain')
            if head['generation'] != expected_generation:
                raise OwnerError('stale generation')
            if len(head['operations']) >= MAX_OPERATIONS:
                raise OwnerError('retained operation capacity exhausted; no receipt eviction')
            if any(path.name[7:] not in head['operations'] for path in self.directory.glob('intent-*')):
                raise OwnerError('unresolved retained intent holds all new publications')
            if root_format == 'tree-v1':
                try:
                    for value in roots.values():
                        validate_application_subset(value)
                except TreeError as exc:
                    raise OwnerError('unsupported application tree for new publication') from exc
            intent = self.directory / ('intent-' + operation_id)
            if intent.exists():
                raise OwnerError('uncertain existing intent; inspect, no automatic replay')
            try:
                with intent.open('xb') as output:
                    output.write(encoded({'operation_id': operation_id, 'digest': digest, 'expected_generation': expected_generation, 'roots': hashes, 'format': root_format}))
                    output.flush()
                    os.fsync(output.fileno())
                sync_directory(self.directory)
                version = 'v-' + uuid.uuid4().hex
                target = self.directory / version
                target.mkdir(mode=0o700)
                for root in ROOTS:
                    fd = os.open(target / root, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
                    with os.fdopen(fd, 'wb') as output:
                        output.write(roots[root])
                        output.flush()
                        os.fsync(output.fileno())
                if root_format == 'tree-v1':
                    tree_target = target / 'trees'
                    tree_target.mkdir(mode=0o700)
                    tree_fd = os.open(tree_target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    try:
                        for root in ROOTS:
                            materialize(roots[root], tree_fd, root)
                        os.fsync(tree_fd)
                    finally:
                        os.close(tree_fd)
                sync_directory(target)
                self.fault('group_durable')
                receipt = {'operation_id': operation_id, 'digest': digest, 'generation': expected_generation + 1, 'version': version, 'roots': hashes}
                updated = {'generation': receipt['generation'], 'version': version, 'roots': hashes,
                           'operations': dict(head['operations'], **{operation_id: receipt})}
                if root_format != 'bytes':
                    receipt['format'] = root_format
                    updated['format'] = root_format
                payload = encoded(updated)
                if len(payload) > MAX_REQUEST:
                    raise OwnerError('retained HEAD capacity exhausted')
                pending = self.directory / ('pending-' + uuid.uuid4().hex)
                with pending.open('xb') as output:
                    output.write(payload)
                    output.flush()
                    os.fsync(output.fileno())
                self.fault('head_durable')
                os.replace(pending, self.directory / 'HEAD')
                self.fault('head_replaced')
                sync_directory(self.directory)
                self.fault('publication_durable')
                return receipt
            except BaseException:
                self.poisoned = True
                raise


def serve_connection(owner, connection, allowed_uid):
    """One authenticated, bounded, single-request local connection; no path API.

    Socket placement/UID separation is deployment responsibility. Same-UID callers
    can impersonate one another; this API does not authenticate provider identity.
    """
    deadline = time.monotonic() + 2
    connection.settimeout(2)
    _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    if uid != allowed_uid:
        raise OwnerError('unauthorized local peer')
    data = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise OwnerError('request deadline exceeded')
        connection.settimeout(remaining)
        block = connection.recv(min(65536, MAX_REQUEST + 1 - len(data)))
        if not block:
            break
        data.extend(block)
        if len(data) > MAX_REQUEST:
            raise OwnerError('oversized request')
    # Ambiguous signed/reviewed intent must never become a different effect via
    # JSON last-key-wins or base64 spellings. Reject before any owner operation.
    def unique_object(items):
        value = {}
        for key, item in items:
            if key in value:
                raise OwnerError('duplicate request member')
            value[key] = item
        return value
    def nonfinite(_):
        raise OwnerError('nonfinite request value')
    def floating(_):
        raise OwnerError('floating request value unsupported')
    try:
        request = json.loads(data, object_pairs_hook=unique_object,
                             parse_constant=nonfinite, parse_float=floating)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise OwnerError('invalid exact request JSON') from exc
    if type(request) is not dict:
        raise OwnerError('request object required')
    if request.get('action') == 'inspect' and set(request) == {'action', 'operation_id'}:
        result = owner.inspect(request['operation_id'])
    elif request.get('action') == 'deny' and set(request) == {'action', 'expected_generation'}:
        result = owner.deny(request['expected_generation'])
    elif request.get('action') in ('publish', 'publish_trees') and set(request) == {'action', 'operation_id', 'expected_generation', 'roots'}:
        wire_roots = request['roots']
        if type(wire_roots) is not dict or set(wire_roots) != set(ROOTS):
            raise OwnerError('complete exact encoded roots required')
        roots = {}
        for key, value in wire_roots.items():
            if type(value) is not str:
                raise OwnerError('canonical base64 root required')
            try:
                raw = base64.b64decode(value, validate=True)
            except ValueError as exc:
                raise OwnerError('canonical base64 root required') from exc
            if base64.b64encode(raw).decode('ascii') != value:
                raise OwnerError('canonical base64 root required')
            roots[key] = raw
        result = owner.publish(request['operation_id'], request['expected_generation'], roots,
                               root_format='tree-v1' if request['action'] == 'publish_trees' else 'bytes')
    else:
        raise OwnerError('unsupported exact request')
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise OwnerError('reply deadline exceeded; inspect exact operation')
    connection.settimeout(remaining)
    connection.sendall(encoded({'result': result}))


def serve(directory, socket_path, allowed_uid, stop):
    """Persistent sequential owner loop; caller provisions a private socket parent.

    Never unlinks an existing endpoint. Lifecycle supervisor owns endpoint cleanup.
    Errors produce refusal; a poisoned publication requires process restart/inspect.
    """
    owner = CanonicalOwner(directory)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(str(socket_path))
        os.chmod(socket_path, 0o666)
        listener.listen(4)
        listener.settimeout(0.1)
        while not stop.is_set():
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            with connection:
                try:
                    serve_connection(owner, connection, allowed_uid)
                except Exception:
                    try:
                        connection.sendall(encoded({'error': 'request refused; inspect exact operation'}))
                    except OSError:
                        pass
    finally:
        listener.close()
        owner.close()
