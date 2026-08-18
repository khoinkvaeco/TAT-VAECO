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

    // ===== 1b. MUC TIEU PHAI CHAY THANG VAO SO LIEU DASHBOARD ==============
    // ⚠️ Day la muc quan trong nhat cua phan nay. Truoc do ty le "dat" duoc
    // tinh O TRINH DUYET tu bang chi tiet - ma bang do bi cat o MAX_ROWS, nen
    // no tinh tren MOT PHAN du lieu trong khi cac the KPI ben canh tinh tren
    // TOAN BO -> hai con so canh nhau ma khac nhau. Nay tinh o SQL.
    const dash = (q) => J(`/api/dashboard?periodType=month&month=2026-08&nocache=1${q || ''}`);
    await J('/api/admin/kpi-config', { tatTargetDays: 2 });
    const d2 = (await dash()).body.kpis;
    kiemTra('Dashboard trả về chỉ số SLA tính ở SQL',
      Number.isFinite(d2.tatXuatTraAvg) && d2.slaN > 0,
      `TB ${d2.tatXuatTraAvg} ngày · ${d2.slaDat}/${d2.slaN}`);
    kiemTra('Mục tiêu dùng đúng con số đặt ở /admin', d2.slaTarget === 2, `${d2.slaTarget}`);
    kiemTra('Đạt + Quá hạn = Tổng', d2.slaDat + d2.slaQuaHan === d2.slaN);
    kiemTra('Tỷ lệ đạt khớp với số đếm',
      d2.slaTyLe === Math.round((d2.slaDat / d2.slaN) * 1000) / 10, `${d2.slaTyLe}%`);
    kiemTra('P50 ≤ P90', d2.slaP50 <= d2.slaP90, `${d2.slaP50} ≤ ${d2.slaP90}`);
    // Mau so PHAI phu het ky, khong duoc bang so dong cua bang chi tiet (bang
    // do co the bi cat) - it nhat phai LON HON HOAC BANG.
    const soDongChiTiet = ((await dash()).body.rows || [])
      .filter((r) => String(r.department || '').toUpperCase() !== 'CUVT'
        && Number.isFinite(Number(r.tat_days))).length;
    kiemTra('Mẫu số SLA phủ hết kỳ (≥ số dòng của bảng chi tiết)',
      d2.slaN >= soDongChiTiet, `${d2.slaN} ≥ ${soDongChiTiet}`);

    // Doi muc tieu o /admin -> so lieu dashboard PHAI doi theo NGAY (khoa cache
    // dung theo URL ma muc tieu khong nam trong URL, nen phai bo cache).
    await J('/api/admin/kpi-config', { tatTargetDays: 30 });
    const d30 = (await dash()).body.kpis;
    kiemTra('Đổi mục tiêu ở /admin → dashboard đổi NGAY (đã bỏ cache)',
      d30.slaTarget === 30 && d30.slaDat >= d2.slaDat && d30.slaTyLe >= d2.slaTyLe,
      `mục tiêu 2n: ${d2.slaTyLe}% → 30n: ${d30.slaTyLe}%`);
    kiemTra('Nới mục tiêu thì số quá hạn GIẢM', d30.slaQuaHan <= d2.slaQuaHan,
      `${d2.slaQuaHan} → ${d30.slaQuaHan}`);
    // Trung binh / P50 / P90 KHONG phu thuoc muc tieu - doi muc tieu ma chung
    // doi thi la dau hieu tinh nham.
    kiemTra('Trung bình / P50 / P90 KHÔNG đổi theo mục tiêu',
      d30.tatXuatTraAvg === d2.tatXuatTraAvg && d30.slaP90 === d2.slaP90);
    await J('/api/admin/kpi-config', { tatTargetDays: 2 });

    // ===== 1c. CAC THE KPI PHAI KHOP NHAU (bai kiem chong "so lieu la") =====
    // ⚠️ SINH RA TU MOT LOI THAT (18/08/2026): the "SL nhan / SL giao (CUVT)"
    // hien 2/2 trong khi cung ky co ~593 thiet bi da doi ung. Khong co gi bao
    // loi ca - trang van chay, so lieu chi lang le sai. Cac dang thuc duoi day
    // dung THEO DINH NGHIA, nen he so nao lech la co cho tinh nham.
    const kAll = (await dash()).body.kpis;
    const daDoiUng = kAll.countIssued - kAll.countNotReconciled;
    kiemTra('Đã đối ứng + Chưa đối ứng = Thiết bị xuất kho',
      daDoiUng + kAll.countNotReconciled === kAll.countIssued,
      `${daDoiUng} + ${kAll.countNotReconciled} = ${kAll.countIssued}`);
    kiemTra('Tỷ lệ đối ứng khớp với số đếm',
      Math.abs(kAll.reconcileRate - (daDoiUng / kAll.countIssued) * 100) < 0.1,
      `${kAll.reconcileRate}%`);
    // Mau so SLA chinh la tap DA DOI UNG (tru CUVT) -> khong duoc vuot qua no.
    kiemTra('Mẫu số SLA không vượt quá số thiết bị đã đối ứng',
      kAll.slaN <= daDoiUng, `${kAll.slaN} ≤ ${daDoiUng}`);
    // KHONG THE nhan nhieu hon so da giao - dang thuc tuyet doi.
    kiemTra('SL nhận (CUVT) ≤ SL giao (CUVT)',
      kAll.cntReci <= kAll.cntDel, `${kAll.cntReci} ≤ ${kAll.cntDel}`);
    // ⚠️ DAU VET CHINH XAC CUA LOI DA XAY RA: bat bo loc Station/Kho vao thi
    // "SL giao" sap gan het (593 -> 2) trong khi "Thiet bi xuat kho" hau nhu
    // khong doi. Nguyen nhan la bo loc duoc ap vao MOT COT KHAC BANG, co bo
    // gia tri khac han, nen phep IN (...) cat sach - va khong he bao loi.
    //
    // Cach do: so sanh TY LE CON LAI cua hai chi so sau khi loc. Hai chi so
    // dem tren hai tap khac nhau nen ty le khong the bang nhau, nhung neu mot
    // cai con 40% ma cai kia chi con 2% thi do khong con la nghiep vu nua.
    // Nguong dat rat rong (lech 10 lan) - chi bat truong hop "sap", khong bat
    // dao dong binh thuong.
    const kLoc = (await dash('&station=SGN')).body.kpis;
    const tyLe = (a, b2) => (b2 ? a / b2 : 0);
    const rXuat = tyLe(kLoc.countIssued, kAll.countIssued);
    const rGiao = tyLe(kLoc.cntDel, kAll.cntDel);
    kiemTra('Lọc Station: KPI nào cũng chỉ nhỏ đi, không cái nào sập riêng',
      kLoc.countIssued <= kAll.countIssued && kLoc.cntDel <= kAll.cntDel,
      `xuất kho ${kAll.countIssued}→${kLoc.countIssued} · giao ${kAll.cntDel}→${kLoc.cntDel}`);
    kiemTra('⚠️ Lọc Station KHÔNG được làm "SL giao" sập trong khi "Thiết bị xuất kho" thì không',
      rXuat < 0.05 || rGiao >= rXuat / 10,
      `còn lại: xuất kho ${(rXuat * 100).toFixed(1)}% · giao ${(rGiao * 100).toFixed(1)}%`);

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
