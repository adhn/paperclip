# SSH lease stop binding

Follow-up to PR #3. Apply `ssh-lease-stop.patch` only after the existing exact-source descendant-stop backport; the preparer checks post-backport hashes and patch anchors. No upstream revision, schema, runner, storage, permission or network change.

The SSH process result carries the supervisor invocation UUID only after verified cleanup. The adapter's final-invocation fence passes it to the host callback before copy-back; a later uncertain attempt invalidates earlier proof. The callback binds it to the host-selected company, agent, run, environment and lease. The SSH driver releases that exact lease with cleanup success only for a matching bound receipt. Shared target URIs and SSH exit status alone grant no authority.

Process stop, file recovery and lease release remain separate obligations. Missing proof fails closed. Existing released leases are never backfilled. Historical cancelled agents stay held pending a separate explicit reconciliation path; this change does not make old acknowledgements into evidence.

Candidate CI must build/typecheck the source, run the adapter, database and actual-SSH regression suites, and publish an immutable controller digest. Pin only that verified digest in the workload before human review/merge. Recheck no active runs immediately before merge. Let Flux deploy, check actual image/readiness, then use an existing fully paused disposable agent for cancellation → fully paused → resume → successful fresh task. Do not create more replacement agents. Retain earlier evidence and keep Gemini authentication deferred and concurrency expansion held.

Rollback: after draining/reconciling work, restore the prior controller digest through GitOps. This does not reconcile old leases or stop remote processes itself.
