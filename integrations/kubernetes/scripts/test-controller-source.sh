#!/bin/sh
set -eu
pnpm --filter @paperclipai/adapter-utils typecheck
pnpm --filter @paperclipai/server typecheck
pnpm exec vitest run packages/adapter-utils/src/server-utils.test.ts packages/adapter-utils/src/ssh-command-managed.test.ts packages/adapter-utils/src/provider-stopped-boundary.test.ts
# Only test-image native-library alias/cache directories need writable ownership.
# PostgreSQL cannot run as root; keep all nine DB cases active.
chown node:node /app/node_modules/.pnpm/embedded-postgres*/node_modules/@embedded-postgres/linux-x64/native/lib
mkdir -p /app/server/node_modules/.vite /app/server/node_modules/.vite-temp
chown node:node /app/server/node_modules/.vite /app/server/node_modules/.vite-temp
exec su node -s /bin/sh -c 'HOME=/tmp node /app/node_modules/vitest/vitest.mjs run --config /app/server/vitest.config.ts --root /app/server --configLoader native src/services/heartbeat/run-control.test.ts src/services/heartbeat/ssh-lease-stop.test.ts src/services/heartbeat/runtime-execution.test.ts'
