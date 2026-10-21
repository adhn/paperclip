"""Strict multi-root contract validation; no state-copy or release authority.

This records every independently versioned destination, including fixed aliases.
Filesystem transfer must implement this contract before native admission uses it.
"""
import posixpath
from authority import Held, digest, identity, strict


COMMON = "id role storage path kind mode version family aliasOf"
CODEX = {
    "controller-auth": ("credential", "file"),
    "company-auth": ("credential", "alias"),
    "auth-cache": ("credential", "file"),
    "runner-auth": ("credential", "file"),
    "staged-auth": ("credential", "file"),
    "canonical-workspace": ("workspace", "directory"),
    "attempt-workspace": ("workspace", "directory"),
    "canonical-sessions": ("session", "directory"),
    "staged-sessions": ("session", "directory"),
}
CLAUDE = {
    "claude-directory": ("credential", "directory"),
    "claude-json": ("credential", "file"),
    "canonical-workspace": ("workspace", "directory"),
    "attempt-workspace": ("workspace", "directory"),
    "encoded-cwd-sessions": ("session", "directory"),
    "staged-sessions": ("session", "directory"),
}


def validate_contract(value, trusted_owner, approved_fingerprint):
    if not isinstance(value, dict):
        raise Held("invalid_contract_fields")
    strict(value, "version provider owner configFingerprint resumeTarget roots" + (" projections" if value.get("version") == 2 else ""))
    if type(value["version"]) is not int or value["version"] not in (1, 2) or value["provider"] not in ("codex", "claude"):
        raise Held("unsupported_state_contract")
    if value["owner"] != trusted_owner or value["configFingerprint"] != approved_fingerprint:
        raise Held("state_configuration_drift")
    if value["resumeTarget"] is not None:
        identity(value["resumeTarget"])
    required = CODEX if value["provider"] == "codex" else CLAUDE
    roots = value["roots"]
    if not isinstance(roots, list) or len(roots) != len(required):
        raise Held("incomplete_state_roots")
    by_id, paths = {}, set()
    for root in roots:
        strict(root, COMMON)
        if root["id"] not in required or root["id"] in by_id or (root["role"], root["kind"]) != required[root["id"]]:
            raise Held("invalid_state_destination")
        for field in ("storage", "path", "version", "family"):
            identity(root[field])
        path = root["path"]
        if not path.startswith("/") or posixpath.normpath(path) != path or path == "/" or "//" in path:
            raise Held("unsafe_state_path")
        if type(root["mode"]) is not int or root["mode"] not in ((0o600, 0o400) if root["kind"] == "file" else (0o700,) if root["kind"] == "directory" else (0o777,)):
            raise Held("unsafe_state_mode")
        key = (root["storage"], root["path"])
        if key in paths:
            raise Held("aliased_state_destination")
        paths.add(key)
        if root["family"] != trusted_owner[root["role"]]:
            raise Held("state_family_remap")
        if root["kind"] != "alias" and root["aliasOf"] is not None:
            raise Held("unexpected_state_alias")
        by_id[root["id"]] = root
    if set(by_id) != set(required):
        raise Held("incomplete_state_roots")
    for root in roots:
        if root["kind"] == "alias" and (root["aliasOf"] not in by_id or by_id[root["aliasOf"]]["kind"] != "file" or by_id[root["aliasOf"]]["role"] != root["role"]):
            raise Held("invalid_fixed_alias")
    projections = value.get("projections", {})
    if not isinstance(projections, dict):
        raise Held("invalid_state_projection")
    nested = {}
    for child in roots:
        parents = [parent for parent in roots if parent is not child and parent["storage"] == child["storage"] and child["path"].startswith(parent["path"] + "/")]
        if parents:
            parent = max(parents, key=lambda candidate: len(candidate["path"]))
            if parent["kind"] != "directory" or child["kind"] == "alias":
                raise Held("invalid_state_projection")
            nested[child["id"]] = parent["id"]
    if projections != nested:
        raise Held("overlapping_state_roots" if nested else "invalid_state_projection")
    return digest(value)


def restoration_outcomes(contract, snapshot_hash, results):
    """Validate independent outcomes; never infer credentials from workspace.

    Results come from trusted transfer, never from provider body/SSH receipts.
    This predicate cannot clear bootstrap/native occupancy on its own.
    """
    if set(results) != {root["id"] for root in contract["roots"]}:
        raise Held("missing_restoration_destination")
    outcomes = {role: True for role in ("workspace", "session", "credential")}
    for root in contract["roots"]:
        result = results[root["id"]]
        strict(result, "snapshot sourceVersion outcome preservedCopy")
        if result["snapshot"] != snapshot_hash or result["sourceVersion"] != root["version"]:
            raise Held("restoration_version_mismatch")
        if result["outcome"] not in ("restored", "unchanged", "conflict", "uncertain", "failed"):
            raise Held("invalid_restoration_outcome")
        if result["outcome"] in ("conflict", "uncertain", "failed"):
            identity(result["preservedCopy"])
            outcomes[root["role"]] = False
    return outcomes
