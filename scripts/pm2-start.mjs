#!/usr/bin/env node
/**
 * Docker + env sync + PM2 start/reload (dùng từ start.bat).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const apm = path.join(root, "automation-profile-manager");
const isWin = process.platform === "win32";

function sh(cmd, args, opts = {}) {
  const cwd = opts.cwd ?? root;
  if (isWin && cmd === "pm2.cmd") {
    execFileSync("cmd.exe", ["/c", "pm2", ...args], {
      stdio: "inherit",
      cwd,
      ...opts,
    });
    return;
  }
  execFileSync(cmd, args, { stdio: "inherit", cwd, ...opts });
}

function shOut(cmd, args, opts = {}) {
  const cwd = opts.cwd ?? root;
  if (isWin && cmd === "pm2.cmd") {
    return execFileSync("cmd.exe", ["/c", "pm2", ...args], {
      encoding: "utf8",
      cwd,
      ...opts,
    }).trim();
  }
  return execFileSync(cmd, args, {
    encoding: "utf8",
    cwd,
    ...opts,
  }).trim();
}

function trySh(cmd, args) {
  try {
    shOut(cmd, args, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

console.log("→ ensure REVIEW_CRON_SECRET");
sh(process.execPath, [path.join(root, "scripts", "ensure-cron-secret.mjs")]);

console.log("→ Docker compose up -d");
if (!trySh("docker", ["compose", "up", "-d"])) {
  console.error("Docker chưa chạy — bật Docker Desktop rồi thử lại.");
  process.exit(1);
}

console.log("→ env:sync");
sh(process.execPath, [path.join(apm, "scripts", "env-sync.js")], { cwd: apm });

const pm2 = "pm2.cmd";
const eco = path.join(root, "ecosystem.config.cjs");

const running = trySh(pm2, ["describe", "binhluan"]);
if (running) {
  console.log("→ PM2 reload binhluan");
  sh(pm2, ["reload", eco, "--update-env"]);
} else {
  console.log("→ PM2 start binhluan (WEB_MODE=prod, chạy nền)");
  sh(pm2, ["start", eco]);
}

try {
  sh(pm2, ["save"]);
} catch {
  console.warn("pm2 save skipped");
}

console.log("\n→ Trạng thái PM2:\n");
sh(pm2, ["status"]);

console.log("\nWeb: http://localhost:3000/login");
console.log("Log: pm2 logs binhluan");
console.log("Dừng: stop.bat\n");
