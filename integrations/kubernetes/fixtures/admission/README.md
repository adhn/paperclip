# Admission contract fixtures

Status: implementation foundation, 2026-10-18. **Not production admission control.**
No application imports this ledger, no migration installs its schema, and no
workload/image reference changes. They exercise the proposed contract against real
temporary PostgreSQL and local subprocesses before integrating the native queue.

## Reproduction

Use the PR #4 source test image, or build its `deps` target as fixture CI does:

```sh
docker run --rm --network none \
  --mount "type=bind,src=$PWD/clusters/homelab/infrastructure/paperclip-evaluation/fixtures/admission,dst=/fixture,readonly" \
  --entrypoint sh paperclip-controller-test /fixture/test.sh
python3 clusters/homelab/infrastructure/paperclip-evaluation/fixtures/admission/test-remote-fence.py
```

The database is disposable, inside the test container, and has no connection to
the homelab. Tests use the pinned source build's PostgreSQL 18 test dependency and
postgres-js 3.4.9. No provider login, API call, model usage, or Docker socket is
available inside the fixture. Failure to start PostgreSQL fails the suite; cases
are not skipped.

## Contracts exercised

- A single scheduler row serializes mutations across independent database clients.
  Scope counts and grants commit atomically; project history advances only on grant.
- Distinct instance, runner, account and credential scopes compose. Adding capacity
  does not remove a credential serialization gate. Terminal UI status is not used.
- Queue ceiling, stable request identities, per-operation unsettled uniqueness,
  eligibility, cooldown and conservative backup gating are durable.
- A start authorization is consumed once. Stop and restoration are separate release
  conditions, with exact company/attempt/run/agent/environment/lease/invocation binding.
- Takeover fences old database writers, drains new admission and retains unresolved
  occupancy. There is deliberately no timeout-based release or synthetic receipt.
- The remote prototype serializes epoch changes with `Popen`, rejects delayed old
  starts and duplicate attempts, and preserves cancellation tombstones. Its journal
  uses fsync. It does **not** provide descendant-stop evidence; the existing subreaper
  must own the launch and stop protocol when this is integrated.

## Explicit limits

This is an executable contract, not an additional production queue. Production
must link native heartbeat/probe identities, generate a normal Drizzle migration,
resolve scopes from server-owned policy, and compose reservation with native claim
in one transaction. The fixture's global project history is a conservative model;
integration must prove fairness per constrained runner, including mixed-provider
traffic and native eligibility changes. Agent and mutable-state scopes are caller
inputs here; canonical identity resolution and configuration fencing are unimplemented.

The fixture `settle` trusts a host-supplied proof for testing. It is not an API and
must never be exposed to agents. Integration needs independent receipt verification,
copy-back/session/auth restoration evidence and a safe pre-launch cancellation
reconciliation path. The remote fence must be incorporated inside the supervisor's
launch lock, with the binding journaled by the controller **before** SSH launch.
Running it as a separate precheck would introduce a launch race.

No takeover reconciliation is implemented: uncertain attempts intentionally hold
capacity forever in this prototype. No periodic queue sweep, native queue/UI wait
projection, scoped operator API, admission-policy deployment, historical occupancy
import, production rollback or live acceptance is claimed. See
[source audit](../../docs/admission-source-audit-2026-10-18.md).

## Candidate subreaper integration

The separate [SSH admission transport overlay](../../images/controller/ssh-admission/README.md)
now assembles the fence into the existing descendant supervisor and accepts an
internal, fixed invocation authorization at the TypeScript transport boundary.
`test-supervisor-fence.py` exercises that assembled supervisor with 12 cases; the
CI workflow also tests actual credential-free SSH. The original six-case prototype
above remains a contract reference. This does not connect the ledger to native
claims or install the overlay in production builds; all remaining native policy,
identity, journaling, restoration and reconciliation limits still apply.
