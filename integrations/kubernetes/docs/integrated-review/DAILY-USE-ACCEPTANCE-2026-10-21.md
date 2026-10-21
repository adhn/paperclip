# Daily-use acceptance preparation — 2026-10-21

Offline preparation only. The executable manifest and result-shape checker make no
network calls, launch no processes and grant no operational acceptance. No real
provider scenario was run. Existing A/shared-family holds, paused B, timers off,
Gemini deferral, current capacity, draft PR5 and human-reviewed merges remain.

Baseline: [daily-use mechanisms](DAILY-USE-MECHANISMS.md), functional1695530,
not only earlier69125a5; public-key source verification does not install custody.
The 2026-10-21 recovery handoff update postpones backup/S3/monitoring work;
valuable-state recovery remains unresolved unless the operator explicitly records
an alternative release scope/risk decision. Do not perform postponed work here.

## Executable offline commands

From `clusters/homelab/infrastructure/paperclip-evaluation` in the review checkout:

```sh
python3 -B protected-execution/daily_use_acceptance.py manifest
python3 -B -m unittest discover -s protected-execution -p test_daily_use_acceptance.py -v
python3 -B protected-execution/daily_use_acceptance.py validate /absolute/path/to/reviewed-results.json
```

`manifest` prints the complete ten numbered tasks for each provider, steps,
evidence keys, prerequisites and exact budgets. `validate` reads only the supplied
local JSON, exits1 on rejection, and always reports `operational_acceptance:false`.
It verifies record shape, serial ordering, time bounds and required reference
fields. It does **not** read referenced artifacts, verify signatures, attest facts,
assert completeness or authorize dispatch. Self-labelled forged real observations
can pass shape checks: independent artifact review remains mandatory. Tests
explicitly use synthetic fixtures even where fixture labels mimic real records.

## Operator sequence after separate authorization

1. Review final immutable activation, installed mandatory runtime/all-command
   routes, physical writer exclusion and independent authority/history custody.
   Complete the entire supported/unsupported legacy inventory and real human-
   reviewed A/shared-family reconciliation through the authority-owned transaction.
   B gets no exemption, replacement identity or direct lifecycle edit.
2. Record the separately authorized provider budget/account/grant scope, original
   agent identities and acceptance workspace. Use only a disposable coding
   repository with existing Python and TypeScript test commands; no valuable state,
   new credentials, paid fallback, implicit dependency install, push or publication.
   Confirm no active sibling/provider task and timers remain disabled. These are
   future reviewed steps, not instructions to inspect live state in this session.
3. In Paperclip's existing dashboard, select original **B**, its existing project
   and reviewed execution environment. Resume only through the supported lifecycle
   after all prerequisites hold. Create one assigned issue at a time with the
   corresponding manifest task instruction, 600-second maximum, explicit CLI
   engine and approved unattended policy. Require callbacks scoped to that issue.
   Save issue/run IDs and exact generated invocation/placement. Do not run the
   historical cancellation-repeat helper's `start`: it creates a replacement A.
4. Execute tasks1–10 serially within7200 seconds including fault/reconciliation
   time. If failure, uncertainty, expiry, missing evidence or budget breach occurs,
   stop that stage and preserve original occupancy/holds. No automatic retry,
   alternative identity, Claude progression or synthesized pass follows. Pre-T
   effects remain charged until independently settled. Captured old evidence is
   contextual only, not current acceptance.
5. Only after complete Codex evidence and independent review, run the same ten
   tasks on the existing Claude agent serially with a fresh two-hour budget.
   Its supported session and renewal semantics require their own proof. Verify
   renewal against the *effective* installed homes and grant lineage; historical
   Claude `.claude`/`.claude.json` and Codex staged controller/runner copies are
   inventory leads, not assertions about the proposed topology. Never record
   tokens, auth files, environment dumps, one-time login codes or private grants.
6. End through supported lifecycle; inspect original uncertain operations before
   any successor. Record paused state, no queued dispatch and completed independent
   settlement. Keep timers off and capacity fixed. Later overlap/everyday-use
   review requires measured headroom, credential safety and recovery disposition.

Manifest tasks include concrete coding/test prompts, byte-complete tracked/
untracked/deleted/binary workspace checks, session continuation, isolated local
Git history, real credential renewal, descendant cancellation, disconnect, runner
restart and controller restart. Python specifies `parse_count` ASCII-decimal behavior and seven exact edge cases,
then uses `python3 -m unittest -v test_parser`; TypeScript
uses the selected repository's existing test command recorded verbatim. No generic
package install is assumed. Delivery here is an isolated local commit/patch;
remote branch/PR delivery remains separately authorized and unaccepted.

Cancellation requires deny T **and** completed independent retirement B, original
intent, stable authoritative bytes and descendant exclusion; API cancelled and
quiet polling alone fail. Disconnect/restart require independent original-intent
inspection/no replay and authoritative workspace reconciliation. Restart does not
promise active process survival. Credential renewal needs an actual supported
renewal event followed by coding, not file mtime changes or manufactured expiry.
A naturally unavailable renewal window leaves that task incomplete.

## Result contract

Top-level JSON: `schema:1`, `synthetic:false`, `operational_acceptance:false`,
`original_agents:{codex:"be500ba7-65ad-4a72-8369-474eb2522274",
claude:"562ed16a-c09c-4660-92d7-bba077643d7f"}`,
`prerequisites` keyed by every manifest prerequisite and `stages` ordered Codex,
Claude. Each stage has `provider`, exact `agent_identity`, timezone-aware ISO
`start`/`end` and exactly ten `tasks` matching manifest numbers/scenarios.

Each task has `number`, `scenario`, unique `run_id`, timezone-aware `start`/`end`,
`result:"pass"`, `synthetic:false` and `evidence` keyed by all its manifest keys.
Every prerequisite and evidence value contains `kind:"real-observation"`, a
nonempty local artifact reference, lowercase64-character SHA256, observer and
reviewer references. Keep authority operation/workload/epoch/generation, session,
credential lineage and measured timing inside the independently reviewed artifact.
Redact secrets before hashing the retained artifact. No success template/real
receipt is supplied; the only passing fixture lives explicitly in synthetic tests.
A valid structure is merely ready for artifact review, never an authority permit.

## Remaining blockers

The supported runtime/storage/history/issuer backends and mandatory native routes
are absent or uninstalled. Exact all-command deployment/fault-injector/restart
procedures and immutable images remain blocked on reviewed mechanism selection
and activation. Therefore no fabricated kubectl/API mutation command is given:
the operator must supply the reviewed narrowly scoped mechanism before tasks8–10.
No provider calls, live inspection, provisioning, restart, dispatch, deployment,
publication, migrations, purchases or merges are authorized now. Actual renewal,
complete Git/PR delivery, real fault recovery and provider acceptance are NOT RUN.
The result collector cannot resolve those blockers.

Verification: nine pure stdlib unit methods (including strict counter/hash type regressions);
root records final integrated PASS timing; no subprocess,
network, database, container, build or full typecheck graph. Existing unchanged
hosted source/image verification is reused only for its original scope.
