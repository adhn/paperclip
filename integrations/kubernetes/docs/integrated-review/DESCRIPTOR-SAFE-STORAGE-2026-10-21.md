# Descriptor-safe owner composition — isolated candidate

This implements a real descriptor-closing exec boundary and detached whole-group
publication in a disposable kernel fixture. It is not an installed production
owner or evidence issuer. The root coordinator executes the container; storage
agent ran six pure guard tests (initial five PASS in 0.018 seconds), without fork/exec/container.
Actual kernel results belong to the root integration log and checkpoint.

## Mechanism and regression

`protected-execution/descriptor_safe_storage_fixture.py` requires explicit opt-in,
root, empty exact separate tmpfs `/canonical` and `/attempts` mountpoints, and no
symlink mountpoints. Only disposable synthetic files are written. The setup parent
has CHOWN/SETUID/SETGID; no DAC_OVERRIDE, FOWNER, SYS_ADMIN or privileged mode.
Canonical directory is UID2000/mode0700; independent attempt files belong to
UID1000 and are readable by the owner. Every child closes all inherited descriptors
except a newly mapped output-only report pipe at FD3, clears supplementary groups,
and drops GID and UID. Standard descriptors are replaced by `/dev/null`.

Descriptor removal enumerates `/proc/self/fd`; missing proc fails closed. It does
not trust a caller-provided list, CLOEXEC alone, or UID mode checks. Setup deliberately
opens a writable canonical file, makes both its ordinary descriptor and FD200
inheritable, then lowers the soft FD limit to128 while FD200 remains open above it, and retains them while launching the provider. The child replaces
its Python process using `execve` with `-I -B`, a fixed test payload and empty
environment. The provider inspects inherited descriptors before opening attempts,
requires no canonical descriptor, explicitly requires EBADF when writing the adversarial FD200, requires EACCES at canonical paths, also requires EACCES/EPERM when attempting to reopen the trusted parent's FD200 through proc, then modifies
all three detached attempt roots. The UID2000 owner independently verifies the
published hashes and the untouched canonical danger file afterward. This directly
regresses the prior actual inherited-canonical-FD bypass; the prior unsafe fixture
remains unchanged as attack characterization.

The owner copies `workspace`, `session`, `config` bytes into new canonical files,
fsyncs content and version directory, then atomically renames and fsyncs one HEAD
binding all roots to one generation and version. Provider changes after publication
cannot mutate those detached inodes. This is a single initial publication under
one local filesystem owner; it does not implement multi-owner transactions,
concurrent publication CAS or cross-PVC common linearization. Prior detached-group
prototype tests cover local predecessor CAS/crash control flow separately.

## Root-only execution

From the evaluation package, use the already cached exact image below; never pull:

```sh
docker run --rm -i --pull=never --network=none --read-only \
  --memory=256m --memory-swap=512m --cpus=1 --pids-limit=64 \
  --cap-drop=ALL --cap-add=SETUID --cap-add=SETGID --cap-add=CHOWN \
  --security-opt=no-new-privileges --user=0:0 \
  --tmpfs /canonical:rw,nosuid,nodev,noexec,size=16m,mode=0700 \
  --tmpfs /attempts:rw,nosuid,nodev,noexec,size=16m,mode=0700 \
  --env PAPERCLIP_DISPOSABLE_FIXTURE=1 \
  sha256:1eee6fcc4d866c86dd8e32a4a1a583767ddac0d640b0fe571b2c22d233b60eee \
  python3 -B - < protected-execution/descriptor_safe_storage_fixture.py
```

No host source/socket/volume mounts, ports, network or provider calls. Root serializes
with other fixtures under aggregate 3GiB RAM/5GiB swap-inclusive/2CPU/256PID.
Each child has a ten-second alarm and bounded report bytes. Failure/nonzero child
exit refuses success. Root should record exact command, output, image, cleanup,
OOM status and hashes. Pure guards exercise missing opt-in/nonroot refusal, closing
an unknown high descriptor while retaining report pipe, missing-proc refusal and
import/payload syntax safety and the report-already-at-FD3 branch. Those mocks are not kernel isolation evidence.

## Production boundary and reviewed transition

The setup parent deliberately retains writable canonical descriptors to construct
the attack. It is trusted test scaffolding and is not a production launcher.
Production requires a separately installed sole owner with canonical mounts and a
launcher/provider process tree that never possesses canonical descriptors, mounts,
aliases or credentials. Here owner children perform bounded operations inside one
container; no persistent authenticated owner API or mandatory native/all-command
routing is installed. Same-container UIDs do not prove Kubernetes mount isolation,
runtime containment, proc policy or escape resistance.

Closing a new child cannot revoke another live legacy process's open descriptor.
Detaching copies cannot retire existing original canonical writers or external
credential/session grants. Before any real sole-owner transition, review the full
shared-family root/alias/writer inventory, independently retire/fence every old
mount/descriptor/controller copy-back route and verify exact original identities.
No transition or retirement receipt is emitted by this fixture. Mutable attempt
capture still needs independent quiescence or a coherent immutable snapshot; this
fixture copies prepared idle synthetic roots before mutation. Real metadata,
symlinks, executable modes, ACL/xattrs and Git semantics require reviewed transfer
handling. Remote durability, current independent high-water/history, restore
rollback defense and authority/effect common decision remain open.

All synthetic output keeps `operational_acceptance`, `legacy_writer_retirement_proven`,
`production_mount_isolation_proven`, and `cross_authority_atomicity_proven` false.
Retain all original A/shared-family holds, B paused, disabled timers, current capacity,
draft PR5, Gemini deferral and human-reviewed merges. Backup/S3/monitoring stay deferred.
Reviewed rollout plus complete real shared-hold reconciliation precede the bounded
serial Codex B tasks and subsequent Claude lifecycle acceptance.

Root's first actual execution refused during setup: attempt directory ownership was
transferred before root created its files, and root intentionally lacks DAC_OVERRIDE.
The implementation now creates files before transferring directory ownership; all
chmod operations precede the corresponding chown so FOWNER is unnecessary. No
capability was added. Root retained that failed log. The corrected final root-scheduled actual container run
PASS (exit0), recorded in `.handoff-state/2026-10-21/enforcement-composition/storage-final.log`.
Its JSON confirms UID1000, no canonical descriptors, inherited FD200 write EBADF,
parent proc FD reopen denied, canonical path denied, changed detached attempts and
unchanged canonical bytes under the complete generation1 three-root HEAD.
Operational acceptance, legacy retirement, production mount isolation and
cross-authority atomicity remain explicitly false. Root confirmed --rm cleanup;
this result does not convert the fixture into a production authority.
