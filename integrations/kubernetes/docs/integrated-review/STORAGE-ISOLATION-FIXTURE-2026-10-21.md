# Disposable separate-UID and filesystem isolation fixture

This is executable isolated verification, not topology approval or production
storage fencing. Root coordinator alone schedules and runs it. The storage agent
ran four pure stdlib shape/guard tests in0.011s; it did not fork or invoke Docker.
The actual container result is recorded by root in the integration checkpoint.

## Exact inputs and root-coordinated command

Use a **previously cached exact Python image ID** selected by root; no pull/build,
credentials or network. From the evaluation package, root can run:

```sh
docker run --rm -i --pull=never --network=none --read-only \
  --memory=256m --memory-swap=512m --cpus=1 --pids-limit=64 \
  --cap-drop=ALL --cap-add=SETUID --cap-add=SETGID --cap-add=CHOWN \
  --security-opt=no-new-privileges --user=0:0 \
  --tmpfs /canonical:rw,nosuid,nodev,noexec,size=16m,mode=0700 \
  --tmpfs /attempts:rw,nosuid,nodev,noexec,size=16m,mode=0700 \
  --env PAPERCLIP_DISPOSABLE_FIXTURE=1 \
  "$CACHED_PYTHON_IMAGE_ID" python3 -B - \
  < protected-execution/multi_uid_storage_fixture.py
```

`CACHED_PYTHON_IMAGE_ID` must be root's exact already inventoried `sha256:...`
identity, not a moving tag. This stdin method mounts no host source, volume or
runtime socket. Only fresh tmpfs files are written. No `SYS_ADMIN`, privileged
mode, `DAC_OVERRIDE`, `FOWNER`, `KILL`, external port or provider access is needed.
Root serializes this with the PostgreSQL fixture under aggregate laptop limits.
The module refuses non-root/missing opt-in, nonempty/non-tmpfs exact mountpoints,
symlinks or a shared filesystem device before constructing any synthetic file.

## Actual mechanisms and expected observations

The initial root parent has only setup capabilities. It creates synthetic attempt
and danger files, retains two writable descriptors, then gives canonical directory
and danger-file ownership to UID/GID2000, canonical mode0700, and attempt ownership
to UID/GID1000, attempt directory mode0755/file0644. A child drops supplementary
groups, GID and UID before each action. Every child has a ten-second alarm and a
bounded JSON result channel; child failure/nonzero/timeout fails the fixture.

A UID2000 canonical-owner child copies attempt bytes into an independent canonical
file, fsyncs it and makes it mode0400. Ordinary provider UID1000 children receive
**neither** controlled descriptor: they must receive EACCES when listing canonical,
reading/writing the version or creating a new canonical file. Separate tmpfs
filesystems exclude hardlinks between attempt and canonical; no symlink/canonical
path is placed in attempt storage. This does not test a Kubernetes mount policy.

A separate provider child deliberately inherits only the writable **attempt**
descriptor. After copy/publication it writes and fsyncs changed attempt bytes.
The canonical owner independently hashes its version and requires exact unchanged
bytes. This proves detached file independence under that real descriptor write;
it does not claim coherent capture while a provider writes during snapshot.

The final characterization intentionally gives a provider child the retained
writable **canonical danger** descriptor. UID1000 must successfully modify this
otherwise inaccessible file, and UID2000 must independently observe the changed
bytes. The fixture treats reproduction as `expected_vulnerability`, **not** a
passed production protection. Unix UID/path restrictions do not revoke an already
open writable file description. Production design must prevent inheritance and
must independently retire/fence every pre-existing legacy canonical writer.

Successful JSON reports `fixture_pass:true`, `synthetic:true`,
`operational_acceptance:false`, the exact EACCES observations, changed attempt,
unchanged detached canonical hash and explicit inherited-FD vulnerability.
`production_mount_isolation_proven`, `legacy_writer_transition_proven` and
`current_history_proven` all stay false. No release/stop/retirement receipt is
created. A failure exits nonzero rather than producing success evidence.

## Limits and remaining integration

Both UIDs live in one disposable container with the same Python code. The parent
is a trusted test coordinator with CHOWN/SETUID/SETGID, not a deployable owner
service. Mode bits and separate tmpfs exercise DAC/inode behavior, not inaccessible
canonical mounts, networked owner APIs or adversarial runtime escapes. No real PVC,
Longhorn durability, cross-PVC atomic head, old legacy mount transition, provider
grant fencing, complete root inventory, independent high-water/history or native
all-command installation is tested. Previous single-filesystem prototype separately
covers full-group HEAD/CAS/crash control flow; neither fixture composes an actual
production authority. Kernel crash and node/runtime replacement remain untested.

Real installation still requires exact reviewed immutable image/policy/RBAC/
network/workload/manual-migration changes and separate rollout authorization.
Preserve all historical A/original shared-family holds, paused B, capacity, timers
off, draft PR5, human-reviewed merges and Gemini deferral. Backup/S3/monitoring
remain postponed. No provider dispatch follows this synthetic result.
