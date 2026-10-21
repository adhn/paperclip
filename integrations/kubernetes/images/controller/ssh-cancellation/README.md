# SSH descendant-stop backport

Evaluation-only patch for upstream `252d9b5077f4eee98ec48225641ef1a02d824158`.
`source-sha256.json` and unique patch anchors reject unexpected source. No database,
provider CLI, runner image, network-policy or privilege changes are introduced.

The old legacy CLI path could acknowledge cancellation after terminating only the
controller SSH client. A live two-agent test left the remote Codex provider and
Python child running and writing after that acknowledgement.

Each SSH provider invocation now has a Linux/Python supervisor and unpredictable
control directory under its remote `.paperclip-runtime`. A startup/stop flock
prevents late-start races. The supervisor uses Linux CHILD_SUBREAPER to own and
reap descendants, including separate sessions/process groups. Stop requests TERM,
then KILL after two seconds. A receipt exists only after waitpid reports no more
children; pidfd signaling avoids PID reuse. Normal provider exit also drains its
background descendants. The control interpreters use isolated Python imports, preventing workspace
modules and PYTHONPATH from shadowing their standard library. No provider prompt,
token or environment is stored in control files. Tombstones are retained to fence late starts.

The shared running-process handle exposes `stopRemote`. Heartbeat awaits its
receipt before cancellation acknowledgement; verified normal SSH cleanup precedes
workspace restoration. Missing/unreachable/error receipts reject cleanup and
cancellation. CLI timeout/client exit uses the same remote cleanup. This is not a
sandbox boundary against hostile same-UID processes and does not establish
controller/runner crash recovery, durable stop across controller restart, or token
refresh correctness. Pinned adapters retain best-effort error-finally restore
attempts after a missing stop receipt; these are not consistent recovery snapshots. Linux procfs, Python3, flock, subreaper and pidfd support are
required; unsupported targets fail before starting provider work.

Verification:

- `python3 scripts/test-ssh-cancellation.py`: real subprocess races, detached
  TERM-ignoring child, sibling survival, stdin/exit status, background cleanup,
  cancellation before late start, and failed receipts.
- `scripts/patch-ssh-cancellation.py CONTEXT`: exact-source patch and heartbeat
  regression asserting no terminal acknowledgement on a missing remote receipt.
- `python3 scripts/test-controller-ssh-cancellation.py CONTROLLER_IMAGE RUNNER_IMAGE`:
  actual compiled adapter path over strict-host-checked SSH to a restricted,
  credential-free Docker runner; simultaneous same-cwd invocations, detached
  child cancellation, sibling completion and timeout cleanup.
- Candidate CI typechecks adapter-utils/server and runs focused upstream tests.

Deploy only an immutable verified controller digest through a human-reviewed
GitOps merge. Repeat the real two-agent/two-project Codex test after deployment,
including stopped remote descendants, stable tick files, sibling completion and
copy-back before declaring the cancellation gate passed. Gemini stays deferred.
