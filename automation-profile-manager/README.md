# Automation Profile Manager (API + Worker)

Phần automation của sản phẩm thống nhất (DB Postgres chung với Next.js UI).

## Quick start

```bash
# từ repo root hoặc đây — cùng project Docker
docker compose up -d
npm run env:sync
npm install
npm run build -w @apm/shared && npm run build -w @apm/crypto
npm run db:generate && npm run db:migrate && npm run db:seed

npm run dev:api
npm run dev:scheduler
npm run dev:worker
# Vite admin tạm (đã port sang Next /admin/*) — tuỳ chọn:
npm run dev:web
```

UI chính: **http://localhost:3000** (Next — login chung, `/admin`, `/app`).

API: http://localhost:4000/api · Admin mẫu: `admin@apm.local` / `Admin@123`

## Migrate CRM MySQL → Postgres (một lần)

```bash
docker compose -f ../docker-compose.crm.yml up -d mysql
npm run migrate:crm
docker compose -f ../docker-compose.crm.yml stop
```
