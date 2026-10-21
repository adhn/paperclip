# Candidate SSH admission transport

Status: explicit development overlay, 2026-10-18. **Not installed or enabled.**
`prepare-controller.py`, production image recipes and workload digests are unchanged.
The admission foundation CI applies `scripts/patch-ssh-admission.py` only after
checking the nine PR #4 baseline source hashes. The overlay refuses other SSH
source versions and is deliberately not idempotent.

## Implemented boundary

`buildSshSpawnTarget` accepts an optional **internal host-owned** authorization.
It snapshots the exact company/agent/run/attempt/environment/lease/invocation and
controller epoch before its first await. The caller must persist that exact binding
before calling the transport. It is not read from adapter config, environment
variables or agent requests. Absence retains the current PR #4 behavior, so this
is not an enforced admission policy and must not justify increased capacity.

The candidate prepends `protocol.py` to the existing PR #3 descendant supervisor
and preserves its process/reaping loop. Under one runner `epoch.lock`, start
checks the epoch, durably consumes the attempt and invocation, persists the
supervisor start marker, and creates the child with `Popen`. Another start cannot
reuse either identity, including after natural exit. Both file contents and parent
directory entries are fsynced. A partial journal consumes authority conservatively.
Provider stdin, output and exit status retain their existing semantics.

`updateSshAdmissionEpoch` is an explicit host operation. Initialization never
happens implicitly during launch. Takeover uses compare-and-set and refuses reuse
of any recorded epoch, preventing a delayed operation from restoring an old token.
The epoch lock covers the actual `Popen`, not a preceding shell check. Takeover
fences future starts; it does not terminate already running work.

Stop uses the exact retained binding and remains available for older epochs.
Pre-start cancellation consumes and tombstones that attempt under the same lock.
A started supervisor must reap its children before writing a receipt. Receipt
identity is checked remotely and in TypeScript. Missing, corrupt or mismatched
proof does not release capacity. There is no timeout-based release or retry launch.

## Trust and remaining integration

The fence root must be one canonical absolute runner-owned directory, resolved
from trusted server policy for every alias of the same runner. No production
resolver or account/workspace/session identity mapping exists yet. Paths and
bindings in tests are synthetic host input. The cooperative runner UID can read
and modify its own state; this is not a hostile-sibling security boundary. A
separate caller choosing another root or omitting authorization is still a bypass
until all starts and policy enforcement are integrated.

Native database schema/claims, pre-launch journal ownership, probes/setup guards,
restart reconciliation, state restoration proof and visible queue waits remain
required. A consumed start with a `started.json` marker and no stop receipt stays
uncertain; this overlay supplies no reconciliation release. Disk loss, explicit
root reset, cross-runner relocation and legacy occupancy require a separately
verified recovery protocol. Do not initialize a new root to clear uncertainty.
Run-bound envelopes here do not yet define non-heartbeat probe identities.
No historical receipt or lifecycle record is rewritten.

## Verification

- `fixtures/admission/test-supervisor-fence.py`: 12 real subprocess tests of this
  assembled subreaper, including deterministic lock/Popen interleaving, takeover,
  duplicate/changed identities, pre-start cancellation, detached TERM-ignoring
  descendant stop, sibling survival, uncertainty and stdin/output/exit handling.
- `scripts/test-ssh-admission.mjs`: actual SSH transport with generated fixture
  keys, fixed/snapshotted invocation identity, duplicate and stale launch denial,
  exact receipt validation and legacy compatibility. Run through
  `scripts/test-controller-ssh-cancellation.py CONTROLLER RUNNER SCRIPT`.
- Existing six supervisor tests, four focused TypeScript suites and actual-SSH
  descendant/sibling/timeout/spawn-error regressions remain covered.
- Foundation CI builds dependencies and test-only source/SSH images. It does not
  build/publish the production application, migrate a database or change Flux.

The first local SSH attempt used the dependency-only image and failed before
connection because `ssh` was absent. The corrected cached SSH fixture image
passed. An offline Corepack invocation also tried downloading pnpm; checks now
use installed compiler/test binaries directly. Neither setup failure involved
provider calls or cluster state.
