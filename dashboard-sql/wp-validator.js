/**
 * ============================================================================
 *  wp-validator.js  -  Lay du lieu WORK PACKAGE tu AMOS cho trang "Ra soat ho so"
 * ============================================================================
 *  Cau SQL goc (ban nghiep vu gui) noi CHIN BANG trong MOT cau:
 *      WP_HEADER x RM_CALENDAR_ENTRY x ADDRESS x WP_SEQUENCE x WO_HEADER
 *      x WORKSTEP_LINK x WO_TEXT_DESCRIPTION x WO_TEXT_ACTION
 *      x TIME_CAPTURED_ADDITIONAL x TIME_CAPTURED x WO_REMARKS
 *  Da do that: chay 1 gio 09 phut ma VAN chua ra dong nao (anh chup man hinh).
 *  Ly do: tat ca deu nam tren LINKED SERVER; SQL Server khong day duoc phep
 *  noi xuong AMOS nen phai keo ca bang ve roi noi tai cho theo cach te nhat.
 *
 *  CACH LAM O DAY - LAY TUNG BANG, TRUYEN ID SANG BANG KE TIEP:
 *      A. WP_HEADER   WHERE WP_STATUS / STATUS / STATION / START_DATE  (chon WP)
 *         RM_CALENDAR_ENTRY WHERE WPNO_I IN (...) AND RESOURCE_TYPE_NOI = -13
 *         ADDRESS    WHERE ADDRESS_I IN (...)                  -> HANGAR
 *      B. WP_SEQUENCE WHERE WPNO_I = ...                       -> EVENT_PERFNO_I
 *         WO_HEADER   WHERE EVENT_PERFNO_I IN (...)            -> STATE
 *         WO_REMARKS  WHERE EVENT_PERFNO_I IN (...)            -> noi dung ban giao
 *         WORKSTEP_LINK WHERE EVENT_PERFNO_I IN (...) -> WORKSTEP_LINKNO_I, DESCNO_I
 *         WO_TEXT_DESCRIPTION WHERE DESCNO_I IN (...)
 *         WO_TEXT_ACTION      WHERE WORKSTEP_LINKNO_I IN (...) -> ACTIONNO_I
 *         TIME_CAPTURED_ADDITIONAL WHERE ITEMNO_I IN (...)     -> BOOKINGNO_I
 *         TIME_CAPTURED   WHERE BOOKINGNO_I IN (...)
 *  Moi buoc la MOT cau don gian tren MOT bang, dieu kien la danh sach so DAT
 *  TRUC TIEP vao cau lenh (khong dung @thamso - tham so chan viec day dieu kien
 *  xuong AMOS, xem README §7b). Noi cac manh lai o Node.
 *
 *  ⚠️ CAU GOC LA ORACLE: `TO_DATE`, `TO_CHAR`, `INTERVAL`, `||` khong chay duoc
 *  qua linked server bang T-SQL. Nen o day chi keo ve SO THO, moi phep doi
 *  ngay/gio/cong deu lam o Node (xem doiNgay / doiGio / doiCong).
 * ============================================================================
 */
'use strict';

const LO = 300;   // moi lo bao nhieu ID trong menh de IN (...)
const T = '[DWH_DB]..[STG_AMOS]';

/** Moc ngay cua AMOS: START_DATE / ACTION_DATE = so ngay ke tu 31/12/1971. */
const MOC_AMOS = Date.UTC(1971, 11, 31);

/**
 * WP_HEADER.WP_STATUS - ma so do nghiep vu cung cap (da xac nhan lai):
 *     11  = PRELOAD      (WP chuan bi)
 *     112 = IN PROGRESS  (WP dang thuc hien)
 *     -2  = CLOSED       (WP da dong)
 */
const WP_STATUS = {
  PRELOAD: 11,
  INPROGRESS: 112,
  CLOSED: -2,
};

/**
 * WP_HEADER.STATUS - cot KHAC WP_STATUS (ban ghi con hieu luc hay khong).
 * ⚠️ Cau SQL nghiep vu chi dung `STATUS = 0` cho nhanh IN PROGRESS; o day no
 * duoc ap cho ca ba tinh trang. Neu voi CLOSED/PRELOAD ma AMOS ghi gia tri
 * khac thi danh sach se ra RONG - nen khi ket qua rong, demStatus0() dem thu
 * "bo dieu kien nay thi duoc bao nhieu" va bao thang ra man hinh.
 */
const STATUS_HIEU_LUC = 0;

/** Loai tai nguyen trong RM_CALENDAR_ENTRY dung de lay HANGAR. */
const RESOURCE_TYPE_HANGAR = -13;

/**
 * TEN COT - tat ca deu do nghiep vu xac nhan, KHONG con cho nao phai doan.
 * Hai cot duoi day khong nam trong danh sach SELECT cua cau SQL goc nen truoc
 * do phai do; nghiep vu da chot:
 *   - WP_HEADER.AC_REGISTR : so dang ky tau
 *   - WO_REMARKS.TEXT      : noi dung ban giao (handover)
 * Doi chieu lai bat cu luc nao bang GET /api/admin/diag/wp-columns.
 */
const COT_AC_REG = 'AC_REGISTR';
const COT_REMARK = 'TEXT';

/** Lay gia tri cot theo danh sach ten co the co. Tra '' neu khong co cot nao. */
function lay(row, tenList) {
  if (!row) return '';
  const ds = Array.isArray(tenList) ? tenList : [tenList];
  for (const t of ds) {
    for (const k of Object.keys(row)) {
      if (k.toLowerCase() === t.toLowerCase()) {
        const v = row[k];
        if (v === null || v === undefined) return '';
        return typeof v === 'string' ? v.trim() : String(v);
      }
    }
  }
  return '';
}

/** Cot ID: tra ve khoa dang chuoi, '' -> null. */
function layId(row, ten) {
  const v = lay(row, [ten]);
  return v === '' ? null : v;
}

const duyNhat = (ds) => [...new Set(ds.filter((v) => v !== null && v !== undefined && v !== ''))];

/** Chia mang thanh cac lo <= LO phan tu. */
function chiaLo(ds) {
  const out = [];
  for (let i = 0; i < ds.length; i += LO) out.push(ds.slice(i, i + LO));
  return out;
}

/** Dat gia tri vao cau lenh: so de nguyen, chuoi nhan doi dau nhay. */
function q(v) {
  const s = String(v);
  return /^-?\d+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
}

const hai = (n) => String(n).padStart(2, '0');

/** So ngay AMOS -> 'DD/MM/YYYY'. 0 / rong -> ''. */
function doiNgay(n) {
  const v = Number(n);
  if (!v || Number.isNaN(v)) return '';
  const d = new Date(MOC_AMOS + v * 86400000);
  return `${hai(d.getUTCDate())}/${hai(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** 'YYYY-MM-DD' -> so ngay AMOS. Sai dinh dang -> null. */
function ngaySangAmos(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - MOC_AMOS) / 86400000);
}

/**
 * ACTION_TIME cua AMOS tinh bang PHUT ke tu 0h (cau goc: INTERVAL '1 MINUTE' *
 * ACTION_TIME) -> 'HH:MM:00'. Khac voi MUTATION_TIME o cac bang kho (mili giay).
 */
function doiGio(n) {
  const v = Number(n);
  if (Number.isNaN(v) || n === '' || n === null || n === undefined) return '';
  const p = Math.max(0, Math.round(v));
  return `${hai(Math.floor(p / 60) % 24)}:${hai(p % 60)}:00`;
}

/** DURATION / EST_MH tinh bang PHUT -> gio (3 chu so thap phan). */
function doiCong(n) {
  const v = Number(n);
  if (!v || Number.isNaN(v)) return 0;
  return Math.round((v / 60) * 1000) / 1000;
}

module.exports = function taoWpValidator({ query, demoMode, docDemo }) {
  /**
   * Lay TAT CA dong cua mot bang AMOS theo danh sach ID - chia lo, chay tuan tu.
   * @param {string} bang    ten bang (khong ke tien to linked server)
   * @param {string} cot     ten cot ID
   * @param {Array} ids      danh sach gia tri
   * @param {Function} ghi   ham ghi nhat ky tien trinh
   * @param {string} [themDk] dieu kien AND them (chuoi SQL thuan, khong tham so)
   */
  async function layTheoId(bang, cot, ids, ghi, themDk = '') {
    const ds = duyNhat(ids);
    if (!ds.length) return [];
    const lo = chiaLo(ds);
    const out = [];
    for (let i = 0; i < lo.length; i++) {
      const nhan = lo.length > 1 ? `${bang} (lô ${i + 1}/${lo.length})` : bang;
      ghi(`▶ ${nhan}: ${lo[i].length} ID…`);
      const t = Date.now();
      // SELECT * : lay het cot roi chon o Node - khong phai sua hai noi moi khi
      // can them mot cot. Dieu kien dat TRUC TIEP (khong @thamso) de AMOS loc
      // duoc ngay tai cho (README §7b).
      const rows = await query(
        `SELECT * FROM ${T}.[${bang}] WHERE [${cot}] IN (${lo[i].map(q).join(', ')})${themDk}`
      );
      ghi(`✔ ${nhan} — ${rows.length} dòng, ${Date.now() - t} ms`);
      out.push(...rows);
    }
    return out;
  }

  /** Gom mang theo khoa. */
  function gom(rows, cot) {
    const m = new Map();
    for (const r of rows) {
      const k = layId(r, cot);
      if (k === null) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  }

  // =========================================================================
  //  A. CHON WORK PACKAGE - station + tinh trang (+ ngay bat dau neu CLOSED)
  // =========================================================================

  /**
   * DEMO: gan station/tinh trang/ngay cho 5 WP mau mot cach CO DINH, de kiem
   * thu ca ba tinh trang ma khong phai co SQL Server.
   */
  function demoDanhSach() {
    const wps = [...new Set(docDemo().map((w) => w.WP))].sort();
    const tt = [WP_STATUS.INPROGRESS, WP_STATUS.CLOSED, WP_STATUS.PRELOAD];
    return wps.map((wp, i) => {
      const wo = docDemo().find((w) => w.WP === wp) || {};
      return {
        wpnoI: String(9000 + i),
        wp,
        station: wo.STATION || 'SGN',
        wpStatus: tt[i % tt.length],
        startDate: doiNgay(19725 + i * 30),
        endDate: doiNgay(19725 + i * 30 + 12),
        startAmos: 19725 + i * 30,
        acOperator: 'VN',
        acModel: 'A321',
        acReg: wo.AC || '',
        projectNo: 'DEMO-' + (i + 1),
        // WP dau tien CO TINH de trong hangar: de kiem thu duoc luat "chi liet
        // ke WP co hangar" tren du lieu mau, khong phai chay that moi biet.
        hangar: i === 0 ? '' : (i % 2 ? 'HANGAR 2' : 'HANGAR 1'),
      };
    });
  }

  /**
   * Tim cac Work Package theo station + tinh trang (+ tu ngay, cho WP da dong).
   * @param {Object} loc { station, wpStatus, tuNgay:'YYYY-MM-DD', gioiHan }
   */
  async function timWorkPackage(loc = {}, ghi = () => {}) {
    const station = String(loc.station || '').trim();
    const wpStatus = Number(loc.wpStatus);
    const n = Math.min(1000, Math.max(1, Number(loc.gioiHan) || 300));
    const tuAmos = ngaySangAmos(loc.tuNgay);

    if (!station) return { loi: 'Chưa chọn station.' };
    if (!Object.values(WP_STATUS).includes(wpStatus)) {
      return { loi: 'Tình trạng WP không hợp lệ (chỉ nhận CLOSED / IN PROGRESS / PRELOAD).' };
    }
    // WP da dong thi rat nhieu - BAT BUOC co moc ngay, neu khong cau nay quet
    // ca lich su AMOS va khong bao gio ve.
    if (wpStatus === WP_STATUS.CLOSED && tuAmos === null) {
      return { loi: 'WP đã đóng phải có “ngày bắt đầu từ” (định dạng YYYY-MM-DD).' };
    }

    if (demoMode) {
      ghi('Chế độ DEMO — dùng dữ liệu mẫu, không hỏi AMOS.');
      const tho = demoDanhSach().filter((w) => w.station === station && w.wpStatus === wpStatus
        && (tuAmos === null || w.startAmos >= tuAmos));
      const ds = tho.filter((w) => w.hangar);
      ghi(`✔ Xong — ${ds.length}/${tho.length} Work Package có hangar (dữ liệu mẫu)`, true);
      return { ds, tongTruocLoc: tho.length, demo: true };
    }

    // --- 1. WP_HEADER: chi dung phep so sanh THUAN, khong ham -> AMOS loc duoc ---
    const dk = [
      `[WP_STATUS] = ${wpStatus}`,
      `[STATUS] = ${STATUS_HIEU_LUC}`,
      `[STATION] = ${q(station)}`,
    ];
    if (tuAmos !== null) dk.push(`[START_DATE] >= ${tuAmos}`);
    ghi(`▶ WP_HEADER: station ${station}, tình trạng ${tenTinhTrang(wpStatus)} (WP_STATUS = ${wpStatus})`
      + (tuAmos !== null ? `, bắt đầu từ ${loc.tuNgay}` : '') + '…');
    let t = Date.now();
    const head = await query(
      `SELECT TOP ${n} * FROM ${T}.[WP_HEADER] WHERE ${dk.join(' AND ')} ORDER BY [START_DATE] DESC`
    );
    ghi(`✔ WP_HEADER — ${head.length} Work Package, ${Date.now() - t} ms`);
    if (!head.length) return { ds: [], tongTruocLoc: 0, khongStatus0: await demStatus0(dk, ghi) };

    // --- 2 + 3. HANGAR: RM_CALENDAR_ENTRY -> ADDRESS ---
    //     Day KHONG con la cot trang tri: nghiep vu chi ra soat WP CO hangar,
    //     nen buoc nay la BO LOC. Loi o day khong duoc nuot - nuot thi danh
    //     sach ra RONG va nguoi dung tuong la "khong co WP nao".
    const wpIds = duyNhat(head.map((r) => layId(r, 'WPNO_I')));
    const lich = await layTheoId('RM_CALENDAR_ENTRY', 'WPNO_I', wpIds, ghi,
      ` AND [RESOURCE_TYPE_NOI] = ${RESOURCE_TYPE_HANGAR}`);
    const addrIds = duyNhat(lich.map((r) => layId(r, 'RESOURCE_AMOS_KEY')));
    const addr = await layTheoId('ADDRESS', 'ADDRESS_I', addrIds, ghi);
    const tenTheoAddr = new Map(addr.map((r) => [layId(r, 'ADDRESS_I'), lay(r, 'VENDOR')]));
    const hangarTheoWp = new Map();
    for (const r of lich) {
      const ten = tenTheoAddr.get(layId(r, 'RESOURCE_AMOS_KEY')) || '';
      if (ten) hangarTheoWp.set(layId(r, 'WPNO_I'), ten);
    }

    const ds = head.map((r) => ({
      wpnoI: layId(r, 'WPNO_I'),
      wp: lay(r, 'WPNO'),
      station: lay(r, 'STATION'),
      wpStatus,
      startDate: doiNgay(lay(r, 'START_DATE')),
      endDate: doiNgay(lay(r, 'END_DATE')),
      startAmos: Number(lay(r, 'START_DATE')) || 0,
      acOperator: lay(r, 'AC_OPERATOR'),
      acModel: lay(r, 'AC_MODEL'),
      acReg: lay(r, COT_AC_REG),
      projectNo: lay(r, 'PROJECTNO'),
      hangar: hangarTheoWp.get(layId(r, 'WPNO_I')) || '',
    })).filter((w) => w.hangar);      // CHI liet ke WP co du lieu hangar

    ghi(`✔ Xong — ${ds.length}/${head.length} Work Package có hangar`, true);
    return { ds, tongTruocLoc: head.length, chamTran: head.length >= n };
  }

  /**
   * Khi tim ra 0 WP: dem thu neu BO dieu kien [STATUS] = 0 thi co bao nhieu.
   * VI SAO: dieu kien nay duoc bung tu cau SQL cua nhanh IN PROGRESS sang ca
   * ba tinh trang, chua ai xac nhan la dung cho CLOSED/PRELOAD. Neu no chinh
   * la thu dang cat het ket qua thi phai noi ra ngay tren man hinh, thay vi de
   * nguoi dung ngoi doan xem "khong co WP nao" that hay gia.
   * Chi chay khi ket qua rong nen khong ton them gi o duong chay binh thuong.
   */
  async function demStatus0(dk, ghi) {
    const conLai = dk.filter((d) => !d.startsWith('[STATUS] ='));
    try {
      const r = await query(
        `SELECT COUNT(*) AS so FROM ${T}.[WP_HEADER] WHERE ${conLai.join(' AND ')}`
      );
      const so = Number(r[0] && r[0].so) || 0;
      if (so) ghi(`· Nếu BỎ điều kiện [STATUS] = ${STATUS_HIEU_LUC} thì có ${so} WP khớp`);
      return so;
    } catch (_) { return null; }
  }

  function tenTinhTrang(n) {
    if (Number(n) === WP_STATUS.CLOSED) return 'CLOSED';
    if (Number(n) === WP_STATUS.INPROGRESS) return 'IN PROGRESS';
    if (Number(n) === WP_STATUS.PRELOAD) return 'PRELOAD';
    return String(n);
  }

  // =========================================================================
  //  B. LAY CHI TIET MOT WORK PACKAGE
  // =========================================================================

  /**
   * BUOC 1 - tim dong WP_HEADER.
   * Nhan ca WPNO_I (so noi bo, danh sach o tren tra ve) lan WPNO (ten nguoi
   * dung doc duoc). Uu tien WPNO_I vi do la khoa that.
   */
  async function timWpHeader(wp, ghi) {
    const laSo = /^\d+$/.test(String(wp));
    const cot = laSo ? 'WPNO_I' : 'WPNO';
    const t = Date.now();
    const rows = await query(`SELECT TOP 1 * FROM ${T}.[WP_HEADER] WHERE [${cot}] = ${q(wp)}`);
    ghi(`✔ WP_HEADER theo [${cot}] — ${rows.length} dòng, ${Date.now() - t} ms`);
    return rows;
  }

  /**
   * Lay toan bo du lieu cua MOT Work Package, tra ve dung dinh dang ma trang
   * ra soat can: [{ WP, AC, STATION, WO, SEQ, ST, TXT, HTML, REM[], steps[] }]
   */
  async function layWorkPackage(wp, ghi = () => {}) {
    if (demoMode) {
      ghi('Chế độ DEMO — dùng dữ liệu mẫu, không hỏi AMOS.');
      const tatCa = docDemo();
      // Demo nhan ca ten WP lan ma so gia (wpnoI) do demoDanhSach() sinh ra
      const theoMa = demoDanhSach().find((x) => x.wpnoI === String(wp));
      const ten = theoMa ? theoMa.wp : String(wp);
      const ds = wp ? tatCa.filter((w) => w.WP === ten) : tatCa;
      // Go sai so WP thi demo cung phai bao "khong tim thay" y nhu chay that,
      // neu khong nguoi kiem thu se tuong loi do da duoc xu ly.
      if (wp && !ds.length) {
        ghi(`✘ Không có Work Package ${wp} trong dữ liệu mẫu`, true);
        return { rows: [], khongThay: true, demo: true };
      }
      // Du lieu mau duoc trich tu ban Excel nen chua co chi tiet cham cong.
      // Dung LAI dung nhung gi da co (nguoi ky + so gio), KHONG bia them bo
      // phan / dau viec - de ban demo khong ve ra thu ma AMOS chua chac tra ve.
      ds.forEach((w) => (w.steps || []).forEach((s) => {
        if (!s.cong) s.cong = s.sg ? [{ nguoi: s.sg, bp: '', viec: '', gio: s.mh || 0, dinhMuc: 0 }] : [];
      }));
      ghi(`✔ Xong — ${ds.length} WO (dữ liệu mẫu)`, true);
      return { rows: ds, demo: true, wp: ten, thongTin: theoMa || null };
    }

    // --- 1. WP_HEADER ---
    ghi(`▶ WP_HEADER: tìm Work Package ${wp}…`);
    const head = await timWpHeader(wp, ghi);
    if (!head.length) return { rows: [], khongThay: true };
    const h0 = head[0];
    const wpId = layId(h0, 'WPNO_I');
    if (wpId === null) {
      return { rows: [], khongThay: true, loi: 'WP_HEADER không có cột WPNO_I — không lần được xuống WP_SEQUENCE.' };
    }
    const wpTen = lay(h0, 'WPNO') || String(wp);

    // --- 2. WP_SEQUENCE ---
    const wpSeq = await layTheoId('WP_SEQUENCE', 'WPNO_I', [wpId], ghi);
    const events = duyNhat(wpSeq.map((r) => layId(r, 'EVENT_PERFNO_I')));
    ghi(`   → ${events.length} work order (EVENT_PERFNO_I)`);
    if (!events.length) {
      ghi('✔ Xong — Work Package không có work order nào', true);
      return { rows: [], wp: wpTen, thongTin: tomTat(h0) };
    }

    // --- 3 + 4 + 5 chay SONG SONG: ba nhanh doc lap, cung khoa EVENT_PERFNO_I ---
    const [woHead, woRem, wsLink] = await Promise.all([
      layTheoId('WO_HEADER', 'EVENT_PERFNO_I', events, ghi),
      layTheoId('WO_REMARKS', 'EVENT_PERFNO_I', events, ghi).catch((e) => {
        // WO_REMARKS chi phuc vu module Handover; thieu no van xem duoc hai
        // module kia - bao ra nhat ky chu khong lam hong ca trang.
        ghi(`· Không đọc được WO_REMARKS (${e.message.slice(0, 60)})`);
        return [];
      }),
      layTheoId('WORKSTEP_LINK', 'EVENT_PERFNO_I', events, ghi),
    ]);

    // --- 6 + 7 chay SONG SONG ---
    const descIds = duyNhat(wsLink.map((r) => layId(r, 'DESCNO_I')));
    const linkIds = duyNhat(wsLink.map((r) => layId(r, 'WORKSTEP_LINKNO_I')));
    const [woDesc, woAct] = await Promise.all([
      layTheoId('WO_TEXT_DESCRIPTION', 'DESCNO_I', descIds, ghi),
      layTheoId('WO_TEXT_ACTION', 'WORKSTEP_LINKNO_I', linkIds, ghi),
    ]);

    // --- 8. TIME_CAPTURED_ADDITIONAL (ITEMNO_I = ACTIONNO_I) ---
    const actIds = duyNhat(woAct.map((r) => layId(r, 'ACTIONNO_I')));
    const tcAdd = await layTheoId('TIME_CAPTURED_ADDITIONAL', 'ITEMNO_I', actIds, ghi);

    // --- 9. TIME_CAPTURED ---
    const bookIds = duyNhat(tcAdd.map((r) => layId(r, 'BOOKINGNO_I')));
    const tc = await layTheoId('TIME_CAPTURED', 'BOOKINGNO_I', bookIds, ghi);

    // --- Noi cac manh lai TAI NODE ---
    ghi('▶ Ghép dữ liệu…');
    const t = Date.now();
    const stateTheoEvent = new Map(woHead.map((r) => [layId(r, 'EVENT_PERFNO_I'), lay(r, 'STATE')]));
    const remTheoEvent = gom(woRem, 'EVENT_PERFNO_I');
    const linkTheoEvent = gom(wsLink, 'EVENT_PERFNO_I');
    const descTheoId = new Map(woDesc.map((r) => [layId(r, 'DESCNO_I'), r]));
    const actTheoLink = gom(woAct, 'WORKSTEP_LINKNO_I');
    const addTheoItem = gom(tcAdd, 'ITEMNO_I');
    const tcTheoBooking = gom(tc, 'BOOKINGNO_I');

    const acReg = lay(h0, COT_AC_REG);
    const station = lay(h0, 'STATION');
    const rows = [];
    for (const sq of wpSeq) {
      const ev = layId(sq, 'EVENT_PERFNO_I');
      if (ev === null) continue;

      const links = (linkTheoEvent.get(ev) || [])
        .sort((a, b) => (Number(lay(a, 'SEQUENCENO')) || 0) - (Number(lay(b, 'SEQUENCENO')) || 0));

      // Noi dung WO = mo ta cua workstep DAU TIEN - dung nhu cong cu Excel lay
      // WO_TEXT/DES o dong dau moi WO.
      const descDau = links.length ? descTheoId.get(layId(links[0], 'DESCNO_I')) : null;

      const steps = [];
      for (const lk of links) {
        const ws = lay(lk, 'SEQUENCENO');
        const desc = descTheoId.get(layId(lk, 'DESCNO_I'));
        const descHtml = lay(desc, 'TEXT_HTML');
        const acts = actTheoLink.get(layId(lk, 'WORKSTEP_LINKNO_I')) || [];
        if (!acts.length) {
          // Workstep chua co hanh dong nao = CHUA THUC HIEN (module 3.4 can biet)
          steps.push({ ws, rawDat: '', rawTim: '', txt: '', html: descHtml.slice(0, 900),
            hdr: '', sg: '', mh: 0, cong: [] });
          continue;
        }
        for (const ac of acts) {
          const adds = addTheoItem.get(layId(ac, 'ACTIONNO_I')) || [];
          const tcs = adds.flatMap((a) => (tcTheoBooking.get(layId(a, 'BOOKINGNO_I')) || [])
            .map((b) => ({ b, a })));
          // Cong tinh theo PHUT trong AMOS. Giu dung quy tac cua cong cu Excel:
          // lay gia tri DURATION dau tien (cac lan cham cong cua cung mot hanh
          // dong ghi cung so) - de con so tren web khop voi ban Excel dang dung.
          const durs = duyNhat(tcs.map(({ b }) => lay(b, 'DURATION')));
          const stepTxt = lay(ac, 'TEXT');
          steps.push({
            ws,
            rawDat: doiNgay(lay(ac, 'ACTION_DATE')),
            rawTim: doiGio(lay(ac, 'ACTION_TIME')),
            txt: stepTxt.slice(0, 800),
            html: stepTxt ? '' : descHtml.slice(0, 900),
            hdr: lay(ac, 'HEADER').slice(0, 90),
            sg: lay(ac, 'SIGN_PERFORMED').slice(0, 80),
            mh: durs.length ? doiCong(durs[0]) : 0,
            // Chi tiet cham cong - chi hien o dong mo rong
            cong: tcs.map(({ b, a }) => ({
              nguoi: lay(b, 'USER_SIGN'),
              bp: lay(a, 'USER_DEPARTMENT'),
              viec: lay(a, 'USER_JOB'),
              gio: doiCong(lay(b, 'DURATION')),
              dinhMuc: doiCong(lay(b, 'EST_MH')),
            })),
          });
        }
      }

      const pre = lay(sq, 'SEQNO_PREFIX_I');
      const so = lay(sq, 'SEQNO');
      rows.push({
        WP: wpTen,
        AC: acReg || lay(h0, 'AC_MODEL'),
        STATION: station,
        WO: String(ev),
        SEQ: pre !== '' && so !== '' ? `${pre}.${so}` : (pre || so),
        ST: stateTheoEvent.get(ev) || '',
        TXT: lay(descDau, 'TEXT').slice(0, 400),
        HTML: lay(descDau, 'TEXT_HTML').slice(0, 1500),
        REM: tachRemark((remTheoEvent.get(ev) || []).map((r) => lay(r, COT_REMARK))),
        steps,
      });
    }
    ghi(`✔ Ghép dữ liệu — ${rows.length} WO, ${Date.now() - t} ms`);
    ghi(`✔ Xong — ${rows.length} WO`, true);
    return { rows, wp: wpTen, thongTin: tomTat(h0) };
  }

  /** Thong tin dau Work Package de hien tren giao dien. */
  function tomTat(h0) {
    return {
      wpnoI: layId(h0, 'WPNO_I'),
      wp: lay(h0, 'WPNO'),
      station: lay(h0, 'STATION'),
      wpStatus: Number(lay(h0, 'WP_STATUS')),
      tinhTrang: tenTinhTrang(lay(h0, 'WP_STATUS')),
      startDate: doiNgay(lay(h0, 'START_DATE')),
      endDate: doiNgay(lay(h0, 'END_DATE')),
      acOperator: lay(h0, 'AC_OPERATOR'),
      acModel: lay(h0, 'AC_MODEL'),
      acReg: lay(h0, COT_AC_REG),
      projectNo: lay(h0, 'PROJECTNO'),
    };
  }

  /**
   * Tach WO_REMARKS thanh tung dong (giong ham remEntries cua cong cu Excel).
   * Nhan ca chuoi lan mang chuoi (mot WO co the co nhieu ban ghi remark).
   */
  function tachRemark(t) {
    const nguon = Array.isArray(t) ? t : [t];
    const out = [];
    for (const x of nguon) {
      if (!x) continue;
      String(x).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        .map((s) => s.replace(/^\s*\d+\./, '').split(';')[0].replace(/_x000D_/g, '').trim())
        .filter(Boolean).forEach((s) => out.push(s.slice(0, 200)));
    }
    return out;
  }

  /**
   * CHAN DOAN: liet ke cot THAT co cua cac bang lien quan.
   * Dung de doi chieu voi ten cot dang dung trong ma nguon, thay vi doan.
   */
  async function soiCot() {
    const bang = ['WP_HEADER', 'RM_CALENDAR_ENTRY', 'ADDRESS', 'WP_SEQUENCE', 'WO_HEADER',
      'WORKSTEP_LINK', 'WO_TEXT_DESCRIPTION', 'WO_TEXT_ACTION', 'WO_REMARKS',
      'TIME_CAPTURED_ADDITIONAL', 'TIME_CAPTURED'];
    // Ten cot ma ma nguon DUNG THANG (theo cau SQL nghiep vu) - kiem tra co that
    const CAN_CO = {
      WP_HEADER: ['WPNO_I', 'WPNO', 'START_DATE', 'END_DATE', 'AC_OPERATOR', 'AC_MODEL',
        'PROJECTNO', 'STATION', 'WP_STATUS', 'STATUS'],
      RM_CALENDAR_ENTRY: ['WPNO_I', 'RESOURCE_AMOS_KEY', 'RESOURCE_TYPE_NOI'],
      ADDRESS: ['ADDRESS_I', 'VENDOR'],
      WP_SEQUENCE: ['WPNO_I', 'SEQNO_PREFIX_I', 'SEQNO', 'EVENT_PERFNO_I'],
      WO_HEADER: ['EVENT_PERFNO_I', 'STATE'],
      WORKSTEP_LINK: ['EVENT_PERFNO_I', 'DESCNO_I', 'WORKSTEP_LINKNO_I', 'SEQUENCENO'],
      WO_TEXT_DESCRIPTION: ['DESCNO_I', 'TEXT', 'TEXT_HTML'],
      WO_TEXT_ACTION: ['WORKSTEP_LINKNO_I', 'ACTIONNO_I', 'HEADER', 'TEXT', 'ACTION_DATE',
        'ACTION_TIME', 'SIGN_PERFORMED'],
      WO_REMARKS: ['EVENT_PERFNO_I', COT_REMARK],
      TIME_CAPTURED_ADDITIONAL: ['ITEMNO_I', 'BOOKINGNO_I', 'USER_DEPARTMENT', 'USER_JOB'],
      TIME_CAPTURED: ['BOOKINGNO_I', 'USER_SIGN', 'DURATION', 'EST_MH'],
    };
    const kq = {};
    for (const b of bang) {
      try {
        const rows = await query(`SELECT TOP 1 * FROM ${T}.[${b}]`);
        const cot = rows.length ? Object.keys(rows[0]) : [];
        const co = new Set(cot.map((c) => c.toLowerCase()));
        kq[b] = {
          cot,
          soDongMau: rows.length,
          thieu: (CAN_CO[b] || []).filter((c) => !co.has(c.toLowerCase())),
        };
      } catch (e) {
        kq[b] = { loi: e.message };
      }
    }
    // Cot nao ma nguon CAN nhung bang KHONG CO -> liet ke gon o dau ket qua,
    // khoi phai doc het danh sach cot cua 11 bang moi thay.
    const thieu = Object.entries(kq)
      .filter(([, v]) => v.thieu && v.thieu.length)
      .map(([b, v]) => `${b}: ${v.thieu.join(', ')}`);
    return { thieuCot: thieu, bang: kq, tinhTrangWp: WP_STATUS };
  }

  /**
   * CHAN DOAN: WP_HEADER that su co nhung cap (WP_STATUS, STATUS) nao, moi cap
   * bao nhieu WP, va bao nhieu trong so do CO hangar.
   * Dung de CHOT bang so lieu hai cho con phai phong doan:
   *   1. `STATUS = 0` co dung cho ca CLOSED/PRELOAD khong (hay chi IN PROGRESS)
   *   2. loc "chi WP co hangar" cat mat bao nhieu
   */
  async function soiTinhTrang(station = '') {
    if (demoMode) return { note: 'Dang o DEMO_MODE, khong co du lieu that.' };
    const dk = station ? ` WHERE [STATION] = ${q(station)}` : '';
    const cap = await query(
      `SELECT [WP_STATUS] AS wp_status, [STATUS] AS status, COUNT(*) AS so`
      + ` FROM ${T}.[WP_HEADER]${dk} GROUP BY [WP_STATUS], [STATUS]`
    );
    const ds = cap
      .map((r) => ({
        wpStatus: Number(r.wp_status),
        status: Number(r.status),
        so: Number(r.so),
        nghia: tenTinhTrang(r.wp_status),
      }))
      .sort((a, b) => b.so - a.so);
    return {
      station: station || '(tất cả)',
      dangDung: {
        wpStatus: WP_STATUS,
        themDieuKien: `[STATUS] = ${STATUS_HIEU_LUC}`,
        canhBao: 'Điều kiện STATUS lấy từ câu SQL nhánh IN PROGRESS, chưa xác nhận cho CLOSED/PRELOAD.',
      },
      capGiaTri: ds,
      // Ba tinh trang dang dung co nam trong du lieu that khong?
      doiChieu: Object.entries(WP_STATUS).map(([ten, ma]) => ({
        ten,
        ma,
        soWp: ds.filter((r) => r.wpStatus === ma).reduce((a, r) => a + r.so, 0),
        soWpKemStatus0: ds.filter((r) => r.wpStatus === ma && r.status === STATUS_HIEU_LUC)
          .reduce((a, r) => a + r.so, 0),
      })),
    };
  }

  return {
    layWorkPackage, timWorkPackage, soiCot, soiTinhTrang,
    WP_STATUS, STATUS_HIEU_LUC, tenTinhTrang,
  };
};
