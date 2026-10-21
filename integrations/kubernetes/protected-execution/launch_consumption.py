"""Current one-use CREATE boundary clients and DISPOSABLE authority fixture.

FixtureCurrentAuthority is not the native reservation service. It deliberately
lives outside the supervisor rollback domain for adversarial acceptance; deploy
neither its SQLite permit installer nor a captured signed-grant-only substitute.
Same Pod UID sandbox recreation is outside CREATE admission's reach.
"""
import json
from pathlib import Path
import sqlite3
import ssl
import urllib.request
from authority import Held, canonical, digest, identity, strict


FIELDS = "version cluster namespaceUid webhook reviewUid podUid namespace name objectHash contract target"


def check_binding(binding):
    strict(binding, FIELDS)
    if binding["version"] != 1:
        raise Held("unsupported_launch_consume")
    for field in "cluster namespaceUid webhook reviewUid podUid namespace name objectHash".split():
        identity(binding[field])
    if len(binding["objectHash"]) != 64:
        raise Held("invalid_launch_object_hash")


class OnlineLaunchConsumer:
    """Explicit HTTPS mutual-TLS native client. No ambient credentials/retries.

    A broken connection after a native commit is a held CREATE, never permission
    to retry this body. The service authenticates this specific webhook identity;
    peer certificate validation and client identity are mandatory.
    """
    def __init__(self, endpoint, ca, certificate, key):
        if not endpoint.startswith("https://") or "@" in endpoint or "#" in endpoint:
            raise Held("explicit_https_native_consume_endpoint_required")
        self.endpoint = endpoint
        self.context = ssl.create_default_context(cafile=ca)
        self.context.minimum_version = ssl.TLSVersion.TLSv1_2
        self.context.load_cert_chain(certificate, key)
        # Redirects must not move native consume requests/client credentials.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=self.context), _NoRedirect())

    def consume(self, binding):
        check_binding(binding)
        request = urllib.request.Request(self.endpoint, data=canonical(binding),
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with self.opener.open(request, timeout=3) as response:
                if response.status != 200:
                    raise Held("native_launch_consume_refused")
                data = response.read(4097)
                if len(data) > 4096:
                    raise Held("invalid_native_launch_consume_reply")
                return json.loads(data)
        except Exception as error:
            raise Held("native_launch_consume_uncertain") from error


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Held("native_consume_redirect_refused")


class FixtureCurrentAuthority:
    """FULL-synchronous independent fixture history; all duplicate consumes deny.

    register() models an independently committed native journal. Tests must install
    it from fixture operator authority, never from the signed supervisor request.
    A separate production transaction must recheck reservation/epoch/cancellation,
    scopes/lease/storage under the same lock as this irreversible consumption.
    """
    def __init__(self, path, context):
        self.path, self.context = str(path), context
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS permits (invocation TEXT PRIMARY KEY, contract TEXT NOT NULL, target TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0)")
            db.execute("CREATE TABLE IF NOT EXISTS attempts (binding TEXT NOT NULL, outcome TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS consumes (invocation TEXT PRIMARY KEY REFERENCES permits(invocation), binding TEXT NOT NULL, binding_hash TEXT NOT NULL, review_uid TEXT NOT NULL UNIQUE, pod_uid TEXT NOT NULL UNIQUE)")

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=2, isolation_level=None)
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def register(self, contract, target):
        with self._connect() as db:
            expected = (canonical(contract).decode(), canonical(target).decode())
            row = db.execute("SELECT contract,target FROM permits WHERE invocation=?", (contract["invocation"],)).fetchone()
            if row is not None:
                if row != expected:
                    raise Held("fixture_permit_is_immutable")
                return
            db.execute("INSERT INTO permits(invocation,contract,target) VALUES (?,?,?)", (contract["invocation"], *expected))

    def cancel(self, invocation):
        with self._connect() as db:
            db.execute("UPDATE permits SET cancelled=1 WHERE invocation=?", (invocation,))

    def consume(self, binding):
        check_binding(binding)
        if any(binding.get(k) != v for k, v in self.context.items()):
            raise Held("wrong_current_admission_authority")
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            invocation = binding["contract"]["invocation"]
            row = db.execute("SELECT contract,target,cancelled FROM permits WHERE invocation=?", (invocation,)).fetchone()
            if not row or row[2] or row[:2] != (canonical(binding["contract"]).decode(), canonical(binding["target"]).decode()):
                raise Held("native_launch_not_current")
            try:
                db.execute("INSERT INTO consumes VALUES (?,?,?,?,?)", (invocation, canonical(binding).decode(), digest(binding), binding["reviewUid"], binding["podUid"]))
            except sqlite3.IntegrityError as error:
                db.execute("INSERT INTO attempts VALUES (?,?)", (canonical(binding).decode(), "denied_consumed"))
                db.commit()
                raise Held("native_launch_already_consumed") from error
            db.execute("INSERT INTO attempts VALUES (?,?)", (canonical(binding).decode(), "consumed"))
            db.commit()
            return {"consumed": True, "bindingHash": digest(binding)}
        finally:
            if db.in_transaction:
                db.rollback()
            db.close()

    def history(self):
        with self._connect() as db:
            return [json.loads(row[0]) for row in db.execute("SELECT binding FROM consumes ORDER BY rowid")]
