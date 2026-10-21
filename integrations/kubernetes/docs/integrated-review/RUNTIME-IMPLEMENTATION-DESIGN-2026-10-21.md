# Runtime implementation design and bounded output codec

This is an implementation proposal against the saved inspected native source,
not authorization to install or an assertion of compatible runtime provenance.
[Prior findings](RUNTIME-ENFORCEMENT-PROPOSAL.md) and
[route closure](ROUTE-CLOSURE-2026-10-21.md) remain applicable. No native files,
production inputs, hosts, runtime, credentials, Git or index were modified.

## Implemented byte protocol

`production/command_frames.py` now encodes and incrementally decodes actual binary
frames, preserving arbitrary stdout/stderr bytes including NUL/non-UTF8 and CRLF.
Header is network byte order `!4s32sBQI`: magic `PCF1`,32-byte exact connection
token, kind byte, unsigned64 sequence, unsigned32 payload length. Kinds1/2 are
stdout/stderr,3/4 their independent zero-payload EOFs,5 terminal unsigned32 exit
status0..255,6 terminal unsigned32 signal1..64. Empty data frames refuse; both
EOFs must precede exactly one terminal frame. One global sequence across both output channels, their EOFs and the terminal
starts0 and increments without gaps/repeats, bounded to signed63 range. No frame follows a terminal.
No text decoding, exit inference or signal-to-exit translation occurs.

Payload is bounded65536 bytes; each transport feed is bounded65585 bytes. The
partial buffer never exceeds65585 bytes, even when a read completes one frame
and starts another. Oversized/invalid input permanently holds and clears buffered
bytes; malformed header payload length refuses before allocating that payload.
Per-feed returned frames are bounded by the input limit plus one existing partial
frame. The transport must stop reading until the caller consumes that returned
tuple: this supplies a concrete bounded handoff, not a transport-level queue.
The codec owns no socket/read loop, process, credential or durable operation.
A consumer must preserve its own bounded sink and backpressure policy.

The connection token must be externally bound to exact command, invocation,
stream and retained operation by the protected owner and framing channel. Token equality is not authentication. No reset/resume/reconnect
API is supplied; any failure requires retained remote inspection, never replay.
A new Python object can decode the same transcript again, so globally refusing
reconnect/reuse requires the missing persistent authority/transport owner. Codec
success says only that bytes formed a complete transcript, not that the claimed
exit occurred or that descendants/accepted writes retired. stdout EOF and SSH
closure alone cannot authorize stop completion or release.

`python3 -B -m unittest test_command_frames -q` from `protected-execution/`:
12 pure stdlib tests PASS in0.015s. Cases include every split of a binary transcript,
byte-at-a-time reads, both terminal forms, maximum payload/partial coalescing,
truncation at every byte, duplicate/skip/reordered sequence, wrong connection,
malformed headers, invalid EOF/status, late bytes and permanent refusal. No
process/container/DB/network/provider or heavy graph runs. Synthetic codec tests
are not installed framing or operational acceptance.

## Exact native composition change proposed for root review

| Existing module/method | Required implementation change |
| --- | --- |
| `packages/adapter-utils/src/ssh.ts`, `SshCommandJournal` / `buildSshSpawnTarget` | Replace optional `spawnProtected?` production use with required protected composition; validate protected factory and exact native route manifest before `createSshAuthArgs`, profiles, cwd and supervisor preparation. No legacy authentication or command fallback on missing/failing composition. |
| Same `runSshCommand` / `runSshTransfer` and `runUnjournalledSshCommand` callers | Route every command/probe/setup/transfer through exact retained operation; keep unjournalled implementation inaccessible to production managed entry points. Known epoch/old-stop callers must move to protected typed operations, not disappear from the matrix. |
| Same `createSshCommandManagedRuntimeRunner` / service stop; file/bundle/tar transfer helpers | One host-owned operation holds process lifetime and bounded output sink. Protected server emits codec frames; native transport needs equivalent exact byte parser and EOF/status handling, with compatible Node stream backpressure. Do not UTF8-roundtrip frame bodies or substitute child `close` for remote terminal. |
| `server/src/services/execution-capacity-lifetime.ts` installed occupied-owner journal | Make factory mandatory; bind connection token to exact owner/run/lease/invocation/source inventory and retained operation. Admit no managed effect if absent. Retain operation state on disconnect/cancel and route exact inspection to original authority, never new command identity. |
| `production/stream_server.py` and `runtime_owned.py` composition | Protected server/backend must own emission and input queue, rather than letting client-side codec results trigger independent writes/effects. Local worker death does not settle remote accepted bytes. No raw callback permit is returned. |

Method spellings/call graph must be checked again against exact source when
native ownership is assigned. The Python codec is not imported by native code
today; a Node implementation or owned protected transport adapter plus actual
cross-language fixtures is required before mandatory integration can pass.

## Runtime patch and compatibility decision

Saved inventory reports MicroK8s snap8702/containerd1.6.36 with runc-v2, kata,
NVIDIA, lower shim endpoints and a second daemon on think3. No immutable snap
build source/provenance or compatible runtime source is present in this checkout.
Therefore an apply-ready runtime patch cannot honestly be specified or compiled
from available files. Containerd2.x examples are not compatibility evidence.
The following is the exact patch obligation for the proven source once supplied:

1. Identify actual CRI create/start/exec/attach and runtime task-service
   create/start/exec/resume/restore/reconnect entry implementations. Containerd
   tasks service and runtime-v2 shim task Start/Exec/Resume handlers are candidate
   hook locations, not proven snap source paths. Each callable daemon/shim/handler
   endpoint must route to the same protected effect owner or be inaccessible to
   workload, kubelet, old shim and maintenance identities by reviewed enforcement.
   A CRI-only proxy cannot cover lower task endpoints or already-open pipes.
2. Before process start/exec/resume/restore, the mandatory owner commits exact
   prospective intent, checks independently current history/generation, and owns
   actual runtime call plus retained uncertain outcome. Attach/stdin reconnect must
   never silently recreate a process or replay accepted input. Runtime process
   starts, input writes and retirement share an unavoidable per-owner effect queue.
3. `deny-intent` in history is prospective. Runtime T is the queue's irreversible
   deny acceptance, ordered against actual input acceptance/effect. At T reject
   new effects and preserve all earlier queued/accepted/partially written bytes
   and possible processes as occupied. A DB lock/rollback cannot undo pipe writes.
   If a write succeeds but reply/history commit is lost, exact intent remains
   uncertain; inspect original operation, never replay journal bytes. If process
   state cannot classify the accepted effect, hold capacity indefinitely.
4. Stop is a typed exact-owner operation usable for historical owners after T;
   it cannot resume them. B requires every incarnation/alias and pre-T queue item
   definitively classified, all processes stopped and write workers quiescent.
   Terminal frames are observations; they do not establish this B.
5. Boot starts held. Runtime/shim sockets and effect-capable tasks remain
   unexposed until protected current history, original owners, tombstones and
   uncertain intents recover. Account for old boot identities and absent nodes;
   missing/stale history, unknown existing task, unavailable old shim or matching
   restored snapshots fails closed. Restore cannot retire monotone tombstones.
   Ordinary systemd start-ordering alone does not fence surviving old shims.
6. Storage supplies a separate physical fence covering old descriptors/mounts and
   external credential writers. Runtime B alone cannot prove storage retirement.
   Root integration must bind both into the reviewed decision/native transaction;
   no cached observation can authorize a later effect.

Reject candidate compatibility if any callable alternate handler/daemon bypasses
these checks, history is consulted only once before exposure, an old UID can
resume after restart, accepted input becomes replayable after failure, or B is
claimed without all possible old workers accounted for. Real runtime/disconnect/
boot-order/old-shim/partial-input tests need a coordinator-scheduled bounded
disposable exact-build environment once source/provenance is available; none was
run. Host installation, topology/live changes and hosted full graphs remain
subject to their separate authorization boundaries. Physical proof, current authority service,
real issuer custody and native transaction integration remain blockers.

Both original A and shared-family holds stay; B remains paused. No replacement
identities, releases or receipts were manufactured. Current capacity, draft PR5,
disabled timers, Gemini deferral and backup/S3/monitoring postponement remain.
