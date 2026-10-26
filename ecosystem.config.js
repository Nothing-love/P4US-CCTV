/**
 * Konfigurasi PM2 untuk P4US CCTV.
 * Jalankan:  pm2 start ecosystem.config.js
 *
 * Catatan: database memakai node:sqlite (WAL) satu proses, jadi mode "fork"
 * dengan 1 instance — JANGAN pakai cluster/instances>1 (akan bentrok DB).
 */
module.exports = {
  apps: [
    {
      name: 'p4us-cctv',
      script: 'backend/server.js',
      cwd: __dirname,
      // node:sqlite butuh flag ini di Node 22.5–23.x; di Node 24+ flag diterima
      // dan tidak berpengaruh. Jadi aman untuk semua Node ≥ 22.5.
      node_args: '--experimental-sqlite',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '600M',
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        PORT: 6969,
      },
      error_file: 'backend/logs/pm2-error.log',
      out_file: 'backend/logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
