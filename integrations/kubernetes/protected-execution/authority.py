"""Inactive non-root execution authority. No Kubernetes/SSH/provider caller.

The runtime interface is trusted infrastructure, never provider stdout. The
disposable Docker adapter is a test oracle, not a Kubernetes termination proof.
"""
import contextlib
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import time
import uuid


class Held(Exception):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False, ensure_ascii=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def strict(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields.split()):
        raise Held("invalid_contract_fields")


def identity(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 512 or value.strip() != value or any(ord(c) < 32 for c in value):
        raise Held("invalid_identity")


def validate_policy(policy):
    strict(policy, "version instance pool runtimeAuthority templates families")
    if type(policy["version"]) is not int or policy["version"] != 1:
        raise Held("invalid_authority_policy")
    for field in ("instance", "pool", "runtimeAuthority"):
        identity(policy[field])
    if not isinstance(policy["templates"], dict) or not 1 <= len(policy["templates"]) <= 3:
        raise Held("invalid_authority_templates")
    for name, template in policy["templates"].items():
        identity(name)
        strict(template, "image entrypoint")
        if not re.fullmatch(r"(?:[^\s]+@)?sha256:[0-9a-f]{64}", template["image"]) or not template["entrypoint"].startswith("/"):
            raise Held("invalid_authority_template")
    if not isinstance(policy["families"], list) or not 1 <= len(policy["families"]) <= 10:
        raise Held("invalid_authority_families")
    for family in policy["families"]:
        strict(family, "runner account workspace session credential")
        for value in family.values():
            identity(value)


def protected_directory(path):
    path = Path(path).absolute()
    # A private directory may have root-owned parents, but none may be writable
    # by an unrelated UID/group. /tmp is deliberately not a production root.
    for item in (path, *path.parents):
        info = item.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022:
            raise Held("unprotected_ledger_root")
    if path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise Held("unprotected_ledger_root")
    return path


class Ledger:
    """FULL synchronous SQLite transactions plus persistent incarnation pin.

    Initialization is explicit and separate from opening. Missing ledger is a
    hold, never an invitation to mint a replacement incarnation on restart.
    Independent controller high-water pins are required against snapshot rollback.
    """
    @classmethod
    def initialize(cls, root, policy):
        validate_policy(policy)
        root = protected_directory(root)
        fd = os.open(root / "ledger.sqlite", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        con = sqlite3.connect(root / "ledger.sqlite")
        try:
            con.executescript("""
              PRAGMA synchronous=FULL;
              CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), incarnation TEXT NOT NULL,
                policy TEXT NOT NULL, generation INTEGER NOT NULL, epoch TEXT);
              CREATE TABLE epochs (epoch TEXT PRIMARY KEY, generation INTEGER UNIQUE NOT NULL);
              CREATE TABLE attempts (id TEXT PRIMARY KEY, owner TEXT UNIQUE NOT NULL,
                epoch TEXT NOT NULL, storage TEXT UNIQUE NOT NULL, phase TEXT NOT NULL);
              CREATE TABLE commands (id TEXT PRIMARY KEY, attempt TEXT NOT NULL REFERENCES attempts(id),
                contract TEXT NOT NULL, phase TEXT NOT NULL, physical TEXT, observation TEXT);
              CREATE TABLE events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL);
            """)
            con.execute("INSERT INTO meta VALUES (1,?,?,0,NULL)", (str(uuid.uuid4()), digest(policy)))
            con.commit()
        finally:
            con.close()
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def __init__(self, root, policy, incarnation):
        validate_policy(policy)
        self.root = protected_directory(root)
        info = (self.root / "ledger.sqlite").lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise Held("unprotected_ledger_file")
        self.db = sqlite3.connect(f"file:{self.root}/ledger.sqlite?mode=rw", uri=True, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA busy_timeout=5000")
        if self.db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise Held("ledger_corrupt")
        meta = self.meta()
        if meta["incarnation"] != incarnation or meta["policy"] != digest(policy):
            raise Held("ledger_identity_mismatch")

    def meta(self):
        return dict(self.db.execute("SELECT * FROM meta WHERE id=1").fetchone())

    def watermark(self, sequence=None):
        rows = (self.db.execute("SELECT seq,body FROM events ORDER BY seq") if sequence is None else
                self.db.execute("SELECT seq,body FROM events WHERE seq<=? ORDER BY seq", (sequence,))).fetchall()
        return {"sequence": rows[-1][0] if rows else 0,
                "hash": digest([[row[0], row[1]] for row in rows])}

    @contextlib.contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def event(self, kind, value):
        self.db.execute("INSERT INTO events(body) VALUES (?)", (canonical({"kind": kind, "value": value}).decode(),))


OWNER_FIELDS = "company agent nativeKind nativeId environment lease attempt runner account workspace session credential"
CONTRACT_FIELDS = "version instance policy epoch generation owner invocation commandHash journalHash storage template argv"


class Authority:
    def __init__(self, ledger, policy, request_key, ack_key, runtime, retirement_verifier=None):
        if len(request_key) < 32 or len(ack_key) < 32 or request_key == ack_key:
            raise Held("invalid_control_keys")
        self.ledger, self.policy, self.runtime = ledger, policy, runtime
        self.request_key, self.ack_key = request_key, ack_key
        self.retirement_verifier = retirement_verifier

    def authenticated(self, envelope):
        strict(envelope, "body mac")
        if not hmac.compare_digest(sign(self.request_key, "request", envelope["body"]), envelope["mac"]):
            raise Held("control_authentication_failed")
        body = envelope["body"]
        if not isinstance(body, dict) or not isinstance(body.get("expires"), int) or not time.time() < body["expires"] <= time.time() + 60:
            raise Held("expired_control_request")
        identity(body.get("nonce"))
        return body

    def respond(self, request, result):
        body = {"requestHash": digest(request), "nonce": request["nonce"],
                "instance": self.policy["instance"], "policy": digest(self.policy),
                "pool": self.policy["pool"], **self.ledger.meta(), "ledgerWatermark": self.ledger.watermark(), "result": result}
        return {"body": body, "mac": sign(self.ack_key, "ack", body)}

    def call(self, envelope):
        request = self.authenticated(envelope)
        strict(request, "op value nonce expires" + (" highWater" if "highWater" in request else ""))
        floor = request.get("highWater")
        # Each operation checks the exact accepted prefix under its mutation
        # lock. A longer divergent log cannot bypass a shorter trusted floor.
        if request["op"] == "acknowledgeEpoch":
            result = self.epoch(request["value"], floor)
        elif request["op"] == "authorizeInvocation":
            result = self.authorize(request["value"], floor)
        elif request["op"] == "recoverAttempt":
            result = self.recover(request["value"], floor)
        elif request["op"] in ("inspect", "stopAndInspect"):
            result = self.inspect(request["value"], request["op"] == "stopAndInspect", floor)
        else:
            raise Held("unsupported_control_operation")
        return self.respond(request, result)

    def _check_floor(self, floor):
        if floor is None:
            return  # legacy fixture protocol only; not a rollback guarantee
        strict(floor, "sequence hash")
        if (type(floor["sequence"]) is not int or floor["sequence"] < 0 or
            not isinstance(floor["hash"], str) or not re.fullmatch("[a-f0-9]{64}", floor["hash"])):
            raise Held("ledger_high_water_rollback")
        prefix = self.ledger.watermark(floor["sequence"])
        if prefix != floor:
            raise Held("ledger_high_water_rollback")

    def epoch(self, value, floor=None):
        strict(value, "expectedGeneration epoch")
        identity(value["epoch"])
        with self.ledger.transaction():
            self._check_floor(floor)
            attestation = self.runtime.attest()
            strict(attestation, "authority configuration objects")
            if (attestation["authority"] != self.policy["runtimeAuthority"] or
                    attestation["configuration"] != digest(self.policy) or attestation["objects"]):
                raise Held("runtime_pool_not_independently_attested_empty")
            meta = self.ledger.meta()
            if type(value["expectedGeneration"]) is not int:
                raise Held("invalid_generation")
            if meta["epoch"] == value["epoch"] and meta["generation"] == value["expectedGeneration"] + 1:
                return {"status": "acknowledged"}  # lost ACK, same CAS only
            if meta["generation"] != value["expectedGeneration"]:
                raise Held("epoch_compare_failed")
            if self.ledger.db.execute("SELECT 1 FROM epochs WHERE epoch=?", (value["epoch"],)).fetchone():
                raise Held("epoch_reuse")
            # No adoption/release: in-flight old work blocks epoch takeover until
            # a separate independently proved recovery protocol exists.
            if self.ledger.db.execute("SELECT 1 FROM attempts LIMIT 1").fetchone():
                raise Held("occupied_epoch_takeover")
            generation = meta["generation"] + 1
            self.ledger.db.execute("INSERT INTO epochs VALUES (?,?)", (value["epoch"], generation))
            self.ledger.db.execute("UPDATE meta SET epoch=?,generation=? WHERE id=1", (value["epoch"], generation))
            self.ledger.event("epoch", value)
            self.ledger.event("runtime_attestation", attestation)
        return {"status": "acknowledged"}

    def validate(self, contract):
        strict(contract, CONTRACT_FIELDS + (" journalGrant" if "journalGrant" in contract else ""))
        strict(contract["owner"], OWNER_FIELDS)
        for value in contract["owner"].values():
            identity(value)
        if contract["owner"]["nativeKind"] not in ("run", "operation"):
            raise Held("invalid_native_owner")
        meta = self.ledger.meta()
        if (contract["version"] != 1 or contract["instance"] != self.policy["instance"] or
                contract["policy"] != digest(self.policy) or contract["epoch"] != meta["epoch"] or
                type(contract["generation"]) is not int or contract["generation"] != meta["generation"] or not meta["epoch"]):
            raise Held("stale_or_foreign_contract")
        for field in ("invocation", "storage", "template"):
            identity(contract[field])
        for field in ("commandHash", "journalHash"):
            if not isinstance(contract[field], str) or not re.fullmatch("[0-9a-f]{64}", contract[field]):
                raise Held("invalid_journal_binding")
        if contract["template"] not in self.policy["templates"]:
            raise Held("unapproved_template")
        argv = contract["argv"]
        if not isinstance(argv, list) or not 1 <= len(argv) <= 128 or any(not isinstance(s, str) or "\x00" in s or len(s) > 65536 for s in argv):
            raise Held("invalid_argv")
        if len(canonical(argv)) > 131072 or digest(argv) != contract["commandHash"]:
            raise Held("command_hash_mismatch")
        family = {key: contract["owner"][key] for key in "runner account workspace session credential".split()}
        if family not in self.policy["families"]:
            raise Held("unapproved_scope_family")

    def authorize(self, contract, floor=None):
        # Lock spans the runtime start: an epoch update cannot race consumption.
        # Intent commits BEFORE any runtime side effect. On timeout or crash the
        # invocation remains consumed and may only be inspected, never replayed.
        with self.ledger.transaction():
            self._check_floor(floor)
            self.validate(contract)
            previous = self.ledger.db.execute("SELECT * FROM commands WHERE id=?", (contract["invocation"],)).fetchone()
            if previous:
                if previous["contract"] != canonical(contract).decode():
                    raise Held("invocation_identity_conflict")
                return self.result(previous)
            attempt = contract["owner"]["attempt"]
            existing = self.ledger.db.execute("SELECT * FROM attempts LIMIT 1").fetchone()
            if existing:
                if (existing["id"] != attempt or existing["owner"] != canonical(contract["owner"]).decode()
                    or existing["epoch"] != contract["epoch"] or existing["storage"] != contract["storage"]):
                    raise Held("global_occupancy_held")
                # An original-sandbox stop is insufficient: replacement sandboxes
                # and stale kubelets must be independently fenced before another
                # command mounts the same state. Never infer this from phase alone.
                prior = self.ledger.db.execute("SELECT * FROM commands WHERE attempt=? ORDER BY id", (attempt,)).fetchall()
                for command in prior:
                    self._verify_retired(command)
            else:
                self.ledger.db.execute("INSERT INTO attempts VALUES (?,?,?,?,?)",
                                       (attempt, canonical(contract["owner"]).decode(), contract["epoch"], contract["storage"], "occupied"))
            self.ledger.db.execute("INSERT INTO commands VALUES (?,?,?,'consumed',NULL,NULL)",
                                   (contract["invocation"], attempt, canonical(contract).decode()))
            self.ledger.event("consumed", {"invocation": contract["invocation"], "contractHash": digest(contract)})
        with self.ledger.transaction():
            self._check_floor(floor)
            current = self.ledger.db.execute("SELECT * FROM commands WHERE id=?", (contract["invocation"],)).fetchone()
            if current["phase"] != "consumed":
                return self.result(current)
            try:
                physical = self.runtime.launch(contract, self.policy["templates"][contract["template"]])
                strict(physical, "pool uid container node storage")
                for value in physical.values():
                    identity(value)
                if physical["pool"] != self.policy["pool"] or physical["storage"] != contract["storage"]:
                    raise Held("runtime_binding_mismatch")
                self.ledger.db.execute("UPDATE commands SET phase='started',physical=? WHERE id=?",
                                       (canonical(physical).decode(), contract["invocation"]))
                self.ledger.event("started", physical)
            except Exception:
                self.ledger.db.execute("UPDATE commands SET phase='uncertain' WHERE id=?", (contract["invocation"],))
                self.ledger.event("uncertain", {"invocation": contract["invocation"]})
            return self.result(self.ledger.db.execute("SELECT * FROM commands WHERE id=?", (contract["invocation"],)).fetchone())

    def recover(self, value, floor=None):
        """Recover an exhaustive same-epoch manifest; never start or adopt an epoch.

        The native host must derive the requested command hashes from its durable
        committed journals. Recorded observations are returned as recordedOnly;
        they are not fresh retirement/storage evidence or capacity release.
        """
        strict(value, "version instance policy epoch generation owner storage commands")
        strict(value["owner"], OWNER_FIELDS)
        for member in value["owner"].values():
            identity(member)
        identity(value["storage"])
        with self.ledger.transaction():
            self._check_floor(floor)
            meta = self.ledger.meta()
            if (type(value["version"]) is not int or value["version"] != 1
                or value["instance"] != self.policy["instance"] or value["policy"] != digest(self.policy)
                or value["epoch"] != meta["epoch"] or type(value["generation"]) is not int
                or value["generation"] != meta["generation"]):
                raise Held("stale_recovery_manifest")
            attempt = self.ledger.db.execute("SELECT * FROM attempts LIMIT 1").fetchone()
            if (not attempt or attempt["id"] != value["owner"]["attempt"]
                or attempt["owner"] != canonical(value["owner"]).decode()
                or attempt["storage"] != value["storage"] or attempt["epoch"] != value["epoch"]):
                raise Held("unknown_recovery_owner")
            commands = self.ledger.db.execute("SELECT * FROM commands WHERE attempt=? ORDER BY id", (attempt["id"],)).fetchall()
            expected = [{"invocation": command["id"], "contractHash": digest(json.loads(command["contract"]))} for command in commands]
            if not expected or value["commands"] != expected:
                raise Held("incomplete_recovery_manifest")
            for command in commands:
                self.validate(json.loads(command["contract"]))
            self.ledger.event("recovery_manifest", {"attempt": attempt["id"], "commands": expected})
            return {"status": "recovered", "occupied": True, "recordedOnly": True,
                    "commands": [{**binding, **self.result(command)} for binding, command in zip(expected, commands)]}

    def _verify_retired(self, command):
        if command["phase"] != "stopped" or not command["physical"] or not command["observation"]:
            raise Held("previous_command_not_stably_retired")
        if self.retirement_verifier is None:
            raise Held("stable_retirement_authority_missing")
        # Host-installed authority; provider output and runtime status are inputs,
        # never authority. Return a durable authenticated proof identity or raise.
        proof = self.retirement_verifier.verify(
            json.loads(command["contract"]), json.loads(command["physical"]),
            json.loads(command["observation"]))
        identity(proof)
        self.ledger.event("stable_retirement_verified", {"invocation": command["id"], "proof": proof})

    @staticmethod
    def result(row):
        return {"status": row["phase"], "physical": json.loads(row["physical"]) if row["physical"] else None,
                "observation": json.loads(row["observation"]) if row["observation"] else None,
                "occupied": True}

    def inspect(self, contract, stop, floor=None):
        with self.ledger.transaction():
            self._check_floor(floor)
            self.validate(contract)
            row = self.ledger.db.execute("SELECT * FROM commands WHERE id=?", (contract["invocation"],)).fetchone()
            if not row and stop:
                # Cancellation may arrive after the native journal commits but
                # before remote consumption. Persist an exact tombstone so a
                # delayed authorize cannot start the cancelled body. This is
                # never stop proof for an uncertain/unrecorded runtime object.
                attempt = contract["owner"]["attempt"]
                existing = self.ledger.db.execute("SELECT * FROM attempts LIMIT 1").fetchone()
                owner = canonical(contract["owner"]).decode()
                if existing and (existing["id"] != attempt or existing["owner"] != owner or
                    existing["storage"] != contract["storage"] or existing["epoch"] != contract["epoch"]):
                    raise Held("global_occupancy_held")
                if not existing:
                    self.ledger.db.execute("INSERT INTO attempts VALUES (?,?,?,?,?)",
                        (attempt, owner, contract["epoch"], contract["storage"], "occupied"))
                self.ledger.db.execute("INSERT INTO commands VALUES (?,?,?,'stop_requested',NULL,NULL)",
                    (contract["invocation"], attempt, canonical(contract).decode()))
                self.ledger.event("cancelled_before_consumption", {"invocation": contract["invocation"]})
                row = self.ledger.db.execute("SELECT * FROM commands WHERE id=?", (contract["invocation"],)).fetchone()
            if not row or row["contract"] != canonical(contract).decode():
                raise Held("unknown_exact_owner")
            if not row["physical"]:
                if stop:
                    # Fence the gap between durable consumption and start. This
                    # is a cancellation request, never fabricated stop proof: a
                    # crash may already have launched an unrecorded incarnation.
                    self.ledger.db.execute("UPDATE commands SET phase='stop_requested' WHERE id=?", (contract["invocation"],))
                    self.ledger.event("stop_requested", {"invocation": contract["invocation"]})
                    row = self.ledger.db.execute("SELECT * FROM commands WHERE id=?", (contract["invocation"],)).fetchone()
                return self.result(row)
            physical = json.loads(row["physical"])
            try:
                observation = self.runtime.stop_and_inspect(physical) if stop else self.runtime.inspect(physical)
                strict(observation, "physical status evidence")
                if observation["physical"] != physical or observation["status"] not in ("running", "confirmed_stopped", "uncertain"):
                    raise Held("runtime_observation_mismatch")
            except Exception:
                observation = {"physical": physical, "status": "uncertain", "evidence": None}
            phase = "stopped" if observation["status"] == "confirmed_stopped" else "uncertain" if observation["status"] == "uncertain" else row["phase"]
            self.ledger.db.execute("UPDATE commands SET phase=?,observation=? WHERE id=?",
                                   (phase, canonical(observation).decode(), contract["invocation"]))
            self.ledger.event("observation", observation)
            return self.result(self.ledger.db.execute("SELECT * FROM commands WHERE id=?", (contract["invocation"],)).fetchone())


def sign(key, domain, body):
    return hmac.new(key, domain.encode() + b"\x00" + canonical(body), hashlib.sha256).hexdigest()


def request(key, op, value):
    body = {"op": op, "value": value, "nonce": str(uuid.uuid4()), "expires": int(time.time()) + 30}
    return {"body": body, "mac": sign(key, "request", body)}


def verify_ack(key, envelope, sent, pin):
    """Host/controller verifier; no provider-file readback or database ACK mint.

    Caller must durably CAS the returned high-water pin in the native DB before
    allowing starts. This helper does not install or activate native admission.
    """
    strict(envelope, "body mac")
    body = envelope["body"]
    if not hmac.compare_digest(sign(key, "ack", body), envelope["mac"]):
        raise Held("ack_authentication_failed")
    if body.get("requestHash") != digest(sent["body"]) or body.get("nonce") != sent["body"]["nonce"] or time.time() >= sent["body"]["expires"]:
        raise Held("ack_challenge_mismatch")
    for key_name in ("instance", "policy", "pool", "incarnation"):
        if body.get(key_name) != pin[key_name]:
            raise Held("ack_identity_mismatch")
    if type(body.get("generation")) is not int or body["generation"] < pin["generation"]:
        raise Held("ack_rollback")
    if sent["body"]["op"] == "acknowledgeEpoch":
        value = sent["body"]["value"]
        if body["epoch"] != value["epoch"] or body["generation"] != value["expectedGeneration"] + 1 or body["result"] != {"status": "acknowledged"}:
            raise Held("ack_epoch_mismatch")
    elif body["epoch"] != sent["body"]["value"]["epoch"] or body["generation"] != sent["body"]["value"]["generation"]:
        raise Held("ack_epoch_mismatch")
    if body["generation"] == pin["generation"] and body["epoch"] != pin.get("epoch"):
        raise Held("ack_epoch_aba")
    watermark = body.get("ledgerWatermark")
    strict(watermark, "sequence hash")
    old = pin.get("ledgerWatermark", {"sequence": 0, "hash": digest([])})
    if (type(watermark["sequence"]) is not int or watermark["sequence"] < old["sequence"] or
        (watermark["sequence"] == old["sequence"] and watermark["hash"] != old["hash"])):
        raise Held("ledger_high_water_rollback")
    return {**pin, "generation": body["generation"], "epoch": body["epoch"], "ledgerWatermark": watermark}
