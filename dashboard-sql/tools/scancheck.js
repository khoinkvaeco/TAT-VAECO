#!/usr/bin/env node
/**
 * SCANCHECK - chot chuc nang MO FILE SCAN THAT (/api/scan/tim, /api/scan/file).
 * ---------------------------------------------------------------------------
 * VI SAO CAN: day la duong duy nhat trong ca app cho phep NGUOI DUNG chi ra
 * mot TEN FILE roi may chu doc file do gui ve. Lam au mot chut la thanh lo
 * hong doc file bat ky tren may chu (path traversal):
 *
 *     /api/scan/file?...&ten=..\..\..\Windows\win.ini
 *
 * Cho nen bai nay khong kiem "co mo duoc file khong" la chinh, ma kiem
 * DIEU BAT BIEN: ten file nao KHONG nam trong danh sach that cua thu muc
 * scan thi TUYET DOI khong duoc phuc vu - du no duoc bo doi kieu gi.
 *
 * Chay o DEMO_MODE (khong can SQL Server, khong can o dia mang).
 *
 * CHAY:  node tools/scancheck.js   (da nam trong `npm run smoke`)
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SCANCHECK_PORT || 3393);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ket = [];
function kiemTra(ten, dat, chiTiet) {
  ket.push({ ten, dat });
  console.log(`  ${dat ? '✔' : '✘'} ${ten}${chiTiet ? '  — ' + chiTiet : ''}`);
}

async function main() {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, DEMO_MODE: 'true', PORT: String(PORT),
      LGC_GATE: 'false', API_CACHE_MINUTES: '0',
    },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(250);
      try { await fetch(`${BASE}/api/health`); up = true; } catch (_) { /* chua len */ }
    }
    if (!up) { console.error('✖ Khong khoi dong duoc server.'); process.exit(1); }

    // --- 1. Duong di binh thuong ---------------------------------------------
    const tim = await fetch(`${BASE}/api/scan/tim?loai=picking&station=HAN&ma=649020`);
    const jt = await tim.json();
    kiemTra('Tra được danh sách file scan của phiếu', tim.ok && jt.ok && jt.files.length > 0,
      JSON.stringify(jt.files));

    const f = await fetch(
      `${BASE}/api/scan/file?loai=picking&station=HAN&ma=649020&ten=${encodeURIComponent(jt.files[0])}`);
    const buf = Buffer.from(await f.arrayBuffer());
    kiemTra('Mở được đúng file PDF', f.ok && buf.slice(0, 5).toString() === '%PDF-',
      `${f.status} · ${buf.length} byte · Content-Type ${f.headers.get('content-type')}`);
    kiemTra('Trả về đúng kiểu application/pdf',
      String(f.headers.get('content-type') || '').includes('application/pdf'));

    const rc = await fetch(`${BASE}/api/scan/tim?loai=receiving&station=SGN&ma=R-259454`);
    const jr = await rc.json();
    kiemTra('Receiving: chấp nhận cả tên có tiền tố "R-"', rc.ok && jr.ok && jr.files.length > 0,
      JSON.stringify(jr.files));

    // --- 2. CHONG DI CHUYEN RA NGOAI THU MUC (phan quan trong nhat) ----------
    // Moi bien the duoi day deu la mot cach that de vuot qua mot bo loc lam au:
    // duong dan tuong doi, dau gach nguoc cua Windows, %2e%2e da ma hoa URL,
    // duong dan tuyet doi, va byte NUL.
    const doc = [
      ['đường dẫn tương đối kiểu Unix', '../../../../etc/passwd'],
      ['dấu gạch ngược của Windows', '..\\..\\..\\Windows\\win.ini'],
      ['dấu chấm đã mã hoá URL (%2e%2e)', '%2e%2e/%2e%2e/etc/passwd'],
      ['đường dẫn tuyệt đối', '/etc/passwd'],
      ['đường dẫn tuyệt đối kiểu Windows', 'C:\\Windows\\win.ini'],
      ['chèn byte NUL', '649020.pdf\u0000.txt'],
      ['tên file có thật nhưng ở thư mục khác', '../649020.pdf'],
    ];
    for (const [ten, hiem] of doc) {
      const r = await fetch(
        `${BASE}/api/scan/file?loai=picking&station=HAN&ma=649020&ten=${encodeURIComponent(hiem)}`);
      const body = Buffer.from(await r.arrayBuffer());
      const laPdf = body.slice(0, 5).toString() === '%PDF-';
      kiemTra(`Chặn: ${ten}`, !r.ok && !laPdf, `HTTP ${r.status}`);
    }

    // --- 3. Tham so sai phai bao ro, khong 500 -------------------------------
    const xau = [
      ['thiếu "loai"', 'station=HAN&ma=649020', 400],
      ['"loai" không hợp lệ', 'loai=../etc&station=HAN&ma=649020', 400],
      ['thiếu "ma"', 'loai=picking&station=HAN', 400],
    ];
    for (const [ten, q, mong] of xau) {
      const r = await fetch(`${BASE}/api/scan/file?${q}`);
      kiemTra(`Báo lỗi rõ khi ${ten}`, r.status === mong, `HTTP ${r.status} (mong đợi ${mong})`);
    }

    // --- 4. Cong LGC phai bao trum ca hai duong nay --------------------------
    // Chay rieng mot server co LGC_GATE=true: file scan la chung tu that, de
    // ngoai cong thi ai trong mang cung tai ve duoc.
    const P2 = PORT + 1;
    const srv2 = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, DEMO_MODE: 'true', PORT: String(P2), LGC_GATE: 'true' },
      stdio: 'ignore',
    });
    try {
      let up2 = false;
      for (let i = 0; i < 40 && !up2; i++) {
        await sleep(250);
        try { await fetch(`http://127.0.0.1:${P2}/api/health`); up2 = true; } catch (_) { /* cho */ }
      }
      for (const duong of ['tim', 'file']) {
        const r = await fetch(
          `http://127.0.0.1:${P2}/api/scan/${duong}?loai=picking&station=HAN&ma=649020&ten=649020.pdf`);
        kiemTra(`Cổng LGC chặn /api/scan/${duong} khi chưa đăng nhập`, r.status === 401,
          `HTTP ${r.status}`);
      }
    } finally {
      srv2.kill();
      await sleep(200);
    }
    // --- 5. DUONG THAT (khong phai DEMO): thu muc PDF co that tren o dia -----
    // ⚠️ Bat buoc phai co muc nay. O DEMO_MODE, /api/scan/file tra ve PDF gia
    // va thoat SOM, nen LOP 2 (chot duong dan tuyet doi phai nam trong thu muc
    // scan) KHONG he duoc chay. Muc 2 o tren moi chi chung minh duoc LOP 1.
    // O day dung thu muc that, co mot file "bi mat" nam NGOAI thu muc scan de
    // xem co lay duoc no ra khong.
    const os = require('os');
    const fs = require('fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scancheck-'));
    const thuMuc = path.join(tmp, 'pdf');
    fs.mkdirSync(thuMuc);
    fs.writeFileSync(path.join(thuMuc, '649020-1.pdf'), '%PDF-1.4\nmot\n%%EOF\n');
    fs.writeFileSync(path.join(thuMuc, '649020-2.pdf'), '%PDF-1.4\nhai\n%%EOF\n');
    fs.writeFileSync(path.join(tmp, 'bi-mat.txt'), 'KHONG DUOC LO RA NGOAI');
    // Thu muc CHUNG CHI NHAP KHO - phuc vu tab "Tra cuu chung tu".
    // Ten file co dau phan cach hang nghin de kiem luon phan chuan hoa so.
    const thuMucCc = path.join(tmp, 'chungchi');
    fs.mkdirSync(thuMucCc);
    fs.writeFileSync(path.join(thuMucCc, "1'234'567.pdf"), '%PDF-1.4\ncc-mot\n%%EOF\n');
    fs.writeFileSync(path.join(thuMucCc, '7654321.pdf'), '%PDF-1.4\ncc-hai\n%%EOF\n');
    fs.writeFileSync(path.join(thuMucCc, 'CC-9990001.pdf'), '%PDF-1.4\ncc-ba\n%%EOF\n');

    const P3 = PORT + 2;
    const B3 = `http://127.0.0.1:${P3}`;
    const srv3 = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env, DEMO_MODE: 'false', PORT: String(P3), LGC_GATE: 'false',
        DATA_DIR: path.join(tmp, 'data'), SCAN_PICKING_DIR: thuMuc,
        SCAN_CHUNGCHI_DIR: thuMucCc,
      },
      stdio: 'ignore',
    });
    try {
      // Khong cho /api/health (khong co SQL Server thi no tra 503) - cho chinh
      // duong /api/scan/tim tra loi, vi day moi la thu can kiem.
      let san = false;
      for (let i = 0; i < 60 && !san; i++) {
        await sleep(250);
        try {
          const r = await fetch(`${B3}/api/scan/tim?loai=picking&station=HAN&ma=649020`);
          san = r.status === 200;
        } catch (_) { /* chua len */ }
      }
      if (!san) { console.error('✖ Khong khoi dong duoc server thu muc that.'); process.exit(1); }

      const t3 = await (await fetch(`${B3}/api/scan/tim?loai=picking&station=HAN&ma=649020`)).json();
      kiemTra('Thư mục thật: liệt kê ĐỦ cả 2 file của cùng một phiếu',
        t3.files.length === 2 && !t3.demo, JSON.stringify(t3.files));

      const ok3 = await fetch(`${B3}/api/scan/file?loai=picking&station=HAN&ma=649020&ten=649020-2.pdf`);
      const b3 = await ok3.text();
      kiemTra('Thư mục thật: mở đúng file được chỉ định',
        ok3.ok && b3.includes('hai'), `HTTP ${ok3.status}`);

      // Phieu co 2 file ma khong noi ro mo cai nao -> KHONG duoc doan bua
      const mo = await fetch(`${B3}/api/scan/file?loai=picking&station=HAN&ma=649020`);
      kiemTra('Thư mục thật: có 2 file mà không chỉ rõ "ten" thì KHÔNG đoán bừa',
        mo.status === 409, `HTTP ${mo.status}`);

      // Diem chinh cua ca muc nay
      // ⚠️ Cac ca duoi day chay tren Linux. Rieng ca "dau gach nguoc" thi tren
      // Linux '\\' KHONG phai dau phan cach nen tu no da khong ra file - o
      // Windows (may chay that) thi CO. Vi vay LOP 1 (danh sach trang) moi la
      // lop chinh: no khong phu thuoc he dieu hanh. Da chung minh: thao LOP 1
      // ra thi ca 7 ca o muc 2 deu tra ve HTTP 200.
      for (const [ten, hiem] of [
        ['lùi một cấp ra file bí mật', '../bi-mat.txt'],
        ['lùi một cấp, dấu gạch ngược', '..\\bi-mat.txt'],
        ['lùi nhiều cấp', '../../../../etc/passwd'],
        ['đường dẫn tuyệt đối tới chính file bí mật', path.join(tmp, 'bi-mat.txt')],
      ]) {
        const r = await fetch(
          `${B3}/api/scan/file?loai=picking&station=HAN&ma=649020&ten=${encodeURIComponent(hiem)}`);
        const body = await r.text();
        kiemTra(`Thư mục thật — chặn: ${ten}`,
          !r.ok && !body.includes('KHONG DUOC LO RA NGOAI'), `HTTP ${r.status}`);
      }

      // ================= TRA CUU CHUNG TU (/api/chungtu/*) =================
      // ⚠️ Duong nay cung cho nguoi dung chi ra TEN FILE roi may chu doc file
      // do gui ve - dung loai lo hong voi /api/scan/file. PHAI kiem RIENG:
      // hai duong dung chung y tuong nhung la HAI DOAN MA khac nhau, sua mot
      // ben khong tu sua ben kia.
      const ct = (q) => `${B3}/api/chungtu/tim?loai=chungchi&station=HAN&${q}`;
      const ctFile = (q) => `${B3}/api/chungtu/file?loai=chungchi&station=HAN&${q}`;

      // 1) Bo dau phan cach hang nghin: go "1'234'567" phai ra file
      const c1 = await (await fetch(ct(`so=${encodeURIComponent("1'234'567")}`))).json();
      kiemTra('Chứng từ: bỏ dấu phân cách hàng nghìn khi tìm',
        c1.ok && c1.files.includes("1'234'567.pdf"), JSON.stringify(c1.files || []));
      // 2) Go so THUAN (khong dau) cung ra dung file do
      const c2 = await (await fetch(ct('so=1234567'))).json();
      kiemTra('Chứng từ: gõ số thuần vẫn ra file có dấu phân cách trong tên',
        c2.ok && c2.files.includes("1'234'567.pdf"), JSON.stringify(c2.files || []));
      // 3) Tim TUONG DOI: chi go vai chu so cuoi
      const c3 = await (await fetch(ct('so=54321'))).json();
      kiemTra('Chứng từ: tìm tương đối (chỉ gõ vài chữ số)',
        c3.ok && c3.files.includes('7654321.pdf'), JSON.stringify(c3.files || []));
      // 4) Khong khop -> rong, KHONG phai loi
      const c4 = await (await fetch(ct('so=000111222'))).json();
      kiemTra('Chứng từ: không khớp thì trả danh sách rỗng',
        c4.ok && c4.files.length === 0, `${(c4.files || []).length} file`);
      // 5) Qua ngan -> tu choi (neu khong thi go 1 ky tu la tra ve ca thu muc)
      const c5 = await fetch(ct('so=1'));
      kiemTra('Chứng từ: gõ dưới 3 ký tự thì từ chối', c5.status === 400, `HTTP ${c5.status}`);
      // 6) Loai khong hop le -> tu choi
      const c6 = await fetch(`${B3}/api/chungtu/tim?loai=linh-tinh&station=HAN&so=1234567`);
      kiemTra('Chứng từ: loại không hợp lệ thì từ chối', c6.status === 400, `HTTP ${c6.status}`);
      // 7) Mo dung file
      const c7 = await fetch(ctFile('so=7654321&ten=7654321.pdf'));
      const b7 = await c7.text();
      kiemTra('Chứng từ: mở đúng file được chọn', c7.ok && b7.includes('cc-hai'), `HTTP ${c7.status}`);
      // 8) Tai ve -> phai la attachment
      const c8 = await fetch(ctFile('so=7654321&ten=7654321.pdf&tai=1'));
      kiemTra('Chứng từ: “Tải về” trả Content-Disposition attachment',
        (c8.headers.get('content-disposition') || '').startsWith('attachment'),
        c8.headers.get('content-disposition') || '');
      // 9) ⚠️ DIEM CHINH: ten file KHONG nam trong ket qua tim -> TUYET DOI
      //    khong duoc phuc vu, du duong dan duoc bo doi kieu gi.
      for (const [ten, hiem] of [
        ['lùi một cấp ra file bí mật', '../bi-mat.txt'],
        ['lùi một cấp, dấu gạch ngược', '..\\bi-mat.txt'],
        ['lùi nhiều cấp', '../../../../etc/passwd'],
        ['đường dẫn tuyệt đối tới chính file bí mật', path.join(tmp, 'bi-mat.txt')],
        ['file CÓ THẬT trong thư mục nhưng KHÔNG khớp số đang tìm', '7654321.pdf'],
      ]) {
        const r = await fetch(ctFile(`so=1234567&ten=${encodeURIComponent(hiem)}`));
        const body2 = await r.text();
        kiemTra(`Chứng từ — chặn: ${ten}`,
          !r.ok && !body2.includes('KHONG DUOC LO RA NGOAI') && !body2.includes('cc-hai'),
          `HTTP ${r.status}`);
      }
    } finally {
      srv3.kill();
      await sleep(300);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    srv.kill();
    await sleep(300);
  }

  const truot = ket.filter((x) => !x.dat);
  if (truot.length) {
    console.error(`\n✖ TRUOT: ${truot.length}/${ket.length} truong hop.`);
    process.exit(1);
  }
  console.log(`\n✔ DAT: chuc nang mo file scan an toan ca ${ket.length} truong hop.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
