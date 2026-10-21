"""Protected read-only legacy reviewer adapter. No issuer, signer or append.

Production starts held: protected files and independently current per-challenge
artifacts do not exist yet. Synthetic test keys are never installed by this file.
"""
import hmac
import json
import os
import re
import stat
import sys
import time
import uuid

from legacy_review import (BINDINGS, DOMAINS, ReviewHeld, canonical, digest,
                           review_authoritative_shared_holds)

CONFIG_PATH = "/etc/paperclip/admission/legacy-review.json"
MAX_BYTES = 2 * 1024 * 1024
MAX_HOLDS = 256
PIN_FIELDS = {"instance", "policyHash", "epoch", "authorityIncarnation", "historyDomain", "historyIncarnation", "historyFloor"}
DECISION_FIELDS = set(BINDINGS) | {"kind", "action", "sequence", "previousHash", "observedAt", "expiresAt", "routeRevocationHash", "retiredIncarnationHash", "wholePodStopHash", "restoration", "operatorApprovalHash"}
ROOT_NAMES = set(DOMAINS) | {"inventory", "continuity", "inspection"}


def exact(value, fields):
    if type(value) is not dict or set(value) != set(fields):
        raise ReviewHeld("bridge_contract")


def text(value, limit=2048):
    if type(value) is not str or not 0 < len(value) <= limit or any(ord(c) < 32 for c in value):
        raise ReviewHeld("bridge_identity")


def hexhash(value):
    if type(value) is not str or re.fullmatch("[a-f0-9]{64}", value) is None:
        raise ReviewHeld("bridge_hash")


def integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= 9007199254740991:
        raise ReviewHeld("bridge_integer")


def decode(raw):
    if type(raw) is not bytes or len(raw) > MAX_BYTES:
        raise ReviewHeld("bridge_input_limit")
    def unique(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ReviewHeld("bridge_duplicate_key")
            result[key] = value
        return result
    try:
        result = json.loads(raw, object_pairs_hook=unique,
                            parse_constant=lambda _: (_ for _ in ()).throw(ReviewHeld("bridge_nonfinite")))
        count = 0
        def bounded(value, depth=0):
            nonlocal count
            count += 1
            if depth > 32 or count > 50000:
                raise ReviewHeld("bridge_structure_limit")
            if type(value) is dict:
                for k, v in value.items():
                    text(k)
                    bounded(v, depth + 1)
            elif type(value) is list:
                for v in value:
                    bounded(v, depth + 1)
            elif type(value) is str:
                if len(value) > 8192:
                    raise ReviewHeld("bridge_string_limit")
            elif type(value) is int:
                integer(value)
            elif value is not None and type(value) is not bool:
                raise ReviewHeld("bridge_scalar")
        bounded(result)
        return result
    except (ValueError, TypeError, RecursionError, UnicodeError):
        raise ReviewHeld("bridge_json") from None


def protected_read(path):
    """Walk root-owned nonwritable parents by fd; never follow a symlink.

    No path is accepted from a request. Config and keys must be installed by a
    separately reviewed protected installer; a projected writable directory fails.
    """
    if type(path) is not str or not path.startswith("/"):
        raise ReviewHeld("bridge_protected_path")
    parts = path.split("/")[1:]
    if not parts or any(x in ("", ".", "..") for x in parts):
        raise ReviewHeld("bridge_protected_path")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for index, part in enumerate(parts):
            before = os.fstat(fd)
            if before.st_uid != 0 or before.st_mode & 0o022:
                raise ReviewHeld("bridge_unprotected_parent")
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if index < len(parts) - 1:
                flags |= os.O_DIRECTORY
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        metadata = os.fstat(fd)
        if metadata.st_uid != 0 or metadata.st_mode & 0o022 or not stat.S_ISREG(metadata.st_mode):
            raise ReviewHeld("bridge_unprotected_file")
        if metadata.st_size > MAX_BYTES:
            raise ReviewHeld("bridge_file_limit")
        chunks = bytearray()
        while len(chunks) <= MAX_BYTES:
            block = os.read(fd, min(65536, MAX_BYTES + 1 - len(chunks)))
            if not block:
                return decode(bytes(chunks))
            chunks.extend(block)
        raise ReviewHeld("bridge_file_limit")
    except OSError:
        raise ReviewHeld("bridge_protected_input_unavailable") from None
    finally:
        os.close(fd)


def fresh(body, now):
    observed, expires = body.get("observedAt"), body.get("expiresAt")
    integer(observed); integer(expires)
    if not now - 60000 <= observed <= now < expires <= observed + 60000:
        raise ReviewHeld("bridge_current_evidence_required")
    return expires


def authenticated(envelope, root, domain):
    exact(envelope, {"body", "mac"})
    if type(envelope["body"]) is not dict:
        raise ReviewHeld("bridge_envelope")
    hexhash(envelope["mac"])
    expected = hmac.digest(root, b"paperclip-legacy-bridge-v1\0" + domain.encode() + b"\0" + canonical(envelope["body"]), "sha256").hex()
    if not hmac.compare_digest(envelope["mac"], expected):
        raise ReviewHeld("bridge_authentication")
    return envelope["body"]


class EvidenceBridge:
    """No constructor path override; only protected host configuration selects inputs."""
    def __init__(self):
        self.config = protected_read(CONFIG_PATH)
        exact(self.config, {"version", "pins", "roots", "inventoryPath", "bundlesPath", "continuityPath", "inspectionPath"})
        if type(self.config["version"]) is not int or self.config["version"] != 1:
            raise ReviewHeld("bridge_config_version")
        self.pins = self.config["pins"]
        exact(self.pins, PIN_FIELDS)
        for key, value in self.pins.items():
            integer(value, 1) if key == "historyFloor" else text(value)
        exact(self.config["roots"], ROOT_NAMES)
        self.roots = {}
        for domain, path in self.config["roots"].items():
            entry = protected_read(path)
            exact(entry, {"key"})
            hexhash(entry["key"])
            self.roots[domain] = bytes.fromhex(entry["key"])
        if len(set(self.roots.values())) != len(self.roots):
            raise ReviewHeld("bridge_independent_roots_required")

    def handle(self, request):
        if type(request) is not dict or request.get("operation") not in ("review", "inspect"):
            raise ReviewHeld("bridge_operation")
        now = request.get("now"); integer(now)
        # Request time is a native binding, not permission to replay expired files.
        if abs(now - int(time.time() * 1000)) > 1000:
            raise ReviewHeld("bridge_host_clock_mismatch")
        challenge = request.get("challenge"); hexhash(challenge)
        if request["operation"] == "inspect":
            return self.inspect(request, now)
        exact(request, {"operation", "decision", "holds", "inventoryHash", "now", "challenge"})
        decision = request["decision"]
        exact(decision, DECISION_FIELDS)
        if decision["kind"] != "present-day-legacy-reconciliation-v1" or decision["action"] not in ("reconcile", "revoke"):
            raise ReviewHeld("bridge_decision_kind")
        for field in ("sequence", "observedAt", "expiresAt"):
            integer(decision[field], 1)
        if decision["previousHash"] is not None:
            hexhash(decision["previousHash"])
        for field in ("holdHash", "policyHash", "routeRevocationHash", "retiredIncarnationHash", "wholePodStopHash", "operatorApprovalHash"):
            hexhash(decision[field])
        exact(decision["restoration"], {"workspace", "session", "credential"})
        for value in decision["restoration"].values():
            hexhash(value)
        hexhash(request["inventoryHash"])
        holds = request["holds"]
        if type(holds) is not list or not 0 < len(holds) <= MAX_HOLDS:
            raise ReviewHeld("bridge_complete_inventory_required")
        for hold in holds:
            exact(hold, BINDINGS)
            if hold["source"] != "lease:" + str(hold["leaseId"]):
                raise ReviewHeld("bridge_supported_original_lease_required")
            for key in ("companyId", "agentId", "runId", "leaseId", "environmentId", "epoch"):
                try:
                    valid = type(hold[key]) is str and str(uuid.UUID(hold[key])) == hold[key]
                except (ValueError, TypeError, AttributeError):
                    valid = False
                if not valid:
                    raise ReviewHeld("bridge_original_uuid_required")
            hexhash(hold["holdHash"]); hexhash(hold["policyHash"])
            if hold["policyHash"] != self.pins["policyHash"] or hold["epoch"] != self.pins["epoch"]:
                raise ReviewHeld("bridge_native_pin_mismatch")
            scopes = hold["scopes"]
            if type(scopes) is not list or not 0 < len(scopes) <= 64 or any(type(v) is not str for v in scopes) or len(set(scopes)) != len(scopes):
                raise ReviewHeld("bridge_exact_scopes_required")
            for scope in scopes:
                text(scope)
        sources = [hold["source"] for hold in holds]
        if len(set(sources)) != len(sources):
            raise ReviewHeld("bridge_duplicate_source")
        fingerprint = digest(sorted(({"source": h["source"], "holdHash": h["holdHash"]} for h in holds), key=lambda h: h["source"]))
        if fingerprint != request["inventoryHash"]:
            raise ReviewHeld("bridge_native_inventory_hash")
        continuity = authenticated(protected_read(self.config["continuityPath"]), self.roots["continuity"], "continuity")
        exact(continuity, {"kind", "pins", "historyRevision", "challenge", "inventoryHash", "observedAt", "expiresAt"})
        if (continuity["kind"] != "legacy-authority-continuity-v1" or canonical(continuity["pins"]) != canonical(self.pins) or
                continuity["challenge"] != challenge or continuity["inventoryHash"] != request["inventoryHash"]):
            raise ReviewHeld("bridge_authority_continuity_mismatch")
        integer(continuity["historyRevision"], self.pins["historyFloor"])
        expires = fresh(continuity, now)
        inventory = protected_read(self.config["inventoryPath"])
        # Full binding equality, including scope order; no caller-selected subset.
        if type(inventory) is not dict or type(inventory.get("body")) is not dict or type(inventory["body"].get("holds")) is not list:
            raise ReviewHeld("bridge_native_inventory_changed")
        protected_holds = inventory["body"]["holds"]
        if (any(type(h) is not dict or type(h.get("source")) is not str for h in protected_holds) or
                sorted(protected_holds, key=lambda h: h["source"]) != sorted(holds, key=lambda h: h["source"])):
            raise ReviewHeld("bridge_native_inventory_changed")
        bundles = protected_read(self.config["bundlesPath"])
        if type(bundles) is not dict or set(bundles) != set(sources):
            raise ReviewHeld("bridge_complete_bundles_required")
        # Operator consent binds the complete semantic inventory, not merely the
        # selected source. Fresh timestamps/challenges cannot extend consent to
        # a changed sibling hold or newly discovered shared owner.
        for source in sources:
            bundle = bundles[source]
            if type(bundle) is not dict or type(bundle.get("artifacts")) is not dict:
                raise ReviewHeld("bridge_operator_inventory_approval_required")
            operator = bundle["artifacts"].get("operator")
            if (type(operator) is not dict or type(operator.get("body")) is not dict or
                    operator["body"].get("approvedInventoryHash") != request["inventoryHash"]):
                raise ReviewHeld("bridge_operator_inventory_approval_required")
            decision = bundle.get("decision")
            approved = operator["body"].get("approvedDecision")
            if (type(decision) is not dict or type(approved) is not dict or
                    set(approved) != {"sequence", "previousHash"}):
                raise ReviewHeld("bridge_operator_decision_intent_required")
            try:
                integer(approved["sequence"], 1)
                integer(decision.get("sequence"), 1)
                if approved["previousHash"] is not None:
                    hexhash(approved["previousHash"])
                if decision.get("previousHash") is not None:
                    hexhash(decision["previousHash"])
            except ReviewHeld:
                raise ReviewHeld("bridge_operator_decision_intent_required") from None
            expected_intent = {"sequence": decision["sequence"], "previousHash": decision.get("previousHash")}
            if canonical(approved) != canonical(expected_intent):
                raise ReviewHeld("bridge_operator_decision_intent_required")
        result = review_authoritative_shared_holds(inventory, bundles, {k: self.roots[k] for k in DOMAINS},
            inventory_root=self.roots["inventory"], expected_inventory_hash=request["inventoryHash"], now=now)
        selected = bundles.get(request["decision"]["source"])
        if not selected or canonical(selected["decision"]) != canonical(request["decision"]):
            raise ReviewHeld("bridge_exact_decision_required")
        return {"decisionHash": digest(request["decision"]), "inventoryHash": result["inventoryHash"],
                "expiresAt": min(expires, result["expiresAt"]), "challenge": challenge, "operationalAcceptance": False}

    def inspect(self, request, now):
        exact(request, {"operation", "source", "sequence", "decisionHash", "now", "challenge"})
        text(request["source"]); integer(request["sequence"], 1); hexhash(request["decisionHash"])
        if not request["source"].startswith("lease:"):
            raise ReviewHeld("bridge_supported_original_lease_required")
        body = authenticated(protected_read(self.config["inspectionPath"]), self.roots["inspection"], "inspection")
        exact(body, {"kind", "pins", "historyRevision", "source", "sequence", "decisionHash", "status", "challenge", "observedAt", "expiresAt"})
        integer(body["historyRevision"], self.pins["historyFloor"])
        integer(body["sequence"], 1)
        if (body["kind"] != "legacy-decision-inspection-v1" or canonical(body["pins"]) != canonical(self.pins) or
                any(body[k] != request[k] for k in ("source", "sequence", "decisionHash", "challenge"))):
            raise ReviewHeld("bridge_inspection_binding")
        fresh(body, now)
        if body["status"] != "committed-exact":
            raise ReviewHeld("bridge_ambiguous_decision_remains_held")
        return {"status": "committed-exact", "source": body["source"], "sequence": body["sequence"],
                "decisionHash": body["decisionHash"], "expiresAt": body["expiresAt"], "challenge": request["challenge"], "operationalAcceptance": False}


def main():
    try:
        request = decode(sys.stdin.buffer.read(MAX_BYTES + 1))
        result = EvidenceBridge().handle(request)
        sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")
        return 0
    except Exception:
        # Never expose protected paths, keys, raw artifacts or peer observations.
        sys.stdout.write('{"status":"held","reason":"protected_evidence_unavailable_or_invalid"}\n')
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
