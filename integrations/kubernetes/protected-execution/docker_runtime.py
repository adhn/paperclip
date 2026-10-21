"""Disposable-only fixed Docker runtime broker; never ship/mount in homelab.

Docker daemon access is broad host authority. Only the fixture harness has it;
neither supervisor nor provider container gets a daemon socket or credentials.
Kubernetes needs its separately reviewed narrow adapter/admission enforcement.
"""
import hashlib
import json
import re
import subprocess
import uuid
from authority import Held, canonical, digest


class DockerRuntime:
    def __init__(self, policy, prefix):
        self.policy, self.prefix = policy, prefix
        self.pool = policy["pool"]
        self.daemon = self.command("info", "--format", "{{.ID}}")
        self.resources = set()
        self.volumes = set()

    def attest(self):
        return {"authority": self.command("info", "--format", "{{.ID}}"), "configuration": digest(self.policy),
                "objects": self.command("ps", "-aq", "--filter", "label=paperclip.fixture=" + self.prefix).splitlines()}

    @staticmethod
    def command(*args):
        result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=20)
        if result.returncode:
            raise Held("fixture_runtime_unavailable")
        return result.stdout.strip()

    def launch(self, contract, template):
        if self.policy["templates"].get(contract["template"]) != template or contract["policy"] != digest(self.policy):
            raise Held("runtime_template_mismatch")
        if self.command("info", "--format", "{{.ID}}") != self.policy["runtimeAuthority"]:
            raise Held("runtime_authority_changed")
        image = template["image"]
        if not re.fullmatch("sha256:[0-9a-f]{64}", image):
            raise Held("fixture_image_must_be_content_addressed")
        name = self.prefix + "-" + hashlib.sha256(contract["invocation"].encode()).hexdigest()[:24]
        volume = name + "-state"
        # No caller-supplied path/mount/name/UID/host setting. Failed or unknown
        # calls retain resources; only final fixture cleanup may delete them.
        self.command("volume", "create", "--label", "paperclip.fixture=" + self.prefix, volume)
        self.volumes.add(volume)
        self.resources.add(name)
        physical_id = self.command("create", "--name", name, "--label", "paperclip.fixture=" + self.prefix,
            "--label", "paperclip.owner=" + digest(contract["owner"]), "--label", "paperclip.storage=" + contract["storage"],
            "--network", "none", "--user", "1000:1000", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m", "--cpus", "0.5",
            "--restart", "no", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m,uid=1000,gid=1000",
            "--mount", f"type=volume,src={volume},dst=/attempt", "--entrypoint", template["entrypoint"],
            image, *contract["argv"])
        self.command("start", physical_id)
        data = json.loads(self.command("inspect", physical_id))[0]
        return {"pool": self.pool, "uid": physical_id, "container": physical_id,
                "node": self.daemon, "storage": contract["storage"]}

    def inspect(self, physical):
        if physical["pool"] != self.pool or self.command("info", "--format", "{{.ID}}") != physical["node"]:
            raise Held("fixture_runtime_incarnation_mismatch")
        data = json.loads(self.command("inspect", physical["uid"]))[0]
        if (data["Id"] != physical["container"] or data["Config"]["Labels"].get("paperclip.fixture") != self.prefix or
                data["Config"]["Labels"].get("paperclip.storage") != physical["storage"]):
            raise Held("fixture_physical_identity_mismatch")
        state = data["State"]
        stopped = (state["Status"] == "exited" and state["Running"] is False and state["Pid"] == 0 and
                   not state["Restarting"] and not state["Dead"] and state["FinishedAt"] != "0001-01-01T00:00:00Z")
        # Runtime-engine observation, not process stdout/listing. Missing/removed
        # container or unreachable daemon throws and becomes uncertain upstream.
        return {"physical": physical, "status": "confirmed_stopped" if stopped else "running" if state["Running"] else "uncertain",
                "evidence": {"kind": "disposable-docker-inspect-v1", "state": state, "daemon": self.daemon}}

    def stop_and_inspect(self, physical):
        self.inspect(physical)  # bind before mutation; never stop by name alone
        self.command("stop", "--time", "1", physical["container"])
        return self.inspect(physical)

    def cleanup(self):
        for name in self.resources:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=20)
        for name in self.volumes:
            subprocess.run(["docker", "volume", "rm", name], capture_output=True, timeout=20)
