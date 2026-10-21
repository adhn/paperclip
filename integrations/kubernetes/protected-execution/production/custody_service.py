"""Actual verify-only Ed25519 primitive; no issuer, signer or use authority.

The fixed trust bundle must be installed outside native rollback by a protected
installer. Reading public keys does not confer signing access. This component
does not establish independent custody, bundle rollback resistance or ordering
with native effects; a successful verification remains historical evidence only.
"""
import base64
import binascii
import hashlib

from legacy_review import ReviewHeld
from production.evidence_bridge import exact, hexhash, integer, protected_read, text

TRUST_PATH = "/etc/paperclip/admission/ed25519-trust.json"
DOMAINS = (
    b"paperclip-legacy-current-history-v1\0",
    b"paperclip-legacy-prospective-inspection-v1\0",
    b"paperclip-legacy-ordered-effect-v1\0",
)
MAX_MESSAGE = 2 * 1024 * 1024


class ProtectedEd25519Verifier:
    """Fixed-path public trust only; requests cannot select paths or algorithms.

    Handle is ed25519: plus SHA-256 of the exact 32-byte public key. Reload the
    protected bundle on every verification so an installed retired key refuses.
    The installer must prevent bundle rollback; rereading is not that mechanism.
    Dependency absence fails held. No private-key API or fallback MAC exists.
    Execute this synchronous primitive inside owned verification, not in an
    unbounded native callback. Its result never authorizes a later effect.
    """

    def verify(self, key_handle: str, message: bytes, signature: str) -> bool:
        text(key_handle, 72)
        if not key_handle.startswith("ed25519:"):
            raise ReviewHeld("custody_key_handle")
        hexhash(key_handle[8:])
        if (type(message) is not bytes or not 0 < len(message) <= MAX_MESSAGE
                or not any(message.startswith(domain) and len(message) > len(domain) for domain in DOMAINS)):
            raise ReviewHeld("custody_message")
        # Canonical padded RFC 4648 Base64, exactly one 64-byte signature.
        if type(signature) is not str or len(signature) != 88:
            raise ReviewHeld("custody_signature_encoding")
        try:
            raw = base64.b64decode(signature, validate=True)
        except (ValueError, binascii.Error):
            raise ReviewHeld("custody_signature_encoding") from None
        if len(raw) != 64 or base64.b64encode(raw).decode("ascii") != signature:
            raise ReviewHeld("custody_signature_encoding")
        bundle = protected_read(TRUST_PATH)
        exact(bundle, {"version", "keys"})
        integer(bundle["version"], 1)
        if bundle["version"] != 1 or type(bundle["keys"]) is not list or not 0 < len(bundle["keys"]) <= 64:
            raise ReviewHeld("custody_trust_bundle")
        keys = {}
        for entry in bundle["keys"]:
            exact(entry, {"handle", "publicKey", "status"})
            hexhash(entry["publicKey"])
            public = bytes.fromhex(entry["publicKey"])
            handle = "ed25519:" + hashlib.sha256(public).hexdigest()
            if (entry["handle"] != handle or handle in keys
                    or entry["status"] not in ("active", "retired")):
                raise ReviewHeld("custody_trust_bundle")
            keys[handle] = (public, entry["status"])
        selected = keys.get(key_handle)
        if selected is None or selected[1] != "active":
            return False
        try:
            from cryptography.exceptions import InvalidSignature
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        except ImportError:
            raise ReviewHeld("custody_crypto_unavailable") from None
        try:
            Ed25519PublicKey.from_public_bytes(selected[0]).verify(raw, message)
        except InvalidSignature:
            return False
        except Exception:
            raise ReviewHeld("custody_crypto_unavailable") from None
        return True
