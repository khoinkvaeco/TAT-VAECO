/**
 * ============================================================================
 *  service-install.js  -  Cai Dashboard TAT thanh WINDOWS SERVICE
 *  Chay: mo CMD/PowerShell "Run as Administrator" -> npm run service:install
 *  Dung node-windows (thuan JS, cai qua npm) -> khong can tai file ngoai.
 *  Service se: tu chay khi khoi dong may + tu restart neu crash.
 * ============================================================================
 */
'use strict';

if (process.platform !== 'win32') {
  console.error('✖ Script nay chi chay tren Windows. (Hien tai: ' + process.platform + ')');
  process.exit(1);
}

const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'DashboardTAT',
  description: 'VAECO Dashboard bao cao TAT (Node.js + Express + mssql)',
  script: path.join(__dirname, 'server.js'),
  workingDirectory: __dirname, // de server.js doc dung .env va ghi logs/ tai day
  // Node doc bien moi truong tu file .env (dotenv). Neu muon ep bien tai day:
  // env: [{ name: 'NODE_ENV', value: 'production' }],
  // Tu khoi dong lai khi crash:
  wait: 2,           // cho 2s truoc khi restart
  grow: 0.5,         // moi lan that bai tang thoi gian cho
  maxRestarts: 10,   // so lan restart toi da trong 60s (chong loop vo han)
});

svc.on('install', () => {
  console.log('✔ Da cai Windows Service "DashboardTAT". Dang khoi dong...');
  svc.start();
});
svc.on('alreadyinstalled', () => {
  console.log('! Service "DashboardTAT" da ton tai. Neu muon cai lai: npm run service:uninstall roi cai lai.');
});
svc.on('start', () => {
  console.log('✔ Service "DashboardTAT" DANG CHAY. Mo http://localhost:<PORT trong .env> de kiem tra.');
  console.log('  Quan ly: services.msc  hoac  sc stop/start DashboardTAT');
});
svc.on('error', (err) => console.error('✖ Loi service:', err));

console.log('Dang cai service (CAN quyen Administrator)...');
svc.install();
