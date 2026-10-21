"""Small actual PostgreSQL-18 socket regression; trusted disposable Docker host.

No builds, pulls, provider credentials, host mounts, volumes or network. Both
non-root containers use the same exact image/limits and tmpfs-only writable data.
"""
import argparse
import json
from pathlib import Path
import subprocess
import time
import uuid
from image_pvc_clone import POSTGRES_IMAGE


def command(argv, *, check=True):
    value = subprocess.run(argv, capture_output=True, timeout=30)
    if check and value.returncode:
        raise RuntimeError("disposable_pg_command_failed:" + value.stderr.decode()[-1500:])
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()
    evidence = Path(args.evidence).resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    command(["docker", "image", "inspect", POSTGRES_IMAGE])
    created, results = [], {}
    prefix = "pc-pg-socket-" + uuid.uuid4().hex[:12]
    try:
        for scenario in ("bad", "fixed"):
            name = prefix + "-" + scenario
            created.append(name)
            argv = ["docker", "run", "-d", "--name", name, "--network", "none", "--user", "999:999",
                "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "256m",
                "--memory-swap", "512m", "--cpus", "2", "--pids-limit", "64",
                "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=32m",
                "--tmpfs", "/var/lib/postgresql:rw,nosuid,nodev,uid=999,gid=999,mode=0770,size=192m",
                "-e", "POSTGRES_USER=fixture", "-e", "POSTGRES_DB=source", "-e", "POSTGRES_PASSWORD=synthetic-only-no-provider",
                "-e", "PGDATA=/var/lib/postgresql/18/clone-fixture"]
            if scenario == "fixed":
                argv += ["--tmpfs", "/var/run/postgresql:rw,nosuid,nodev,uid=999,gid=999,mode=2775,size=4m"]
            argv += [POSTGRES_IMAGE, "postgres", "-c", "shared_buffers=16MB"]
            if scenario == "bad": argv += ["-c", "unix_socket_directories=/tmp"]
            command(argv)
            deadline, ready = time.monotonic() + 30, False
            while time.monotonic() < deadline:
                state = json.loads(command(["docker", "inspect", name, "--format", "{{json .State}}"] ).stdout)
                if not state["Running"]: break
                if command(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "fixture", "-d", "source"], check=False).returncode == 0:
                    ready = True; break
                time.sleep(.25)
            logs = command(["docker", "logs", name], check=False)
            output = logs.stdout + logs.stderr
            (evidence / (scenario + ".log")).write_bytes(output)
            metadata = json.loads(command(["docker", "inspect", name]).stdout)[0]
            (evidence / (scenario + "-inspect.json")).write_text(json.dumps(metadata, indent=2))
            if metadata["State"].get("OOMKilled"):
                raise RuntimeError("pg_fixture_oom_is_not_socket_evidence")
            if scenario == "bad":
                if ready or metadata["State"]["Running"] or metadata["State"]["ExitCode"] != 2 or b'listening on Unix socket "/tmp/.s.PGSQL.5432"' not in output or b'/var/run/postgresql/.s.PGSQL.5432' not in output:
                    raise RuntimeError("old_socket_failure_not_reproduced")
                results[scenario] = {"exitCode": metadata["State"]["ExitCode"], "ready": False,
                    "cause": "temporary server socket /tmp differs from docker_process_sql default /var/run/postgresql"}
            else:
                if not ready: raise RuntimeError("fixed_pg_not_ready")
                query = command(["docker", "exec", "-e", "PGPASSWORD=synthetic-only-no-provider", name, "psql", "-h", "127.0.0.1",
                    "-U", "fixture", "-d", "source", "-At", "-v", "ON_ERROR_STOP=1", "-c", "SELECT current_user, current_database();"]).stdout.strip()
                if query != b"fixture|source": raise RuntimeError("fixed_pg_sql_identity_wrong")
                if not metadata["HostConfig"]["ReadonlyRootfs"] or metadata["Config"]["User"] != "999:999" or any(mount["Type"] != "tmpfs" for mount in metadata["Mounts"]):
                    raise RuntimeError("fixed_pg_containment_drift")
                results[scenario] = {"ready": True, "query": query.decode(), "uid": 999, "readOnlyRoot": True, "writableMounts": "tmpfs only"}
            command(["docker", "rm", "-f", name])
            created.remove(name)
        (evidence / "result.json").write_text(json.dumps({"status": "PASS", "image": POSTGRES_IMAGE,
            "scope": "actual PostgreSQL socket reproduction only; not image/PVC acceptance", "scenarios": results}, indent=2))
        print((evidence / "result.json").read_text())
    finally:
        for name in created:
            command(["docker", "rm", "-f", name], check=False)
        leftovers = command(["docker", "ps", "-a", "--filter", "name=" + prefix, "--format", "{{.Names}}"] ).stdout.strip()
        if leftovers: raise RuntimeError("pg_socket_fixture_container_leaked")
        (evidence / "cleanup.json").write_text(json.dumps({"status": "PASS", "prefix": prefix, "remainingContainers": []}))


if __name__ == "__main__": main()
