#!/bin/sh
set -e
npx prisma migrate deploy
npx tsx prisma/seed.ts
exec npm run start
