# Inactive authority/native SQL review

`authority-native.sql` is entirely inside one SQL block comment after its warning
header. It is review material, **not a migration or deployment command**. No
statement has been executed, parsed by PostgreSQL, installed or validated against
the native schema. SQL/concurrency/role/restore tests: **NOT RUN**. Reading the
file is not a database fixture or an acceptance result.

The candidate puts authoritative admission claims, occupancy, deny state,
prospective exact requests, generation fencing and their effect journal into one
H database transaction domain. Paperclip P stores projections of those decisions;
its old reservations/lifecycle booleans must lose authority. This is a significant
source/schema integration proposal, not a drop-in service or a selected topology.
It requires existing external PostgreSQL; no second cluster is proposed or created.

The proposed routines show concrete same-transaction invariants:

- `require_generation` locks one protected generation row through COMMIT. Every
  effect uses it; no separate check transaction or returned permit exists.
- An independently retained `approved_requests` row must match the complete typed
  descriptor, original operation, request digest, incarnation, epoch, kind and
  target. Executor credentials cannot insert it. An arbitrary caller hash is not
  authority. Lost outcomes leave that original prospective record occupied.
- `claim` checks the original overlapping hold closure independently from the H
  inventory, rejects unsupported/held sources, checks scope holds/capacity, then
  commits the authoritative claim and exact operation journal together.
- `deny` consumes a retained prospective denial with exact predecessor and updates
  native denial plus journal together. It returns native-denied-only; it cannot
  assert runtime T, completed B, storage exclusion or fully settled revocation.
- `release` consumes exact independent imported release facts in the same
  transaction as claim occupancy release and journal. It cannot insert facts or
  reconstruct historical lease receipts. The missing facts importer must enforce
  current runtime/storage/root-group generations and all original-domain evidence.
  These finite signed facts alone do not solve live physical exclusion.
- Existing exact operations return inspect-original without executing again.
  A separate protected read-only inspector must compare all retained fields and
  actual authoritative journal state. No safe-retry API is provided. A serializable
  error or lost COMMIT response requires original-operation inspection, never a
  new operation ID or automatic provider/body replay.

Role names are proposals. The final owner must be NOLOGIN, unreachable through
executor membership and own the schema/tables/functions; executor must have no
schema CREATE, table DML, role creation, BYPASSRLS or superuser authority. Functions
use a fixed trusted search path and no dynamic SQL. PUBLIC default function
EXECUTE must be revoked before exposing any connection/schema. No roles, grants,
credentials, network allow rules or default privileges are actually installed.
No evidence-import, history-open, generation-rotation or revoke-settlement routine
is supplied. Their absence keeps the candidate held rather than offering a caller
boolean/callback escape hatch.

The SQL does not reproduce the complete native application's predicates. The
existing admission claim/reservation, queue, per-instance concurrency, lease,
agent lifecycle, callback and reconciliation semantics must be moved/reworked
explicitly and tested before any projection can replace their authoritative use.
`claim` and `release` illustrate transaction shape, not a claim that partial
native tables are enough. Full source inventory, native migration review and
all-caller rewiring remain blockers. Read
[the transaction design](../../docs/integrated-review/HISTORY-NATIVE-TRANSACTION-DESIGN-2026-10-21.md)
for recovery, stale connections, runtime ordering and concrete next verification.
