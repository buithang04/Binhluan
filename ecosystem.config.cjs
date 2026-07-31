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
        NODE_ENV: "production",
        WEB_MODE: "prod",
        CHROME_DEBUG: "1",
      },
      min_uptime: 30_000,
      max_restarts: 15,
      restart_delay: 10_000,
      kill_timeout: 20_000,
      // treekill giữ mặc định (true): tắt nest/next con khi restart.
      // Chrome Maps không nằm trong tree (Start-Process độc lập) nên vẫn sống.
      autorestart: true,
    },
  ],
};
