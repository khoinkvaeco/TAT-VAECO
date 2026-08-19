/**
 * ============================================================================
 *  auth-lgc.js  -  XAC THUC cho TOAN BO chuong trinh
 * ============================================================================
 *  Thay cho "cong nhan dien" cu (chi hoi ma nhan vien, khong co mat khau).
 *
 *  ⚠️ PHAM VI DA MO RONG (18/08/2026 - nghiep vu chot):
 *    - TRUOC: chi chan trang LGC, va CHI nhan vien CUVT moi lap duoc tai khoan.
 *    - NAY  : phai dang nhap moi vao duoc dashboard. MOI nhan vien co ma trong
 *             bang SIGN deu lap duoc tai khoan va xem duoc dashboard TAT.
 *             RIENG nhom LGC (Quan ly xuat kho / Receiving / Repair Admin)
 *             van CHI danh cho nhan vien CUVT - xem co laCuvt.
 *    Ten file giu nguyen de khong phai sua hang chuc cho tham chieu.
 *
 *  LUONG:
 *    1. Nhap MA NHAN VIEN + MAT KHAU.
 *    2. Chua co tai khoan -> tra bang SIGN: co ma trong SIGN la lap duoc, va
 *       mat khau lan dau PHAI la chinh ma nhan vien VIET HOA.
 *    3. Lap xong -> BAT BUOC doi mat khau ngay (co doi_mk = 1). Chua doi thi
 *       chua vao duoc trang LGC.
 *    4. Ho ten nhan vien = [LASTNAME] + [FIRSTNAME] cua bang SIGN (thu tu
 *       Viet Nam: HO truoc). Truoc day lay [DESCRIPTION] - cot do khong phai
 *       ho ten.
 *
 *  LUU BANG SQL (khong dung file JSON): bang [NQT].[dbo].[TAT_USER], app tu
 *  tao neu chua co.
 *
 *  ⚠️ QUY TAC BAT DI BAT DICH: app CHI duoc TAO va ghi vao cac bang TIEN TO
 *  `TAT_` (va SIGN_CACHE co san). TUYET DOI khong sua bang khac cua SQL Server.
 *  Co bai kiem tra tu dong canh dieu nay - xem tools/sqlcheck.js, luat "DDL/DML
 *  ra ngoai bang cua app".
 *
 *  MAT KHAU: bam bang scrypt (co san trong Node, khong them thu vien) voi
 *  muoi ngau nhien 16 byte moi nguoi. KHONG bao gio luu mat khau goc.
 * ============================================================================
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'lgc_auth';
const TTL_MS = 12 * 60 * 60 * 1000;        // ve song 12 gio
// ⚠️ KHONG con danh sach "trung tam duoc dang nhap": MOI nhan vien co trong
// SIGN deu vao duoc dashboard. Danh sach duoi day chi quyet dinh AI THAY NHOM
// LGC - dung mot cho duy nhat de khong bao gio lech giua giao dien va server.
const DEPTS_LGC = ['CUVT'];                 // trung tam duoc dung nhom LGC
/** Nhan vien nay co duoc dung nhom LGC khong? */
const laCuvt = (dept) => DEPTS_LGC.includes(String(dept || '').trim().toUpperCase());
const SAI_TOI_DA = 5;                       // sai lien tiep bao nhieu lan thi khoa
const KHOA_PHUT = 15;                       // khoa bao lau
const MK_TOI_THIEU = 6;                     // do dai mat khau toi thieu

/** Bam mat khau. scrypt: cham co chu dich, chong do mat khau hang loat. */
function bam(matKhau, muoi) {
  return crypto.scryptSync(String(matKhau), muoi, 64);
}

module.exports = function taoAuthLgc({ query, dataDir, logDir, demoMode }) {
  let sanSang = false;             // bang TAT_USER da co chua
  let loiTaoBang = '';
  const demo = new Map();          // DEMO_MODE: giu trong bo nho, khong dung SQL

  // --- Khoa ky cookie: luu ra file de KHOI DONG LAI khong dang xuat ai ---
  const fileBiMat = path.join(dataDir, 'lgc-secret.txt');
  let _bm = '';
  function biMat() {
    if (_bm) return _bm;
    try { if (fs.existsSync(fileBiMat)) _bm = fs.readFileSync(fileBiMat, 'utf8').trim(); } catch (_) { /* tao moi */ }
    if (!_bm) {
      _bm = crypto.randomBytes(32).toString('hex');
      try {
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(fileBiMat, _bm, { encoding: 'utf8', mode: 0o600 });
      } catch (e) { console.warn('[LGC] Khong luu duoc lgc-secret.txt:', e.message); }
    }
    return _bm;
  }
  const ky = (v) => crypto.createHmac('sha256', biMat()).update(v).digest('hex').slice(0, 32);

  function taoVe(ma) {
    const than = `${encodeURIComponent(ma)}.${Date.now() + TTL_MS}`;
    return `${than}.${ky(than)}`;
  }

  /** Doc cookie -> ma nhan vien, hoac '' neu khong hop le / het han. */
  function docVe(req) {
    const raw = String(req.headers.cookie || '')
      .split(';').map((v) => v.trim()).find((v) => v.startsWith(COOKIE + '='));
    if (!raw) return '';
    const [ma, han, chuKy] = raw.slice(COOKIE.length + 1).split('.');
    if (!ma || !han || !chuKy) return '';
    const mong = ky(`${ma}.${han}`);
    if (chuKy.length !== mong.length) return '';
    if (!crypto.timingSafeEqual(Buffer.from(chuKy), Buffer.from(mong))) return '';
    if (Number(han) < Date.now()) return '';
    return decodeURIComponent(ma);
  }

  function ghiLog(ip, ma, ketQua, ghiChu) {
    const day = new Date().toISOString().slice(0, 10);
    const vn = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
    const line = [vn, ip, ma || '-', ketQua, ghiChu || ''].join('\t') + '\n';
    try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) { /* co roi */ }
    fs.appendFile(path.join(logDir, `lgc-access-${day}.log`), line, () => {});
  }

  // -------------------------------------------------------------------------
  // BANG TAT_USER - app tu tao. CHI tao bang cua app, khong dung bang khac.
  // -------------------------------------------------------------------------
  async function khoiTao() {
    if (demoMode) { sanSang = true; return; }
    try {
      await query(`
        IF OBJECT_ID('[NQT].[dbo].[TAT_USER]', 'U') IS NULL
        CREATE TABLE [NQT].[dbo].[TAT_USER] (
          [ma_nv]      NVARCHAR(32)  NOT NULL PRIMARY KEY,
          [ten]        NVARCHAR(200) NULL,
          [department] NVARCHAR(50)  NULL,
          [mk_hash]    VARBINARY(64) NOT NULL,
          [mk_muoi]    VARBINARY(32) NOT NULL,
          [doi_mk]     BIT           NOT NULL CONSTRAINT DF_TAT_USER_doimk DEFAULT (1),
          [tao_luc]    DATETIME2(0)  NOT NULL CONSTRAINT DF_TAT_USER_tao   DEFAULT (SYSUTCDATETIME()),
          [dn_cuoi]    DATETIME2(0)  NULL,
          [sai_lien]   INT           NOT NULL CONSTRAINT DF_TAT_USER_sai   DEFAULT (0),
          [khoa_den]   DATETIME2(0)  NULL
        );`);
      sanSang = true;
      console.log('[LGC] Bang [NQT].[dbo].[TAT_USER] san sang.');
    } catch (e) {
      loiTaoBang = e.message;
      sanSang = false;
      console.warn('[LGC] ⚠ Khong tao duoc bang TAT_USER:', e.message);
      console.warn('[LGC]   Tai khoan SQL can quyen CREATE TABLE tren [NQT].[dbo].');
      console.warn('[LGC]   Trong luc do trang LGC se BI KHOA (an toan hon la mo toang).');
    }
  }

  /** Tra Trung tam + Ten cua mot ma nhan vien tu bang SIGN cua AMOS. */
  async function traSign(ma) {
    if (demoMode) {
      // DEMO: ma bat dau bang 'CU' coi nhu CUVT, de chay thu giao dien
      return /^cu/i.test(ma)
        ? { department: 'CUVT', ten: 'Nhan vien demo ' + ma.toUpperCase() }
        : { department: 'PA', ten: 'Nhan vien demo ' + ma.toUpperCase() };
    }
    const rows = await query(
      `SELECT TOP 1
              LTRIM(RTRIM([DEPARTMENT])) AS department,
              LTRIM(RTRIM(LTRIM(RTRIM(ISNULL([LASTNAME], '')))
                          + ' ' + LTRIM(RTRIM(ISNULL([FIRSTNAME],''))))) AS ten
       FROM [DWH_DB]..[STG_AMOS].[SIGN]
       WHERE LTRIM(RTRIM([USER_SIGN])) = @ma`,
      { ma }
    );
    const r = rows[0] || {};
    return {
      department: String(r.department || '').trim().toUpperCase(),
      ten: String(r.ten || '').trim(),
    };
  }

  async function layUser(ma) {
    if (demoMode) return demo.get(ma) || null;
    const rows = await query(
      `SELECT [ma_nv], [ten], [department], [mk_hash], [mk_muoi], [doi_mk],
              [sai_lien], [khoa_den]
       FROM [NQT].[dbo].[TAT_USER] WHERE [ma_nv] = @ma`,
      { ma }
    );
    return rows[0] || null;
  }

  async function themUser(u) {
    // doi_mk: 1 la BAT BUOC - thieu no thi nguoi moi lap tai khoan vao thang
    // duoc bang mat khau mac dinh (= ma nhan vien), tuc buoc doi mat khau chi
    // la hinh thuc. Nhanh SQL dat 1 trong cau INSERT; nhanh demo tung quen.
    if (demoMode) { demo.set(u.ma_nv, { ...u, doi_mk: true, sai_lien: 0, khoa_den: null }); return; }
    await query(
      `INSERT INTO [NQT].[dbo].[TAT_USER]
         ([ma_nv], [ten], [department], [mk_hash], [mk_muoi], [doi_mk])
       VALUES (@ma, @ten, @dept, @hash, @muoi, 1)`,
      { ma: u.ma_nv, ten: u.ten, dept: u.department, hash: u.mk_hash, muoi: u.mk_muoi }
    );
  }

  async function datMatKhau(ma, hash, muoi) {
    if (demoMode) {
      const u = demo.get(ma); if (u) { u.mk_hash = hash; u.mk_muoi = muoi; u.doi_mk = false; }
      return;
    }
    await query(
      `UPDATE [NQT].[dbo].[TAT_USER]
       SET [mk_hash] = @hash, [mk_muoi] = @muoi, [doi_mk] = 0, [sai_lien] = 0, [khoa_den] = NULL
       WHERE [ma_nv] = @ma`,
      { ma, hash, muoi }
    );
  }

  async function ghiNhanDung(ma) {
    if (demoMode) { const u = demo.get(ma); if (u) { u.sai_lien = 0; u.khoa_den = null; } return; }
    await query(
      `UPDATE [NQT].[dbo].[TAT_USER]
       SET [sai_lien] = 0, [khoa_den] = NULL, [dn_cuoi] = SYSUTCDATETIME() WHERE [ma_nv] = @ma`,
      { ma }
    );
  }

  async function ghiNhanSai(ma, lanSai) {
    const khoa = lanSai >= SAI_TOI_DA;
    if (demoMode) {
      const u = demo.get(ma);
      if (u) { u.sai_lien = lanSai; u.khoa_den = khoa ? new Date(Date.now() + KHOA_PHUT * 60000) : null; }
      return khoa;
    }
    await query(
      `UPDATE [NQT].[dbo].[TAT_USER]
       SET [sai_lien] = @n,
           [khoa_den] = CASE WHEN @n >= ${SAI_TOI_DA} THEN DATEADD(minute, ${KHOA_PHUT}, SYSUTCDATETIME()) END
       WHERE [ma_nv] = @ma`,
      { ma, n: lanSai }
    );
    return khoa;
  }

  const dangKhoa = (u) => u && u.khoa_den && new Date(u.khoa_den).getTime() > Date.now();

  // -------------------------------------------------------------------------
  // DANG NHAP
  // -------------------------------------------------------------------------
  /**
   * @returns {{ok:boolean, ma?:string, ten?:string, doiMk?:boolean,
   *            maLoi?:string, message?:string, status?:number}}
   */
  async function dangNhap(maRaw, matKhau, ip) {
    const ma = String(maRaw || '').trim().toUpperCase().slice(0, 32);
    if (!ma) return { ok: false, status: 400, message: 'Chưa nhập mã nhân viên.' };
    if (!matKhau) return { ok: false, status: 400, message: 'Chưa nhập mật khẩu.' };
    if (!sanSang) {
      return { ok: false, status: 503, maLoi: 'CHUA_SAN_SANG',
        message: 'Hệ thống tài khoản chưa sẵn sàng (không tạo được bảng TAT_USER). Báo quản trị viên.' };
    }

    let u = await layUser(ma);

    if (dangKhoa(u)) {
      const con = Math.ceil((new Date(u.khoa_den).getTime() - Date.now()) / 60000);
      ghiLog(ip, ma, 'LOCKED', `con ${con} phut`);
      return { ok: false, status: 429, message: `Tài khoản đang bị khoá do sai mật khẩu nhiều lần. Thử lại sau ${con} phút.` };
    }

    // --- Chua co tai khoan: lap lan dau ---
    if (!u) {
      const sign = await traSign(ma);
      if (!sign.department) {
        ghiLog(ip, ma, 'DENY', 'khong co trong SIGN');
        return { ok: false, status: 403, message: `Không tìm thấy mã nhân viên “${ma}” trong hệ thống AMOS.` };
      }
      // ⚠️ KHONG chan theo trung tam nua: co ma trong SIGN la lap duoc tai
      // khoan. Trung tam chi quyet dinh co THAY nhom LGC hay khong (laCuvt).
      // Mat khau khoi tao PHAI la chinh ma nhan vien VIET HOA
      if (String(matKhau) !== ma) {
        ghiLog(ip, ma, 'DENY', 'mat khau khoi tao sai');
        return { ok: false, status: 401, maLoi: 'LAN_DAU',
          message: 'Lần đầu đăng nhập: mật khẩu chính là MÃ NHÂN VIÊN VIẾT HOA.' };
      }
      const muoi = crypto.randomBytes(16);
      await themUser({ ma_nv: ma, ten: sign.ten, department: sign.department, mk_hash: bam(ma, muoi), mk_muoi: muoi });
      ghiLog(ip, ma, 'CREATE', `dept=${sign.department}`);
      u = await layUser(ma);
      return { ok: true, ma, ten: (u && u.ten) || sign.ten,
        department: sign.department, lgc: laCuvt(sign.department), doiMk: true };
    }

    // --- Da co tai khoan: kiem tra mat khau ---
    const muoi = Buffer.from(u.mk_muoi);
    const mong = Buffer.from(u.mk_hash);
    const thu = bam(matKhau, muoi);
    const dung = thu.length === mong.length && crypto.timingSafeEqual(thu, mong);
    if (!dung) {
      const lan = (u.sai_lien || 0) + 1;
      const biKhoa = await ghiNhanSai(ma, lan);
      ghiLog(ip, ma, 'FAIL', `sai lan ${lan}${biKhoa ? ' -> KHOA' : ''}`);
      return { ok: false, status: 401,
        message: biKhoa
          ? `Sai mật khẩu ${lan} lần. Tài khoản bị khoá ${KHOA_PHUT} phút.`
          : `Sai mật khẩu. Còn ${SAI_TOI_DA - lan} lần trước khi bị khoá.` };
    }
    await ghiNhanDung(ma);
    ghiLog(ip, ma, 'ALLOW', `dept=${u.department || ''}`);
    return { ok: true, ma, ten: u.ten || '', department: u.department || '',
      lgc: laCuvt(u.department), doiMk: !!u.doi_mk };
  }

  /** Doi mat khau. Yeu cau biet mat khau cu (ke ca lan doi bat buoc dau tien). */
  async function doiMatKhau(ma, cu, moi, ip) {
    if (!sanSang) return { ok: false, status: 503, message: 'Hệ thống tài khoản chưa sẵn sàng.' };
    const u = await layUser(ma);
    if (!u) return { ok: false, status: 401, message: 'Phiên đăng nhập không hợp lệ.' };

    const muoi = Buffer.from(u.mk_muoi);
    const mong = Buffer.from(u.mk_hash);
    const thu = bam(cu, muoi);
    if (!(thu.length === mong.length && crypto.timingSafeEqual(thu, mong))) {
      ghiLog(ip, ma, 'CHGPW_FAIL', 'mat khau cu sai');
      return { ok: false, status: 401, message: 'Mật khẩu hiện tại không đúng.' };
    }
    const s = String(moi || '');
    if (s.length < MK_TOI_THIEU) {
      return { ok: false, status: 400, message: `Mật khẩu mới phải từ ${MK_TOI_THIEU} ký tự trở lên.` };
    }
    if (s.toUpperCase() === ma) {
      // Neu cho phep thi mat khau van la ma nhan vien - dung bang khong doi
      return { ok: false, status: 400, message: 'Mật khẩu mới không được trùng mã nhân viên.' };
    }
    const muoiMoi = crypto.randomBytes(16);
    await datMatKhau(ma, bam(s, muoiMoi), muoiMoi);
    ghiLog(ip, ma, 'CHGPW_OK', '');
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // QUAN TRI TAI KHOAN (goi tu /api/admin/... - da qua adminGuard theo IP)
  // -------------------------------------------------------------------------

  /** Danh sach tai khoan LGC + trang thai khoa, de trang /admin xu ly. */
  async function danhSachUser() {
    if (demoMode) {
      return [...demo.values()].map((u) => ({
        ma_nv: u.ma_nv, ten: u.ten || '', department: u.department || '',
        doi_mk: !!u.doi_mk, sai_lien: u.sai_lien || 0,
        khoa_den: u.khoa_den || null, dn_cuoi: u.dn_cuoi || null, tao_luc: u.tao_luc || null,
      }));
    }
    if (!sanSang) return [];
    // KHONG lay [mk_hash] / [mk_muoi]: bam mat khau khong co viec gi phai roi
    // ra khoi may chu, ke ca cho trang quan tri.
    const rows = await query(
      `SELECT [ma_nv], [ten], [department], [doi_mk], [sai_lien], [khoa_den], [dn_cuoi], [tao_luc]
       FROM [NQT].[dbo].[TAT_USER] ORDER BY [ma_nv]`
    );
    return rows.map((u) => ({ ...u, doi_mk: !!u.doi_mk }));
  }

  /**
   * MO KHOA: chi xoa trang thai khoa, GIU NGUYEN mat khau.
   * Dung cho nguoi go sai vai lan roi bi khoa 15 phut nhung van nho mat khau -
   * khong co ly do gi bat ho dat lai mat khau.
   */
  async function moKhoaUser(maRaw) {
    const ma = String(maRaw || '').trim().toUpperCase();
    if (!ma) return { ok: false, message: 'Thiếu mã nhân viên.' };
    if (demoMode) {
      const u = demo.get(ma);
      if (!u) return { ok: false, message: `Không có tài khoản “${ma}”.` };
      u.sai_lien = 0; u.khoa_den = null;
      return { ok: true, ma };
    }
    const r = await query(
      `UPDATE [NQT].[dbo].[TAT_USER] SET [sai_lien] = 0, [khoa_den] = NULL
       WHERE [ma_nv] = @ma;
       SELECT @@ROWCOUNT AS n;`, { ma }
    );
    const n = (r[0] || {}).n || 0;
    if (!n) return { ok: false, message: `Không có tài khoản “${ma}”.` };
    return { ok: true, ma };
  }

  /**
   * DAT LAI MAT KHAU ve chinh MA NHAN VIEN VIET HOA - dung quy tac cua lan
   * dang nhap dau tien, nen khong phai bay ra mot mat khau tam roi tim cach
   * bao cho nguoi ta.
   * ⚠️ BAT BUOC dat [doi_mk] = 1: neu khong, nguoi dung co the dung mai mat
   * khau bang chinh ma nhan vien minh - ai cung doan ra.
   * Cung xoa luon trang thai khoa (dat lai xong ma van bi khoa thi vo nghia).
   */
  async function datLaiMatKhau(maRaw) {
    const ma = String(maRaw || '').trim().toUpperCase();
    if (!ma) return { ok: false, message: 'Thiếu mã nhân viên.' };
    const muoi = crypto.randomBytes(16);
    const hash = bam(ma, muoi);
    if (demoMode) {
      const u = demo.get(ma);
      if (!u) return { ok: false, message: `Không có tài khoản “${ma}”.` };
      u.mk_hash = hash; u.mk_muoi = muoi; u.doi_mk = true; u.sai_lien = 0; u.khoa_den = null;
      return { ok: true, ma, mkMoi: ma };
    }
    const r = await query(
      `UPDATE [NQT].[dbo].[TAT_USER]
       SET [mk_hash] = @hash, [mk_muoi] = @muoi, [doi_mk] = 1,
           [sai_lien] = 0, [khoa_den] = NULL
       WHERE [ma_nv] = @ma;
       SELECT @@ROWCOUNT AS n;`, { ma, hash, muoi }
    );
    const n = (r[0] || {}).n || 0;
    if (!n) return { ok: false, message: `Không có tài khoản “${ma}”.` };
    return { ok: true, ma, mkMoi: ma };
  }

  /** Nguoi dung hien tai (da dang nhap va KHONG con phai doi mat khau). */
  async function aiDangDung(req) {
    const ma = docVe(req);
    if (!ma) return null;
    const u = await layUser(ma).catch(() => null);
    if (!u) return null;
    // `lgc` = co duoc dung nhom LGC khong. Server dung chinh co nay de chan
    // (lgcGuard), giao dien dung no de an/hien tab -> mot nguon su that duy nhat.
    return { ma, ten: u.ten || '', doiMk: !!u.doi_mk,
      department: u.department || '', lgc: laCuvt(u.department) };
  }

  return {
    COOKIE, TTL_MS, DEPTS_LGC, laCuvt, MK_TOI_THIEU,
    khoiTao, dangNhap, doiMatKhau, aiDangDung, docVe, taoVe, ghiLog, layUser,
    danhSachUser, moKhoaUser, datLaiMatKhau, SAI_TOI_DA, KHOA_PHUT,
    trangThai: () => ({ sanSang, loiTaoBang }),
  };
};
