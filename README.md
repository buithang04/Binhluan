# Binhluan — CRM + Automation Profile Manager (thống nhất)

Một sản phẩm: **1 đăng nhập**, **Admin** cấu hình, **User** dùng & truyền liệu.  
**Database duy nhất:** PostgreSQL (+ Redis cho queue). MySQL CRM chỉ còn file lưu trữ migrate.

## Chạy local (1 lệnh)

Từ **root** repo (sau lần đầu `npm install` ở root + trong `automation-profile-manager`):

```bash
npm run dev
```

Lệnh này tự: bật Docker Desktop nếu cần → `docker compose up` (Postgres `:5433` + Redis `:6379`) → sync `.env` APM → chạy **API + worker + scheduler + Next**.

- UI: http://localhost:3000/login  
- Admin: `/admin` · User: `/app`  
- API: http://localhost:4000/api  
- Tài khoản mẫu: `admin@apm.local` / `Admin@123`

Chỉ UI: `npm run dev:web` · Chỉ infra: `npm run docker:up`

### Setup lần đầu (một lần)

```bash
npm install
cd automation-profile-manager && npm install
npm run build -w @apm/shared && npm run build -w @apm/crypto
npm run db:generate && npm run db:migrate && npm run db:seed
cd ..
# đảm bảo có .env (DATABASE_URL postgres :5433) và automation-profile-manager/.env
```

## MySQL CRM (legacy — không chạy mặc định)

```bash
docker compose -f docker-compose.crm.yml up -d mysql   # port 3307, volume mysql_data giữ nguyên
```

Chỉ bật khi cần migrate dữ liệu cũ sang Postgres (`npm run migrate:crm` trong APM).

## Deploy lên server

Toàn bộ lệnh cài đặt, PM2, Nginx, URL các trang admin, curl API, backup: xem **[deploy/README.md](deploy/README.md)**.

## Cấu trúc

| Phần | Vai trò |
|------|---------|
| `src/` (Next.js) | UI chung: login, `/admin`, `/app` |
| `automation-profile-manager/` | Nest API, worker, scheduler, Prisma (Postgres) |
| `deploy/` | Nginx + README vận hành server |
| `docker-compose.crm.yml` | MySQL legacy (stopped by default) |
