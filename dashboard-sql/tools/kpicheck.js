#!/usr/bin/env node
/**
 * KPICHECK - chot bang KPI THEO NHAN VIEN cua hai tab LGC.
 * ---------------------------------------------------------------------------
 *   - "KPI thu kho xuat booking"  (PICKSLIP_HEADER.BOOKING_SIGN)
 *   - "KPI inspector nhap kho"    (HISTORY.CREATED_BY)
 *
 * VI SAO CAN: hai bang nay duoc gom o HAI NOI khac nhau roi ghep lai:
 *   so item / so phieu  -> gom bang SQL tren bang tam (#ps, #hi)
 *   so phieu da/chua scan -> dem o NODE (doi chieu thu muc file scan)
 * Ghep sai (bo sot mot nhom, dem mot phieu cho hai nguoi, nham mau so ty le)
 * KHONG lam trang chet - no chi lam con so LECH, ma day la so danh gia CON
 * NGUOI nen sai la rat nang. Vi vay bai nay khong kiem "co chay khong" ma kiem
 * DIEU BAT BIEN: cong tat ca cac dong trong bang KPI phai ra DUNG con so KPI
 * cua ca tab.
 *
 * Chay o DEMO_MODE nen khong can SQL Server.
 *
 * CHAY:  node tools/kpicheck.js   (da nam trong `npm run smoke`)
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.KPICHECK_PORT || 3394);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ket = [];
function kiemTra(ten, dat, chiTiet) {
  ket.push({ ten, dat });
  console.log(`  ${dat ? '✔' : '✘'} ${ten}${chiTiet ? '  — ' + chiTiet : ''}`);
}
const cong = (ds, f) => ds.reduce((a, r) => a + (Number(r[f]) || 0), 0);

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

    // --- 1. Thu kho xuat booking ---------------------------------------------
    const ps = await fetch(`${BASE}/api/pickslip?nocache=1`).then((r) => r.json());
    const tk = ps.kpiThuKho || [];
    const k = ps.kpis || {};
    kiemTra('Có bảng KPI thủ kho', tk.length > 0, `${tk.length} người`);
    kiemTra('Tổng item khớp KPI cả tab',
      cong(tk, 'so_item') === k.soDong, `${cong(tk, 'so_item')} vs ${k.soDong}`);
    kiemTra('Tổng cancel khớp',
      cong(tk, 'so_cancel') === k.soCancel, `${cong(tk, 'so_cancel')} vs ${k.soCancel}`);
    kiemTra('Tổng return khớp',
      cong(tk, 'so_return') === k.soReturn, `${cong(tk, 'so_return')} vs ${k.soReturn}`);
    kiemTra('Tổng "hủy/trả khác" khớp',
      cong(tk, 'so_khac') === k.soKhac, `${cong(tk, 'so_khac')} vs ${k.soKhac}`);
    // Item xuat = item - (cancel + return + khac): tu kiem tra trong bang
    kiemTra('Item xuất = item − (cancel + return + khác) ở TỪNG người',
      tk.every((r) => r.so_xuat === r.so_item - r.so_cancel - r.so_return - r.so_khac));
    // ⚠️ MOT PHIEU CHI THUOC MOT THU KHO: neu dem mot phieu cho nhieu nguoi thi
    //    tong o day se LON HON mau so cua ca tab (da tung xay ra o du lieu mau).
    kiemTra('Phiếu đã scan khớp — không đếm một phiếu cho nhiều người',
      cong(tk, 'da_scan') === k.daScan, `${cong(tk, 'da_scan')} vs ${k.daScan}`);
    kiemTra('Mẫu số tỷ lệ scan khớp (phiếu toàn cancel đã bị loại)',
      cong(tk, 'da_scan') + cong(tk, 'chua_scan') === k.tongPhieuScan,
      `${cong(tk, 'da_scan') + cong(tk, 'chua_scan')} vs ${k.tongPhieuScan}`);
    kiemTra('Không có mã nhân viên rỗng', tk.every((r) => String(r.ma_nv || '').trim()));
    // Ty le scan = null (khong phai 0) khi nguoi do khong co phieu nao can scan
    kiemTra('Tỷ lệ scan để trống khi không có phiếu nào cần scan',
      tk.every((r) => (r.da_scan + r.chua_scan === 0
        ? r.ty_le_scan === null
        : typeof r.ty_le_scan === 'number')));

    // --- 2. Inspector nhap kho ------------------------------------------------
    const rc = await fetch(`${BASE}/api/receiving?nocache=1`).then((r) => r.json());
    const ins = rc.kpiInspector || [];
    const kr = rc.kpis || {};
    kiemTra('Có bảng KPI inspector', ins.length > 0, `${ins.length} người`);
    kiemTra('Tổng item khớp KPI cả tab',
      cong(ins, 'so_item') === kr.soDong, `${cong(ins, 'so_item')} vs ${kr.soDong}`);
    kiemTra('Phiếu đã scan khớp',
      cong(ins, 'da_scan') === kr.daScan, `${cong(ins, 'da_scan')} vs ${kr.daScan}`);
    kiemTra('Mẫu số tỷ lệ scan khớp',
      cong(ins, 'da_scan') + cong(ins, 'chua_scan') === kr.tongPhieuScan,
      `${cong(ins, 'da_scan') + cong(ins, 'chua_scan')} vs ${kr.tongPhieuScan}`);
    kiemTra('Không có mã nhân viên rỗng', ins.every((r) => String(r.ma_nv || '').trim()));

    // --- 3. Bo loc phai an vao ca bang KPI -----------------------------------
    const ps2 = await fetch(`${BASE}/api/pickslip?nocache=1&station=HAN`).then((r) => r.json());
    const tk2 = ps2.kpiThuKho || [];
    kiemTra('Đổi bộ lọc → bảng KPI cũng đổi theo (không phải số của cả kỳ)',
      cong(tk2, 'so_item') === (ps2.kpis || {}).soDong
        && cong(tk2, 'so_item') <= cong(tk, 'so_item'),
      `HAN: ${cong(tk2, 'so_item')} item ≤ tất cả: ${cong(tk, 'so_item')}`);
  } finally {
    srv.kill();
    await sleep(300);
  }

  const truot = ket.filter((x) => !x.dat);
  if (truot.length) {
    console.error(`\n✖ TRUOT: ${truot.length}/${ket.length} truong hop.`);
    process.exit(1);
  }
  console.log(`\n✔ DAT: bang KPI theo nhan vien khop so lieu ca ${ket.length} truong hop.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
