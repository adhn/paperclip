"""Durable local retained-intent component, NOT an issuer or effect authority.

Protected installer must provision this file outside native rollback, protect its
parent against replacement, and independently establish complete original holds.
SQLite durability cannot detect disk snapshot rollback or exclude a physical stale
writer. No signing keys, evidence acceptance, native append, effect, permit or
operational receipt is provided. Callers must own cancellable worker execution.
"""
import copy
import json
import os
import sqlite3
import stat
from pathlib import Path
from contextlib import contextmanager

from legacy_review import ReviewHeld, canonical
from production.decision_history import build_intent_request, original_hold, pins_valid
from production.evidence_bridge import integer, hexhash


class RetainedDecisionStore:
    @staticmethod
    def _file_identity(info):
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != os.geteuid() or info.st_nlink != 1):
            raise ReviewHeld('retained_protected_file_required')
        return info.st_dev, info.st_ino

    @classmethod
    def _open_checked(cls, path, expected=None):
        # The protected parent is a deployment prerequisite. These checks catch
        # file aliases/replacement around open; they cannot secure a hostile
        # parent or prevent replacement after open by a privileged actor.
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            raise ReviewHeld('retained_protected_file_unavailable') from None
        db = None
        try:
            identity = cls._file_identity(os.fstat(fd))
            if expected is not None and identity != expected:
                raise ReviewHeld('retained_file_replaced')
            if cls._file_identity(os.lstat(path)) != identity:
                raise ReviewHeld('retained_file_replaced')
            db = sqlite3.connect(Path(path).absolute().as_uri() + '?mode=rw', uri=True, timeout=0)
            if cls._file_identity(os.fstat(fd)) != identity or cls._file_identity(os.lstat(path)) != identity:
                raise ReviewHeld('retained_file_replaced')
        except BaseException:
            if db is not None:
                try:
                    db.close()
                except BaseException:
                    pass  # Preserve the original setup/identity failure.
            try:
                os.close(fd)
            except BaseException:
                pass
            raise
        try:
            os.close(fd)
        except BaseException:
            # Descriptor close failure overrides successful setup. Do not leak
            # the database being returned, or retry an ambiguous numeric FD.
            try:
                db.close()
            except BaseException:
                pass
            raise
        return db

    @classmethod
    def provision(cls, path, *, pins, holds):
        """Explicit installer-only creation; never recreate a missing ledger on open."""
        pins_valid(pins)
        if type(holds) is not list or not 0 < len(holds) <= 256:
            raise ReviewHeld('retained_complete_inventory_required')
        for hold in holds:
            original_hold(hold)
        if len({h['source'] for h in holds}) != len(holds):
            raise ReviewHeld('retained_duplicate_source')
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            identity = cls._file_identity(os.fstat(fd))
            db = cls._open_checked(path, expected=identity)
        except BaseException:
            try:
                os.close(fd)
            except BaseException:
                pass
            raise
        try:
            os.close(fd)
        except BaseException:
            try:
                db.close()
            except BaseException:
                pass
            raise
        try:
            db.execute('PRAGMA journal_mode=DELETE')
            db.execute('PRAGMA synchronous=FULL')
            with db:
                db.execute('CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), pins BLOB NOT NULL, revision INTEGER NOT NULL)')
                db.execute('INSERT INTO metadata VALUES (1, ?, ?)', (canonical(pins), pins['historyFloor']))
                db.execute('CREATE TABLE sources (source TEXT PRIMARY KEY, hold BLOB NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, decision_hash TEXT, pending TEXT)')
                db.execute('CREATE TABLE intents (hash TEXT PRIMARY KEY, source TEXT NOT NULL, sequence INTEGER NOT NULL, body BLOB NOT NULL, status TEXT NOT NULL, UNIQUE(source,sequence))')
                db.executemany('INSERT INTO sources(source,hold) VALUES (?,?)', [(h['source'],canonical(h)) for h in holds])
        except BaseException:
            try:
                db.close()
            except BaseException:
                pass
            raise
        else:
            db.close()
        directory_fd = os.open(os.path.dirname(os.path.abspath(path)), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return cls(path, pins=pins)

    def __init__(self, path, *, pins):
        pins_valid(pins)
        # mode=rw refuses missing files; no implicit bootstrap after loss.
        db = self._open_checked(path)
        try:
            db.execute('PRAGMA synchronous=FULL')
            retained_pins = copy.deepcopy(pins)
            row = db.execute('SELECT pins,revision FROM metadata WHERE id=1').fetchone()
            if row is None or row[0] != canonical(pins) or row[1] < pins['historyFloor']:
                raise ReviewHeld('retained_identity_or_floor_mismatch')
        except BaseException:
            # Every post-open setup step belongs to this boundary. A failed
            # PRAGMA or interrupted metadata read must not leak SQL authority;
            # cleanup failure must not replace the original setup failure.
            try:
                db.close()
            except BaseException:
                pass
            raise
        self.db = db
        self.pins = retained_pins

    def close(self):
        db, self.db = self.db, None
        if db is not None:
            db.close()

    @contextmanager
    def _transaction(self):
        if self.db is None:
            raise ReviewHeld('retained_store_closed_or_uncertain')
        try:
            self.db.execute('BEGIN IMMEDIATE')
            yield
            self.db.commit()
        except BaseException:
            try:
                self.db.rollback()
            except BaseException:
                # An unacknowledged rollback cannot leave a reusable connection
                # carrying partial SQL work. Detach before one cleanup attempt.
                try:
                    self.close()
                except BaseException:
                    pass
            raise

    def _revision(self, expected):
        integer(expected, self.pins['historyFloor'])
        revision = self.db.execute('SELECT revision FROM metadata WHERE id=1').fetchone()[0]
        if revision != expected:
            raise ReviewHeld('retained_revision_cas')
        return revision

    def _advance(self):
        self.db.execute('UPDATE metadata SET revision=revision+1 WHERE id=1')

    def prepare(self, request, *, expected_revision):
        """Retain uncertainty BEFORE native append; not evidence validation/approval.

        A protected issuer must independently validate inventory/evidence/consent
        before calling. Exact retries inspect the same row, never supersede it.
        Every unresolved intent blocks another sequence, including a revoke.
        """
        if type(request) is not dict:
            raise ReviewHeld('retained_exact_request_required')
        intent = request.get('intent', {})
        try:
            rebuilt = build_intent_request(pins=self.pins, hold=intent['hold'], sequence=intent['sequence'],
                previous_hash=intent['previousHash'], decision_hash=intent['decisionHash'],
                inventory_hash=intent['inventoryHash'], approval_hash=intent['approvalHash'],
                action=intent['action'], challenge=request['challenge'], now=request['now'])
        except (KeyError, TypeError):
            raise ReviewHeld('retained_exact_request_required') from None
        if canonical(rebuilt) != canonical(request):
            raise ReviewHeld('retained_exact_request_required')
        with self._transaction():
            self._revision(expected_revision)
            source = self.db.execute('SELECT hold,sequence,decision_hash,pending FROM sources WHERE source=?', (intent['hold']['source'],)).fetchone()
            if source is None or source[0] != canonical(intent['hold']):
                raise ReviewHeld('retained_original_hold_mismatch')
            existing = self.db.execute('SELECT body FROM intents WHERE hash=?', (request['intentHash'],)).fetchone()
            if existing is not None:
                if existing[0] != canonical(intent):
                    raise ReviewHeld('retained_intent_conflict')
            else:
                if source[3] is not None or intent['sequence'] != source[1]+1 or intent['previousHash'] != source[2]:
                    raise ReviewHeld('retained_predecessor_or_uncertain')
                self.db.execute('INSERT INTO intents VALUES (?,?,?,?,?)', (request['intentHash'],intent['hold']['source'],intent['sequence'],canonical(intent),'prospective-uncertain'))
                self.db.execute('UPDATE sources SET pending=? WHERE source=?', (request['intentHash'],intent['hold']['source']))
                self._advance()
        return self.inspect(request['intentHash'])

    def record_committed(self, intent_hash, *, expected_revision):
        """Protected coordinator records exact confirmed append; never executes it.

        For revoke this records history only, NOT revoked-settled: an independent
        ordered effect authority must still persist deny and settle pre-deny work.
        Lost/ambiguous native append must remain prospective-uncertain.
        """
        hexhash(intent_hash)
        with self._transaction():
            self._revision(expected_revision)
            row = self.db.execute('SELECT source,sequence,body,status FROM intents WHERE hash=?', (intent_hash,)).fetchone()
            if row is None:
                raise ReviewHeld('retained_unknown_intent')
            if row[3] != 'committed-exact':
                pending = self.db.execute('SELECT pending FROM sources WHERE source=?', (row[0],)).fetchone()[0]
                if pending != intent_hash:
                    raise ReviewHeld('retained_pending_conflict')
                intent = json.loads(row[2])
                self.db.execute("UPDATE intents SET status='committed-exact' WHERE hash=?", (intent_hash,))
                self.db.execute('UPDATE sources SET sequence=?,decision_hash=?,pending=NULL WHERE source=?', (row[1],intent['decisionHash'],row[0]))
                self._advance()
        return self.inspect(intent_hash)

    def inspect(self, intent_hash):
        """Unsigned observation only. Unknown is held, never permission to retry."""
        hexhash(intent_hash)
        with self._transaction():
            revision = self.db.execute('SELECT revision FROM metadata WHERE id=1').fetchone()[0]
            row = self.db.execute('SELECT body,status FROM intents WHERE hash=?', (intent_hash,)).fetchone()
            if row is None:
                raise ReviewHeld('retained_unknown_intent_inspection_held')
            intent = json.loads(row[0])
            current = self.db.execute('SELECT sequence,decision_hash,pending FROM sources WHERE source=?', (intent['hold']['source'],)).fetchone()
            return dict(intentHash=intent_hash, intent=intent, status=row[1], historyRevision=revision,
                        current=(current[0] == intent['sequence'] and current[1] == intent['decisionHash'] and current[2] is None))
