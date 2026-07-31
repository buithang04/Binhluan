#!/usr/bin/env node
/**
 * One-command local stack:
 *   docker (Postgres + Redis) → env sync → api + worker + scheduler + Next
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import concurrently from "concurrently";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const apm = path.join(root, "automation-profile-manager");
const isWin = process.platform === "win32";

function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: opts.cwd ?? root, ...opts });
}

function trySh(cmd, args, opts = {}) {
  try {
    execFileSync(cmd, args, {
      stdio: "pipe",
      cwd: opts.cwd ?? root,
      encoding: "utf8",
      ...opts,
    });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureDockerDesktop() {
  if (trySh("docker", ["info"])) return true;
  if (!isWin) {
    console.error("Docker engine is not running. Start Docker, then retry.");
    return false;
  }
  const candidates = [
    path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Docker", "Docker", "Docker Desktop.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Docker", "Docker Desktop.exe"),
  ];
  const exe = candidates.find((p) => p && existsSync(p));
  if (!exe) {
    console.error("Docker Desktop not found. Install/start Docker, then retry.");
    return false;
  }
  console.log("Starting Docker Desktop…");
  spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 60; i++) {
    if (trySh("docker", ["info"])) {
      console.log("Docker ready");
      return true;
    }
    await sleep(3000);
  }
  console.error("Docker engine did not become ready in time.");
  return false;
}

async function waitHealthy(container, label, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const status = execFileSync(
        "docker",
        ["inspect", "--format", "{{.State.Health.Status}}", container],
        { encoding: "utf8" },
      ).trim();
      if (status === "healthy") {
        console.log(`${label} healthy`);
        return true;
      }
    } catch {
      /* container may not exist yet */
    }
    await sleep(1500);
  }
  console.warn(`${label} not healthy yet — continuing anyway`);
  return false;
}

async function main() {
  if (!(await ensureDockerDesktop())) process.exit(1);

  console.log("→ docker compose up -d");
  sh("docker", ["compose", "up", "-d"]);

  await waitHealthy("automation-profile-manager-postgres-1", "postgres");
  await waitHealthy("automation-profile-manager-redis-1", "redis");

  console.log("→ env:sync");
  sh(process.execPath, [path.join(apm, "scripts", "env-sync.js")], { cwd: apm });

  const webMode = (process.env.WEB_MODE || "dev").toLowerCase();
  const webCommand =
    webMode === "prod"
      ? "npx next start -H 0.0.0.0 -p 3000"
      : "npx next dev -H 0.0.0.0 -p 3000 --turbopack";
  console.log(
    `→ web mode: ${webMode === "prod" ? "production (stable LAN)" : "development (turbopack)"}`,
  );

  // Build web trước khi bật API/worker để tránh Prisma query_engine.dll lock trên Windows.
  if (webMode === "prod") {
    const skipBuild =
      process.env.SKIP_WEB_BUILD === "1" ||
      (existsSync(path.join(root, ".next", "BUILD_ID")) &&
        process.env.FORCE_WEB_BUILD !== "1");
    if (skipBuild) {
      console.log("→ skip web build (đã có .next) — FORCE_WEB_BUILD=1 để build lại");
    } else {
      console.log("→ building web (production)...");
      if (isWin) {
        sh("cmd", ["/c", "npm run build"], { cwd: root });
      } else {
        sh("npm", ["run", "build"], { cwd: root });
      }
    }
  }

  console.log("→ api · worker · scheduler · next\n");
  const { result } = concurrently(
    [
      {
        name: "api",
        command: "npm run start:dev -w @apm/api",
        cwd: apm,
        prefixColor: "green",
      },
      {
        name: "worker",
        command: "npm run start:dev -w @apm/worker",
        cwd: apm,
        prefixColor: "yellow",
      },
      {
        name: "scheduler",
        command: "npm run start:dev -w @apm/scheduler",
        cwd: apm,
        prefixColor: "magenta",
      },
      {
        name: "web",
        command: webCommand,
        cwd: root,
        prefixColor: "cyan",
      },
    ],
    {
      prefix: "name",
      killOthersOn: ["failure"],
      restartTries: 0,
    },
  );

  const outcomes = await result;
  const failed = outcomes.some((o) => o.exitCode !== 0 && o.exitCode !== null);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
