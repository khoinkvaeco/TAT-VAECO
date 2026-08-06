/**
 * SMOKE TEST - bat loi LAP TRINH trong cac ham dung cau SQL, KHONG can SQL Server.
 * ---------------------------------------------------------------------------
 * VI SAO CAN: chay `npm start` voi DEMO_MODE=true KHONG he goi cac ham dung cau
 * SQL (chung bi thay bang du lieu mau), con `node --check` chi kiem cu phap.
 * Nen mot loi kieu "Cannot access 'dept' before initialization" van lot qua ca
 * hai, den luc chay that moi vo.
 *
 * CACH LAM: bat server o che do LIVE nhung tro vao mot dia chi DB KHONG ton tai.
 * Moi endpoint se chay HET phan dung cau SQL roi moi chet o buoc ket noi.
 *   - Loi ket noi        -> DAT (code chay tot)
 *   - Bat ky loi nao khac -> TRUOT (loi lap trinh that)
 *
 * CHAY:  npm run smoke
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 3399);
const BASE = `http://127.0.0.1:${PORT}`;

// Cac endpoint co chay truy van SQL (khong ke endpoint tinh/đoc file)
const ENDPOINTS = [
  '/api/tat/departments',
  '/api/tat/cuvt',
  '/api/dashboard',
  '/api/reports/returned-unservice',
  '/api/reports/issued-not-installed',
  '/api/reports/removed-not-returned',
  '/api/reports/not-reconciled',
  '/api/reports/manual-pair',
  '/api/reports/removed-before-installed',
  '/api/reports/other',
  '/api/reports/return-store-tat',
  '/api/reports/repair-admin',
  // Cac endpoint chan doan (chi IP quan tri - chay tu localhost nen qua duoc)
  '/api/admin/diag/dept',
  '/api/admin/diag/higher',
  '/api/admin/diag/pairing',
  '/api/admin/diag/rbi',
];

/** Loi NAY la binh thuong: khong co DB that de ket noi. */
const CONN_ERROR = /Failed to connect|ETIMEOUT|ESOCKET|ECONNREFUSED|ECONNRESET|Could not connect|Login failed|getaddrinfo/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      DEMO_MODE: 'false',
      PORT: String(PORT),
      DB_SERVER: '127.0.0.1',
      DB_PORT: '1',           // cong chac chan khong co SQL Server
      DB_USER: 'smoke',
      DB_PASSWORD: 'smoke',
      SIGN_CACHE: 'false',
    },
    stdio: 'ignore',
  });

  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
    await sleep(500);
    try { await fetch(`${BASE}/api/whoami`); ok = true; } catch (_) { /* chua len */ }
  }
  if (!ok) {
    srv.kill();
    console.error('✖ Khong khoi dong duoc server de kiem tra.');
    process.exit(1);
  }

  const fails = [];
  for (const ep of ENDPOINTS) {
    let note = '';
    try {
      const res = await fetch(BASE + ep);
      const body = await res.json().catch(() => ({}));
      const msg = String(body.message || body.loi || '');
      // Endpoint chan doan bat loi ben trong -> soi cac truong con
      const inner = JSON.stringify(body).match(/"loi":"([^"]+)"/g) || [];
      const allMsgs = [msg, ...inner.map((x) => x.slice(7, -1))].filter(Boolean);
      const bad = allMsgs.filter((m) => m && !CONN_ERROR.test(m));
      if (bad.length) { fails.push({ ep, msg: bad[0] }); note = '✖ ' + bad[0].slice(0, 70); }
      else note = '✔ ' + (allMsgs.length ? 'loi ket noi (mong doi)' : 'ok');
    } catch (e) {
      fails.push({ ep, msg: e.message });
      note = '✖ ' + e.message;
    }
    console.log(ep.padEnd(38), note);
  }

  srv.kill();
  await sleep(300);
  if (fails.length) {
    console.error(`\n✖ TRUOT: ${fails.length}/${ENDPOINTS.length} endpoint co loi lap trinh.`);
    for (const f of fails) console.error(`   ${f.ep}: ${f.msg}`);
    process.exit(1);
  }
  console.log(`\n✔ DAT: ${ENDPOINTS.length}/${ENDPOINTS.length} endpoint dung cau SQL khong loi.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
