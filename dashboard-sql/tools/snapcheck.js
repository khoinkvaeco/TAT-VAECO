#!/usr/bin/env node
/**
 * SNAPCHECK - kiem tra BAN LUU KPI THEO THANG (data/thang-snapshot.json).
 * ---------------------------------------------------------------------------
 * Bang "So sanh cac thang" tren dashboard doc ban luu de khoi hoi AMOS lai cho
 * nhung thang DA DONG. Loi o day KHONG lam trang chet - no lam trang hien SO
 * SAI mot cach im lang, nguy hiem hon nhieu. Ba cho phai dung:
 *
 *   1. Thang DA DONG -> lay tu ban luu (nhanh)
 *   2. Thang HIEN TAI -> LUON tinh lai (con dang phat sinh)
 *   3. Doi BO LOC -> ban luu RIENG, khong duoc dung nham so cua bo loc khac
 *
 * MEO KIEM THU: chay o DEMO_MODE. Du lieu mau sinh NGAU NHIEN moi lan, nen neu
 * lan 2 tra ve SO Y HET lan 1 thi chac chan la lay tu ban luu chu khong phai
 * tinh lai - khong can DB that van chung minh duoc.
 *
 * CHAY:  node tools/snapcheck.js   (da nam trong `npm run smoke`)
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SNAPCHECK_PORT || 3395);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), `snapcheck-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ket = [];
function kiemTra(ten, dat, chiTiet) {
  ket.push({ ten, dat });
  console.log(`  ${dat ? '✔' : '✘'} ${ten}${chiTiet ? '  — ' + chiTiet : ''}`);
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DEMO_MODE: 'true', PORT: String(PORT), DATA_DIR: DATA,
      LGC_GATE: 'false', API_CACHE_MINUTES: '0' },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(250);
      try { await fetch(`${BASE}/api/health`); up = true; } catch (_) { /* chua len */ }
    }
    if (!up) { console.error('✖ Khong khoi dong duoc server.'); process.exit(1); }

    // Neo vao thang HIEN TAI de "thang cuoi day" dung la thang dang chay
    const n = new Date();
    const thangNay = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
    const goi = (them = '') => fetch(`${BASE}/api/trend?months=6&nocache=1&month=${thangNay}${them}`)
      .then((r) => r.json());
    const daDong = (r) => r.series.filter((x) => x.month !== thangNay).map((x) => x.tatTotal);

    const l1 = await goi();
    kiemTra('Lan dau: chua co ban luu nen phai tinh het', l1.tuSnapshot === 0, `tuSnapshot=${l1.tuSnapshot}/6`);

    const l2 = await goi();
    kiemTra('Lan hai: thang da dong lay tu ban luu', l2.tuSnapshot === 5, `tuSnapshot=${l2.tuSnapshot}/6`);
    kiemTra('So cua thang DA DONG giu nguyen (demo sinh ngau nhien)',
      JSON.stringify(daDong(l1)) === JSON.stringify(daDong(l2)));

    const nay = l2.series.find((x) => x.month === thangNay);
    kiemTra('Thang HIEN TAI luon tinh lai (khong lay ban luu)', nay && nay.tuSnapshot === false);

    // Doi bo loc -> ban luu rieng
    const l3 = await goi('&station=HAN');
    kiemTra('Doi bo loc -> KHONG dung nham ban luu cua bo loc khac',
      l3.tuSnapshot === 0, `tuSnapshot=${l3.tuSnapshot}/6`);
    const l4 = await goi('&station=HAN');
    kiemTra('Moi bo loc co ban luu RIENG', l4.tuSnapshot === 5, `tuSnapshot=${l4.tuSnapshot}/6`);

    const f = path.join(DATA, 'thang-snapshot.json');
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    kiemTra('File ban luu ghi dung (2 bo loc x 5 thang)',
      Object.keys(d.muc).length === 10, `${Object.keys(d.muc).length} ban ghi, version=${d.version}`);

    const xoa = await fetch(`${BASE}/api/admin/snapshot/clear`, { method: 'POST' }).then((r) => r.json());
    const l5 = await goi();
    kiemTra('Xoa ban luu -> tinh lai het', l5.tuSnapshot === 0, `da xoa ${xoa.daXoa} ban`);
  } finally {
    srv.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  const truot = ket.filter((k) => !k.dat);
  console.log('');
  if (truot.length) {
    console.error(`✘ TRUOT: ${truot.length}/${ket.length} muc ve ban luu thang khong dat.`);
    process.exit(1);
  }
  console.log(`✔ DAT: ban luu KPI theo thang dung ca ${ket.length} truong hop.`);
}

main().catch((e) => { console.error('✖ Loi khi kiem tra ban luu thang:', e.message); process.exit(1); });
