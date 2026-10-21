"""Local durable pipe-effect owner, NOT runtime T or native release authority.

Trusted installation must establish exclusive custody of a nonblocking pipe writer;
Python descriptor transfer cannot revoke duplicates or inherited writers. Every enqueue is
an actual atomic kernel pipe write, after a FULL-synchronous prospective record.
A lost result stays pending forever until inspection; no body is replayed. Deny
and enqueue share the same local lock and durable generation. This cannot retract
queued bytes or prove consumer dequeue/retirement, remote runtime ownership,
independent history, rollback fencing, or physical-COMMIT freshness.
Sticky private filesystem attempt/deny barriers precede fallible SQLite commands.
Interrupted preparation or a barrier without exact enqueued completion holds new
work across reopen, including failure before a prospective SQL row exists.
Only the latest barrier is selected; older exact completed intents stay in SQL.
No marker is deleted to recover uncertainty. Marker-only inspection means pending,
not absent; partial/corrupt preparation holds globally without fabricated identity.

Only trusted installation code may supply the state path within an owner-private,
non-aliased parent directory and the descriptor.
Successful construction closes the transferred caller FD and retains a private
close-on-exec duplicate. The caller must not concurrently close/reassign the FD
during construction. This protects accidental later reuse, not hostile trusted
code, surviving duplicates, or shared open-file-description flag changes.
No socket listener, provider execution, installation, or production bypass removal
is supplied here. All existing routes remain unmodified.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import threading

from production.gateway import Held
from production.route_policy import COMMAND_ROUTES


class PipeEffectOwner:
    def __init__(self, database, writer_fd, *, generation=1, owner_binding=None):
        if type(generation) is not int or generation < 1:
            raise Held('generation_invalid')
        if owner_binding is not None and (type(owner_binding) is not bytes or not 1 <= len(owner_binding) <= 512):
            raise Held('bounded_owner_binding_required')
        # Refuse special/non-private existing state before SQLite opens it.
        if os.path.lexists(database):
            mode = os.lstat(database)
            if not stat.S_ISREG(mode.st_mode) or mode.st_uid != os.geteuid() or mode.st_mode & 0o077:
                raise Held('private_regular_state_required')
        # Independent sticky barriers retain uncertainty even if SQLite refuses
        # an INSERT/UPDATE before any row exists. Trusted private parent custody
        # and rollback protection remain installation requirements.
        self._attempt = Path(str(database) + '.attempt')
        self._preparing = Path(str(database) + '.attempt.pending')
        self._denial = Path(str(database) + '.denied')
        self._generation = generation  # immutable identity, verified against SQL below
        self._mutex = threading.RLock()
        self._closed = False
        self._fd = None
        self._db = None
        self._parentfd = None
        self._lockfd = None
        try:
            # Validate custody before creating even the lock file. A refused
            # nonprivate parent must not receive owner state as a side effect.
            self._parentfd = os.open(os.path.dirname(os.path.abspath(database)), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            parent_stat = os.fstat(self._parentfd)
            if parent_stat.st_uid != os.geteuid() or parent_stat.st_mode & 0o077:
                raise Held('private_state_parent_required')
            self._lockfd = os.open(str(database) + '.owner', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
            lock_stat = os.fstat(self._lockfd)
            if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_uid != os.geteuid() or lock_stat.st_mode & 0o077 or lock_stat.st_nlink != 1:
                raise Held('private_regular_lock_required')
            fcntl.flock(self._lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if not stat.S_ISFIFO(os.fstat(writer_fd).st_mode):
                raise Held('pipe_writer_required')
            flags = fcntl.fcntl(writer_fd, fcntl.F_GETFL)
            if flags & os.O_ACCMODE != os.O_WRONLY or not flags & os.O_NONBLOCK:
                raise Held('nonblocking_writer_required')
            # Duplicate before any fallible state setup, but leave caller custody
            # intact until initialization and durability have succeeded.
            self._fd = fcntl.fcntl(writer_fd, fcntl.F_DUPFD_CLOEXEC, 0)
            self._limit = min(os.fpathconf(self._fd, 'PC_PIPE_BUF'), 4096)
            self._db = sqlite3.connect(database, isolation_level=None, check_same_thread=False)
            os.chmod(database, 0o600)
            self._db.execute('PRAGMA journal_mode=DELETE')
            self._db.execute('PRAGMA synchronous=FULL')
            self._db.executescript('''
              CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, denied INTEGER NOT NULL);
              CREATE TABLE IF NOT EXISTS custody (id INTEGER PRIMARY KEY CHECK(id=1), binding BLOB);
              CREATE TABLE IF NOT EXISTS intents (operation TEXT PRIMARY KEY, generation INTEGER NOT NULL, route TEXT NOT NULL, digest TEXT NOT NULL, frame BLOB NOT NULL, status TEXT NOT NULL);
            ''')
            retained = self._db.execute('SELECT binding FROM custody WHERE id=1').fetchone()
            if retained is None:
                # Existing generic history cannot be reinterpreted as exact-owner
                # control. New databases pin custody before descriptor transfer.
                if owner_binding is not None and (
                        self._db.execute('SELECT 1 FROM state').fetchone()
                        or self._db.execute('SELECT 1 FROM intents').fetchone()):
                    raise Held('existing_unbound_owner_cannot_be_rebound')
                self._db.execute('INSERT INTO custody VALUES (1, ?)', (owner_binding,))
            elif retained[0] != owner_binding:
                raise Held('retained_owner_binding_mismatch')
            self._db.execute('INSERT OR IGNORE INTO state VALUES (1, ?, 0)', (generation,))
            current = self._db.execute('SELECT generation FROM state WHERE id=1').fetchone()[0]
            if current != generation:
                raise Held('stale_owner_generation')
            # Any prior pending write has unknown effect. Startup never replays.
            self._held = bool(self._db.execute("SELECT 1 FROM intents WHERE status='pending' LIMIT 1").fetchone())
            # Never discard an interrupted barrier, even when the SQL journal
            # has no row. A completed exact journal entry can settle only its
            # matching selected barrier; no effect is automatically retried.
            self._held = self._held or os.path.lexists(self._preparing)
            if os.path.lexists(self._attempt):
                try:
                    marker = self._read_attempt(self._attempt)
                    row = self._db.execute('SELECT digest,status FROM intents WHERE operation=?',
                                           (marker['operation'],)).fetchone()
                    self._held = self._held or row != (marker['digest'], 'enqueued')
                except Exception:
                    self._held = True
            # SQLite FULL syncs its journal/database, but initial directory entry
            # durability is also required before any externally visible pipe byte.
            os.fsync(self._parentfd)
            os.close(writer_fd)  # successful construction consumes caller custody
        except BaseException:
            # Every independent handle is attempted even if one close fails;
            # preserve the original setup error. Only owner-held handles are
            # cleaned here; final caller-FD transfer retains normal close limits.
            try:
                self._close_resources()
            except BaseException:
                pass
            raise

    def _close_resources(self):
        first_error = None
        for name in ('_fd', '_db', '_parentfd', '_lockfd'):
            resource = getattr(self, name)
            # Detach before close: never retry a numeric descriptor after an
            # ambiguous close error, when that number may have been reused.
            setattr(self, name, None)
            if resource is not None:
                try:
                    if name == '_db':
                        resource.close()
                    else:
                        os.close(resource)
                except BaseException as error:
                    if first_error is None:
                        first_error = error
        if first_error is not None:
            raise first_error

    @staticmethod
    def _read_attempt(path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > 4096):
                raise Held('invalid_attempt_barrier')
            frame = source.read(4097)
        marker = json.loads(frame)
        if (type(marker) is not dict or set(marker) != {'operation', 'route', 'generation', 'payload'}
                or type(marker['generation']) is not int or marker['generation'] < 1
                or type(marker['route']) is not str or marker['route'] not in COMMAND_ROUTES
                or type(marker['payload']) is not str):
            raise Held('invalid_attempt_barrier')
        PipeEffectOwner._operation(marker['operation'])
        # Recovery recognizes only exact frames this owner could have written.
        # Corrupt markers still hold globally, but cannot invent an inspectable
        # operation. Re-encoding is validation only; no frame is replayed.
        try:
            payload = base64.b64decode(marker['payload'], validate=True)
        except (ValueError, TypeError):
            raise Held('invalid_attempt_barrier') from None
        canonical = json.dumps(marker, sort_keys=True, separators=(',', ':')).encode() + b'\n'
        if (len(payload) > 1024 or base64.b64encode(payload).decode('ascii') != marker['payload']
                or canonical != frame):
            raise Held('invalid_attempt_barrier')
        # Immutable exact pipe frame is retained, not reconstructed for replay.
        return {'operation': marker['operation'], 'generation': marker['generation'],
                'route': marker['route'], 'digest': hashlib.sha256(frame).hexdigest(),
                'status': 'pending'}

    def _barrier(self, frame):
        # A partial preparation remains a permanent global uncertainty hold.
        # No unlink/cleanup is permitted after a failed attempt.
        fd = os.open(self._preparing, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(frame)
            output.flush()
            os.fsync(output.fileno())
        os.fsync(self._parentfd)
        os.replace(self._preparing, self._attempt)
        os.fsync(self._parentfd)

    @staticmethod
    def _operation(operation):
        if type(operation) is not str or not 1 <= len(operation) <= 128 or not operation.isascii() or not all(c.isalnum() or c in '-_.' for c in operation):
            raise Held('operation_invalid')

    def _open(self):
        if self._closed:
            raise Held('owner_closed')

    def enqueue(self, operation, route, payload, *, generation):
        self._operation(operation)
        if type(route) is not str or route not in COMMAND_ROUTES or type(payload) is not bytes or len(payload) > 1024:
            raise Held('exact_bounded_route_payload_required')
        if type(generation) is not int or generation < 1:
            raise Held('generation_invalid')
        # Payload is exact bytes, encoded once; the owner writes this frame itself.
        frame = json.dumps({'operation': operation, 'route': route, 'generation': generation,
                            'payload': base64.b64encode(payload).decode('ascii')}, sort_keys=True, separators=(',', ':')).encode() + b'\n'
        if len(frame) > self._limit:
            raise Held('atomic_frame_bound')
        digest = hashlib.sha256(frame).hexdigest()
        with self._mutex:
            self._open()
            if generation != self._generation:
                raise Held('stale_owner_generation')
            old = self._db.execute('SELECT generation,route,digest,status FROM intents WHERE operation=?', (operation,)).fetchone()
            if old:
                # Even exact successful requests inspect rather than replay.
                raise Held('exact_intent_already_retained' if old[:3] == (generation, route, digest) else 'intent_conflict')
            current, denied = self._db.execute('SELECT generation,denied FROM state WHERE id=1').fetchone()
            if current != self._generation:
                self._held = True
                raise Held('retained_generation_changed')
            if self._held or denied or os.path.lexists(self._denial) or generation != self._generation:
                raise Held('owner_held_denied_or_stale')
            # Commit errors may themselves be ambiguous. Poison before insertion,
            # and never clear the hold after any database or pipe exception.
            self._held = True
            try:
                self._barrier(frame)
                self._db.execute('INSERT INTO intents VALUES (?,?,?,?,?,?)', (operation, generation, route, digest, frame, 'pending'))
                # Retain parent metadata before an irreversible local effect.
                os.fsync(self._parentfd)
                # FULL synchronous prospective commit precedes the actual write.
                count = os.write(self._fd, frame)
                if count != len(frame):
                    raise Held('unexpected_partial_atomic_write')
                self._db.execute("UPDATE intents SET status='enqueued' WHERE operation=?", (operation,))
                self._held = False
            except BaseException:
                raise Held('pipe_effect_unknown_inspect_only') from None
            return self.inspect(operation)

    def inspect(self, operation):
        self._operation(operation)
        with self._mutex:
            self._open()
            row = self._db.execute('SELECT generation,route,digest,status FROM intents WHERE operation=?', (operation,)).fetchone()
            if row is not None:
                return dict(zip(('generation', 'route', 'digest', 'status'), row))
            for path in (self._preparing, self._attempt):
                if os.path.lexists(path):
                    try:
                        marker = self._read_attempt(path)
                    except Exception:
                        continue  # malformed barrier still holds all new effects
                    if marker.pop('operation') == operation:
                        return marker
            return None

    def deny(self, *, generation):
        """Durably deny local future enqueues; never claims runtime T/completed B."""
        if type(generation) is not int:
            raise Held('generation_invalid')
        with self._mutex:
            self._open()
            # Reject stale caller intent without touching persistence. The owner
            # generation is immutable and verified during construction; a later
            # database read failure must not make an exact deny disappear.
            if generation != self._generation:
                raise Held('stale_owner_generation')
            was_held = self._held
            self._held = True
            try:
                # Permanent deny precedes the fallible SQL update. Inspection
                # does not depend on success of that update, now or after restart.
                if not os.path.lexists(self._denial):
                    fd = os.open(self._denial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
                    with os.fdopen(fd, 'wb') as output:
                        output.write(b'denied\n')
                        output.flush()
                        os.fsync(output.fileno())
                else:
                    # A previous attempt may have created the marker but failed
                    # its inode fsync. Presence is a conservative hold, not proof
                    # of durability: retry must sync it before any SQL access.
                    fd = os.open(self._denial, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
                    try:
                        info = os.fstat(fd)
                        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                                or info.st_mode & 0o077 or info.st_nlink != 1):
                            raise Held('private_regular_denial_required')
                        os.fsync(fd)
                    finally:
                        os.close(fd)
                os.fsync(self._parentfd)
                current = self._db.execute('SELECT generation FROM state WHERE id=1').fetchone()[0]
                if current != self._generation:
                    raise Held('retained_generation_changed')
                self._db.execute('UPDATE state SET denied=1 WHERE id=1')
                os.fsync(self._parentfd)
            except BaseException:
                raise Held('deny_commit_unknown_local_owner_held') from None
            self._held = was_held

    def close(self):
        with self._mutex:
            if not self._closed:
                self._closed = True
                self._close_resources()
