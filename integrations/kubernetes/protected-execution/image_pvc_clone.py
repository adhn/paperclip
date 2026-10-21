"""Real controller images + PVCs in a disposable, enforcing-CNI kind cluster.

Trusted test host only. Never deploy this broad Docker/kubectl/CNI harness.
No default kubeconfig, provider credentials, live backup or homelab access.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import time

CLUSTER = "pc-image-pvc-clone-disposable"
NODE = CLUSTER + "-control-plane"
NAMESPACE = "pc-image-pvc-clone"
OLD_IMAGE = "ghcr.io/adhn/paperclip-eval/controller@sha256:8bd2d8ccef956c777ea6eefa2004152632e0781706031e8cd42ef89bdd7c50ca"
POSTGRES_IMAGE = "postgres:18-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c"
CANDIDATE = "paperclip-admission-candidate:latest"
POLICY_PATH = "/etc/clone-policy.json"
APPLICATION_MEMORY = "1536Mi"
APPLICATION_NODE_OPTIONS = "--max-old-space-size=768"
OLD_ALIAS = "pc-clone-old-controller:disposable"
POSTGRES_ALIAS = "pc-clone-postgres:disposable"
COMPANY = "10000000-0000-4000-8000-000000000001"
AGENT = "20000000-0000-4000-8000-000000000002"
PASSWORD = "disposable-synthetic-no-provider-secret"
APP_COMMAND = ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh", "node", "--import", "/app/server/node_modules/tsx/dist/loader.mjs", "/app/server/dist/index.js"]
STALE_SCHEMA_ERROR = b"admission_bootstrap_schema_not_current"
# The pinned production build compiles server but uses the DB package's shipped
# TypeScript runtime exports through its TSX loader. DB dist/client.js is absent
# in the observed old image; never guess a compiled path or fall back to SQL.
OLD_SOURCE_MIGRATE_JS = """import {applyPendingMigrations,inspectMigrations} from '/app/packages/db/src/client.ts';
if(typeof applyPendingMigrations!=='function'||typeof inspectMigrations!=='function')throw Error('fixture_packaged_migration_api_missing');
console.log('fixture_db_module_verified:/app/packages/db/src/client.ts');
await applyPendingMigrations(process.env.DATABASE_URL);
const result=await inspectMigrations(process.env.DATABASE_URL);
if(result.status!=='upToDate')throw Error('fixture_manual_migration_incomplete');
console.log('fixture_manual_migration_complete');process.exit(0);"""
# Candidate policy is validated before importing/calling the migration API.
# The old image lacks this module; its empty synthetic source initialization is
# externally contained fixture setup, not a protected operational executor.
POLICY_METADATA_JS = """import {realpath,stat} from 'node:fs/promises';
import {dirname} from 'node:path';
const configured=process.env.PAPERCLIP_ADMISSION_POLICY_FILE;
let metadata={configured:configured??null};
if(configured){
 const canonical=await realpath(configured);const file=await stat(canonical);const parents=[];
 for(let current=dirname(canonical);;current=dirname(current)){
  const value=await stat(current);parents.push({path:current,uid:value.uid,mode:value.mode&0o7777,directory:value.isDirectory()});
  if(current==='/')break;
 }
 metadata={configured,canonical,file:{uid:file.uid,mode:file.mode&0o7777,regular:file.isFile()},parents};
}
console.log('PC_POLICY_METADATA '+JSON.stringify(metadata));
if(configured){
 if(!metadata.file.regular||metadata.file.uid!==0||(metadata.file.mode&0o022))throw Error('fixture_policy_file_unprotected');
 if(metadata.parents.some(value=>!value.directory||value.uid!==0||(value.mode&0o022)))throw Error('fixture_policy_parent_unprotected');
}
"""
POLICY_VALIDATE_JS = """import {loadProductionAdmissionPolicy} from '/app/server/dist/services/execution-admission-bootstrap.js';
await loadProductionAdmissionPolicy({databaseUrl:process.env.DATABASE_URL,
autoApply:process.env.PAPERCLIP_MIGRATION_AUTO_APPLY,policyPath:process.env.PAPERCLIP_ADMISSION_POLICY_FILE});
console.log('fixture_manual_policy_verified');
"""
POLICY_PREFLIGHT_JS = POLICY_METADATA_JS + POLICY_VALIDATE_JS + "process.exit(0);"
MIGRATE_JS = POLICY_METADATA_JS + POLICY_VALIDATE_JS + """
const {applyPendingMigrations,inspectMigrations}=await import('/app/packages/db/src/client.ts');
if(typeof applyPendingMigrations!=='function'||typeof inspectMigrations!=='function')throw Error('fixture_packaged_migration_api_missing');
console.log('fixture_db_module_verified:/app/packages/db/src/client.ts');
await applyPendingMigrations(process.env.DATABASE_URL);
const result=await inspectMigrations(process.env.DATABASE_URL);
if(result.status!=='upToDate')throw Error('fixture_manual_migration_incomplete');
console.log('fixture_manual_migration_complete');process.exit(0);"""
MIGRATION_LEDGER_SQL = "SELECT COALESCE(json_agg(row_to_json(t) ORDER BY id)::text,'[]') FROM drizzle.__drizzle_migrations t;"

APPLICATION_BUDGET_JS = """import {getHeapStatistics} from 'node:v8';
const heap=getHeapStatistics().heap_size_limit;
console.log(JSON.stringify({nodeOptions:process.env.NODE_OPTIONS,heapSizeLimitBytes:heap}));
if(process.env.NODE_OPTIONS!=='--max-old-space-size=768'||heap<768*1024*1024||heap>1024*1024*1024)process.exit(1);"""
HEALTH_JS = """const r=await fetch('http://127.0.0.1:3100/api/health',{signal:AbortSignal.timeout(3000)});
if(!r.ok||(await r.json()).status!=='ok')process.exit(1);"""
POLICY = {"version": 1, "mode": "held", "instance": "synthetic-image-pvc-clone", "pendingLimit": 4, "legacyOwners": []}
SEED_SQL = f"""INSERT INTO companies(id,name,status,issue_prefix) VALUES('{COMPANY}','synthetic PVC clone','paused','CLONE');
INSERT INTO agents(id,company_id,name,adapter_type,status,lifecycle_state,lifecycle_holds,runtime_config)
VALUES('{AGENT}','{COMPANY}','synthetic held no-provider agent','process','paused','paused','["manual"]','{{"heartbeat":{{"enabled":false}}}}');
CREATE TABLE clone_rehearsal_marker(value text NOT NULL); INSERT INTO clone_rehearsal_marker VALUES('coordinated-checkpoint');"""
FACTS_SQL = f"""SELECT json_build_object('company', (SELECT row_to_json(t) FROM
(SELECT id,status,issue_prefix FROM companies WHERE id='{COMPANY}') t), 'agent', (SELECT row_to_json(t) FROM
(SELECT id,company_id,adapter_type,status,lifecycle_state,lifecycle_holds,runtime_config FROM agents WHERE id='{AGENT}') t),
'marker',(SELECT value FROM clone_rehearsal_marker));"""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def run(argv, *, data=None, check=True, timeout=60):
    result = subprocess.run(list(map(str, argv)), input=data, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError("fixture_command_failed: " + result.stderr.decode()[-2500:])
    return result


def registry_digest(reference):
    """Canonical registry/repository digest; a source tag is not identity."""
    repository, marker, checksum = reference.partition("@")
    if not marker or not re.fullmatch("sha256:[0-9a-f]{64}", checksum):
        raise ValueError("exact_registry_digest_required")
    tail = repository.rsplit("/", 1)[-1]
    if ":" in tail: repository = repository.rsplit(":", 1)[0]
    first = repository.split("/", 1)[0]
    if "/" not in repository: repository = "docker.io/library/" + repository
    elif "." not in first and ":" not in first and first != "localhost": repository = "docker.io/" + repository
    if repository.startswith("index.docker.io/"): repository = "docker.io/" + repository[len("index.docker.io/"):]
    return repository + "@" + checksum


def bind_host_image(source, alias, image, *, require_digest):
    """Bind authenticated pre-pull identity before any kind resource is created."""
    config_id = image.get("Id", "")
    layers = image.get("RootFS", {}).get("Layers", [])
    if not re.fullmatch("sha256:[0-9a-f]{64}", config_id) or image.get("RootFS", {}).get("Type") != "layers" or not layers or any(
            not re.fullmatch("sha256:[0-9a-f]{64}", layer) for layer in layers):
        raise ValueError("host_image_config_and_rootfs_required")
    if image.get("Os") != "linux" or image.get("Architecture") != "amd64":
        raise ValueError("exact_linux_amd64_image_required")
    expected = registry_digest(source) if require_digest else None
    if expected and expected not in {registry_digest(value) for value in image.get("RepoDigests", [])}:
        raise ValueError("authenticated_prepull_registry_digest_missing")
    return {"source": source, "registryDigest": expected, "localAlias": alias, "configId": config_id,
        "rootfsLayers": layers, "platform": "linux/amd64"}


def verify_imported_image(binding, inspected):
    if inspected.get("status", {}).get("id") != binding["configId"]:
        raise ValueError("imported_image_config_differs_from_bound_host")


def host_cleanup_references(binding):
    """Only the bound source reference plus its fixed disposable alias."""
    allowed = {CANDIDATE: CANDIDATE, OLD_IMAGE: OLD_ALIAS, POSTGRES_IMAGE: POSTGRES_ALIAS}
    source, alias = binding.get("source"), binding.get("localAlias")
    if source not in allowed or alias != allowed[source]:
        raise ValueError("exact_fixture_host_cleanup_references_required")
    # Docker canonicalizes tag@digest to repository@digest on pull. Removing
    # that exact digest reference must not remove a floating source tag.
    source_reference = registry_digest(source) if source != CANDIDATE else source
    return list(dict.fromkeys((source_reference, alias)))


def remove_imported_host_image(binding, imported):
    """Release host copies only after independently checking the node import.

    No image IDs, wildcards, force, system prune or node-image removal. Other
    references to the same rootfs remain untouched; Docker retains shared layers.
    """
    verify_imported_image(binding, imported)
    references = host_cleanup_references(binding)
    # Validate all references before the first mutation. Once a registry digest
    # is untagged, its metadata may disappear from the remaining alias too.
    for reference in references:
        image = json.loads(run(["docker", "image", "inspect", reference]).stdout)[0]
        current = bind_host_image(binding["source"], binding["localAlias"], image,
            require_digest=binding["source"] != CANDIDATE)
        if current != binding:
            raise RuntimeError("host_cleanup_image_metadata_rebound")
    for reference in references:
        # Recheck content identity immediately before each exact untag operation;
        # digest metadata was already validated before any removal above.
        current = json.loads(run(["docker", "image", "inspect", reference]).stdout)[0]
        if current.get("Id") != binding["configId"] or current.get("RootFS", {}).get("Layers") != binding["rootfsLayers"]:
            raise RuntimeError("host_cleanup_image_identity_rebound")
        run(["docker", "image", "rm", "--no-prune", reference])
        if run(["docker", "image", "inspect", reference], check=False).returncode == 0:
            raise RuntimeError("host_cleanup_reference_still_present")
    return {"status": "PASS", "source": binding["source"], "configId": binding["configId"], "removedHostReferences": references,
        "nodeImageRetained": True, "unrelatedImagesPruned": False}


def collect_import_diagnostics(rehearsal, prefix, binding=None):
    """Fixed read-only fixture-host/node diagnostics; never infer timeout cause."""
    commands = {
        "host-disk": ["df", "-h", "/", str(rehearsal.evidence)],
        "host-inodes": ["df", "-i", "/", str(rehearsal.evidence)],
        "node-state": ["docker", "inspect", NODE, "--format", "{{json .State}}"],
        "node-stats": ["docker", "stats", "--no-stream", "--format", "{{json .}}", NODE],
        "node-cgroup": ["docker", "exec", NODE, "cat", "/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.peak",
            "/sys/fs/cgroup/memory.events", "/sys/fs/cgroup/memory.swap.current", "/sys/fs/cgroup/pids.current", "/sys/fs/cgroup/pids.events"],
        "node-disk": ["docker", "exec", NODE, "df", "-h", "/var/lib/containerd", "/var/lib/kubelet", "/"],
        "containerd-journal": ["docker", "exec", NODE, "journalctl", "-u", "containerd", "--no-pager", "-n", "80"],
        "node-images": ["docker", "exec", NODE, "crictl", "images", "-o", "json"],
    }
    if binding is not None:
        host_cleanup_references(binding)
        commands["bound-image"] = ["docker", "exec", NODE, "crictl", "inspecti", binding["localAlias"]]
    results = {}
    for name, argv in commands.items():
        try:
            value = run(argv, check=False, timeout=12)
            rehearsal.save(prefix + "-diagnostic-" + name + ".stdout", value.stdout)
            rehearsal.save(prefix + "-diagnostic-" + name + ".stderr", value.stderr)
            results[name] = {"returnCode": value.returncode, "timeoutSeconds": 12}
        except Exception as error:
            results[name] = {"error": type(error).__name__, "timeoutSeconds": 12}
    rehearsal.save(prefix + "-diagnostics.json", results)


def import_bound_image(kind, binding, rehearsal):
    """Bounded import with exact identity checks and retained failure evidence.

    A timeout is a failed fixture even if an image happens to become inspectable.
    No import retry, host cleanup or workload acceptance follows that timeout.
    """
    host_cleanup_references(binding)  # refuse unknown source/alias before command
    prefix = binding["localAlias"].replace(":", "-")
    deadline = 600 if binding["source"] in (CANDIDATE, OLD_IMAGE) else 240
    argv = [str(kind), "load", "docker-image", binding["localAlias"], "--name", CLUSTER]
    record = {"binding": binding, "argv": argv, "deadlineSeconds": deadline, "status": "STARTED"}
    rehearsal.save(prefix + "-import-attempt.json", record)
    print(json.dumps({"imageImportStarted": binding["localAlias"], "deadlineSeconds": deadline}), flush=True)
    started = time.monotonic()
    try:
        try:
            value = run(argv, check=False, timeout=deadline)
        except subprocess.TimeoutExpired as error:
            record["commandDurationSeconds"] = round(time.monotonic() - started, 3)
            rehearsal.save(prefix + "-import.stdout", error.stdout or b"")
            rehearsal.save(prefix + "-import.stderr", error.stderr or b"")
            record["status"] = "TIMEOUT"
            raise RuntimeError("fixture_image_import_timeout:" + binding["localAlias"]) from error
        record["commandDurationSeconds"] = round(time.monotonic() - started, 3)
        rehearsal.save(prefix + "-import.stdout", value.stdout)
        rehearsal.save(prefix + "-import.stderr", value.stderr)
        record["returnCode"] = value.returncode
        if value.returncode:
            record["status"] = "COMMAND_FAILED"
            raise RuntimeError("fixture_image_import_failed:" + binding["localAlias"])
        imported = json.loads(run(["docker", "exec", NODE, "crictl", "inspecti", binding["localAlias"]], timeout=30).stdout)
        rehearsal.save(prefix + "-import.json", imported)
        verify_imported_image(binding, imported)
        record["status"] = "PASS"
        record["verifiedConfigId"] = imported["status"]["id"]
        return imported
    except BaseException as error:
        record["errorType"] = type(error).__name__
        if record["status"] == "STARTED": record["status"] = "IMPORT_IDENTITY_OR_INSPECTION_FAILED"
        # Diagnostics are independent observations. Failure to collect one never
        # converts an import failure to a pass, retries import or weakens identity.
        try: collect_import_diagnostics(rehearsal, prefix, binding)
        except Exception as error: record["diagnosticsError"] = type(error).__name__
        raise
    finally:
        record["durationSeconds"] = round(time.monotonic() - started, 3)
        rehearsal.save(prefix + "-import-attempt.json", record)


def load_cni():
    path = Path(__file__).parent / "kubernetes-review/network_fixture_runner.py"
    spec = importlib.util.spec_from_file_location("pinned_clone_cni", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_context(config):
    if config.get("current-context") != "kind-" + CLUSTER or len(config.get("clusters", [])) != 1:
        raise ValueError("explicit_disposable_clone_context_required")
    if not re.fullmatch(r"https://127\.0\.0\.1:[0-9]+", config["clusters"][0]["cluster"]["server"]):
        raise ValueError("loopback_clone_api_required")


def environment(database_url):
    return [{"name": key, "value": value} for key, value in {
        "DATABASE_URL": database_url, "HOME": "/paperclip", "HOST": "0.0.0.0", "PORT": "3100", "SERVE_UI": "false",
        "PAPERCLIP_HOME": "/paperclip", "PAPERCLIP_DEPLOYMENT_MODE": "authenticated", "PAPERCLIP_DEPLOYMENT_EXPOSURE": "private",
        "PAPERCLIP_AUTH_BASE_URL_MODE": "explicit", "PAPERCLIP_AUTH_PUBLIC_BASE_URL": "http://localhost:3100",
        "PAPERCLIP_ALLOWED_HOSTNAMES": "localhost,127.0.0.1", "PAPERCLIP_MIGRATION_AUTO_APPLY": "false",
        "PAPERCLIP_MIGRATION_PROMPT": "never", "HEARTBEAT_SCHEDULER_ENABLED": "false", "PAPERCLIP_DB_BACKUP_ENABLED": "false",
        "PAPERCLIP_TELEMETRY_ENABLED": "false", "PAPERCLIP_ADMISSION_POLICY_FILE": POLICY_PATH,
        "BETTER_AUTH_SECRET": "synthetic-clone-only-auth-secret-000000000000000000000000",
        "PAPERCLIP_AGENT_JWT_SECRET": "synthetic-clone-only-agent-secret-00000000000000000000000",
    }.items()]


def kind_configuration():
    # Patches belong to the node, not the Cluster object. The effective value
    # is subsequently checked through the real kubelet /configz endpoint.
    return {"kind": "Cluster", "apiVersion": "kind.x-k8s.io/v1alpha4",
        "nodes": [{"role": "control-plane", "kubeadmConfigPatches": [json.dumps({
            "apiVersion": "kubelet.config.k8s.io/v1beta1", "kind": "KubeletConfiguration", "podPidsLimit": 256})]}],
        "networking": {"disableDefaultCNI": True, "podSubnet": "192.168.0.0/16", "apiServerAddress": "127.0.0.1"}}


def pvc(name):
    return {"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": {"name": name, "namespace": NAMESPACE},
        "spec": {"accessModes": ["ReadWriteOnce"], "storageClassName": "standard", "resources": {"requests": {"storage": "1Gi"}}}}


def pod(name, image, command, *, database_url=None, state=None, checkpoints=False, source=False, db=False, label="controller"):
    volumes = [{"name": "tmp", "emptyDir": {"medium": "Memory", "sizeLimit": "64Mi"}}]
    mounts = [{"name": "tmp", "mountPath": "/tmp"}]
    if db:
        volumes.append({"name": "database", "persistentVolumeClaim": {"claimName": "database"}})
        mounts.append({"name": "database", "mountPath": "/var/lib/postgresql"})
        volumes.append({"name": "postgres-socket", "emptyDir": {"medium": "Memory", "sizeLimit": "4Mi"}})
        mounts.append({"name": "postgres-socket", "mountPath": "/var/run/postgresql"})
    for volume_name, target in ((state, "/paperclip"), ("checkpoint" if checkpoints else None, "/checkpoint"), ("source-state" if source else None, "/source")):
        if volume_name:
            volumes.append({"name": volume_name, "persistentVolumeClaim": {"claimName": volume_name}})
            mounts.append({"name": volume_name, "mountPath": target})
    if database_url:
        volumes.append({"name": "policy", "configMap": {"name": "held-policy", "defaultMode": 0o444}})
        mounts.append({"name": "policy", "mountPath": POLICY_PATH, "subPath": "policy.json", "readOnly": True})
    uid = 999 if db else 1000
    container = {"name": "fixture", "image": image, "imagePullPolicy": "Never", "command": command,
        "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
        "resources": {"requests": {"cpu": "100m", "memory": "128Mi"}, "limits": {"cpu": "1", "memory": APPLICATION_MEMORY if database_url and command == APP_COMMAND else "768Mi" if database_url else "256Mi"}},
        "volumeMounts": mounts}
    if database_url:
        container["env"] = environment(database_url)
        if command == APP_COMMAND:
            container["env"].append({"name": "NODE_OPTIONS", "value": APPLICATION_NODE_OPTIONS})
    if db:
        container["env"] = [{"name": "POSTGRES_PASSWORD", "value": PASSWORD}, {"name": "POSTGRES_USER", "value": "fixture"},
            {"name": "POSTGRES_DB", "value": "source"}, {"name": "PGDATA", "value": "/var/lib/postgresql/18/clone-fixture"}]
        # The official entrypoint's temporary server and docker_process_sql
        # must use the same default socket directory. A writable fsGroup-owned
        # emptyDir supports non-root initialization without changing PGHOST or
        # adding a root initContainer. The bounded Docker regression proves it.
        container["command"] = ["docker-entrypoint.sh", "postgres", "-c", "shared_buffers=16MB"]
    return {"apiVersion": "v1", "kind": "Pod", "metadata": {"name": name, "namespace": NAMESPACE, "labels": {"app": label}},
        "spec": {"automountServiceAccountToken": False, "enableServiceLinks": False, "restartPolicy": "Never", "terminationGracePeriodSeconds": 30,
            "securityContext": {"runAsNonRoot": True, "runAsUser": uid, "runAsGroup": uid, "fsGroup": uid, "seccompProfile": {"type": "RuntimeDefault"}},
            "containers": [container], "volumes": volumes}}


def migration_pod(name, image, url, state, *, policy_failure=None):
    if image not in (OLD_ALIAS, CANDIDATE):
        raise ValueError("exact_fixture_migration_image_required")
    if policy_failure not in (None, "missing", "invalid") or (policy_failure and image != CANDIDATE):
        raise ValueError("candidate_policy_failure_mode_required")
    script = OLD_SOURCE_MIGRATE_JS if image == OLD_ALIAS else MIGRATE_JS
    value = pod(name, image, ["node", "--import", "/app/server/node_modules/tsx/dist/loader.mjs", "--input-type=module", "-e", script], database_url=url, state=state)
    if policy_failure == "missing":
        container = value["spec"]["containers"][0]
        container["env"] = [item for item in container["env"] if item["name"] != "PAPERCLIP_ADMISSION_POLICY_FILE"]
    if policy_failure == "invalid":
        for volume in value["spec"]["volumes"]:
            if volume["name"] == "policy": volume["configMap"]["name"] = "invalid-policy"
    return value


def network_policies():
    base = {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy"}
    return [{**base, "metadata": {"name": "deny-all", "namespace": NAMESPACE},
        "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]}},
        {**base, "metadata": {"name": "controller-to-fixture-db-only", "namespace": NAMESPACE},
        "spec": {"podSelector": {"matchLabels": {"app": "controller"}}, "policyTypes": ["Egress"],
            "egress": [{"to": [{"podSelector": {"matchLabels": {"app": "database"}}}], "ports": [{"protocol": "TCP", "port": 5432}]}]}},
        {**base, "metadata": {"name": "db-from-fixture-only", "namespace": NAMESPACE},
        "spec": {"podSelector": {"matchLabels": {"app": "database"}}, "policyTypes": ["Ingress"],
            "ingress": [{"from": [{"podSelector": {"matchLabels": {"app": "controller"}}}], "ports": [{"protocol": "TCP", "port": 5432}]}]}}]


class Rehearsal:
    def __init__(self, kubeconfig, evidence, bindings):
        self.kubeconfig, self.evidence = Path(kubeconfig), Path(evidence)
        self.bindings = {binding["localAlias"]: binding for binding in bindings}
        self.image_observations = {}
        validate_context(json.loads(self.kube("config", "view", "--raw", "-o", "json").stdout))
        labels = json.loads(run(["docker", "inspect", NODE, "--format", "{{json .Config.Labels}}"] ).stdout)
        if labels.get("io.x-k8s.kind.cluster") != CLUSTER:
            raise ValueError("disposable_clone_node_required")
        self.steps = []

    def kube(self, *args, data=None, check=True, timeout=60):
        return run(["kubectl", "--kubeconfig", self.kubeconfig, "--request-timeout=45s", *args], data=data, check=check, timeout=timeout)

    def save(self, name, value):
        (self.evidence / name).write_bytes(value if isinstance(value, bytes) else canonical(value))

    def capture_pod_logs(self, name):
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]", name):
            raise ValueError("fixture_pod_log_name_required")
        try:
            logs = self.kube("-n", NAMESPACE, "logs", name, "--all-containers=true", "--timestamps=true", "--tail=100",
                "--limit-bytes=32768", "--pod-running-timeout=5s", check=False, timeout=12)
            self.save(name + "-failure.log", logs.stdout + logs.stderr)
        except Exception as error:
            self.save(name + "-failure.log", ("fixture_log_capture_failed:" + type(error).__name__).encode())

    def collect_failure_diagnostics(self):
        # Only this fixture namespace, at most sixteen Pods and 32 KiB/Pod.
        # Capture before deleting kind; a generic Pod list alone loses PG errors.
        result = self.kube("-n", NAMESPACE, "get", "pods", "-o", "json", check=False, timeout=15)
        self.save("failure-fixture-pods.json", result.stdout + (result.stderr if result.returncode else b""))
        if result.returncode: return
        for value in json.loads(result.stdout).get("items", [])[:16]:
            self.capture_pod_logs(value["metadata"]["name"])

    def wait_database_ready(self, timeout=60):
        deadline = time.monotonic() + timeout
        last_probe = b"no readiness probe completed"
        while time.monotonic() < deadline:
            value = self.object("pod", "database")
            phase = value.get("status", {}).get("phase")
            statuses = value.get("status", {}).get("containerStatuses", [])
            terminated = [item.get("state", {}).get("terminated", {}) for item in statuses if item.get("state", {}).get("terminated")]
            if phase in ("Failed", "Succeeded") or terminated:
                self.save("database-readiness.json", value)
                self.capture_pod_logs("database")
                exits = [item.get("exitCode") for item in terminated]
                raise RuntimeError("fixture_database_exited_before_ready:" + str(phase) + ":" + str(exits))
            result = self.exec("database", "pg_isready", "-h", "127.0.0.1", "-U", "fixture", "-d", "source", check=False)
            last_probe = result.stdout + result.stderr
            if result.returncode == 0:
                self.save("database-readiness.log", last_probe)
                return
            time.sleep(1)
        self.save("database-readiness.log", last_probe)
        self.save("database-readiness.json", self.object("pod", "database"))
        self.capture_pod_logs("database")
        raise RuntimeError("fixture_database_unready")

    def install(self, *objects):
        self.kube("create", "-f", "-", data=canonical({"apiVersion": "v1", "kind": "List", "items": list(objects)}))

    def object(self, kind, name):
        return json.loads(self.kube("-n", NAMESPACE, "get", kind, name, "-o", "json").stdout)

    def exec(self, name, *args, data=None, check=True):
        return self.kube("-n", NAMESPACE, "exec", "-i", name, "--", *args, data=data, check=check)

    def verify_pod_image(self, value):
        containers = value["spec"].get("containers", [])
        statuses = value.get("status", {}).get("containerStatuses", [])
        if len(containers) != 1 or len(statuses) != 1 or containers[0]["image"] not in self.bindings:
            raise RuntimeError("exact_bound_pod_image_required")
        binding = self.bindings[containers[0]["image"]]
        image_id = statuses[0].get("imageID", "")
        for prefix in ("docker-pullable://", "docker://"):
            if image_id.startswith(prefix): image_id = image_id[len(prefix):]
        if not image_id or len(image_id) > 2048 or re.search(r"\s", image_id) or "://" in image_id:
            raise RuntimeError("running_pod_image_identity_missing")
        observed = json.loads(run(["docker", "exec", NODE, "crictl", "inspecti", image_id]).stdout)
        verify_imported_image(binding, observed)
        container_id = statuses[0].get("containerID", "")
        if not re.fullmatch("containerd://[0-9a-f]{64}", container_id):
            raise RuntimeError("exact_running_cri_container_required")
        container = json.loads(run(["docker", "exec", NODE, "crictl", "inspect", container_id.split("://", 1)[1]]).stdout)
        if container.get("status", {}).get("id") != container_id.split("://", 1)[1]:
            raise RuntimeError("running_cri_container_rebound")
        image_ref = container["status"].get("imageRef")
        if not isinstance(image_ref, str) or not image_ref:
            raise RuntimeError("running_cri_image_reference_missing")
        container_image = json.loads(run(["docker", "exec", NODE, "crictl", "inspecti", image_ref]).stdout)
        verify_imported_image(binding, container_image)
        self.save(value["metadata"]["name"] + "-container-inspect.json", container)
        self.save(value["metadata"]["name"] + "-image-inspect.json", observed)
        self.image_observations[value["metadata"]["uid"]] = {"pod": value["metadata"]["name"], "imageID": image_id,
            "containerID": container_id, "containerImageRef": image_ref, "configId": binding["configId"],
            "source": binding["source"], "registryDigest": binding["registryDigest"], "localAlias": binding["localAlias"]}
        self.save("pod-image-bindings.json", self.image_observations)

    def wait(self, name, *, completed=False, timeout=150):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = self.object("pod", name)
            phase = value.get("status", {}).get("phase")
            if phase in ("Failed", "Succeeded"):
                self.verify_pod_image(value)
                self.save(name + ".log", self.kube("-n", NAMESPACE, "logs", name, check=False).stdout)
                if phase == "Failed": raise RuntimeError("fixture_pod_failed:" + name)
                if completed: return value
                raise RuntimeError("fixture_pod_unexpected_exit:" + name)
            statuses = value.get("status", {}).get("containerStatuses", [])
            if not completed and statuses and statuses[0].get("state", {}).get("running"):
                self.verify_pod_image(value)
                return value
            time.sleep(2)
        self.save(name + ".json", self.object("pod", name))
        raise RuntimeError("fixture_pod_timeout:" + name)

    def stop(self, name):
        self.save(name + ".log", self.kube("-n", NAMESPACE, "logs", name, check=False).stdout)
        self.kube("-n", NAMESPACE, "delete", "pod", name, "--wait=true", "--timeout=90s", timeout=100)
        # Fixture only: wait for the exact Pod object to vanish before PVC
        # handoff. This is NOT the protected provider stable-retirement proof.
        self.steps.append("retired-fixture-pod:" + name)
        print("fixture Pod stopped: " + name, flush=True)

    def require_no_application_pod(self):
        values = json.loads(self.kube("-n", NAMESPACE, "get", "pods", "-o", "json").stdout)["items"]
        if any(container.get("command") == APP_COMMAND for value in values for container in value["spec"]["containers"]):
            raise RuntimeError("fixture_application_predecessor_not_removed")
        return values

    def once(self, manifest):
        self.require_no_application_pod()
        name = manifest["metadata"]["name"]
        self.install(manifest)
        self.wait(name, completed=True)
        output = self.kube("-n", NAMESPACE, "logs", name).stdout
        self.stop(name)
        return output

    def sql(self, database, value):
        return self.exec("database", "psql", "-U", "fixture", "-d", database, "-v", "ON_ERROR_STOP=1", "-At", data=value.encode()).stdout.strip()

    def boot(self, name, image, url, state):
        values = self.require_no_application_pod()
        if [value["metadata"]["name"] for value in values] != ["database"]:
            raise RuntimeError("fixture_application_requires_database_only_phase")
        try:
            self.install(pod(name, image, APP_COMMAND, database_url=url, state=state))
            value = self.wait(name)
            configured = value["spec"]["containers"][0]
            budget_out = self.exec(name, "node", "--input-type=module", "-e", APPLICATION_BUDGET_JS).stdout
            actual = json.loads(budget_out)
            if configured["resources"]["limits"]["memory"] != APPLICATION_MEMORY or actual.get("nodeOptions") != APPLICATION_NODE_OPTIONS:
                raise RuntimeError("fixture_application_budget_mismatch")
            self.save(name + "-runtime-budget.json", {"assignedPodLimits": configured["resources"]["limits"],
                "effectiveNode": actual, "nodeMemoryBytes": 3 * 1024**3, "databaseLimitMiB": 256,
                "singleApplicationLimitMiB": 1536, "remainingNodeBudgetMiB": 1280,
                "scope": "hosted fixture configuration only; no measured startup headroom or production capacity acceptance"})
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                result = self.exec(name, "node", "--input-type=module", "-e", HEALTH_JS, check=False)
                if result.returncode == 0:
                    running = self.object("pod", name)
                    self.verify_pod_image(running)
                    self.save(name + "-running.json", running)
                    print(json.dumps({"healthyController": name, "podUID": running["metadata"]["uid"],
                        "image": image, "imageID": running["status"]["containerStatuses"][0].get("imageID")}), flush=True)
                    return value["metadata"]["uid"]
                if self.object("pod", name).get("status", {}).get("phase") in ("Failed", "Succeeded"): break
                time.sleep(2)
            self.save(name + ".log", self.kube("-n", NAMESPACE, "logs", name, check=False).stdout)
            raise RuntimeError("controller_health_failed:" + name)
        except BaseException:
            try: self.capture_pod_logs(name)
            except Exception: pass
            try: collect_import_diagnostics(self, "controller-" + name)
            except Exception: pass
            raise

    def migrate(self, name, image, url, state):
        out = self.once(migration_pod(name, image, url, state))
        if image == CANDIDATE and b"fixture_manual_policy_verified" not in out: raise RuntimeError("migration_policy_verification_missing")
        if b"fixture_db_module_verified:/app/packages/db/src/client.ts" not in out: raise RuntimeError("migration_image_module_verification_missing")
        if b"fixture_manual_migration_complete" not in out: raise RuntimeError("migration_completion_marker_missing")
        self.steps.append("manual-migration:" + name)
        print("real image manual migration verified: " + name, flush=True)

    def candidate_policy_preflight(self, url):
        out = self.once(pod("candidate-policy-preflight", CANDIDATE,
            ["node", "--import", "/app/server/node_modules/tsx/dist/loader.mjs", "--input-type=module", "-e", POLICY_PREFLIGHT_JS],
            database_url=url, state="restored-state"))
        if b"fixture_manual_policy_verified" not in out: raise RuntimeError("candidate_policy_preflight_loader_failed")
        lines = [line[len(b"PC_POLICY_METADATA "):] for line in out.splitlines() if line.startswith(b"PC_POLICY_METADATA ")]
        if len(lines) != 1: raise RuntimeError("candidate_policy_preflight_metadata_missing")
        metadata = json.loads(lines[0])
        if metadata.get("configured") != POLICY_PATH or metadata.get("canonical") != POLICY_PATH:
            raise RuntimeError("candidate_policy_file_binding_mismatch")
        if metadata.get("file", {}).get("uid") != 0 or metadata["file"].get("mode", 0o7777) & 0o022:
            raise RuntimeError("candidate_policy_file_unprotected")
        parents = metadata.get("parents", [])
        if [value.get("path") for value in parents] != ["/etc", "/"] or any(value.get("uid") != 0 or value.get("mode", 0o7777) & 0o022 for value in parents):
            raise RuntimeError("candidate_policy_parent_binding_mismatch")
        self.save("candidate-policy-preflight.json", metadata)
        self.steps.append("candidate-exact-policy-file-parent-preflight")

    def candidate_policy_negative_controls(self, url):
        self.require_no_application_pod()
        before = self.sql("restored", MIGRATION_LEDGER_SQL)
        self.install({"apiVersion": "v1", "kind": "ConfigMap", "immutable": True,
            "metadata": {"name": "invalid-policy", "namespace": NAMESPACE}, "data": {"policy.json": '{"version":0}'}})
        for mode, expected in (("missing", b"admission_bootstrap_policy_required"), ("invalid", b"invalid_admission_bootstrap_policy")):
            name = "candidate-migration-policy-" + mode
            self.install(migration_pod(name, CANDIDATE, url, "restored-state", policy_failure=mode))
            try:
                self.wait(name, completed=True)
                raise RuntimeError("candidate_migration_accepted_bad_policy:" + mode)
            except RuntimeError as error:
                if str(error) != "fixture_pod_failed:" + name: raise
            failed = self.object("pod", name)
            status = failed["status"]["containerStatuses"][0]["state"]["terminated"]
            log = self.kube("-n", NAMESPACE, "logs", name).stdout
            if status.get("exitCode") != 1 or expected not in log or b"fixture_manual_policy_verified" in log or b"fixture_manual_migration_complete" in log:
                raise RuntimeError("unexpected_candidate_migration_policy_failure:" + mode)
            if self.sql("restored", MIGRATION_LEDGER_SQL) != before or self.sql("restored", "SELECT to_regclass('public.execution_admission_scheduler');") != b"":
                raise RuntimeError("candidate_policy_failure_mutated_migration_state:" + mode)
            self.save(name + "-negative.json", {"status": "PASS", "exactPolicyError": expected.decode(),
                "migrationLedgerUnchanged": True, "admissionSchemaAbsent": True, "productionAcceptance": False})
            self.stop(name)
        self.steps.append("candidate-migration-missing-invalid-policy-before-migration")

    def tools(self, name, script, *, state=None, source=False):
        # No shell interpolation of source/credentials/user-controlled paths.
        return self.once(pod(name, POSTGRES_ALIAS, ["bash", "-e", "-u", "-o", "pipefail", "-c", script], state=state, checkpoints=True, source=source))

    def execute(self, candidate):
        self.install({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": NAMESPACE,
            "labels": {"pod-security.kubernetes.io/enforce": "restricted", "pod-security.kubernetes.io/enforce-version": "v1.34"}}})
        self.install(*network_policies())
        self.install({"apiVersion": "v1", "kind": "ConfigMap", "immutable": True, "metadata": {"name": "held-policy", "namespace": NAMESPACE}, "data": {"policy.json": json.dumps(POLICY)}})
        self.install(*(pvc(name) for name in ("database", "source-state", "restored-state", "checkpoint")))
        self.install(pod("database", POSTGRES_ALIAS, [], db=True, label="database"))
        database = self.wait("database")
        ip = database["status"]["podIP"]
        self.wait_database_ready()
        source_url = f"postgresql://fixture:{PASSWORD}@{ip}:5432/source"
        clone_url = f"postgresql://fixture:{PASSWORD}@{ip}:5432/restored"
        node_addresses = json.loads(self.kube("get", "node", NODE, "-o", "json").stdout)["status"]["addresses"]
        node_ips = [item["address"] for item in node_addresses if item["type"] == "InternalIP"]
        if len(node_ips) != 1: raise RuntimeError("exact_fixture_node_ip_required")
        node_ip = node_ips[0]
        api_ip = json.loads(self.kube("-n", "default", "get", "service", "kubernetes", "-o", "json").stdout)["spec"]["clusterIP"]
        # An actually listening canary with an explicit ingress allow is the
        # controlled denied-egress target; closed public ports alone would not
        # prove the fixture's egress policy is enforced.
        canary_js = "const n=require('node:net');n.createServer(s=>s.end()).listen(31415,'0.0.0.0');"
        self.install(pod("egress-canary", OLD_ALIAS, ["node", "-e", canary_js], label="canary"))
        canary = self.wait("egress-canary")
        self.install({"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": {"name": "canary-ingress-positive", "namespace": NAMESPACE},
            "spec": {"podSelector": {"matchLabels": {"app": "canary"}}, "policyTypes": ["Ingress"],
                "ingress": [{"from": [{"podSelector": {"matchLabels": {"app": "controller"}}}], "ports": [{"protocol": "TCP", "port": 31415}]}]}})
        canary_ip = canary["status"]["podIP"]
        self.install({"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": {"name": "temporary-canary-egress-positive", "namespace": NAMESPACE},
            "spec": {"podSelector": {"matchLabels": {"app": "controller"}}, "policyTypes": ["Egress"],
                "egress": [{"to": [{"podSelector": {"matchLabels": {"app": "canary"}}}], "ports": [{"protocol": "TCP", "port": 31415}]}]}})
        positive_js = "const n=require('node:net');const s=n.connect(31415," + json.dumps(canary_ip) + ");s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000);"
        self.once(pod("canary-positive", OLD_ALIAS, ["node", "-e", positive_js]))
        self.kube("-n", NAMESPACE, "delete", "networkpolicy", "temporary-canary-egress-positive")
        targets = [[ip, 5432, True], [ip, 5433, False], [canary["status"]["podIP"], 31415, False], ["1.1.1.1", 443, False],
            ["2606:4700:4700::1111", 443, False], ["169.254.169.254", 80, False], [node_ip, 6443, False], [api_ip, 443, False]]
        packet_js = """const net=await import('node:net');for(const [host,port,allowed]of TARGETS){const ok=await new Promise(resolve=>{const s=net.connect({host,port});const done=x=>{s.destroy();resolve(x)};s.setTimeout(1500);s.once('connect',()=>done(true));s.once('timeout',()=>done(false));s.once('error',()=>done(false));});if(ok!==allowed)throw Error('fixture_packet_policy_failed:'+host+':'+port);}console.log('fixture_packets_pass');""".replace("TARGETS", json.dumps(targets))
        packet = self.once(pod("packet-check", OLD_ALIAS, ["node", "--input-type=module", "-e", packet_js]))
        if b"fixture_packets_pass" not in packet: raise RuntimeError("packet_proof_missing")
        self.save("network-targets.json", targets)
        self.stop("egress-canary")
        self.steps.append("actual-allow-db-deny-public-metadata-api-node-packets")
        self.migrate("old-source-migrate", OLD_ALIAS, source_url, "source-state")
        self.sql("source", SEED_SQL)
        self.tools("source-files", "printf '%s' synthetic-workspace > /paperclip/workspace.bin; printf '%s' synthetic-no-provider-session > /paperclip/session.json; printf '%s' synthetic-no-provider-credential > /paperclip/credential.json", state="source-state")
        self.boot("old-source", OLD_ALIAS, source_url, "source-state")
        self.stop("old-source")
        source_facts = self.sql("source", FACTS_SQL)
        self.save("source-facts.json", source_facts)
        # A single stopped application and no admitted worker make DB/files a
        # coordinated synthetic checkpoint. All backup consumers are trusted
        # fixture tools and neither controller mounts the checkpoint PVC.
        dump = f"PGPASSWORD={PASSWORD} pg_dump --host={ip} --username=fixture --dbname=source --format=custom --no-owner --file=/checkpoint/source.dump; find /source -mindepth 1 -maxdepth 1 -printf '%f\\0' | tar --null -czf /checkpoint/state.tar.gz -C /source -T -; sha256sum /checkpoint/source.dump /checkpoint/state.tar.gz"
        self.save("checkpoint-sha256.txt", self.tools("checkpoint-write", dump, source=True))
        self.sql("source", "CREATE DATABASE restored;")
        restore = f"PGPASSWORD={PASSWORD} pg_restore --host={ip} --username=fixture --dbname=restored --no-owner --exit-on-error /checkpoint/source.dump; tar -xzf /checkpoint/state.tar.gz -C /paperclip"
        self.tools("restore-clone", restore, state="restored-state")
        if self.sql("restored", FACTS_SQL) != source_facts: raise RuntimeError("restored_facts_changed")
        self.candidate_policy_preflight(clone_url)
        # Candidate must refuse stale schema with automatic migrations disabled.
        self.install(pod("new-stale-refusal", candidate, APP_COMMAND, database_url=clone_url, state="restored-state"))
        try:
            self.wait("new-stale-refusal", completed=True)
            raise RuntimeError("candidate_accepted_unmigrated_schema")
        except RuntimeError as error:
            if str(error) != "fixture_pod_failed:new-stale-refusal": raise
        failed = self.object("pod", "new-stale-refusal")
        status = failed["status"]["containerStatuses"][0]["state"]["terminated"]
        log = self.kube("-n", NAMESPACE, "logs", "new-stale-refusal").stdout
        if status.get("exitCode") != 1 or STALE_SCHEMA_ERROR not in log:
            raise RuntimeError("unexpected_stale_schema_failure")
        self.stop("new-stale-refusal")
        self.steps.append("candidate-exact-stale-schema-refusal")
        self.candidate_policy_negative_controls(clone_url)
        self.migrate("new-manual-migrate", candidate, clone_url, "restored-state")
        first_uid = self.boot("new-first", candidate, clone_url, "restored-state")
        scheduler = self.sql("restored", "SELECT draining FROM execution_admission_scheduler;")
        if scheduler != b"t": raise RuntimeError("candidate_bootstrap_not_held")
        first_epoch = self.sql("restored", "SELECT epoch FROM execution_admission_scheduler;")
        self.stop("new-first")
        next_uid = self.boot("new-restart", candidate, clone_url, "restored-state")
        if next_uid == first_uid: raise RuntimeError("restart_did_not_replace_application_pod")
        next_epoch = self.sql("restored", "SELECT epoch FROM execution_admission_scheduler;")
        if next_epoch == first_epoch: raise RuntimeError("restart_did_not_advance_held_epoch")
        if self.sql("restored", FACTS_SQL) != source_facts: raise RuntimeError("candidate_changed_held_facts")
        self.stop("new-restart")
        self.sql("restored", "UPDATE clone_rehearsal_marker SET value='new-image-divergence';")
        self.tools("diverge-files", "printf '%s' synthetic-divergence > /paperclip/credential.json", state="restored-state")
        # Full restore into a fresh DB, never old binary over upgraded schema.
        self.sql("source", "DROP DATABASE restored WITH (FORCE); CREATE DATABASE restored;")
        self.tools("rollback-checkpoint", f"find /paperclip -mindepth 1 -maxdepth 1 -exec rm -rf -- {{}} +; {restore}", state="restored-state")
        if self.sql("restored", "SELECT to_regclass('public.execution_admission_scheduler');") != b"":
            raise RuntimeError("rollback_reused_upgraded_database")
        if self.sql("restored", FACTS_SQL) != source_facts: raise RuntimeError("rollback_did_not_restore_original_facts")
        self.tools("verify-files", "tar -dzf /checkpoint/state.tar.gz -C /paperclip; test \"$(cat /paperclip/credential.json)\" = synthetic-no-provider-credential; test \"$(cat /paperclip/session.json)\" = synthetic-no-provider-session; test \"$(cat /paperclip/workspace.bin)\" = synthetic-workspace", state="restored-state")
        self.boot("old-rollback", OLD_ALIAS, clone_url, "restored-state")
        self.stop("old-rollback")
        if self.sql("source", FACTS_SQL) != source_facts: raise RuntimeError("source_database_was_mutated")
        if self.sql("source", "SELECT to_regclass('public.execution_admission_scheduler');") != b"": raise RuntimeError("source_database_was_upgraded")
        self.tools("source-files-unchanged", "tar -dzf /checkpoint/state.tar.gz -C /source", source=True)
        claims = json.loads(self.kube("-n", NAMESPACE, "get", "pvc", "-o", "json").stdout)
        volumes = json.loads(self.kube("get", "pv", "-o", "json").stdout)
        expected_claims = {"database", "source-state", "restored-state", "checkpoint"}
        if {claim["metadata"]["name"] for claim in claims["items"]} != expected_claims:
            raise RuntimeError("exact_clone_pvc_set_required")
        if len({claim["metadata"]["uid"] for claim in claims["items"]}) != 4 or len({claim["spec"]["volumeName"] for claim in claims["items"]}) != 4:
            raise RuntimeError("clone_storage_alias_or_rebind")
        for claim in claims["items"]:
            matches = [volume for volume in volumes["items"] if volume["metadata"]["name"] == claim["spec"]["volumeName"]]
            if claim["status"]["phase"] != "Bound" or len(matches) != 1 or matches[0]["spec"]["claimRef"]["uid"] != claim["metadata"]["uid"]:
                raise RuntimeError("exact_bound_clone_pvc_required")
        self.save("pvcs.json", claims)
        self.save("pvs.json", volumes)
        self.save("result.json", {"status": "PASS", "productionAcceptance": False, "images": {"old": OLD_IMAGE, "new": candidate, "postgres": POSTGRES_IMAGE}, "imageBindings": list(self.bindings.values()),
            "steps": self.steps, "restartPodUIDs": [first_uid, next_uid], "heldEpochs": [first_epoch.decode(), next_epoch.decode()],
            "scope": "synthetic actual-image/PVC migration restart rollback in disposable kind; no real backup or provider"})
        print((self.evidence / "result.json").read_text(), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", required=True)
    parser.add_argument("--calico-source", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--candidate", default=CANDIDATE)
    args = parser.parse_args()
    if args.candidate not in (CANDIDATE, "paperclip-admission-candidate"):
        raise ValueError("hosted_built_candidate_tag_required")
    evidence = Path(args.evidence).resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    cni = load_cni()
    prepared = cni.prepare(args.calico_source)
    (evidence / "calico-pinned.json").write_bytes(canonical(prepared))
    if not run([args.kind, "version"]).stdout.decode().startswith("kind v0.30.0 "):
        raise ValueError("pinned_kind_version_required")
    existing = run(["docker", "ps", "-a", "--filter", "label=io.x-k8s.kind.cluster", "--format", "{{.Names}}"])
    if existing.stdout.strip(): raise ValueError("no_overlapping_kind_cluster_allowed")
    bindings = []
    # CI authenticates and pulls exact old/PG digests on the trusted host before
    # the expensive build. This harness performs no registry pull or login and
    # never transfers registry credentials/configuration to kind or a Pod.
    for source, alias, digest_required in ((CANDIDATE, CANDIDATE, False), (OLD_IMAGE, OLD_ALIAS, True), (POSTGRES_IMAGE, POSTGRES_ALIAS, True)):
        image = json.loads(run(["docker", "image", "inspect", source]).stdout)[0]
        binding = bind_host_image(source, alias, image, require_digest=digest_required)
        if source != alias:
            run(["docker", "tag", binding["configId"], alias])
            tagged = json.loads(run(["docker", "image", "inspect", alias]).stdout)[0]
            if tagged["Id"] != binding["configId"] or tagged["RootFS"]["Layers"] != binding["rootfsLayers"]:
                raise RuntimeError("disposable_alias_rebound")
        bindings.append(binding)
    (evidence / "image-bindings.json").write_bytes(canonical(bindings))
    (evidence / "candidate-image.json").write_bytes(canonical(bindings[0]))
    config = evidence / "kind.yaml"
    config.write_bytes(canonical(kind_configuration()))
    kubeconfig = evidence / "kubeconfig"
    created = False
    rehearsal = None
    try:
        created = True
        run([args.kind, "create", "cluster", "--name", CLUSTER, "--image", cni.KIND_IMAGE, "--config", config, "--kubeconfig", kubeconfig, "--wait", "0s"], timeout=180)
        run(["docker", "update", "--memory", "3g", "--memory-swap", "5g", "--cpus", "2", "--pids-limit", "1024", NODE])
        rehearsal = Rehearsal(kubeconfig, evidence, bindings)
        rehearsal.kube("create", "-f", evidence / "calico-pinned.json")
        rehearsal.kube("-n", "kube-system", "rollout", "status", "daemonset/calico-node", "--timeout=180s", timeout=200)
        rehearsal.kube("-n", "kube-system", "rollout", "status", "deployment/calico-kube-controllers", "--timeout=120s", timeout=140)
        rehearsal.kube("wait", "--for=condition=Ready", "node", "--all", "--timeout=60s", timeout=70)
        version = json.loads(rehearsal.kube("version", "-o", "json").stdout)
        if version["serverVersion"]["gitVersion"] != "v1.34.0": raise RuntimeError("exact_kubernetes_version_required")
        rehearsal.save("kubernetes-version.json", version)
        effective = json.loads(rehearsal.kube("get", "--raw", "/api/v1/nodes/" + NODE + "/proxy/configz").stdout)
        if effective.get("kubeletconfig", {}).get("podPidsLimit") != 256:
            raise RuntimeError("effective_kubelet_pid_limit_required")
        rehearsal.save("kubelet-effective-config.json", effective)
        rehearsal.save("fixture-policy.json", POLICY)
        rehearsal.save("network-policies.json", network_policies())
        host_cleanup = []
        for binding in bindings:
            imported = import_bound_image(args.kind, binding, rehearsal)
            host_cleanup.append(remove_imported_host_image(binding, imported))
            rehearsal.save("host-image-cleanup.json", host_cleanup)
            print("verified import retained in kind; removed exact host references: " + binding["localAlias"], flush=True)
        rehearsal.execute(CANDIDATE)
    except BaseException:
        if rehearsal:
            try: rehearsal.collect_failure_diagnostics()
            except Exception: pass
            for file, argv in (("failure-pods.json", ("get", "pods", "-A", "-o", "json")), ("failure-events.json", ("get", "events", "-A", "-o", "json"))):
                try: rehearsal.save(file, rehearsal.kube(*argv, check=False).stdout)
                except Exception: pass
        raise
    finally:
        if created:
            run([args.kind, "delete", "cluster", "--name", CLUSTER, "--kubeconfig", kubeconfig], timeout=100)
            remaining = run(["docker", "ps", "-a", "--filter", "label=io.x-k8s.kind.cluster=" + CLUSTER, "--format", "{{.Names}}"])
            if remaining.stdout.strip(): raise RuntimeError("clone_fixture_node_leaked")
            (evidence / "cleanup.json").write_bytes(canonical({"status": "PASS", "cluster": CLUSTER, "remainingNodes": []}))


if __name__ == "__main__": main()
