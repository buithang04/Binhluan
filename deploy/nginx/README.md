# Nginx — deploy APM trên server

## Kiến trúc

```
Internet → :443 nginx → :3000 Next (UI + /apm-api rewrite)
                      → :4000 Nest API (location /api/ tuỳ chọn)
Worker / Scheduler → gọi thẳng http://127.0.0.1:4000/api (không qua nginx)
Chrome (headless/Xvfb) → chạy trên cùng máy worker
```

## Env khi đổi domain (chỉ sửa root `.env`)

```env
APP_URL="https://apm.example.com"
NEXTAUTH_URL="https://apm.example.com"
APM_API_URL="http://127.0.0.1:4000/api"
NEXT_PUBLIC_APM_API_URL=""
```

Chạy `npm run env:sync` trong `automation-profile-manager` (hoặc `npm run dev`) —
script tự ghi `APP_URL` + `WEB_ORIGIN` vào Nest/worker từ `APP_URL` ở repo root.

CORS Nest đọc theo thứ tự: `WEB_ORIGIN` → `APP_URL` → `NEXTAUTH_URL`.

## SSL nhanh (certbot)

```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo cp deploy/nginx/apm.conf /etc/nginx/sites-available/apm
# sửa server_name + tạm dùng block HTTP-only nếu chưa có cert
sudo ln -sf /etc/nginx/sites-available/apm /etc/nginx/sites-enabled/apm
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d apm.example.com
```

## Firewall

Mở 80/443; không mở 3000/4000 ra public nếu đã có nginx.
