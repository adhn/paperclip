#!/bin/sh
set -eu
# Explicit test-only image; no external DB or network. PostgreSQL runs non-root.
cd /app/packages/db
./node_modules/.bin/tsx src/check-migration-numbering.ts
./node_modules/.bin/tsx src/check-migration-safety.ts
GOMEMLIMIT=2GiB GOGC=50 GOMAXPROCS=2 ./node_modules/.bin/tsc --noEmit
cd /app
mkdir -p /etc/paperclip-admission-fixture/..data
printf '%s\n' '{"version":1,"mode":"held","instance":"fixture-instance","pendingLimit":4,"legacyOwners":[]}' > /etc/paperclip-admission-fixture/..data/policy.json
chmod 444 /etc/paperclip-admission-fixture/..data/policy.json
ln -s ..data/policy.json /etc/paperclip-admission-fixture/policy.json
chown node:node /app/node_modules/.pnpm/embedded-postgres*/node_modules/@embedded-postgres/linux-x64/native/lib
# CI COPY creates root-owned project directories. Vite writes bundled config
# files beside each project config and caches beneath node_modules. Change only
# the shallow source/cache directories, not the frozen dependency file tree.
find /app -maxdepth 4 -type d -not -path '/app/node_modules/*' -exec chown node:node {} +
su node -s /bin/sh -c 'HOME=/tmp ./node_modules/.bin/vitest run --silent=true server/src/__tests__/protected-execution-journal.test.ts server/src/__tests__/protected-stdin-authority-client.test.ts server/src/__tests__/legacy-evidence-bridge.test.ts server/src/__tests__/protected-execution-transport.test.ts server/src/__tests__/execution-legacy-reconciliation.test.ts server/src/__tests__/execution-admission-bootstrap.test.ts server/src/__tests__/execution-admission.test.ts server/src/__tests__/execution-capacity-recovery.test.ts server/src/__tests__/agents-capacity-models.test.ts server/src/services/heartbeat/queue.test.ts server/src/__tests__/heartbeat-queued-run-claim-isolation.test.ts server/src/__tests__/heartbeat-auto-checkout.test.ts server/src/__tests__/heartbeat-comment-wake-batching.test.ts server/src/__tests__/heartbeat-task-drain-admission-release.test.ts server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts server/src/__tests__/environment-probe.test.ts server/src/__tests__/agent-harness-verification.test.ts server/src/services/heartbeat/workspace-preparation.test.ts server/src/services/heartbeat/run-control.test.ts server/src/services/heartbeat/runtime-execution.test.ts server/src/services/heartbeat/ssh-lease-stop.test.ts server/src/modules/agent-lifecycle/__tests__/lifecycle.test.ts packages/adapters/codex-local/src/server/codex-auth-copyback.test.ts packages/adapter-utils/src/remote-managed-runtime.test.ts'
cd /app/server
# Keep local development bounded. The full server graph exceeded the laptop's
# test-container memory limit; this checks the service and its imported contracts.
node --input-type=module -e 'import fs from "node:fs"; fs.writeFileSync("tsconfig.admission-test.json", JSON.stringify({extends:"./tsconfig.json",include:["src/services/execution-admission-bootstrap.ts","src/services/execution-admission.ts","src/services/execution-capacity-lifetime.ts","src/services/protected-execution-journal.ts","src/services/protected-execution-transport.ts","src/services/protected-stdin-authority-client.ts","src/services/legacy-evidence-bridge.ts","src/services/execution-legacy-reconciliation.ts","src/types/express.d.ts"],exclude:[]}))'
GOMEMLIMIT=2GiB GOGC=50 GOMAXPROCS=2 ./node_modules/.bin/tsc --noEmit -p tsconfig.admission-test.json
echo 'Candidate native admission: database checks, contract cases and focused service typecheck passed'
