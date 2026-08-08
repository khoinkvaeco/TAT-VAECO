#!/usr/bin/env node
/**
 * LOADCHECK - kiem tra hai co che GIU CHO HE THONG SONG khi mo cho ca cong ty.
 * ---------------------------------------------------------------------------
 *  1. GOP REQUEST TRUNG NHAU: nhieu nguoi cung bo loc -> AMOS chi nhan MOT cau.
 *  2. HANG DOI TRUY VAN NANG: khong bao gio chay qua HEAVY_MAX cung luc, va
 *     suat PHAI duoc tra lai KE CA KHI LOI - thieu cho nay thi moi truy van
 *     loi an mat mot suat, den khi het suat la ca he thong dung han.
 *
 *  Chay server LIVE voi `mssql` gia (tools/sqlspy.js) + SQLSPY_DELAY_MS de gia
 *  lam truy van cham: voi DB gia tra loi trong ~1ms thi con bao ket thuc truoc
 *  khi kip do bat cu thu gi (da gap that - phep do dau tien cho ra "dinh cao 0").
 *
 *  Tai hien tai doc qua /api/health -> .tai (tu ngoai khong the biet duoc).
 *
 * CHAY:  node tools/loadcheck.js   (da nam trong `npm run smoke`)
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.LOADCHECK_PORT || 3396);
const BASE = `http://127.0.0.1:${PORT}`;
const HEAVY_MAX = 2;
const DELAY = 120;                       // ms moi cau SQL gia

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ket = [];
function kiemTra(ten, dat, chiTiet) {
  ket.push({ ten, dat });
  console.log(`  ${dat ? '✔' : '✘'} ${ten}${chiTiet ? '  — ' + chiTiet : ''}`);
}

function moServer(themEnv) {
  return spawn(process.execPath, ['-r', path.join(ROOT, 'tools', 'sqlspy.js'), 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      SQLSPY_OUT: path.join(os.tmpdir(), `loadcheck-${process.pid}.jsonl`),
      DEMO_MODE: 'false', PORT: String(PORT),
      HEAVY_MAX: String(HEAVY_MAX), LGC_GATE: 'false', SIGN_CACHE: 'false',
      API_CACHE_MINUTES: '0',        // tat cache de do dung co che, khong bi cache che mat
      DB_SERVER: '127.0.0.1', DB_USER: 'x', DB_PASSWORD: 'x',
      ...themEnv,
    },
    stdio: 'ignore',
  });
}

async function doiServerLen() {
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { await fetch(`${BASE}/api/health`); return true; } catch (_) { /* chua len */ }
  }
  return false;
}

const tai = () => fetch(`${BASE}/api/health`).then((r) => r.json()).then((d) => d.tai);

async function main() {
  let srv = moServer({ SQLSPY_DELAY_MS: String(DELAY) });
  try {
    if (!await doiServerLen()) { console.error('✖ Khong khoi dong duoc server.'); process.exit(1); }

    // --- 1. GOP REQUEST TRUNG NHAU: 20 nguoi, CUNG bo loc ---
    const N = 20;
    const q = 'periodType=month&month=2026-08';
    const kq1 = await Promise.all(Array.from({ length: N }, (_, i) =>
      fetch(`${BASE}/api/pickslip?${q}&job=same${i}`)
        .then((r) => r.headers.get('x-cache') || 'CHAY_THAT').catch(() => 'ERR')));
    const dem1 = {};
    kq1.forEach((v) => { dem1[v] = (dem1[v] || 0) + 1; });
    const chayThat = dem1.CHAY_THAT || 0;
    kiemTra(`${N} nguoi CUNG bo loc -> chi 1 luot chay that`,
      chayThat === 1 && !kq1.includes('ERR'), JSON.stringify(dem1));

    // --- 2. HANG DOI: 30 request, moi cai mot bo loc KHAC nhau ---
    let dinhCao = 0; let hangDaiNhat = 0;
    const doTai = setInterval(async () => {
      try { const t = await tai(); dinhCao = Math.max(dinhCao, t.dangChayNang); hangDaiNhat = Math.max(hangDaiNhat, t.hangDoi); }
      catch (_) { /* bo qua */ }
    }, 15);
    const M = 30;
    const kq2 = await Promise.all(Array.from({ length: M }, (_, i) =>
      fetch(`${BASE}/api/pickslip?${q}&store=K${i}&job=diff${i}`)
        .then((r) => r.status).catch(() => 'ERR')));
    clearInterval(doTai);
    kiemTra(`${M} request khac bo loc -> tat ca deu duoc phuc vu`,
      !kq2.includes('ERR') && kq2.every((v) => v === 200));
    kiemTra(`Khong bao gio chay qua HEAVY_MAX (${HEAVY_MAX}) cung luc`,
      dinhCao > 0 && dinhCao <= HEAVY_MAX, `dinh cao ${dinhCao}, hang doi dai nhat ${hangDaiNhat}`);
    kiemTra('Hang doi that su co hoat dong (khong phai chay het mot luc)',
      hangDaiNhat > 0, `hang doi dai nhat ${hangDaiNhat}`);

    const sau = await tai();
    kiemTra('Sau con bao: tra lai HET suat', sau.dangChayNang === 0 && sau.hangDoi === 0,
      `dangChay=${sau.dangChayNang}, hangDoi=${sau.hangDoi}`);
    srv.kill();
    await sleep(400);

    // --- 3. LOI cung phai tra suat (neu khong he thong tu khoa dan) ---
    //     Chay server that (khong co mssql gia) tro vao DB khong ton tai ->
    //     moi truy van deu LOI.
    srv = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env, DEMO_MODE: 'false', PORT: String(PORT), HEAVY_MAX: String(HEAVY_MAX),
        LGC_GATE: 'false', SIGN_CACHE: 'false', API_CACHE_MINUTES: '0',
        DB_SERVER: '127.0.0.1', DB_PORT: '1', DB_USER: 'x', DB_PASSWORD: 'x',
      },
      stdio: 'ignore',
    });
    if (!await doiServerLen()) { console.error('✖ Khong khoi dong lai duoc server.'); process.exit(1); }
    const kq3 = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      fetch(`${BASE}/api/pickslip?${q}&store=L${i}`).then((r) => r.status).catch(() => 'ERR')));
    const deuLoi = kq3.every((v) => v === 500);
    const sauLoi = await tai();
    kiemTra('10 truy van LOI -> van tra lai het suat',
      sauLoi.dangChayNang === 0 && sauLoi.hangDoi === 0,
      `${deuLoi ? 'ca 10 deu loi dung nhu mong doi' : 'ket qua: ' + JSON.stringify(kq3)}; `
      + `dangChay=${sauLoi.dangChayNang}, hangDoi=${sauLoi.hangDoi}`);
  } finally {
    srv.kill();
  }

  const truot = ket.filter((k) => !k.dat);
  console.log('');
  if (truot.length) {
    console.error(`✘ TRUOT: ${truot.length}/${ket.length} muc ve tai/hang doi khong dat.`);
    process.exit(1);
  }
  console.log(`✔ DAT: gop request + hang doi dung ca ${ket.length} truong hop.`);
}

main().catch((e) => { console.error('✖ Loi khi kiem tra tai:', e.message); process.exit(1); });
