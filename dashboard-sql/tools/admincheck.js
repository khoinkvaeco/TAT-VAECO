#!/usr/bin/env node
/**
 * ADMINCHECK - chot hai chuc nang cua trang /admin:
 * ---------------------------------------------------------------------------
 *   1. MUC TIEU KPI (SLA)      - /api/kpi-config, /api/admin/kpi-config
 *   2. TAI KHOAN LGC quen MK   - /api/admin/lgc-users{,/mo-khoa,/dat-lai-mk}
 *
 * VI SAO CAN:
 *   - Muc tieu KPI la con so ca cong ty doc chung. Nhan bua mot gia tri vo ly
 *     (0, am, chuoi) se lam MOI ty le "dat" sai ma khong bao gi.
 *   - "Dat lai mat khau" ma KHONG thuc su vo hieu hoa mat khau cu thi la lo
 *     hong that: nguoi bi thu hoi quyen van dang nhap duoc. Bai nay kiem
 *     DIEU BAT BIEN do bang cach dat mot mat khau THAT, reset, roi thu lai
 *     chinh mat khau do.
 *   - "Mo khoa" thi NGUOC LAI: phai GIU NGUYEN mat khau.
 *
 * Chay o DEMO_MODE nen khong can SQL Server.
 *
 * CHAY:  node tools/admincheck.js   (da nam trong `npm run smoke`)
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.ADMINCHECK_PORT || 3391);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ket = [];
function kiemTra(ten, dat, chiTiet) {
  ket.push({ ten, dat });
  console.log(`  ${dat ? '✔' : '✘'} ${ten}${chiTiet ? '  — ' + chiTiet : ''}`);
}

const J = (url, body) => fetch(BASE + url, body
  ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  : undefined).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

/** Dang nhap va tra ve CA cookie (de goi duoc /api/lgc/doi-mat-khau). */
async function dangNhap(ma, matKhau) {
  const r = await fetch(`${BASE}/api/lgc/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ma, matKhau }),
  });
  const body = await r.json().catch(() => ({}));
  const ck = String(r.headers.get('set-cookie') || '').split(';')[0];
  return { status: r.status, body, cookie: ck };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'admincheck-'));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, DEMO_MODE: 'true', PORT: String(PORT), LGC_GATE: 'false',
      // Thu muc du lieu RIENG: bai nay GHI file kpi-targets.json, khong duoc
      // dam vao cau hinh that cua may dang chay.
      DATA_DIR: tmp,
      // Bai nay dang nhap lien tuc nhieu hon muc chan mac dinh (10/phut).
      LGC_RATE_PER_MIN: '200',
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

    // ================= 1. MUC TIEU KPI =====================================
    const mac = await J('/api/kpi-config');
    kiemTra('Mục tiêu mặc định = 2 ngày (nghiệp vụ chốt)',
      mac.body.tatTargetDays === 2, `${mac.body.tatTargetDays}`);
    kiemTra('Máy quản trị (localhost) được phép sửa', mac.body.canEdit === true);

    const luu = await J('/api/admin/kpi-config', { tatTargetDays: 3.5, backlogWarnDays: 45 });
    kiemTra('Lưu được mục tiêu mới',
      luu.status === 200 && luu.body.tatTargetDays === 3.5 && luu.body.backlogWarnDays === 45);
    const doc = await J('/api/kpi-config');
    kiemTra('Đọc lại đúng giá trị vừa lưu (ghi ra file, không chỉ trong bộ nhớ)',
      doc.body.tatTargetDays === 3.5 && !!doc.body.updatedAt);

    // ⚠️ Gia tri vo ly PHAI bi tu choi: muc tieu = 0 se lam moi ty le "dat"
    // thanh 0% ma khong co gi bao la sai.
    for (const [ten, body] of [
      ['số 0', { tatTargetDays: 0 }],
      ['số âm', { tatTargetDays: -5 }],
      ['chuỗi chữ', { tatTargetDays: 'hai ngày' }],
      ['quá lớn', { tatTargetDays: 99999 }],
      ['tồn đọng = 0', { backlogWarnDays: 0 }],
    ]) {
      const r = await J('/api/admin/kpi-config', body);
      kiemTra(`Từ chối mục tiêu ${ten}`, r.status === 400, `HTTP ${r.status}`);
    }
    const vanCon = await J('/api/kpi-config');
    kiemTra('Sau các lần bị từ chối, giá trị cũ vẫn nguyên vẹn',
      vanCon.body.tatTargetDays === 3.5, `${vanCon.body.tatTargetDays}`);
    await J('/api/admin/kpi-config', { tatTargetDays: 2, backlogWarnDays: 30 });

    // ================= 2. TAI KHOAN LGC ====================================
    const MA = 'CU7788';
    const tao = await dangNhap(MA, MA);          // lan dau: mat khau = ma NV
    kiemTra('Lập được tài khoản ở lần đăng nhập đầu', tao.body.ok === true && tao.body.doiMk === true);

    // Dat mot mat khau THAT (khac ma nhan vien) - day moi la thu can vo hieu
    // hoa khi reset.
    const MK_THAT = 'MatKhauThat2026';
    const doiR = await fetch(`${BASE}/api/lgc/doi-mat-khau`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: tao.cookie },
      body: JSON.stringify({ matKhauCu: MA, matKhauMoi: MK_THAT }),
    });
    kiemTra('Đổi được sang mật khẩu thật', doiR.status === 200, `HTTP ${doiR.status}`);
    kiemTra('Đăng nhập được bằng mật khẩu thật',
      (await dangNhap(MA, MK_THAT)).body.ok === true);

    // --- Khoa tai khoan bang cach go sai lien tiep ---
    let khoa = null;
    for (let i = 0; i < 6; i++) khoa = await dangNhap(MA, 'sai-mat-khau');
    kiemTra('Sai liên tiếp thì bị khoá', khoa.status === 429, `HTTP ${khoa.status}`);
    let ds = await J('/api/admin/lgc-users');
    const u1 = (ds.body.users || []).find((u) => u.ma_nv === MA);
    kiemTra('Trang admin thấy tài khoản đang bị khoá', !!u1 && u1.dangKhoa === true);
    kiemTra('Danh sách KHÔNG trả về hash / muối mật khẩu',
      !!u1 && !('mk_hash' in u1) && !('mk_muoi' in u1));

    // --- MO KHOA: phai GIU NGUYEN mat khau ---
    const mo = await J('/api/admin/lgc-users/mo-khoa', { ma: MA });
    kiemTra('Mở khoá thành công', mo.status === 200 && mo.body.ok === true);
    ds = await J('/api/admin/lgc-users');
    kiemTra('Sau khi mở khoá, không còn ở trạng thái khoá',
      !(ds.body.users || []).find((u) => u.ma_nv === MA).dangKhoa);
    kiemTra('MỞ KHOÁ GIỮ NGUYÊN mật khẩu (vẫn đăng nhập bằng mật khẩu thật)',
      (await dangNhap(MA, MK_THAT)).body.ok === true);

    // --- DAT LAI MK: phai VO HIEU HOA mat khau cu ---
    const reset = await J('/api/admin/lgc-users/dat-lai-mk', { ma: MA });
    kiemTra('Đặt lại mật khẩu thành công', reset.status === 200 && reset.body.ok === true);
    const cu = await dangNhap(MA, MK_THAT);
    kiemTra('⚠️ Mật khẩu CŨ hết tác dụng sau khi đặt lại',
      cu.body.ok !== true, `HTTP ${cu.status}`);
    const moi = await dangNhap(MA, MA);
    kiemTra('Đăng nhập được bằng mã nhân viên VIẾT HOA', moi.body.ok === true);
    kiemTra('⚠️ BẮT BUỘC đổi mật khẩu ở lần đăng nhập kế tiếp', moi.body.doiMk === true);

    // --- Tham so sai ---
    for (const [ten, url, body, mong] of [
      ['mã không tồn tại', '/api/admin/lgc-users/dat-lai-mk', { ma: 'KHONG-CO-MA-NAY' }, 404],
      ['thiếu mã', '/api/admin/lgc-users/mo-khoa', {}, 400],
      ['việc không hợp lệ', '/api/admin/lgc-users/xoa-sach', { ma: MA }, 404],
    ]) {
      const r = await J(url, body);
      kiemTra(`Báo lỗi rõ khi ${ten}`, r.status === mong, `HTTP ${r.status} (mong đợi ${mong})`);
    }
  } finally {
    srv.kill();
    await sleep(300);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const truot = ket.filter((x) => !x.dat);
  if (truot.length) {
    console.error(`\n✖ TRUOT: ${truot.length}/${ket.length} truong hop.`);
    process.exit(1);
  }
  console.log(`\n✔ DAT: muc tieu KPI + quan ly tai khoan dung ca ${ket.length} truong hop.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
