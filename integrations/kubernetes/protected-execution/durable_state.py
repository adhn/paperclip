"""Inactive detached canonical store. No mount, Kubernetes or release authority.

Canonical heads are atomic SQLite pointers to immutable, fsynced multi-root objects.
Original PVC import/route retirement must be independently fenced before initialize.
The injected fence is trusted infrastructure and must establish actual whole-Pod
stop and storage detach; fixture claims cannot satisfy a production fence.
"""
import base64
import json
import os
import re
from pathlib import Path
import sqlite3
import stat
import uuid
from authority import Held, canonical, digest, identity, protected_directory
from safe_transfer import capture, materialize, open_directory
from state_contract import validate_contract, restoration_outcomes


def _encode(snapshot):
    return {**snapshot, "files": {key: base64.b64encode(value).decode() for key, value in snapshot["files"].items()}}


def _decode(snapshot):
    return {**snapshot, "files": {key: base64.b64decode(value, validate=True) for key, value in snapshot["files"].items()}}


class IndependentStorageFence:
    """Durable high-water authority in a separately protected durability domain.

    This backend never attests a physical detach/stop/release itself. ``physical``
    must authenticate those facts independently and return a stable evidence ID.
    The configured incarnation must be pinned outside this ledger; never restore
    this authority alongside canonical state. Losing either is a manual hold.
    No production PVC ownership adapter or signer is installed by this class.
    """
    @classmethod
    def initialize(cls, root):
        root = protected_directory(root)
        fd = os.open(root / "fence.sqlite", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        incarnation = str(uuid.uuid4())
        db = sqlite3.connect(root / "fence.sqlite")
        try:
            db.executescript("""PRAGMA synchronous=FULL;
              CREATE TABLE meta(incarnation TEXT NOT NULL);
              CREATE TABLE pins(policy TEXT PRIMARY KEY, incarnation TEXT NOT NULL,
                generation INTEGER NOT NULL, hash TEXT NOT NULL, family TEXT NOT NULL, storages TEXT NOT NULL);
              CREATE TABLE proofs(id TEXT PRIMARY KEY, binding TEXT NOT NULL);
            """)
            db.execute("INSERT INTO meta VALUES(?)", (incarnation,))
            db.commit()
        finally:
            db.close()
        _sync(root)
        return incarnation

    def __init__(self, root, incarnation, physical):
        root = protected_directory(root)
        path = root / "fence.sqlite"
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise Held("unprotected_storage_fence")
        self.db = sqlite3.connect(f"file:{path}?mode=rw", uri=True, isolation_level=None, timeout=5)
        self.db.execute("PRAGMA synchronous=FULL")
        if (self.db.execute("PRAGMA integrity_check").fetchone() != ("ok",) or
            self.db.execute("SELECT incarnation FROM meta").fetchall() != [(incarnation,)]):
            self.db.close()
            raise Held("storage_fence_identity_mismatch")
        self.physical = physical

    def verify(self, kind, owner, storages, evidence):
        if not isinstance(storages, list) or not storages or sorted(set(storages)) != storages:
            raise Held("invalid_storage_fence_bindings")
        for storage in storages:
            identity(storage)
        family = {key: owner[key] for key in ("company", "runner", "account", "workspace", "session", "credential")}
        for value in family.values():
            identity(value)
        if kind == "canonical-high-water":
            if (not isinstance(evidence, dict) or set(evidence) != {"incarnation", "generation", "hash", "policy"}
                or type(evidence["generation"]) is not int or evidence["generation"] < 0
                or any(not isinstance(evidence[key], str) or not re.fullmatch("[a-f0-9]{64}", evidence[key]) for key in ("hash", "policy"))):
                raise Held("invalid_canonical_high_water")
            identity(evidence["incarnation"])
            self.db.execute("BEGIN IMMEDIATE")
            try:
                previous = self.db.execute("SELECT incarnation,generation,hash,family,storages FROM pins WHERE policy=?", (evidence["policy"],)).fetchone()
                current = (evidence["incarnation"], evidence["generation"], evidence["hash"], canonical(family).decode(), canonical(storages).decode())
                if previous and (previous[0] != current[0] or previous[3:] != current[3:]
                    or current[1] < previous[1] or (current[1] == previous[1] and current[2] != previous[2])):
                    raise Held("canonical_snapshot_rollback")
                self.db.execute("INSERT INTO pins VALUES(?,?,?,?,?,?) ON CONFLICT(policy) DO UPDATE SET generation=excluded.generation,hash=excluded.hash", (evidence["policy"], *current))
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise
            return "canonical-pin-" + digest(evidence)
        # Authentication occurs outside the SQLite transaction. Persistently bind
        # a proof ID to its exact kind/owner/storage; an identical retry is safe,
        # while recycling a receipt for a sibling or other phase is rejected.
        proof = self.physical.verify(kind, owner, storages, evidence)
        identity(proof)
        binding = digest({"kind": kind, "owner": owner, "storages": storages})
        self.db.execute("BEGIN IMMEDIATE")
        try:
            previous = self.db.execute("SELECT binding FROM proofs WHERE id=?", (proof,)).fetchone()
            if previous and previous != (binding,):
                raise Held("storage_proof_rebinding")
            self.db.execute("INSERT OR IGNORE INTO proofs VALUES(?,?)", (proof, binding))
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise
        return proof

    def verify_current(self, kind, owner, storages, current, evidence):
        """Pin an independently authenticated operation to exact canonical CAS.

        The physical authority must establish exclusion for this state transition
        and preserve it through transfer completion, not merely observe no mount.
        Old verify-only backends cannot authorize this stronger operation.
        """
        if (not isinstance(current, dict) or set(current) != {"incarnation", "generation", "hash", "policy"}):
            raise Held("invalid_current_storage_binding")
        self.verify("canonical-high-water", owner, storages, current)
        verifier = getattr(self.physical, "verify_current", None)
        if verifier is None:
            raise Held("current_physical_storage_authority_missing")
        proof = verifier(kind, owner, storages, current, evidence)
        identity(proof)
        binding = digest({"kind": kind, "owner": owner, "storages": storages, "current": current})
        self.db.execute("BEGIN IMMEDIATE")
        try:
            previous = self.db.execute("SELECT binding FROM proofs WHERE id=?", (proof,)).fetchone()
            if previous and previous != (binding,):
                raise Held("storage_proof_rebinding")
            # Recheck the independently retained high-water after the physical
            # call; a concurrent newer transition cannot be authorized backwards.
            pin = self.db.execute("SELECT incarnation,generation,hash FROM pins WHERE policy=?", (current["policy"],)).fetchone()
            if pin != (current["incarnation"], current["generation"], current["hash"]):
                raise Held("current_storage_compare_failed")
            self.db.execute("INSERT OR IGNORE INTO proofs VALUES(?,?)", (proof, binding))
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise
        return proof

    def close(self):
        self.db.close()


class DurableState:
    """Trusted transfer boundary with fail-closed ownership and restart semantics.

    fence.verify(kind, owner, storage_ids, opaque_evidence) must return a stable
    authenticated evidence identity or raise. Never implement it from Pod absence,
    provider receipts, process lists, or caller-supplied boolean flags.
    """
    def __init__(self, root, contract, trusted_owner, fingerprint, fence):
        self.root = protected_directory(root)
        self.contract = contract
        validate_contract(contract, trusted_owner, fingerprint)
        self.contract_hash = _policy_hash(contract)
        self.owner = trusted_owner
        self.owner_key = digest(trusted_owner)
        self.fence = fence
        self.storages = sorted({r["storage"] for r in contract["roots"]})
        if not (self.root / "state.sqlite").exists():
            raise Held("missing_state_ledger")
        self.db = sqlite3.connect(self.root / "state.sqlite", isolation_level=None, timeout=5)
        self.db.execute("PRAGMA synchronous=FULL")
        metadata = self.db.execute("SELECT contract FROM meta").fetchone()
        if metadata != (self.contract_hash,):
            self.db.close()
            raise Held("state_contract_drift")
        try:
            self._pin()
        except BaseException:
            self.db.close()
            raise

    @classmethod
    def initialize(cls, root, contract, trusted_owner, fingerprint, fence, bindings, import_evidence):
        root = protected_directory(root)
        validate_contract(contract, trusted_owner, fingerprint)
        contract_hash = _policy_hash(contract)
        if set(bindings) != {r["id"] for r in contract["roots"]}:
            raise Held("incomplete_state_bindings")
        proof = fence.verify("import-detached", trusted_owner, sorted({r["storage"] for r in contract["roots"]}), import_evidence)
        identity(proof)
        objects = root / "objects"
        objects.mkdir(mode=0o700)
        snapshots = {}
        for spec in contract["roots"]:
            source = Path(bindings[spec["id"]])
            # Binding paths are supplied by protected operator configuration.
            if str(source) != spec["path"]:
                raise Held("state_binding_path_drift")
            parent_fd = open_directory(source.parent)
            try:
                info = os.stat(source.name, dir_fd=parent_fd, follow_symlinks=False)
                if stat.S_IMODE(info.st_mode) != spec["mode"]:
                    raise Held("state_binding_mode_drift")
                if spec["kind"] == "alias":
                    alias_target = os.readlink(source.name, dir_fd=parent_fd)
            finally:
                os.close(parent_fd)
            if spec["kind"] == "alias":
                target = next(r for r in contract["roots"] if r["id"] == spec["aliasOf"])
                if not stat.S_ISLNK(info.st_mode) or alias_target != target["path"]:
                    raise Held("fixed_alias_drift")
                snapshots[spec["id"]] = {"alias": spec["aliasOf"]}
            elif spec["kind"] == "file":
                # Private wrapper preserves the existing bounded dirfd reader.
                snapshots[spec["id"]] = _capture_file(source)
            else:
                snapshots[spec["id"]] = capture(source)
        object_id = cls._write_object(root, snapshots)
        fd = os.open(root / "state.sqlite", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        db = sqlite3.connect(root / "state.sqlite")
        try:
            db.executescript("""PRAGMA synchronous=FULL;
              CREATE TABLE meta(contract TEXT NOT NULL, incarnation TEXT NOT NULL, import_proof TEXT NOT NULL, generation INTEGER NOT NULL);
              CREATE TABLE heads(id TEXT PRIMARY KEY, version TEXT NOT NULL, object TEXT NOT NULL);
              CREATE TABLE attempts(owner TEXT PRIMARY KEY, phase TEXT NOT NULL, snapshot TEXT NOT NULL,
                source TEXT NOT NULL, result TEXT, proof TEXT NOT NULL);
              CREATE TABLE occupancy(storage TEXT PRIMARY KEY, owner TEXT NOT NULL);
              CREATE TABLE events(id INTEGER PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL);
            """)
            db.execute("INSERT INTO meta VALUES(?,?,?,0)", (contract_hash, str(uuid.uuid4()), proof))
            db.executemany("INSERT INTO heads VALUES(?,?,?)", [(r["id"], r["version"], object_id) for r in contract["roots"]])
            # Persist the independent floor before making canonical heads visible.
            # If local commit is lost, the ahead floor intentionally holds restart.
            pending = cls.__new__(cls)
            pending.db, pending.contract_hash = db, contract_hash
            pending.fence, pending.owner = fence, trusted_owner
            pending.storages = sorted({r["storage"] for r in contract["roots"]})
            pending._commit_pinned()
        finally:
            db.close()
        _sync(root)
        return cls(root, contract, trusted_owner, fingerprint, fence)

    @staticmethod
    def _write_object(root, values):
        data = {key: value if "alias" in value else _encode(value) for key, value in values.items()}
        object_id = digest(data)
        path = root / "objects" / object_id
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            if path.read_bytes() != canonical(data):
                raise Held("immutable_state_corrupt")
            return object_id
        try:
            content = memoryview(canonical(data))
            while content:
                content = content[os.write(fd, content):]
            os.fsync(fd)
        finally:
            os.close(fd)
        _sync(path.parent)
        return object_id

    def _object(self, object_id):
        value = json.loads((self.root / "objects" / object_id).read_bytes())
        if digest(value) != object_id:
            raise Held("immutable_state_corrupt")
        return {key: item if "alias" in item else _decode(item) for key, item in value.items()}

    def _proof(self, kind, evidence):
        current = self._pin()
        verifier = getattr(self.fence, "verify_current", None)
        if verifier is None:
            raise Held("current_physical_storage_authority_missing")
        proof = verifier(kind, self.owner, self.storages, current, evidence)
        identity(proof)
        return proof, current

    def _assert_current(self, expected):
        # Called under the operation's write transaction. Physical evidence for
        # another canonical generation must never mutate this ledger.
        if self._snapshot_binding() != expected:
            raise Held("current_storage_compare_failed")

    def _snapshot_binding(self):
        incarnation, generation = self.db.execute("SELECT incarnation,generation FROM meta").fetchone()
        state = {table: self.db.execute("SELECT * FROM " + table + " ORDER BY 1").fetchall()
                 for table in ("meta", "heads", "attempts", "occupancy", "events")}
        return {"incarnation": incarnation, "generation": generation, "hash": digest(state), "policy": self.contract_hash}

    def stage(self, detach_evidence):
        self._pin()
        proof, current = self._proof("stage-detached", detach_evidence)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._assert_current(current)
            existing = self.db.execute("SELECT phase,snapshot FROM attempts WHERE owner=?", (self.owner_key,)).fetchone()
            if existing:
                raise Held("attempt_already_consumed")
            for storage in self.storages:
                if self.db.execute("SELECT 1 FROM occupancy WHERE storage=?", (storage,)).fetchone():
                    raise Held("storage_occupied")
                self.db.execute("INSERT INTO occupancy VALUES(?,?)", (storage, self.owner_key))
            heads = self.db.execute("SELECT id,version,object FROM heads ORDER BY id").fetchall()
            values = {key: self._object(obj)[key] for key, version, obj in heads}
            snapshot = self._write_object(self.root, values)
            source = {key: version for key, version, obj in heads}
            self.db.execute("INSERT INTO attempts VALUES(?,?,?,?,NULL,?)", (self.owner_key, "staging", snapshot, json.dumps(source), proof))
            self.db.execute("UPDATE meta SET generation=generation+1")
            self._commit_pinned()
        except BaseException:
            self.db.rollback()
            raise
        # A crash/failure here retains occupancy; stage is never replayed blindly.
        attempt = self.root / ("attempt-" + self.owner_key)
        attempt.mkdir(mode=0o700)
        _sync(self.root)
        for key, value in values.items():
            if "alias" not in value and key not in self.contract.get("projections", {}):
                materialize(value, attempt / key)
        # Overlapping roots share one mutable ownership unit and physical bytes.
        for key in self.contract.get("projections", {}):
            if self._capture_attempt(key) != values[key]:
                raise Held("state_projection_content_drift")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            changed = self.db.execute("UPDATE attempts SET phase='staged' WHERE owner=? AND phase='staging'", (self.owner_key,))
            if changed.rowcount != 1:
                raise Held("staging_owner_phase_changed")
            self.db.execute("UPDATE meta SET generation=generation+1")
            self._commit_pinned()
        except BaseException:
            self.db.rollback()
            raise
        return {"snapshot": snapshot, "attempt": str(attempt), "sourceVersions": source,
                "bindings": {r["id"]: str(self._attempt_path(r["id"])) for r in self.contract["roots"] if r["kind"] != "alias"},
                "aliases": {r["id"]: r["aliasOf"] for r in self.contract["roots"] if r["kind"] == "alias"}}

    def handoff(self, evidence):
        self._pin()
        proof, current = self._proof("provider-exclusive", evidence)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._assert_current(current)
            cursor = self.db.execute("UPDATE attempts SET phase='provider',proof=? WHERE owner=? AND phase='staged'", (proof, self.owner_key))
            if cursor.rowcount != 1:
                raise Held("invalid_storage_handoff")
            self.db.execute("UPDATE meta SET generation=generation+1")
            self._commit_pinned()
        except BaseException:
            self.db.rollback()
            raise

    def restore(self, stop_evidence, detach_evidence):
        self._pin()
        # Stable retirement is required before reading returned provider state;
        # successful stop of only the original sandbox cannot authorize transfer.
        stop, stop_current = self._proof("stable-retirement", stop_evidence)
        detach, current = self._proof("restore-detached", detach_evidence)
        if current != stop_current:
            raise Held("current_storage_compare_failed")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._assert_current(current)
            row = self.db.execute("SELECT phase,snapshot,source,result FROM attempts WHERE owner=?", (self.owner_key,)).fetchone()
            if not row or row[0] not in ("provider", "restoring", "restored"):
                raise Held("invalid_storage_restore")
            if row[0] == "restored" and all(json.loads(row[3])["outcomes"].values()):
                self.db.rollback()
                return json.loads(row[3])
            self.db.execute("UPDATE attempts SET phase='restoring',proof=? WHERE owner=?", (digest([stop, detach]), self.owner_key))
            self.db.execute("UPDATE meta SET generation=generation+1")
            self._commit_pinned()
        except BaseException:
            self.db.rollback()
            raise
        phase, snapshot, source_json, previous = row
        source = json.loads(source_json)
        prior_results = json.loads(previous)["roots"] if previous else {}
        values, results = {}, dict(prior_results)
        for spec in self.contract["roots"]:
            key = spec["id"]
            if key in prior_results and prior_results[key]["outcome"] != "failed":
                continue
            try:
                values[key] = {"alias": spec["aliasOf"]} if spec["kind"] == "alias" else self._capture_attempt(key)
                outcome = "restored"
            except (OSError, Held):
                outcome = "failed"
            results[key] = {"snapshot": snapshot, "sourceVersion": source[key], "outcome": outcome,
                            "preservedCopy": "attempt-" + self.owner_key + "/" + key}
        returned = self._write_object(self.root, values)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            current_phase = self.db.execute("SELECT phase,result FROM attempts WHERE owner=?", (self.owner_key,)).fetchone()
            if current_phase[0] == "restored":
                self.db.rollback()
                return json.loads(current_phase[1])
            if current_phase[0] != "restoring":
                raise Held("restoration_owner_phase_changed")
            # All roots in a projection group share a CAS/ownership unit. A
            # child conflict cannot be bypassed by replacing its parent tree.
            for group in self._groups():
                active = [key for key in group if key in values]
                if not active:
                    continue
                failed = any(results[key]["outcome"] == "failed" for key in group)
                conflict = any(self.db.execute("SELECT version FROM heads WHERE id=?", (key,)).fetchone()[0] != source[key] for key in group)
                if failed or conflict:
                    for key in group:
                        results[key]["outcome"] = "conflict" if conflict else "failed"
                        values.pop(key, None)
            for spec in self.contract["roots"]:
                key = spec["id"]
                if key not in values:
                    continue
                current = self.db.execute("SELECT version FROM heads WHERE id=?", (key,)).fetchone()[0]
                if current != source[key]:
                    results[key]["outcome"] = "conflict"
                else:
                    # Parent version prevents version ABA even for identical bytes.
                    version = digest({"parent": current, "returned": returned, "root": key})
                    self.db.execute("UPDATE heads SET version=?,object=? WHERE id=? AND version=?", (version, returned, key, current))
            report = {"snapshot": snapshot, "roots": results,
                      "outcomes": restoration_outcomes({**self.contract, "roots": [{**r, "version": source[r["id"]]} for r in self.contract["roots"]]}, snapshot, results),
                      "quarantine": returned}
            self.db.execute("UPDATE attempts SET phase='restored',result=? WHERE owner=?", (json.dumps(report), self.owner_key))
            self.db.execute("INSERT INTO events(owner,body) VALUES(?,?)", (self.owner_key, json.dumps(report)))
            # Occupancy intentionally remains: only native verified release may
            # retire it after independently consuming these exact durable facts.
            self.db.execute("UPDATE meta SET generation=generation+1")
            self._commit_pinned()
            return report
        except BaseException:
            self.db.rollback()
            raise

    def _commit_local(self):
        self.db.commit()

    def _commit_pinned(self):
        """External prospective floor first; failed local commits stay held.

        Never acknowledge or expose new canonical heads before independent
        history retains them. Loss of either side is recovery uncertainty, not
        permission to lower the floor or repeat provider bodies.
        """
        evidence = self._snapshot_binding()
        proof = self.fence.verify("canonical-high-water", self.owner, self.storages, evidence)
        identity(proof)
        self._commit_local()

    def _pin(self):
        """Independent durable high-water storage is mandatory, never local JSON.

        The verifier must persist the canonical-family/incarnation/generation/hash
        outside this storage snapshot, rejecting incarnation changes, lower
        generations and equal-generation changed contents. The unit fence is a
        fixture implementation only; no production durable pin backend is wired.
        """
        self.db.execute("BEGIN")
        try:
            evidence = self._snapshot_binding()
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise
        proof = self.fence.verify("canonical-high-water", self.owner, self.storages, evidence)
        identity(proof)
        return evidence

    def _attempt_path(self, key):
        specs = {r["id"]: r for r in self.contract["roots"]}
        parent = self.contract.get("projections", {}).get(key)
        if parent:
            relative = specs[key]["path"][len(specs[parent]["path"]) + 1:]
            return self._attempt_path(parent) / relative
        return self.root / ("attempt-" + self.owner_key) / key

    def _capture_attempt(self, key):
        spec = next(r for r in self.contract["roots"] if r["id"] == key)
        if spec["kind"] == "file" and key not in self.contract.get("projections", {}):
            result = capture(self._attempt_path(key))
            if result["manifest"]["directories"] or set(result["files"]) != {"content"}:
                raise Held("file_root_shape_drift")
            return result
        if spec["kind"] == "file":
            return _capture_file(self._attempt_path(key))
        return capture(self._attempt_path(key))

    def _groups(self):
        projections = self.contract.get("projections", {})
        groups = {}
        for spec in self.contract["roots"]:
            parent = key = spec["id"]
            while parent in projections:
                parent = projections[parent]
            groups.setdefault(parent, []).append(key)
        return list(groups.values())

    def retire(self, evidence):
        """Consume a trusted committed-native-release proof, never a hold flag.

        The verifier must establish exact owner, all command stops and independent
        restoration status in the native transaction. No production signer is
        installed by this isolated package.
        """
        self._pin()
        proof, current = self._proof("native-release-consumed", evidence)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._assert_current(current)
            row = self.db.execute("SELECT phase,result FROM attempts WHERE owner=?", (self.owner_key,)).fetchone()
            if not row or row[0] != "restored" or not all(json.loads(row[1])["outcomes"].values()):
                raise Held("native_release_prerequisites_missing")
            self.db.execute("DELETE FROM occupancy WHERE owner=?", (self.owner_key,))
            self.db.execute("UPDATE attempts SET phase='retired',proof=? WHERE owner=?", (proof, self.owner_key))
            self.db.execute("INSERT INTO events(owner,body) VALUES(?,?)", (self.owner_key, json.dumps({"retirement": proof})))
            self.db.execute("UPDATE meta SET generation=generation+1")
            self._commit_pinned()
        except BaseException:
            self.db.rollback()
            raise

    def canonical_head(self, root_id):
        self._pin()
        row = self.db.execute("SELECT version,object FROM heads WHERE id=?", (root_id,)).fetchone()
        if not row:
            raise Held("unknown_canonical_root")
        return {"version": row[0], "snapshot": self._object(row[1])[root_id]}

    def import_refresh(self, root_id, expected_version, evidence):
        """Trusted external refresh import, retaining conflict with an older attempt.

        Reads only the protected contract's original binding. It cannot execute a
        refresh or assert provider grant independence. The independent verifier
        must fence writers before allowing this operation.
        """
        self._pin()
        proof, current = self._proof("refresh-detached", evidence)
        spec = next((r for r in self.contract["roots"] if r["id"] == root_id), None)
        if not spec or spec["kind"] == "alias":
            raise Held("invalid_refresh_root")
        group = next(group for group in self._groups() if root_id in group)
        source_versions = {key: self.canonical_head(key)["version"] for key in group}
        if source_versions[root_id] != expected_version:
            raise Held("canonical_version_conflict")
        values = {}
        for key in group:
            member = next(r for r in self.contract["roots"] if r["id"] == key)
            values[key] = _capture_file(Path(member["path"])) if member["kind"] == "file" else capture(member["path"])
        obj = self._write_object(self.root, values)
        versions = {key: digest({"parent": source_versions[key], "object": obj, "proof": proof}) for key in group}
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._assert_current(current)
            for key in group:
                cursor = self.db.execute("UPDATE heads SET version=?,object=? WHERE id=? AND version=?", (versions[key], obj, key, source_versions[key]))
                if cursor.rowcount != 1:
                    raise Held("canonical_version_conflict")
            self.db.execute("INSERT INTO events(owner,body) VALUES(?,?)", (self.owner_key, json.dumps({"refresh": root_id, "versions": versions, "proof": proof})))
            self.db.execute("UPDATE meta SET generation=generation+1")
            self._commit_pinned()
        except BaseException:
            self.db.rollback()
            raise
        return versions[root_id]

    def inspect(self):
        self._pin()
        row = self.db.execute("SELECT phase,snapshot,result FROM attempts WHERE owner=?", (self.owner_key,)).fetchone()
        return None if row is None else {"phase": row[0], "snapshot": row[1], "result": json.loads(row[2]) if row[2] else None}

    def close(self):
        self.db.close()


def _sync(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _capture_file(path):
    # Read exactly one regular file with the same race checks/bounds as trees.
    from safe_transfer import capture_file
    return capture_file(path)


def _policy_hash(contract):
    # Canonical family/configuration identity persists across run/agent/lease
    # owners; every operation remains bound to the entire exact attempt owner.
    stable_owner = {key: contract["owner"][key] for key in ("company", "runner", "account", "workspace", "session", "credential")}
    return digest({**contract, "owner": stable_owner})
