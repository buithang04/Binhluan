/**
 * PM2 — chạy trên server:
 *   cd /opt/apm
 *   pm2 start deploy/ecosystem.config.cjs
 *   pm2 save && pm2 startup
 *
 * Trước đó phải build:
 *   npm run build
 *   cd automation-profile-manager && npm run build -w @apm/api && npm run build -w @apm/worker && npm run build -w @apm/scheduler
 */
module.exports = {
  apps: [
    {
      name: "apm-api",
      cwd: "automation-profile-manager/apps/api",
      script: "dist/main.js",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "apm-worker",
      cwd: "automation-profile-manager/apps/worker",
      script: "dist/main.js",
      instances: 1,
      autorestart: true,
      max_memory_restart: "2G",
      env: {
        NODE_ENV: "production",
        // WORKER_HEADLESS: "true",
        // DISPLAY: ":99",
      },
    },
    {
      name: "apm-scheduler",
      cwd: "automation-profile-manager/apps/scheduler",
      script: "dist/main.js",
      instances: 1,
      autorestart: true,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "apm-web",
      cwd: ".",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
    },
  ],
};
