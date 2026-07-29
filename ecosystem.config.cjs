/** PM2 — một process quản lý cả stack (api + worker + scheduler + web). */
const path = require("path");

const root = __dirname;
const nodeBin =
  process.platform === "win32"
    ? process.env.BINHLUAN_NODE || "C:\\binhluan\\tools\\nodejs\\node.exe"
    : process.env.BINHLUAN_NODE || "node";

module.exports = {
  apps: [
    {
      name: "binhluan",
      script: path.join(root, "scripts", "dev.mjs"),
      cwd: root,
      interpreter: nodeBin,
      env: {
        NODE_ENV: "development",
        WEB_MODE: "dev",
      },
      min_uptime: 30_000,
      max_restarts: 15,
      restart_delay: 10_000,
      kill_timeout: 20_000,
      autorestart: true,
    },
  ],
};
