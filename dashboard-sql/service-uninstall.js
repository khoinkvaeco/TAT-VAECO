/**
 * ============================================================================
 *  service-uninstall.js  -  Go Windows Service "DashboardTAT"
 *  Chay: CMD/PowerShell "Run as Administrator" -> npm run service:uninstall
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
  script: path.join(__dirname, 'server.js'),
});

svc.on('uninstall', () => console.log('✔ Da go service "DashboardTAT".'));
svc.on('error', (err) => console.error('✖ Loi:', err));

console.log('Dang go service (CAN quyen Administrator)...');
svc.uninstall();
