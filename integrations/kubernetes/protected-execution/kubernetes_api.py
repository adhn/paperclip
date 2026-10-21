"""Explicit narrow Kubernetes HTTPS transport candidate; no ambient discovery.

This is transport, not admission, namespace-incarnation attestation, a runtime
witness, stable retirement, storage exclusion or a deployment installer. The
independent guard and all retirement/storage gates remain mandatory. Only the
current protected single-container Pod schema is accepted; schema drift holds.
"""
import http.client
import ipaddress
import json
from pathlib import Path
import re
import ssl
import socket
import threading
import time
import urllib.parse

from authority import Held, canonical

MAX_BYTES = 1_048_576
METADATA = set("name namespace uid resourceVersion generation creationTimestamp deletionTimestamp deletionGracePeriodSeconds labels annotations finalizers managedFields ownerReferences selfLink".split())
POD_SPEC = set("containers volumes restartPolicy terminationGracePeriodSeconds activeDeadlineSeconds serviceAccountName automountServiceAccountToken securityContext enableServiceLinks dnsPolicy schedulerName preemptionPolicy serviceAccount priority tolerations nodeName".split())
POD_STATUS = set("phase conditions reason message hostIP hostIPs podIP podIPs startTime containerStatuses initContainerStatuses ephemeralContainerStatuses qosClass nominatedNodeName resize resourceClaimStatuses observedGeneration".split())
CONTAINER = set("name image imagePullPolicy command args resources securityContext volumeMounts terminationMessagePath terminationMessagePolicy".split())
CONTAINER_STATUS = set("name state lastState ready restartCount image imageID containerID started allocatedResources resources volumeMounts user allocatedResourcesStatus stopSignal".split())
PVC_SPEC = set("accessModes selector resources volumeName storageClassName volumeMode dataSource dataSourceRef volumeAttributesClassName".split())
PVC_STATUS = set("phase accessModes capacity conditions allocatedResources allocatedResourceStatuses currentVolumeAttributesClassName modifyVolumeStatus resizeStatus".split())


def _object(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise Held("kubernetes_unknown_schema")
    return value


def _name(value, namespace=False):
    if not isinstance(value, str) or not value or len(value) > (63 if namespace else 253):
        raise Held("kubernetes_invalid_name")
    labels = value.split(".")
    if (namespace and len(labels) != 1) or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels):
        raise Held("kubernetes_invalid_name")
    return value


def _identity(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", value):
        raise Held("kubernetes_invalid_identity")
    return value


def _tree(value, depth=0):
    if depth > 32:
        raise Held("kubernetes_body_too_deep")
    if isinstance(value, dict):
        if any(not isinstance(key, str) or len(key) > 1024 for key in value):
            raise Held("kubernetes_unknown_schema")
        for child in value.values(): _tree(child, depth + 1)
    elif isinstance(value, list):
        if len(value) > 4096: raise Held("kubernetes_unknown_schema")
        for child in value: _tree(child, depth + 1)
    elif isinstance(value, str):
        if len(value) > 131072 or "\0" in value: raise Held("kubernetes_unknown_schema")
    elif value is None or isinstance(value, bool):
        pass
    elif type(value) is int and abs(value) <= 9_007_199_254_740_991:
        pass
    else:
        raise Held("kubernetes_unknown_schema")


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result: raise Held("kubernetes_duplicate_json_key")
        result[key] = value
    return result


class _DeadlineConnection(http.client.HTTPSConnection):
    """Literal-IP connection: one deadline covers connect/TLS/headers/body."""
    def __init__(self, host, port, context, timeout):
        super().__init__(host, port, context=context, timeout=timeout)
        self.deadline = time.monotonic() + timeout
        self.expired = threading.Event()
        self.live_socket = None

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if self.expired.is_set() or remaining <= 0:
            raise Held("kubernetes_api_deadline")
        return remaining

    def abort(self):
        self.expired.set()
        live = self.live_socket
        if live is not None:
            try: live.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            try: live.close()
            except OSError: pass

    def connect(self):
        self.remaining()
        address = ipaddress.ip_address(self.host)
        raw = socket.socket(socket.AF_INET6 if address.version == 6 else socket.AF_INET, socket.SOCK_STREAM)
        self.live_socket = raw  # registered BEFORE connect/handshake
        raw.settimeout(self.remaining())
        raw.connect((self.host, self.port))  # literal IP; no resolver or proxy
        raw.settimeout(self.remaining())
        secured = self._context.wrap_socket(raw, server_hostname=self.host, do_handshake_on_connect=False)
        self.sock = self.live_socket = secured
        secured.settimeout(self.remaining())
        secured.do_handshake()
        self.remaining()

    def send(self, data):
        self.remaining()
        if self.sock is not None: self.sock.settimeout(self.remaining())
        return super().send(data)


class KubernetesAPI:
    """Fixed core/v1 namespaced Pod CRUD + one exact PVC GET, no retries.

    Initial origin must be a literal IPv4/IPv6 address covered by the supplied
    CA/server certificate. Hostname resolution is deliberately unsupported.
    Supplied bearer credentials must separately have narrow Kubernetes RBAC.
    Holding a token does not attest its rights or the independent guard. The
    namespace's current UID must be established outside this client; it has no
    namespace/nodes/secrets/raw/exec/attach API. Its memory of Pod UIDs and create
    attempts is defensive only, never the durable native launch/retirement fence.
    """
    def __init__(self, origin, ca_file, bearer_token, namespace, pvc_name, pvc_uid, timeout=3, max_bytes=MAX_BYTES):
        try:
            parsed = urllib.parse.urlsplit(origin)
            if (not isinstance(origin, str) or parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.isascii()
                    or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment or parsed.path not in ("", "/")
                    or any(char.isspace() for char in origin) or any(char in origin for char in "@?#%\\") or parsed.port == 0):
                raise ValueError()
            # Initial transport deliberately accepts literal IPs only. No ambient
            # DNS resolver can outlive the operation's explicit deadline.
            address = ipaddress.ip_address(parsed.hostname)
            if not isinstance(bearer_token, str) or len(bearer_token) > 16384 or not re.fullmatch(r"[A-Za-z0-9._~+/-]{1,16384}=*", bearer_token):
                raise ValueError()
            if type(timeout) not in (int, float) or not .1 <= timeout <= 10 or type(max_bytes) is not int or not 1024 <= max_bytes <= MAX_BYTES:
                raise ValueError()
            ca_path = Path(ca_file)
            if not ca_path.is_absolute(): raise ValueError()
            with ca_path.open("rb") as source: ca = source.read(65537)
            if not ca or len(ca) > 65536: raise ValueError()
            context = ssl.create_default_context(cadata=ca.decode("ascii"))
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            self._context = context
            self._host, self._port = str(address), parsed.port or 443
            self._namespace = _name(namespace, namespace=True)
            self._pvc_name, self._pvc_uid = _name(pvc_name), _identity(pvc_uid)
            self._token, self._timeout, self._max_bytes = bearer_token, timeout, max_bytes
            self._pods, self._submitted = {}, set()
        except Exception:
            raise Held("explicit_kubernetes_https_configuration_required") from None

    def _path(self, resource, name=None):
        path = "/api/v1/namespaces/" + urllib.parse.quote(self._namespace, safe="") + "/" + resource
        return path + ("/" + urllib.parse.quote(_name(name), safe="") if name is not None else "")

    def _request(self, method, path, body=None, statuses=(200,)):
        data = None if body is None else canonical(body)
        if data is not None and len(data) > self._max_bytes: raise Held("kubernetes_request_too_large")
        connection = _DeadlineConnection(self._host, self._port, self._context, self._timeout)
        timer = threading.Timer(self._timeout, connection.abort)
        timer.daemon = True
        response = None
        timer.start()
        try:
            connection.request(method, path, body=data, headers={"Authorization": "Bearer " + self._token,
                "Accept": "application/json", "Content-Type": "application/json", "Connection": "close"})
            response = connection.getresponse()
            connection.remaining()
            # http.client bounds headers to 100 lines of <=65536 bytes; do not
            # alter its global limits. Refuse >64KiB aggregate after parsing.
            if sum(len(key) + len(value) for key, value in response.headers.raw_items()) > 65536:
                raise Held("kubernetes_headers_too_large")
            if response.status not in statuses:
                # Only the numeric HTTP status is safe diagnostic data. Never
                # expose server reason text, headers or response/request bodies.
                raise Held("kubernetes_api_refused_http_" + str(response.status))  # redirects never followed
            if response.headers.get_content_type() != "application/json" or response.headers.get("Content-Encoding", "identity") != "identity":
                raise Held("kubernetes_response_refused")
            length = response.headers.get("Content-Length")
            transfer = response.headers.get("Transfer-Encoding")
            if transfer not in (None, "chunked") or (transfer is not None and length is not None):
                raise Held("kubernetes_response_refused")
            if length is not None and (not length.isascii() or not length.isdecimal() or int(length) > self._max_bytes):
                raise Held("kubernetes_response_too_large")
            data = response.read(self._max_bytes + 1)
            connection.remaining()
            if len(data) > self._max_bytes: raise Held("kubernetes_response_too_large")
            if length is not None and len(data) != int(length): raise Held("kubernetes_response_truncated")
            result = json.loads(data.decode("utf8"), object_pairs_hook=_pairs,
                parse_constant=lambda _: (_ for _ in ()).throw(Held("kubernetes_unknown_schema")))
            _tree(result)
            return result
        except Held:
            raise
        except Exception:
            # Never include token, request/response body, header or transport
            # exception. An uncertain write remains spent in this client.
            raise Held("kubernetes_api_uncertain") from None
        finally:
            timer.cancel()
            connection.abort()  # closes saved socket even if response owns it
            if response is not None: response.close()
            connection.close()
            timer.join(timeout=.1)

    def _metadata(self, value, *, name=None):
        value = _object(value, METADATA, ("name", "namespace", "uid", "resourceVersion"))
        if value["namespace"] != self._namespace or (name is not None and value["name"] != name):
            raise Held("kubernetes_response_target_changed")
        _name(value["name"]); _identity(value["uid"]); _identity(value["resourceVersion"])
        for key in ("labels", "annotations"):
            if key in value and (not isinstance(value[key], dict) or any(not isinstance(v, str) for v in value[key].values())):
                raise Held("kubernetes_unknown_schema")
        if "finalizers" in value and (not isinstance(value["finalizers"], list) or any(not isinstance(v, str) for v in value["finalizers"])):
            raise Held("kubernetes_unknown_schema")
        return value

    def _spec(self, spec):
        spec = _object(spec, POD_SPEC, ("containers",))
        if not isinstance(spec["containers"], list) or len(spec["containers"]) != 1: raise Held("kubernetes_unknown_schema")
        container = _object(spec["containers"][0], CONTAINER, ("name", "image"))
        if not isinstance(container["name"], str) or not isinstance(container["image"], str) or not container["image"]:
            raise Held("kubernetes_unknown_schema")
        if "volumes" in spec and (not isinstance(spec["volumes"], list) or len(spec["volumes"]) > 8): raise Held("kubernetes_unknown_schema")
        if "volumeMounts" in container and (not isinstance(container["volumeMounts"], list) or len(container["volumeMounts"]) > 8): raise Held("kubernetes_unknown_schema")
        for volume in spec.get("volumes", []):
            _object(volume, ("name", "persistentVolumeClaim", "emptyDir"), ("name",))
            if ("persistentVolumeClaim" in volume) == ("emptyDir" in volume): raise Held("kubernetes_unknown_schema")
            if "persistentVolumeClaim" in volume:
                source = _object(volume["persistentVolumeClaim"], ("claimName", "readOnly"), ("claimName",))
                if source["claimName"] != self._pvc_name: raise Held("kubernetes_fixed_pvc_required")
            else:
                _object(volume["emptyDir"], ("medium", "sizeLimit"))
        for mount in container.get("volumeMounts", []):
            _object(mount, ("name", "mountPath", "readOnly"), ("name", "mountPath"))
        if "securityContext" in container:
            _object(container["securityContext"], ("runAsNonRoot", "runAsUser", "runAsGroup", "allowPrivilegeEscalation", "readOnlyRootFilesystem", "capabilities", "seccompProfile"))
        if "securityContext" in spec:
            _object(spec["securityContext"], ("runAsNonRoot", "runAsUser", "runAsGroup", "fsGroup", "seccompProfile"))
        return spec

    def _pod(self, value, *, name=None, list_item=False):
        _object(value, ("apiVersion", "kind", "metadata", "spec", "status"), ("metadata", "spec"))
        # A validated v1 PodList supplies its items' type context. Kubernetes
        # omits both TypeMeta fields there; partial or conflicting types still
        # fail closed, as do missing types on standalone Pod responses.
        if not (list_item and "apiVersion" not in value and "kind" not in value):
            if value.get("apiVersion") != "v1" or value.get("kind") != "Pod":
                raise Held("kubernetes_unknown_schema")
        self._metadata(value["metadata"], name=name)
        self._spec(value["spec"])
        if "status" in value:
            status = _object(value["status"], POD_STATUS)
            for key in ("containerStatuses", "initContainerStatuses", "ephemeralContainerStatuses"):
                if key in status:
                    if not isinstance(status[key], list) or len(status[key]) > 1: raise Held("kubernetes_unknown_schema")
                    for item in status[key]: _object(item, CONTAINER_STATUS, ("name",))
        return value

    def _remember(self, pods):
        names, uids = set(), set()
        for pod in pods:
            meta = pod["metadata"]
            if meta["name"] in names or meta["uid"] in uids or self._pods.get(meta["name"], meta["uid"]) != meta["uid"]:
                raise Held("kubernetes_pod_incarnation_changed")
            names.add(meta["name"]); uids.add(meta["uid"])
        self._pods.update({pod["metadata"]["name"]: pod["metadata"]["uid"] for pod in pods})

    def get_storage(self, name):
        if name != self._pvc_name: raise Held("kubernetes_fixed_pvc_required")
        result = self._request("GET", self._path("persistentvolumeclaims", name))
        _object(result, ("apiVersion", "kind", "metadata", "spec", "status"), ("apiVersion", "kind", "metadata", "spec"))
        if result["apiVersion"] != "v1" or result["kind"] != "PersistentVolumeClaim": raise Held("kubernetes_unknown_schema")
        if self._metadata(result["metadata"], name=name)["uid"] != self._pvc_uid: raise Held("storage_incarnation_changed")
        _object(result["spec"], PVC_SPEC)
        if "status" in result: _object(result["status"], PVC_STATUS)
        return result

    def get_pod(self, name):
        result = self._pod(self._request("GET", self._path("pods", _name(name))), name=name)
        self._remember([result])
        return result

    def list_pods(self):
        result = self._request("GET", self._path("pods") + "?limit=128")
        _object(result, ("apiVersion", "kind", "metadata", "items"), ("apiVersion", "kind", "metadata", "items"))
        if result["apiVersion"] != "v1" or result["kind"] != "PodList": raise Held("kubernetes_unknown_schema")
        metadata = _object(result["metadata"], ("resourceVersion", "continue", "remainingItemCount", "selfLink"), ("resourceVersion",))
        _identity(metadata["resourceVersion"])
        if metadata.get("continue") or metadata.get("remainingItemCount", 0): raise Held("kubernetes_list_incomplete")
        if not isinstance(result["items"], list) or len(result["items"]) > 128: raise Held("kubernetes_list_incomplete")
        pods = [self._pod(pod, list_item=True) for pod in result["items"]]
        self._remember(pods)
        return pods

    def create_pod(self, manifest):
        # Snapshot before validation/network; the caller cannot mutate a queued
        # manifest into a different namespace, name or metadata operation.
        try:
            data = canonical(manifest)
            if len(data) > self._max_bytes: raise Held("kubernetes_request_too_large")
            manifest = json.loads(data, object_pairs_hook=_pairs)
            _tree(manifest)
            _object(manifest, ("apiVersion", "kind", "metadata", "spec"), ("apiVersion", "kind", "metadata", "spec"))
            metadata = _object(manifest["metadata"], ("name", "namespace", "labels", "annotations", "finalizers"), ("name", "namespace"))
            name = _name(metadata["name"])
            if manifest["apiVersion"] != "v1" or manifest["kind"] != "Pod" or metadata["namespace"] != self._namespace:
                raise Held("kubernetes_request_target_changed")
            # Full template/policy validation remains the independent guard's job.
            self._spec(manifest["spec"])
            if name in self._submitted or name in self._pods: raise Held("kubernetes_create_already_attempted")
            self._submitted.add(name)  # no retry after timeout/refusal/invalid reply
            result = self._pod(self._request("POST", self._path("pods"), manifest, (201,)), name=name)
            self._remember([result])
            return result
        except Held:
            raise
        except Exception:
            raise Held("kubernetes_invalid_manifest") from None

    def delete_pod(self, name, options):
        name = _name(name)
        try: options = json.loads(canonical(options), object_pairs_hook=_pairs)
        except Exception: raise Held("kubernetes_exact_graceful_delete_required") from None
        _tree(options)
        _object(options, ("apiVersion", "kind", "gracePeriodSeconds", "preconditions"), ("apiVersion", "kind", "gracePeriodSeconds", "preconditions"))
        preconditions = _object(options["preconditions"], ("uid", "resourceVersion"), ("uid", "resourceVersion"))
        if (options["apiVersion"] != "v1" or options["kind"] != "DeleteOptions" or type(options["gracePeriodSeconds"]) is not int
                or not 1 <= options["gracePeriodSeconds"] <= 5 or self._pods.get(name) != _identity(preconditions["uid"])):
            raise Held("kubernetes_exact_graceful_delete_required")
        _identity(preconditions["resourceVersion"])
        result = self._request("DELETE", self._path("pods", name), options, (200, 202))
        if isinstance(result, dict) and result.get("kind") == "Pod":
            self._pod(result, name=name)
            if result["metadata"]["uid"] != preconditions["uid"]: raise Held("kubernetes_pod_incarnation_changed")
        else:
            _object(result, ("apiVersion", "kind", "status", "message", "reason", "details", "code", "metadata"), ("apiVersion", "kind", "status", "details"))
            details = _object(result["details"], ("name", "group", "kind", "uid", "causes", "retryAfterSeconds"), ("name", "uid"))
            if (result["apiVersion"] != "v1" or result["kind"] != "Status" or result["status"] != "Success"
                    or details["name"] != name or details["uid"] != preconditions["uid"]):
                raise Held("kubernetes_delete_unconfirmed")
        # A response means only API deletion accepted. Never stop proof or release.
        return result
