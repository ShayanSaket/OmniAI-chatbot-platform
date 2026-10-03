#!/bin/sh
set -e
# Apply pending migrations before starting (safe to run on every boot).
node prisma-cli/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
exec node server.js
