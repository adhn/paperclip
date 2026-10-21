# Retained runtime provenance inventory — 2026-10-21

Only local retained files were read. No live host inspection, runtime invocation,
socket connection, network, provider, Git operation or archive extraction occurred.
This report distinguishes historical observation from authenticated build source.
It does not create a runtime receipt or establish present-day host facts.

## Reproducible inventory

From `protected-execution/` run:

```sh
python3 -B runtime_provenance_inventory.py --root /home/andam/Documents/Testing123/AI/Paperclip
python3 -B -m unittest test_runtime_provenance_inventory -q
```

Tool defaults select exactly eight retained files, with stable JSON path/class/
size/SHA256 output. The scan read191283 bytes. Nine pure stdlib tests PASS in0.005s,
including exact hashes/determinism, missing files, candidate nonverification,
path traversal, symlink parents/files, FIFO/directory refusal, byte/count bounds,
and nonrecursive selection. File reads use directory-relative no-follow opens,
nonblocking special-file refusal, bounded reads and before/after file metadata.
This detects ordinary read changes, not malicious privileged rewriting.

Default classes are seven saved observations and one observation-collector source;
none is runtime source/build proof. `--candidate CLASS:RELATIVE_PATH` adds an
explicit candidate, at most32 files total,2MiB each and8MiB aggregate accepted
bytes. No directory traversal or archive unpack occurs. Source/build candidate
labels never change `verifiedRuntimeProvenance:false`; all outputs retain
`operationalAcceptance:false`. Missing inputs remain unverified even if a supplied
candidate is present. Hashing an arbitrary build document is not authentication.
No artifact contents, credentials or environment values are printed.

| Retained artifact (relative to workspace; retirement files use `.handoff-state/2026-10-20/retirement-design/`) | Bytes | SHA256 |
| --- | ---: | --- |
| `runtime-host-think1.json` |50838|`1fd044bd9fa1120629e3ea6dab8f0c8441aaf982d4e59162f92cd4894ba0c542`|
| `runtime-host-think2.json` |50521|`10abddadcd8b996f0f960f0cab8e0b08525ae17f3188066952f25636ef7e1afb`|
| `runtime-host-think3.json` |58414|`69dc4e8e63da289832c63668094f3c06617fdeb3e67312c79c3390b5e4a26fd3`|
| `runtime-host-checkpoint.json` |3545|`314478a2aa7b89ff04a994da9d9ed22ffef8538d9c85b064db086741cc21e2ef`|
| `runtime-current-inventory.json` |5076|`866cd8f2398a816105a432a946bed342a7d50b99a04422e5c2a5966fcd556227`|
| `runtime-host-probe.py` (collector source, never executed here) |6230|`5846b534e0a0d48ec1b48bf5b3d616843070bab4b708acb78f8efe9abd583192`|
| Evaluation `docs/runtime-host-inventory-2026-10-20.md` |8511|`1b42b8ce466511a6f4cda085b1df2c36c23b6fc8b1380056ffd772a54d1689f9`|
| Evaluation `docs/runtime-current-inventory-2026-10-20.md` |8148|`af6dcaed4f9581f1c7eea6f330c6eb707c1a8338215cd69aeb1c3bacac0860a5`|

The host JSON hashes match the saved checkpoint. Reported target remains snap8702/
containerd1.6.36; saved binaries include matching containerd, runc-v2 shim, runc
and kubelite hashes on three hosts. The binaries themselves were not read here.
The saved hash identifies historical bytes read on a host; it does not identify
source commit, patches, compiler, running executable or covered runtime effects.

`rg --files --hidden .handoff-state .work docs` with node_modules/.git excluded
was filtered for runtime/containerd/runc/kata/NVIDIA/snapcraft/provenance names.
A narrower `*.go`, `*snapcraft*`, `*containerd*.go`, `*runc*.go`, `*kata*.go`,
`*nvidia*.go`, `*8702*` filename search found no exact runtime build source or
snap8702 manifest in these enumerated paths. Agent-shim Go files in the dirty
native checkout are Paperclip command-spec loading code, not containerd/runc
source. Disposable containerd journal logs are diagnostic observations, not a
build provenance chain. No archive contents, external cache or ignored paths
were exhaustively searched; no global absence claim follows. An initial search
included absent `tools/` and emitted a missing-directory diagnostic; corrected
search used only existing retained roots. Nothing was fetched or restored.

## Exact missing inputs and hook feasibility

| Target/path from retained evidence | Available observation | Required input / compatibility disposition |
| --- | --- | --- |
| Snap8702/containerd1.6.36 | Historical API string, selected args/config, binary hashes | Authenticated immutable snap build manifest/source revision, applied patches, compiler/dependencies and binary-to-build mapping absent. Exact-build patch is **blocked**, not proven compatible. |
| CRI sandbox start and recovery | Saved upstream v1.6.36 review references `pkg/cri/server/sandbox_run.go` (`RunPodSandbox`) and `restart.go` (`recover`/load paths) | Candidate mandatory intent/start and pre-exposure recovery hooks are identifiable. Upstream tag alone does not map to snap bytes. Ordinary container-start/task-local upstream reads were previously unavailable; do not invent their inspected implementation. |
| Runtime-v2 lower shim | Saved upstream references `runtime/v2/shim.go` and `runtime/v2/runc/task/service.go`; historical `.ttrpc`/shim socket observations | Exact snap shim/task Create/Start/Exec/Resume/restore/reconnect call graph and accepted stdin owner needed. CRI-only interception is **incompatible with complete closure** while these callable lower paths remain. |
| runc-v2/runc | Historical installed-file hashes | Exact runc and shim commits/build mapping, checkpoint/restore/reattach and direct invocation custody missing. A shim patch does not prove direct runc cannot bypass it. |
| kata | Configured `io.containerd.kata.v2`, BinaryName `kata-runtime` | Actual binary existence/version/source/VM task/input/recovery ownership unknown. Cannot claim runc hooks cover kata; cover full handler or reviewed non-bypassable exclusion. |
| NVIDIA | Configured `io.containerd.runc.v2`, BinaryName `nvidia-container-runtime` | Actual wrapper binary/version/source and complete effect chain unknown. Shared runtime type is insufficient coverage evidence. |
| think3 second daemon | Saved `/run/containerd/containerd.sock` and `.ttrpc` paths | Owning service, running executable/build/config, clients, namespaces and effects unknown. Its omission makes a one-daemon proof **incompatible** with complete closure. |
| Boot/old incarnations | Selected containerd-before-kubelite edges and stat-denied lower shim paths | Complete effective units/drop-ins, executable identities, socket/client custody, surviving shim/old boot behavior and restart gate absent. Unit ordering does not prove current-history recovery before effect exposure. |

Upstream links are preserved historical review references, not fetched or verified
in this increment. The next exact-build fixture must use authenticated local
source/build mapping, cover every applicable method/handler/socket, and prove
stale-owner refusal at actual irreversible effects. Root can schedule bounded
isolated tests once inputs exist within current authorization; host installation,
live inspection/mutation, topology changes and hosted full graphs retain their
separate boundaries.

Runtime T must order deny with irreversible stream acceptance in the same sole
owner queue. Prospective history deny is not T; accepted/partial/unknown pipe
writes remain occupied and cannot be rolled back by SQL or replayed after lost
reply. B still requires complete old-incarnation/process/input attribution and
permanent exclusion, plus independent physical storage fencing. This inventory
supplies none of those proofs. See [runtime implementation design](RUNTIME-IMPLEMENTATION-DESIGN-2026-10-21.md).

All original A/shared-family holds remain, B paused, current capacity unchanged,
PR5 draft, human-reviewed merges, timers disabled and Gemini deferred. Backup/S3/
monitoring remains postponed. Native dirty source was read only, never reset or
reapplied. Runtime implementation and operational acceptance remain blocked.
