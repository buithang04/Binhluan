#!/usr/bin/env node
/**
 * Đảm bảo REVIEW_CRON_SECRET có trong .env gốc — cron quét/review-dispatch luôn sẵn sàng khi bật hệ thống.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");

if (!existsSync(envPath)) {
  console.warn("ensure-cron-secret: .env chưa có — bỏ qua");
  process.exit(0);
}

const text = readFileSync(envPath, "utf8");
if (/^REVIEW_CRON_SECRET=/m.test(text)) {
  process.exit(0);
}

const secret = randomBytes(24).toString("hex");
const block = `\n# Tự sinh — dùng cho cron nội bộ / gọi API cron\nREVIEW_CRON_SECRET="${secret}"\n`;
writeFileSync(envPath, `${text.replace(/\s*$/, "")}${block}`);
console.log("ensure-cron-secret: đã thêm REVIEW_CRON_SECRET vào .env");
