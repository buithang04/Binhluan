# Deploy & thao tác trên Server

Hướng dẫn đẩy hệ thống lên server, mở các trang admin, và các lệnh vận hành thường dùng.

---

## 1. Kiến trúc trên server

| Thành phần | Port nội bộ | Vai trò |
|------------|-------------|---------|
| Nginx | `80` / `443` | Reverse proxy công khai |
| Next.js (UI) | `3000` | Login, `/admin/*`, `/app/*` |
| Nest API | `4000` | REST `/api` |
| Worker | — | Chrome / Puppeteer (ngầm) |
| Scheduler | — | Xếp job định kỳ |
| Postgres | `5433` (hoặc `5432` trong Docker) | DB |
| Redis | `6379` | Queue BullMQ |

```
Internet → Nginx :443 → Next :3000
                       → Nest :4000 (/api)
Worker/Scheduler → http://127.0.0.1:4000/api
Chrome headless → chạy trên máy worker
```

---

## 2. Chuẩn bị server (lần đầu)

```bash
# Cập nhật hệ thống (Ubuntu/Debian)
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl nginx certbot python3-certbot-nginx

# Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # >= 20

# Docker
sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER
# logout/login lại rồi kiểm tra:
docker --version

# Chrome (cho worker) — Ubuntu
sudo apt install -y google-chrome-stable
# hoặc chromium:
# sudo apt install -y chromium-browser

# (Tuỳ chọn) màn hình ảo nếu Google chặn headless
sudo apt install -y xvfb
```

Clone code:

```bash
cd /opt   # hoặc thư mục bạn chọn
sudo mkdir -p /opt/apm && sudo chown $USER:$USER /opt/apm
cd /opt/apm
git clone <URL_REPO> .
# hoặc: git pull nếu đã có
```

Cài dependency:

```bash
cd /opt/apm
npm install
cd automation-profile-manager && npm install
npm run build -w @apm/shared && npm run build -w @apm/crypto
cd ..
```

---

## 3. File môi trường (.env)

### Root `/opt/apm/.env`

```bash
cp .env.example .env
nano .env
```

Ví dụ production — **đổi domain chỉ cần `APP_URL` (+ `NEXTAUTH_URL` cùng giá trị)**:

```env
APP_URL="https://apm.example.com"
NEXTAUTH_URL="https://apm.example.com"
NEXTAUTH_SECRET="doi-chuoi-bi-mat-dai"
APM_API_URL="http://127.0.0.1:4000/api"
NEXT_PUBLIC_APM_API_URL=""
DATABASE_URL="postgresql://apm:apmsecret@127.0.0.1:5433/apm"
```

Sau đó chạy `cd automation-profile-manager && npm run env:sync` — tự ghi `APP_URL` / `WEB_ORIGIN` vào Nest/worker.

### APM `/opt/apm/automation-profile-manager/.env`

```bash
cp automation-profile-manager/.env.example automation-profile-manager/.env
nano automation-profile-manager/.env
```

```env
DATABASE_URL="postgresql://apm:apmsecret@127.0.0.1:5433/apm"
REDIS_URL="redis://127.0.0.1:6379"
JWT_ACCESS_SECRET="doi-secret-access-min-32-ky-tu!!!!"
JWT_REFRESH_SECRET="doi-secret-refresh-min-32-ky-tu!!!"
ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
API_PORT=4000
API_BASE_URL="http://127.0.0.1:4000/api"
# WEB_ORIGIN/APP_URL được env:sync lấy từ root APP_URL — không cần sửa tay
APP_URL="https://apm.example.com"
WEB_ORIGIN="https://apm.example.com"
INTERNAL_API_TOKEN="doi-token-internal-worker"
PROFILE_STORAGE_DIR="./data/profiles"
WORKER_CONCURRENCY=2
WORKER_HEADLESS=true
WORKER_KEEP_BROWSER_ALIVE=true
WORKER_USE_PROXY=true
WORKER_CHROME_CHANNEL=chrome
# PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
```

Đồng bộ env sang các app:

```bash
cd /opt/apm/automation-profile-manager
npm run env:sync
```

---

## 4. Database & Redis

```bash
cd /opt/apm
docker compose up -d

# Kiểm tra
docker compose ps
docker compose logs -f postgres
```

Migrate + seed admin:

```bash
cd /opt/apm
npm run db:generate
npm run db:migrate
npm run db:seed
```

Tài khoản mặc định sau seed:

- Email: `admin@apm.local`
- Password: `Admin@123`
- **Đổi mật khẩu ngay trên production.**

---

## 5. Chạy app bằng PM2 (khuyến nghị)

```bash
sudo npm install -g pm2
cd /opt/apm
```

Tạo file `deploy/ecosystem.config.cjs` nếu chưa có, hoặc chạy tay:

```bash
# Build Next
cd /opt/apm
npm run build

# Build APM packages + api/worker/scheduler
cd /opt/apm/automation-profile-manager
npm run build -w @apm/shared
npm run build -w @apm/crypto
npm run build -w @apm/prisma
npm run build -w @apm/api
npm run build -w @apm/worker
npm run build -w @apm/scheduler
```

### Lệnh PM2 khởi động (dùng ecosystem)

```bash
cd /opt/apm

pm2 delete apm-api apm-worker apm-scheduler apm-web 2>/dev/null || true
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup
# làm theo lệnh in ra (systemd enable)
```

### (Tuỳ chọn) Xvfb cho Chrome “có màn hình ảo”

```bash
# Chạy một lần mỗi reboot
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
# Thêm vào ecosystem / systemd của worker: DISPLAY=:99
pm2 restart apm-worker --update-env
```

### Lệnh PM2 hàng ngày

```bash
pm2 status
pm2 logs                  # tất cả
pm2 logs apm-worker       # chỉ worker
pm2 logs apm-api --lines 100
pm2 restart all
pm2 restart apm-worker
pm2 stop apm-worker
pm2 start apm-worker
pm2 monit
```

---

## 6. Nginx + HTTPS

```bash
# Copy cấu hình (sửa server_name trong file trước)
sudo nano /opt/apm/deploy/nginx/apm.conf
# đổi apm.example.com → domain thật

sudo cp /opt/apm/deploy/nginx/apm.conf /etc/nginx/sites-available/apm
sudo ln -sf /etc/nginx/sites-available/apm /etc/nginx/sites-enabled/apm
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t
sudo systemctl reload nginx

# SSL
sudo certbot --nginx -d apm.example.com
sudo certbot renew --dry-run
```

Firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
sudo ufw status
# KHÔNG mở 3000, 4000, 5433, 6379 ra ngoài
```

---

## 7. Các trang web (sau khi lên server)

Thay `https://apm.example.com` bằng domain của bạn.

| Trang | URL | Việc làm |
|-------|-----|----------|
| Đăng nhập | `https://apm.example.com/login` | Login admin |
| Dashboard Admin | `https://apm.example.com/admin` | Tổng quan |
| **Google Accounts** | `https://apm.example.com/admin/accounts` | Thêm/sửa/xóa email, Mở/Reset browser |
| Proxies | `https://apm.example.com/admin/proxies` | Proxy Webshare / thủ công |
| Profiles | `https://apm.example.com/admin/profiles` | Hồ sơ Chrome gắn account |
| Jobs | `https://apm.example.com/admin/jobs` | Lịch sử LOGIN / HEALTHCHECK |
| Packages | `https://apm.example.com/admin/packages` | Gói dịch vụ |
| Templates | `https://apm.example.com/admin/templates` | Mẫu nội dung |
| App User | `https://apm.example.com/app` | Khu vực user |

### Thao tác trên `/admin/accounts` (UI)

1. **+ Thêm email** → nhập Gmail + mật khẩu → tick “Tự gắn proxy + mở Chrome”
2. **Import Excel** → tải file mẫu / chọn `.xlsx` có cột `email`, `password` (tuỳ chọn `recoveryEmail`) → Import
3. **Mở** → worker mở/reconnect Chrome login (server ngầm)
4. **Hiện** → focus browser đang alive (trên server không thấy cửa sổ trên laptop)
5. **Sửa** → đổi email/mk (đổi email = profile Chrome mới)
6. **Reset** → xóa session cũ, login lại
7. **Xóa** → xóa account + profile
8. Đèn **READY** = đã login myaccount · **alive** = Chrome process còn trên server

---

## 8. Lệnh API (curl) — thao tác không cần mở UI

Lấy token:

```bash
TOKEN=$(curl -s -X POST https://apm.example.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@apm.local","password":"Admin@123"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")

echo $TOKEN
```

### Accounts

```bash
# Danh sách
curl -s https://apm.example.com/api/accounts \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# Import hàng loạt (sau khi parse Excel → JSON)
curl -s -X POST https://apm.example.com/api/accounts/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"accounts":[{"email":"a@gmail.com","password":"MatKhau123"},{"email":"b@gmail.com","password":"MatKhau456"}],"updateExisting":false}'

# Thêm account
curl -s -X POST https://apm.example.com/api/accounts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@gmail.com","password":"mat-khau-gmail"}'

# Sửa account (ACCOUNT_ID = uuid)
curl -s -X PUT https://apm.example.com/api/accounts/ACCOUNT_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"moi@gmail.com","status":"UNREADY"}'

# Reset Chrome profile (xóa session cũ)
curl -s -X POST https://apm.example.com/api/accounts/ACCOUNT_ID/reset-browser \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

# Xóa account
curl -s -X DELETE https://apm.example.com/api/accounts/ACCOUNT_ID \
  -H "Authorization: Bearer $TOKEN"
```

### Profiles / mở browser

```bash
# Auto gắn proxy + mở login
curl -s -X POST https://apm.example.com/api/profiles/auto-assign \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"accountId":"ACCOUNT_ID","openLogin":true}'

# Mở / reconnect / focus browser
curl -s -X POST https://apm.example.com/api/profiles/PROFILE_ID/open-browser \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

# Focus
curl -s -X POST https://apm.example.com/api/profiles/PROFILE_ID/focus-browser \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Proxies & Jobs

```bash
# List proxy
curl -s https://apm.example.com/api/proxies \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# Sync Webshare (cần WEBSHARE_API_TOKEN trong .env)
curl -s -X POST https://apm.example.com/api/proxies/sync-webshare \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

# Jobs gần nhất
curl -s "https://apm.example.com/api/jobs?limit=20" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

> Nếu nginx chỉ proxy Next `:3000` mà không expose `/api`, dùng:
> `http://127.0.0.1:4000/api/...` **trên server** (SSH vào rồi curl localhost).

```bash
# Trên server — gọi API nội bộ
curl -s http://127.0.0.1:4000/api/accounts \
  -H "Authorization: Bearer $TOKEN"
```

---

## 9. Git deploy / cập nhật bản mới

```bash
cd /opt/apm
git pull

npm install
cd automation-profile-manager && npm install && npm run env:sync && cd ..

npm run db:generate
npm run db:migrate

# Build lại
cd automation-profile-manager
npm run build -w @apm/shared && npm run build -w @apm/crypto && npm run build -w @apm/prisma
npm run build -w @apm/api && npm run build -w @apm/worker && npm run build -w @apm/scheduler
cd ..
npm run build

pm2 restart all
pm2 logs --lines 50
```

---

## 10. Backup & bảo trì

```bash
# Backup Postgres
docker compose exec -T postgres pg_dump -U apm apm > backup-$(date +%F).sql

# Restore
cat backup-YYYY-MM-DD.sql | docker compose exec -T postgres psql -U apm apm

# Backup Chrome profiles (session login)
tar -czf profiles-$(date +%F).tar.gz \
  automation-profile-manager/apps/worker/data/profiles

# Xem dung lượng
du -sh automation-profile-manager/apps/worker/data/profiles
df -h
```

---

## 11. Kiểm tra sức khỏe

```bash
# Process
pm2 status
docker compose ps

# Port lắng nghe
ss -tlnp | grep -E '80|443|3000|4000|5433|6379'

# API sống?
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4000/api
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/login

# Nginx
sudo nginx -t
sudo systemctl status nginx

# Log lỗi
pm2 logs apm-worker --err --lines 80
sudo journalctl -u nginx -n 50 --no-pager
```

---

## 12. Sự cố thường gặp

| Hiện tượng | Cách xử lý |
|------------|------------|
| UI 502 | `pm2 restart apm-web` · kiểm tra `:3000` |
| Login 401 | Đăng nhập lại · kiểm tra `JWT_*` / `NEXTAUTH_*` |
| Account alive sai | Tắt Chrome → chờ ~10s · `pm2 restart apm-worker` |
| LOGIN fail Google | Xem `pm2 logs apm-worker` · thử `DISPLAY=:99` + Xvfb · hoặc login tay qua VNC |
| Proxy hết slot | Sync Webshare / tăng `maxProfiles` |
| Disk đầy | Xóa profile cũ / backup rồi `rm` thư mục profile không dùng |

```bash
# Restart sạch worker + clear stuck
pm2 restart apm-worker apm-api
docker compose restart redis
```

---

## 13. Tóm tắt lệnh hay dùng nhất

```bash
# Vào project
cd /opt/apm

# Infra
docker compose up -d
docker compose ps

# App
pm2 status
pm2 restart all
pm2 logs apm-worker

# Cập nhật code
git pull && npm run db:migrate && pm2 restart all

# Mở trang (trên máy bạn)
# https://apm.example.com/login
# https://apm.example.com/admin/accounts
```

Chi tiết nginx: xem thêm `deploy/nginx/README.md` và `deploy/nginx/apm.conf`.
