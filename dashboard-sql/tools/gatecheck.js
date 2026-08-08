#!/usr/bin/env node
/**
 * GATECHECK - kiem tra CONG VAO TRANG LGC that su CHAN, khong phai chi an di.
 * ---------------------------------------------------------------------------
 * VI SAO CAN: truoc day `/lgc` chi la "don gian hoa giao dien" - ai go dung
 * dia chi deu vao duoc. Khi cong bo dashboard cho CA CONG TY thi dieu do co
 * nghia la cong bo luon nghiep vu noi bo cua kho. Nay da co cong hoi ma nhan
 * vien; bai kiem tra nay bao dam cong do KHONG bi ho tro lai mot cach am tham.
 *
 * Chay server o DEMO_MODE (ma bat dau bang 'CU' = thuoc CUVT) roi thu:
 *   1. Chua nhap ma  -> trang /lgc ra man nhap ma, API LGC tra 401
 *   2. Trang dashboard cong khai KHONG bi chan
 *   3. Ma khong thuoc CUVT -> tu choi
 *   4. Ma thuoc CUVT -> cho vao, va cookie dung duoc cho API
 *   5. Cookie GIA MAO / SUA HAN -> tu choi  (day la cho de sai nhat)
 *   6. Do ma hang loat -> bi chan (429)
 *
 * CHAY:  node tools/gatecheck.js   (da nam trong `npm run smoke`)
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.GATECHECK_PORT || 3397);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ket = [];
function kiemTra(ten, dat, chiTiet) {
  ket.push({ ten, dat, chiTiet });
  console.log(`  ${dat ? '✔' : '✘'} ${ten}${chiTiet ? '  — ' + chiTiet : ''}`);
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DEMO_MODE: 'true', PORT: String(PORT), LGC_GATE: 'true' },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(250);
      try { await fetch(`${BASE}/api/health`); up = true; } catch (_) { /* chua len */ }
    }
    if (!up) { console.error('✖ Khong khoi dong duoc server de kiem tra cong LGC.'); process.exit(1); }

    const API_LGC = `/api/pickslip?periodType=month&month=2026-08`;

    // 1. Chua nhap ma
    const trang = await fetch(`${BASE}/lgc`).then((r) => r.text());
    kiemTra('Chua nhap ma -> /lgc ra man hinh nhap ma',
      trang.includes('Nhập mã nhân viên'));
    for (const ep of [API_LGC, '/api/receiving', '/api/reports/repair-admin']) {
      const r = await fetch(BASE + ep);
      kiemTra(`Chua nhap ma -> ${ep.split('?')[0]} bi chan`, r.status === 401, `HTTP ${r.status}`);
    }

    // 2. Trang cong khai khong bi anh huong
    for (const ep of ['/', '/api/dashboard?periodType=month&month=2026-08']) {
      const r = await fetch(BASE + ep);
      kiemTra(`Trang cong khai ${ep.split('?')[0]} van vao duoc`, r.ok, `HTTP ${r.status}`);
    }

    // 3. Ma khong thuoc CUVT
    const sai = await fetch(`${BASE}/api/lgc/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ma: 'VAE12345' }),
    });
    kiemTra('Ma KHONG thuoc CUVT -> tu choi', sai.status === 403, `HTTP ${sai.status}`);

    // 4. Ma thuoc CUVT
    const ok = await fetch(`${BASE}/api/lgc/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ma: 'CU001' }),
    });
    const cookie = (ok.headers.get('set-cookie') || '').split(';')[0];
    kiemTra('Ma thuoc CUVT -> cho vao', ok.ok && cookie.startsWith('lgc_ok='), `HTTP ${ok.status}`);

    const coVe = await fetch(BASE + API_LGC, { headers: { Cookie: cookie } });
    kiemTra('Co cookie hop le -> API LGC chay duoc', coVe.ok, `HTTP ${coVe.status}`);

    // 5. Cookie gia mao / sua han  <-- cho de sai nhat
    const gia = await fetch(BASE + API_LGC, {
      headers: { Cookie: 'lgc_ok=CU001.99999999999999.deadbeefdeadbeefdeadbeefdeadbeef' },
    });
    kiemTra('Cookie BIA chu ky -> tu choi', gia.status === 401, `HTTP ${gia.status}`);

    const [ma, , chuKy] = cookie.slice('lgc_ok='.length).split('.');
    const keoHan = await fetch(BASE + API_LGC, {
      headers: { Cookie: `lgc_ok=${ma}.99999999999999.${chuKy}` },
    });
    kiemTra('Cookie hop le nhung SUA HAN -> tu choi', keoHan.status === 401, `HTTP ${keoHan.status}`);

    // 6. Do ma hang loat
    let bichan = 0;
    for (let i = 0; i < 14; i++) {
      const r = await fetch(`${BASE}/api/lgc/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ma: `ZZ${i}` }),
      });
      if (r.status === 429) bichan += 1;
    }
    kiemTra('Do ma hang loat -> bi chan', bichan > 0, `${bichan}/14 luot bi chan`);
  } finally {
    srv.kill();
  }

  const truot = ket.filter((k) => !k.dat);
  console.log('');
  if (truot.length) {
    console.error(`✘ TRUOT: ${truot.length}/${ket.length} muc cua cong LGC khong dat.`);
    process.exit(1);
  }
  console.log(`✔ DAT: cong LGC chan dung ca ${ket.length} truong hop.`);
}

main().catch((e) => { console.error('✖ Loi khi kiem tra cong LGC:', e.message); process.exit(1); });
