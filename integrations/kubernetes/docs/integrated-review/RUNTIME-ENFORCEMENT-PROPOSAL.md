# Mandatory runtime enforcement: failed feasibility obligation and exact next change

2026-10-20 continuation. **Blocked; no runtime mechanism implemented or installed.**
This is a source inspection/proposal, not an execution receipt. Existing hosted
component and native passes retain their recorded scopes. No additional model,
interface, runtime backend stub or synthetic test was added: those would not
supply the missing unavoidable effect/recovery boundary.

## Finding against the available source

Paths below are relative to `paperclip-evaluation/`; line numbers identify the
inspected continuation and may move in a later patch.

| Evidence | Consequence |
| --- | --- |
| `protected-execution/production/runtime_owned.py:26-63` constructs a supplied backend, then sets a local recovered boolean after its method returns; `:74-80` explicitly excludes mandatory placement and remote cancellation | Real local worker ownership is implemented. It cannot make containerd, old shims, stale kubelet or already-open input writers obey that worker. |
| `protected-execution/production/runtime_boundary.py`, `MandatoryRuntimeAuthority` | Actual backend defaults refuse. Its rehearsal explicitly uses synthetic route/alias inputs. There is no compatible runtime implementation to instantiate. |
| `docs/runtime-host-inventory-2026-10-20.md:21-58,84-95` | Saved target is snap 8702/reported containerd 1.6.36, with runc-v2, kata and NVIDIA configuration, lower shim routes and a second daemon on think3. This is historical inventory; no current host verification was performed. |
| `images/controller/admission-native/source/packages/adapter-utils/src/ssh.ts:55,1519-1527` | Protected spawn is optional. Missing protected spawn reaches SSH authentication and supervisor preparation. A command journal alone does not close the fallback. |
| Same `ssh.ts:722-728,1411-1416` | Transfer and command functions explicitly use unjournalled SSH without a journal. Async-context use is not a mandatory security boundary. |
| Same `ssh.ts:1473-1485,1550-1564,1602-1606` | Epoch and old-command stop use a separate unjournalled route. Removing normal dispatch fallback alone would leave lifecycle paths. Stop must remain exact-owner and work on retained old identities, through a separately ordered authority route. |
| Same `ssh.ts:81-83,737-741,785-788,1618,1650-1654,1747,1767-1770` | Managed service, file/bundle/tar paths create child processes. Protected transport needs complete input/output/exit/signal framing and exact worker ownership for every path. Local tar processing is not itself a remote authority. |
| `images/controller/admission-native/source/server/src/services/execution-capacity-lifetime.ts:82,119-122` | Installation is optional even inside the occupied owner journal. Making the optional transport required is necessary at this entry, but cannot implement its physical backend. |

No runtime/containerd/runc implementation source or exact-build patch exists in
this repository. The recorded binary hashes do not supply source provenance or a
reviewed change to actual effect/recovery paths. A Python broker controlling only
new requests would leave the observed lower routes and already-accepted work
outside it. Therefore a correct concrete backend cannot be produced by editing
the assigned Python files under the current topology.

## Concrete proposed implementation project

Choose an **exact-build runtime integration**, rather than a CRI proxy, as the
candidate. This proposal selects the work to review, not a compatible build or
permission to install it. The deliverable must be a patch against the proven
source of snap 8702's containerd/shim/runtime chain, or an explicit incompatibility
report. Do not silently substitute the containerd 2.x examples cited in the older
design for the reported 1.6.36 target.

1. Obtain immutable snap build provenance, exact containerd/runc/shim source and
   effective handler/recovery configuration from independently retained artifacts.
   Produce a call graph for each observed endpoint before writing a backend.
2. Place mandatory intent/effect checks in every actual task/process start, exec,
   resume, restore and reconnect/recovery path, including applicable shim methods.
   The protected runtime service owns the effect; it returns no reusable permit.
   All managed effects require an exact retained native claim and original owner
   binding; missing/unknown attribution denies and preserves occupied ownership.
3. Give that service sole access to its runtime state, persistent UID tombstones
   and independently current intent/deny history. Ordinary boot/restart must not
   expose any effect-capable daemon/shim until current history and all old accepted
   intents are recovered. Existing unknown tasks remain charged, without resume.
4. Either integrate each configured handler/daemon/lower route or propose its
   non-bypassable removal/exclusion with a verified administrator boundary. Any
   uncovered row rejects the candidate. A dedicated pool is conditional on a
   later approved topology; it cannot retroactively retire historical SSH owners.
5. Serialize prospective intent, actual effect and T under backend authority.
   Accepted pre-T work stays pending until exact results/aliases are settled and
   stopped. B requires every possible old node/boot/runtime incarnation accounted
   for and every existing write worker quiesced. Runtime B does not prove physical
   stale storage I/O exclusion; the storage authority supplies that separately.
6. Root-owned native integration must make the protected route mandatory before
   SSH preparation for all managed command/setup/probe/service/transfer routes.
   Epoch/stop/recovery become exact retained-authority operations. Preserve actual
   stdout/stderr bytes and terminal exit/signal frames; do not infer remote exit
   or retirement from transport completion. Unsupported routes refuse.

Input-write ordering additionally requires the [atomic backend proposal](ATOMIC-BACKEND-PROPOSAL.md): task-start hooks alone cannot order accepted stdin bytes against native cancellation, runtime retirement and decision revocation. The runtime-owned queue must account for already accepted bytes and unresolved pipe effects through B.

An exact installation diff must name snap/runtime executable and service changes,
all socket/handler/namespace ownership, boot dependencies, host administrators,
placement admission, protected factory identity, authority authentication/pins and
history recovery. No such host/topology diff is authorized in this continuation.
No apply-ready installer or fixture deployment is supplied.

## Proof obligations and next dependencies

| Gate | Status | Exact next dependency / rejection condition |
| --- | --- | --- |
| Actual mandatory runtime start/effect | Blocked | Exact-build source/provenance and compatible integration covering all task/process and input-write effects. Reject if any direct daemon, shim, handler or accepted work can bypass it. |
| Recovery before exposure and permanent retirement | Blocked | Independently retained current history/custody plus actual daemon/shim boot ordering. Prove restart in both orders, stale kubelet, unavailable old incarnation and permanent same-UID refusal. Missing/rolled-back history must hold. |
| Complete application command route closure | Open | Root-owned changes across `ssh.ts` and native installer/transport plus actual byte/terminal-frame backend. Journal absence, optional install and lifecycle/transfer routes must have explicit refusal/ownership; local helper tests alone cannot close runtime bypasses. |
| T versus B and pre-T uncertainty | Implemented protocol model only | Actual-runtime trace must prove every accepted pre-T effect remains occupied through lost reply, crash and cancellation until attributed and terminated. No model barrier is an authority artifact. |
| Disposable verification | Open, not run here | Only after a compatible implementation exists: separately approved actual-runtime disposable host plan; exact route matrix, six fault cut points, old-boot recovery, sibling preservation, history rollback and storage/native uncertain commit races. No host fixture may deploy to homelab. |
| Installed, operationally accepted authority | Blocked | Complete runtime/storage/custody/native implementation, reviewed rollout and operational evidence. Existing 164 component cases and native/image passes do not establish this. |

Backup/recovery preparation is reserved to Claude Code. This track edits no backup
or recovery-preparation files, recovery execution procedure, Git state or index.
It neither selects the external history storage/restore domain nor claims that a
matching local snapshot provides independent history.

Both historical A holds and original shared Codex families remain. B stays paused,
Gemini deferred, timers off, PR #5 draft and production inputs unchanged. No live
verification/mutation, dispatch, publication, migration, installation, capacity
increase, receipt, lifecycle edit or merge is implied.
