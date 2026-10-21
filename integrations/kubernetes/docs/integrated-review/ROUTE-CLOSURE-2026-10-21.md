# Static route closure candidate — 2026-10-21

Baseline: [DAILY-USE-MECHANISMS.md](DAILY-USE-MECHANISMS.md), functional1695530,
supersedes authority-services69125a5. Native d489129 and intentionally dirty source
are untouched. Recovery handoff's 2026-10-21 daily-use direction postpones
backup/S3/monitoring; none of that work is included here.

`production/route_policy.py` adds an immutable candidate manifest for the inspected
application route surface. Every setup, command, probe, service start/stop,
file/bundle/tar upload/download, stdin write, epoch, stop and recovery route must
appear exactly once with one protected factory and all eight named dependencies.
Missing/duplicate/unknown routes, wildcard or legacy fallback, mutable containers,
missing dependencies and source/factory drift refuse. A lookup returns only
static requirements. It performs no effect, supplies no receipt and grants no
permit. Reference strings are requirements for integration review, not current
facts, signed evidence or proof of a complete runtime inventory. This is useful
source for the native installer contract; no installer imports it today.

`python3 -B -m unittest test_route_policy -v` from `protected-execution/`:
12 pure stdlib unit methods PASS in0.050s. Parameterized cases remove each of15
routes and each of8 dependencies for every route. Tests cover unknown routes,
source/factory mismatch and immutable nested data. No subprocess fixture,
container, database, network, provider or heavyweight graph ran. An initial
command used package-relative paths from the package directory, produced two
"no such file" errors and an import error without writing files; corrected
package-relative creation and the run above passed. No source overlay reset.

## Exact remaining integration blockers

| Inspected source (relative to this package) | Required root-owned integration |
| --- | --- |
| `images/controller/admission-native/source/packages/adapter-utils/src/ssh.ts:55,1519-1527` | `spawnProtected?` remains optional; absence reaches legacy authentication/setup. Require installation before authentication, profiles, cwd, supervisor or remote preparation. A candidate manifest does not alter this. |
| Same `ssh.ts:722-728,1411-1416` | Transfer/command routes can use unjournalled SSH when journal absent. Refuse missing protected composition at every entry; AsyncLocalStorage is insufficient as enforcement. |
| Same `ssh.ts:1473-1485,1550-1564,1602-1606` | Epoch, old-command stop and recovery require separate exact retained-owner authority routing, including old identities. Denied new execution cannot prevent authorized cancellation inspection. No unjournalled fallback. |
| Same `ssh.ts:81-83,737-741,785-788,1618,1650-1654,1747,1767-1770` | Managed service/file/bundle/tar children require owned lifetime and actual stdout/stderr/exit/signal framing. Child closure and SSH disconnect cannot imply remote exit. |
| `images/controller/admission-native/source/server/src/services/execution-capacity-lifetime.ts:82,119-122` | Optional native installation must become mandatory with protected factory identity and independently pinned source inventory, plus authority-owned every-use transaction; no future effect from observation/receipt. |
| `production/runtime_owned.py` and `runtime_boundary.py` | Local worker cancellation/recovery gating remains useful but supplies no actual compatible containerd/shim effect backend, recovery ordering, physical fence or complete handler/daemon inventory. |

The static route vocabulary must be checked against the exact native call graph
on integration and extended whenever source introduces a route. It is not a
claim that caller-selected route names constrain a hostile or bypassing caller.
Root must add native tests for refusal before any preparation, all call sites,
complete terminal framing, exact stop ownership and failure/disconnect behavior
once those native files are assigned. Current native/image heavy verification is
reused only for its unchanged scope; these new files have not had hosted checks.

## Cancellation and physical exclusion obligations

Every route names current independent history, exact retained owner, common
atomic effect/deny ordering, uncertain-operation inspection, runtime effect
boundary, recovery-before-exposure, output framing and physical stale-writer
exclusion. All are dependency references, never booleans asserting installation.
A remote effect accepted before deny T remains occupied through lost response,
local cancellation, disconnected pipe and restart until exact authoritative
inspection settles it. A timeout, terminated local group or terminal frame is not
retirement B. Stop/recovery authority must be available for exact historical
owners without granting new execution or exempting B from shared holds.

Actual common irreversible effect/deny linearization remains unresolved as in
[ATOMIC-BACKEND-PROPOSAL.md](ATOMIC-BACKEND-PROPOSAL.md). Actual runtime backend
needs exact snap8702/containerd1.6.36 build provenance, all handler/lower-shim and
second-daemon paths covered or non-bypassably excluded, and recovery before any
exposure. Physical exclusion requires proof over old descriptors, mounts and
external credential-bearing writers through the complete canonical root group;
Longhorn metadata, a lease, a label, policy validation and local locks cannot
supply this. See [RUNTIME-ENFORCEMENT-PROPOSAL.md](RUNTIME-ENFORCEMENT-PROPOSAL.md)
and [STORAGE-PROOF-BOUNDARY.md](STORAGE-PROOF-BOUNDARY.md).

No live inspection/mutation, provisioning, publication, deployment, migration,
capacity change or Git operation occurred. All original A/shared-family holds,
paused B, Gemini deferral, disabled timers, draft PR5 and human-reviewed merges
remain. Tests establish static fail-closed validation only; daily use and
operational runtime/storage acceptance remain blocked.
