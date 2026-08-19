#!/usr/bin/env node
/**
 * GATECHECK - kiem tra CONG DANG NHAP that su CHAN, khong phai chi an di.
 * ---------------------------------------------------------------------------
 * VI SAO CAN: truoc day `/lgc` chi la "don gian hoa giao dien" - ai go dung
 * dia chi deu vao duoc. Khi cong bo dashboard cho CA CONG TY thi dieu do co
 * nghia la cong bo luon nghiep vu noi bo cua kho. Nay da co XAC THUC (ma nhan
 * vien + mat khau); bai kiem tra nay bao dam no KHONG bi ho tro lai am tham.
 *
 * ⚠️ PHAM VI DA DOI (18/08/2026 - nghiep vu chot). HAI MUC CHAN, khong duoc
 * lan lon nhau:
 *   MUC 1 - DANG NHAP: bat buoc cho CA CHUONG TRINH, ke ca dashboard TAT.
 *           MOI nhan vien co ma trong SIGN deu lap duoc tai khoan.
 *   MUC 2 - TRUNG TAM: rieng nhom LGC (xuat kho / receiving / repair admin)
 *           con doi dung nhan vien CUVT.
 *   Truoc day dashboard la CONG KHAI va chi CUVT moi lap duoc tai khoan -
 *   dung nguoc lai voi bay gio.
 *
 * Chay server o DEMO_MODE (ma bat dau bang 'CU' = thuoc CUVT) roi thu:
 *   1. Chua dang nhap -> ra man dang nhap, moi API tra 401 (KE CA dashboard)
 *   2. Ma KHONG thuoc CUVT -> VAN dang nhap duoc va xem duoc dashboard,
 *      NHUNG API cua nhom LGC tra 403
 *   3. Ma CUVT nhung mat khau khoi tao sai -> tu choi
 *   4. Ma CUVT + mat khau khoi tao dung -> vao duoc NHUNG phai doi mat khau,
 *      va TRONG LUC CHUA DOI thi VAN BI CHAN  (cho de lam hinh thuc nhat)
 *   5. Mat khau moi khong duoc trung ma nhan vien / khong duoc qua ngan
 *   6. Doi xong -> vao duoc; mat khau CU khong dung duoc nua
 *   7. Cookie GIA MAO / SUA HAN -> tu choi  (cho de sai nhat)
 *   8. Sai mat khau nhieu lan -> KHOA tai khoan
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
    const dn = (ma, matKhau) => fetch(`${BASE}/api/lgc/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ma, matKhau }),
    });

    // 1. Chua dang nhap -> CHAN HET, ke ca dashboard
    const trang = await fetch(`${BASE}/lgc`).then((r) => r.text());
    kiemTra('Chua dang nhap -> /lgc ra man hinh dang nhap', trang.includes('Đăng nhập'));
    const trangGoc = await fetch(`${BASE}/`).then((r) => r.text());
    kiemTra('⚠️ Chua dang nhap -> TRANG CHU cung ra man hinh dang nhap',
      trangGoc.includes('Đăng nhập') && !trangGoc.includes('kpiGrid'));
    for (const ep of [API_LGC, '/api/receiving', '/api/reports/repair-admin',
      '/api/dashboard?periodType=month&month=2026-08', '/api/tat/departments']) {
      const r = await fetch(BASE + ep);
      kiemTra(`Chua dang nhap -> ${ep.split('?')[0]} bi chan`, r.status === 401, `HTTP ${r.status}`);
    }
    // Trang dang nhap va tep tinh PHAI van mo, neu khong thi khong ai vao duoc
    for (const ep of ['/login', '/style.css', '/api/lgc/me']) {
      const r = await fetch(BASE + ep);
      kiemTra(`Duong MO ${ep} khong bi chan`, r.ok, `HTTP ${r.status}`);
    }

    // 2. Ma KHONG thuoc CUVT: dang nhap duoc, xem dashboard duoc, NHUNG khong
    //    duoc vao nhom LGC. Day la muc chan THU HAI - de nham voi muc mot la
    //    hoac chan oan ca cong ty, hoac mo toang nghiep vu kho.
    const paDn = await dn('VAE12345', 'VAE12345');
    kiemTra('Ma ngoai CUVT -> VAN lap duoc tai khoan', paDn.ok, `HTTP ${paDn.status}`);
    const paCookie = (paDn.headers.get('set-cookie') || '').split(';')[0];
    const paDoi = await fetch(`${BASE}/api/lgc/doi-mat-khau`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: paCookie },
      body: JSON.stringify({ matKhauCu: 'VAE12345', matKhauMoi: 'MatKhau123' }),
    });
    kiemTra('Ma ngoai CUVT -> doi duoc mat khau', paDoi.ok, `HTTP ${paDoi.status}`);
    const paDash = await fetch(`${BASE}/api/dashboard?periodType=month&month=2026-08`,
      { headers: { Cookie: paCookie } });
    kiemTra('Ma ngoai CUVT -> XEM DUOC dashboard TAT', paDash.ok, `HTTP ${paDash.status}`);
    for (const ep of [API_LGC, '/api/receiving', '/api/reports/repair-admin']) {
      const r = await fetch(BASE + ep, { headers: { Cookie: paCookie } });
      kiemTra(`⚠️ Ma ngoai CUVT -> ${ep.split('?')[0]} bi tu choi`,
        r.status === 403, `HTTP ${r.status}`);
    }
    const paMe = await fetch(`${BASE}/api/lgc/me`, { headers: { Cookie: paCookie } })
      .then((r) => r.json());
    kiemTra('Ma ngoai CUVT -> /api/lgc/me bao lgc = false (giao dien an tab LGC)',
      paMe.ok === true && paMe.lgc === false, `lgc=${paMe.lgc}`);

    // 3. Ma CUVT nhung mat khau khoi tao sai
    const saiMk = await dn('CU001', 'linh-tinh');
    kiemTra('Ma CUVT + mat khau khoi tao SAI -> tu choi', saiMk.status === 401, `HTTP ${saiMk.status}`);

    // 5. Mat khau khoi tao dung = MA NHAN VIEN VIET HOA
    const ok1 = await dn('cu001', 'CU001');
    const d1 = await ok1.json();
    const cookie = (ok1.headers.get('set-cookie') || '').split(';')[0];
    kiemTra('Mat khau khoi tao = ma nhan vien viet hoa -> vao duoc',
      ok1.ok && d1.doiMk === true, `doiMk=${d1.doiMk}, ten="${d1.ten || ''}"`);
    kiemTra('Ten nhan vien lay tu cot DESCRIPTION cua SIGN', !!d1.ten, `ten="${d1.ten || ''}"`);

    // CHUA doi mat khau -> VAN BI CHAN (neu khong thi buoc doi chi la hinh thuc)
    const chuaDoi = await fetch(BASE + API_LGC, { headers: { Cookie: cookie } });
    kiemTra('CHUA doi mat khau -> van BI CHAN', chuaDoi.status === 401, `HTTP ${chuaDoi.status}`);

    // 6. Luat mat khau moi
    const doi = (cu, moi) => fetch(`${BASE}/api/lgc/doi-mat-khau`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ matKhauCu: cu, matKhauMoi: moi }),
    });
    // ⚠️ Cac phep thu duoi day PHAI deu THAT BAI, neu khong mat khau bi doi
    // giua chung va cac buoc sau se sai mat khau hien tai (da dinh mot lan).
    kiemTra('Mat khau moi qua ngan -> tu choi', (await doi('CU001', 'abc')).status === 400);
    const trungMa = await doi('CU001', 'CU001');
    kiemTra('Mat khau moi = ma nhan vien -> tu choi', trungMa.status === 400, `HTTP ${trungMa.status}`);
    kiemTra('Mat khau cu SAI -> tu choi doi', (await doi('sai-het', 'MatKhau123')).status === 401);

    // 7. Doi thanh cong -> vao duoc; mat khau cu het tac dung
    kiemTra('Doi mat khau hop le', (await doi('CU001', 'MatKhau123')).ok);
    const sauDoi = await fetch(BASE + API_LGC, { headers: { Cookie: cookie } });
    kiemTra('Sau khi doi -> API LGC chay duoc', sauDoi.ok, `HTTP ${sauDoi.status}`);
    kiemTra('Mat khau CU khong dung duoc nua', (await dn('CU001', 'CU001')).status === 401);
    kiemTra('Mat khau MOI dang nhap duoc', (await dn('CU001', 'MatKhau123')).ok);

    // 8. Cookie gia mao / sua han  <-- cho de sai nhat
    const gia = await fetch(BASE + API_LGC, {
      headers: { Cookie: 'lgc_auth=CU001.99999999999999.deadbeefdeadbeefdeadbeefdeadbeef' },
    });
    kiemTra('Cookie BIA chu ky -> tu choi', gia.status === 401, `HTTP ${gia.status}`);
    const [ma, , chuKy] = cookie.slice('lgc_auth='.length).split('.');
    const keoHan = await fetch(BASE + API_LGC, {
      headers: { Cookie: `lgc_auth=${ma}.99999999999999.${chuKy}` },
    });
    kiemTra('Cookie hop le nhung SUA HAN -> tu choi', keoHan.status === 401, `HTTP ${keoHan.status}`);

    // 9. Sai mat khau nhieu lan -> khoa tai khoan
    await dn('cuvt99', 'CUVT99');                 // lap tai khoan thu hai
    let daKhoa = false;
    for (let i = 0; i < 6; i++) {
      const r = await dn('CUVT99', 'sai-mat-khau');
      const b = await r.json().catch(() => ({}));
      if (/kho[áa]/i.test(b.message || '')) daKhoa = true;
    }
    kiemTra('Sai mat khau nhieu lan -> KHOA tai khoan', daKhoa);
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
