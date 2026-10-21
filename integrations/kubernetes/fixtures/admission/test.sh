#!/bin/sh
set -eu
# Run only inside the disposable source test image. No production DB input.
test -d /app/node_modules
chown node:node /app/node_modules/.pnpm/embedded-postgres*/node_modules/@embedded-postgres/linux-x64/native/lib
exec su node -s /bin/sh -c 'HOME=/tmp node --test /fixture/ledger.test.mjs'
