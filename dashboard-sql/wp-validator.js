/**
 * ============================================================================
 *  wp-validator.js  -  Lay du lieu WORK PACKAGE tu AMOS cho trang "Ra soat ho so"
 * ============================================================================
 *  Cau SQL goc (ban giay cua nghiep vu) noi BAY BANG trong MOT cau:
 *      WP_HEADER x WP_SEQUENCE x WORKSTEP_LINK x WO_TEXT_DESCRIPTION
 *      x WO_TEXT_ACTION x TIME_CAPTURED_ADDITIONAL x TIME_CAPTURED
 *  Da do that: chay 1 gio 09 phut ma VAN chua ra dong nao (anh chup man hinh).
 *  Ly do: bay bang deu nam tren LINKED SERVER; SQL Server khong day duoc phep
 *  noi xuong AMOS nen phai keo ca bang ve roi noi tai cho.
 *
 *  CACH LAM O DAY - LAY TUNG BANG, TRUYEN ID SANG BANG KE TIEP:
 *      1. WP_HEADER            WHERE WPNO_I = <so WP>        -> lay WPNO_I
 *      2. WP_SEQUENCE          WHERE WPNO_I = ...            -> EVENT_PERFNO_I
 *      3. WORKSTEP_LINK        WHERE EVENT_PERFNO_I IN (...) -> WORKSTEP_LINKNO_I, DESCNO_I
 *      4. WO_TEXT_DESCRIPTION  WHERE DESCNO_I IN (...)
 *      5. WO_TEXT_ACTION       WHERE WORKSTEP_LINKNO_I IN (...) -> ACTIONNO_I
 *      6. TIME_CAPTURED_ADDITIONAL WHERE ITEMNO_I IN (...)   -> BOOKINGNO_I
 *      7. TIME_CAPTURED        WHERE BOOKINGNO_I IN (...)
 *  Moi buoc la MOT cau don gian tren MOT bang, dieu kien la danh sach so DAT
 *  TRUC TIEP vao cau lenh (khong dung @thamso - tham so chan viec day dieu kien
 *  xuong AMOS, xem README §7b). Noi cac manh lai o Node.
 *
 *  ⚠️ KHONG DOAN TEN COT NGUON: moi buoc lay `SELECT *` cho dung cac ID can,
 *  roi anh xa sang ten nghiep vu bang bang COT_ALIAS o duoi. Cot nao khong
 *  nhan ra thi bao ra o /api/wp/columns de nguoi dung doi chieu va sua - thay
 *  vi de chuong trinh chay sai am tham.
 * ============================================================================
 */
'use strict';

const LO = 300;   // moi lo bao nhieu ID trong menh de IN (...)

/**
 * ANH XA COT: ten nghiep vu -> cac ten cot co the co trong AMOS.
 * Lay tu chinh cong cu Excel cua nghiep vu (cac ten trong `pick(r, [...])`),
 * cong them vai bien the hay gap. So khop KHONG phan biet hoa/thuong.
 */
const COT_ALIAS = {
  // WP_HEADER
  wp:        ['WPNO', 'WP', 'WPNO_C', 'WP_NO', 'WPNUMBER'],
  ac:        ['AC_REGISTR', 'ACREGISTR', 'AC', 'REGISTRATION', 'AC_REG'],
  station:   ['STATION', 'STATIONNO', 'STN'],
  // WP_SEQUENCE
  seq:       ['SEQ', 'SEQUENCE', 'SEQNO', 'SEQ_NO', 'WP_SEQ'],
  wo:        ['WO', 'WONO', 'WO_NO', 'EVENT_PERFNO_I', 'EVENTNO'],
  woState:   ['WO_STATE', 'STATE', 'WOSTATE', 'STATUS'],
  woText:    ['WO_TEXT', 'WOTEXT', 'TEXT_WO', 'DESCRIPTION_SHORT'],
  woRemarks: ['WO_REMARKS', 'REMARKS', 'HANDOVER', 'WOREMARKS'],
  // WORKSTEP_LINK
  workstep:  ['WORKSTEP', 'WORKSTEPNO', 'STEP', 'STEPNO', 'WORKSTEP_NO'],
  header:    ['HEADER', 'HEADER_TEXT', 'TITLE'],
  // WO_TEXT_DESCRIPTION
  des:       ['DES', 'DESCRIPTION', 'DESC_TEXT', 'TEXT_HTML', 'HTMLTEXT'],
  // WO_TEXT_ACTION
  text:      ['TEXT', 'ACTION_TEXT', 'ACTIONTEXT'],
  // TIME_CAPTURED
  sign:      ['SIGN_PERFORMED', 'SIGNPERFORMED', 'SIGN', 'USER_SIGN', 'PERFORMED_BY'],
  actionDat: ['ACTION_DAT', 'ACTIONDAT', 'ACTION_DATE', 'DAT'],
  actionTim: ['ACTION_TIM', 'ACTIONTIM', 'ACTION_TIME', 'TIM'],
  duration:  ['DURATION', 'DUR', 'EST_MH', 'ESTMH', 'MANHOUR', 'MH'],
};

/** Lay gia tri cot theo danh sach ten co the co. Tra '' neu khong co cot nao. */
function lay(row, tenList) {
  if (!row) return '';
  for (const t of tenList) {
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

/** Cot ID: tra ve so/chuoi khoa, bo trong. */
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
  return /^\d+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
}

/**
 * Loi nay co phai "bang khong co cot do" khong?
 * QUAN TRONG: cho "thu tung cot ung vien" chi duoc bo qua DUNG loai loi nay.
 * Neu bo qua MOI loi thi luc SQL Server sap (mat ket noi, het han dang nhap)
 * nguoi dung se nhan "Khong tim thay Work Package" - sai hoan toan va rat kho
 * doan. Loi khac phai nem ra ngoai de bao dung nguyen nhan.
 */
function laLoiTenCot(e) {
  return e && e.number === 207 || /invalid column name/i.test((e && e.message) || '');
}

module.exports = function taoWpValidator({ query, demoMode, docDemo }) {
  /**
   * Lay TAT CA dong cua mot bang AMOS theo danh sach ID - chia lo, chay tuan tu.
   * @param {string} bang    ten bang day du, vd '[DWH_DB]..[STG_AMOS].[WP_SEQUENCE]'
   * @param {string} cot     ten cot ID
   * @param {Array} ids      danh sach gia tri
   * @param {Function} ghi   ham ghi nhat ky tien trinh
   * @param {string} nhan    ten hien trong nhat ky
   */
  async function layTheoId(bang, cot, ids, ghi, nhan) {
    const ds = duyNhat(ids);
    if (!ds.length) return [];
    const lo = chiaLo(ds);
    const out = [];
    for (let i = 0; i < lo.length; i++) {
      ghi(`▶ ${nhan}: lô ${i + 1}/${lo.length} (${lo[i].length} ID)…`);
      const t = Date.now();
      // SELECT * : khong doan ten cot nguon - anh xa o Node (xem COT_ALIAS).
      // Dieu kien dat TRUC TIEP (khong @thamso) de AMOS loc duoc ngay tai cho.
      const rows = await query(
        `SELECT * FROM ${bang} WHERE [${cot}] IN (${lo[i].map(q).join(', ')})`
      );
      ghi(`✔ ${nhan}: lô ${i + 1}/${lo.length} — ${rows.length} dòng, ${Date.now() - t} ms`);
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

  /**
   * BUOC 1 - tim dong WP_HEADER.
   * Nguoi dung go TEN Work Package ('A509-310326-BASE-MCC-STO'), con khoa noi
   * cua AMOS la so (WPNO_I). Ta KHONG BIET chac cot chua ten la gi, nen thu lan
   * luot cac ung vien: cot nao khong ton tai thi SQL Server bao "Invalid column
   * name" -> bo qua, thu cot ke tiep. Cot nao chay duoc VA ra dong thi dung.
   * Tra ve ca ten cot da dung de ghi vao nhat ky - de nguoi van hanh biet.
   */
  async function timWpHeader(wpno, ghi) {
    const T = '[DWH_DB]..[STG_AMOS]';
    const soThuan = /^\d+$/.test(wpno);
    const ungVien = soThuan
      ? ['WPNO_I', 'WPNO', 'WP']
      : ['WPNO', 'WP', 'WPNO_C', 'WP_NO', 'WPNUMBER'];
    const loi = [];
    for (const c of ungVien) {
      const t = Date.now();
      try {
        const rows = await query(`SELECT * FROM ${T}.[WP_HEADER] WHERE [${c}] = ${q(wpno)}`);
        ghi(`✔ WP_HEADER theo cột [${c}] — ${rows.length} dòng, ${Date.now() - t} ms`);
        if (rows.length) return { rows, cot: c, daThu: loi };
      } catch (e) {
        if (!laLoiTenCot(e)) throw e;      // loi that (mat ket noi...) - dung ngay
        loi.push(`${c}: ${e.message}`);
        ghi(`· WP_HEADER: không có cột [${c}] — thử cột khác`);
      }
    }
    return { rows: [], cot: null, daThu: loi };
  }

  /**
   * Lay toan bo du lieu cua MOT Work Package, tra ve dung dinh dang ma trang
   * ra soat can: [{ WP, AC, STATION, WO, SEQ, ST, TXT, HTML, REM[], steps[] }]
   */
  async function layWorkPackage(wpno, ghi = () => {}) {
    if (demoMode) {
      ghi('Chế độ DEMO — dùng dữ liệu mẫu, không hỏi AMOS.', false);
      const tatCa = docDemo();
      const ds = wpno ? tatCa.filter((w) => w.WP === wpno) : tatCa;
      // Go sai so WP thi demo cung phai bao "khong tim thay" y nhu chay that,
      // neu khong nguoi kiem thu se tuong loi do da duoc xu ly.
      if (wpno && !ds.length) {
        ghi(`✘ Không có Work Package ${wpno} trong dữ liệu mẫu`, true);
        return { rows: [], khongThay: true, demo: true };
      }
      ghi(`✔ Xong — ${ds.length} WO (dữ liệu mẫu)`, true);
      return { rows: ds, demo: true, wp: wpno || '(tất cả)' };
    }
    const T = '[DWH_DB]..[STG_AMOS]';

    // --- 1. WP_HEADER ---
    ghi(`▶ WP_HEADER: tìm Work Package ${wpno}…`);
    let t = Date.now();
    const tim = await timWpHeader(wpno, ghi);
    if (!tim.rows.length) return { rows: [], khongThay: true, daThu: tim.daThu };
    const h0 = tim.rows[0];
    // Khoa noi cua AMOS: lay TU DONG HEADER, khong lay tu chuoi nguoi dung go.
    const wpId = layId(h0, 'WPNO_I');
    if (wpId === null) {
      return { rows: [], khongThay: true, loi: 'WP_HEADER không có cột WPNO_I — không lần được xuống WP_SEQUENCE.' };
    }

    // --- 2. WP_SEQUENCE ---
    const wpSeq = await layTheoId(`${T}.[WP_SEQUENCE]`, 'WPNO_I', [wpId], ghi, 'WP_SEQUENCE');
    const events = duyNhat(wpSeq.map((r) => layId(r, 'EVENT_PERFNO_I')));
    ghi(`   → ${events.length} work order (EVENT_PERFNO_I)`);

    // --- 3. WORKSTEP_LINK ---
    const wsLink = await layTheoId(`${T}.[WORKSTEP_LINK]`, 'EVENT_PERFNO_I', events, ghi, 'WORKSTEP_LINK');

    // --- 4 + 5 chay SONG SONG: hai nhanh doc lap nhau ---
    const descIds = duyNhat(wsLink.map((r) => layId(r, 'DESCNO_I')));
    const linkIds = duyNhat(wsLink.map((r) => layId(r, 'WORKSTEP_LINKNO_I')));
    const [woDesc, woAct] = await Promise.all([
      layTheoId(`${T}.[WO_TEXT_DESCRIPTION]`, 'DESCNO_I', descIds, ghi, 'WO_TEXT_DESCRIPTION'),
      layTheoId(`${T}.[WO_TEXT_ACTION]`, 'WORKSTEP_LINKNO_I', linkIds, ghi, 'WO_TEXT_ACTION'),
    ]);

    // --- 6. TIME_CAPTURED_ADDITIONAL (ITEMNO_I = ACTIONNO_I) ---
    const actIds = duyNhat(woAct.map((r) => layId(r, 'ACTIONNO_I')));
    const tcAdd = await layTheoId(`${T}.[TIME_CAPTURED_ADDITIONAL]`, 'ITEMNO_I', actIds, ghi, 'TIME_CAPTURED_ADDITIONAL');

    // --- 7. TIME_CAPTURED ---
    const bookIds = duyNhat(tcAdd.map((r) => layId(r, 'BOOKINGNO_I')));
    const tc = await layTheoId(`${T}.[TIME_CAPTURED]`, 'BOOKINGNO_I', bookIds, ghi, 'TIME_CAPTURED');

    // --- Noi cac manh lai TAI NODE ---
    ghi('▶ Ghép dữ liệu…');
    t = Date.now();
    const descTheoId = new Map(woDesc.map((r) => [layId(r, 'DESCNO_I'), r]));
    const actTheoLink = gom(woAct, 'WORKSTEP_LINKNO_I');
    const addTheoItem = gom(tcAdd, 'ITEMNO_I');
    const tcTheoBooking = gom(tc, 'BOOKINGNO_I');
    const linkTheoEvent = gom(wsLink, 'EVENT_PERFNO_I');

    const wpTen = lay(h0, COT_ALIAS.wp) || String(wpno);
    const rows = [];
    for (const sq of wpSeq) {
      const ev = layId(sq, 'EVENT_PERFNO_I');
      if (ev === null) continue;
      const steps = [];
      for (const lk of (linkTheoEvent.get(ev) || [])) {
        const linkNo = layId(lk, 'WORKSTEP_LINKNO_I');
        const desc = descTheoId.get(layId(lk, 'DESCNO_I'));
        // Moi ACTION la mot lan thuc hien; ghep sang TIME_CAPTURED de lay
        // nguoi ky + ngay gio + so cong.
        const acts = actTheoLink.get(linkNo) || [];
        if (!acts.length) {
          steps.push({
            ws: lay(lk, COT_ALIAS.workstep), rawDat: '', rawTim: '',
            txt: '', html: lay(desc, COT_ALIAS.des).slice(0, 900),
            hdr: lay(lk, COT_ALIAS.header).slice(0, 90), sg: '', mh: 0,
          });
          continue;
        }
        for (const ac of acts) {
          const adds = addTheoItem.get(layId(ac, 'ACTIONNO_I')) || [];
          const tcs = adds.flatMap((a) => tcTheoBooking.get(layId(a, 'BOOKINGNO_I')) || []);
          const ky = duyNhat(tcs.map((x) => lay(x, COT_ALIAS.sign)));
          const durs = duyNhat(tcs.map((x) => lay(x, COT_ALIAS.duration)))
            .map(Number).filter((n) => !isNaN(n));
          const t0 = tcs[0] || null;
          const stepTxt = lay(ac, COT_ALIAS.text);
          steps.push({
            ws: lay(lk, COT_ALIAS.workstep),
            rawDat: lay(t0, COT_ALIAS.actionDat),
            rawTim: lay(t0, COT_ALIAS.actionTim),
            txt: stepTxt.slice(0, 800),
            html: stepTxt ? '' : lay(desc, COT_ALIAS.des).slice(0, 900),
            hdr: lay(lk, COT_ALIAS.header).slice(0, 90),
            sg: ky.join(', ').slice(0, 80),
            // Cong tinh theo PHUT trong AMOS -> doi ra gio, giong cong cu Excel
            mh: durs.length ? Math.round((durs[0] / 60) * 1000) / 1000 : 0,
          });
        }
      }
      rows.push({
        WP: wpTen,
        AC: lay(h0, COT_ALIAS.ac),
        STATION: lay(h0, COT_ALIAS.station),
        WO: String(ev),
        SEQ: lay(sq, COT_ALIAS.seq),
        ST: lay(sq, COT_ALIAS.woState),
        TXT: lay(sq, COT_ALIAS.woText).slice(0, 400),
        HTML: '',
        REM: tachRemark(lay(sq, COT_ALIAS.woRemarks)),
        steps,
      });
    }
    ghi(`✔ Ghép dữ liệu — ${rows.length} WO, ${Date.now() - t} ms`);
    ghi(`✔ Xong — ${rows.length} WO`, true);
    return { rows, wp: wpTen, cotWp: tim.cot };
  }

  /**
   * Danh sach Work Package de go y o o nhap. Tim gan dung theo ten.
   * Cung ky thuat "thu tung cot ung vien" nhu timWpHeader.
   */
  async function danhSachWp(tuKhoa = '', gioiHan = 50) {
    if (demoMode) {
      const wps = [...new Set(docDemo().map((w) => w.WP))];
      const k = tuKhoa.trim().toLowerCase();
      return { ds: wps.filter((w) => !k || w.toLowerCase().includes(k)).slice(0, gioiHan) };
    }
    const T = '[DWH_DB]..[STG_AMOS]';
    const n = Math.min(500, Math.max(1, Number(gioiHan) || 50));
    const k = String(tuKhoa).replace(/'/g, "''").replace(/[%_[]/g, '');
    for (const c of ['WPNO', 'WP', 'WPNO_C', 'WP_NO', 'WPNUMBER']) {
      try {
        const dk = k ? ` WHERE [${c}] LIKE '%${k}%'` : '';
        const rows = await query(`SELECT DISTINCT TOP ${n} [${c}] AS wp FROM ${T}.[WP_HEADER]${dk} ORDER BY [${c}] DESC`);
        return { ds: rows.map((r) => String(r.wp || '').trim()).filter(Boolean), cot: c };
      } catch (e) {
        if (!laLoiTenCot(e)) throw e;      // chi bo qua khi that su la "khong co cot do"
      }
    }
    return { ds: [], loi: 'Không nhận ra cột tên Work Package trong WP_HEADER.' };
  }

  /** Tach WO_REMARKS thanh tung dong (giong ham remEntries cua cong cu Excel). */
  function tachRemark(t) {
    if (!t) return [];
    return String(t).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .map((s) => s.replace(/^\s*\d+\./, '').split(';')[0].replace(/_x000D_/g, '').trim())
      .filter(Boolean).map((s) => s.slice(0, 200));
  }

  /**
   * CHAN DOAN: liet ke cot THAT co cua 7 bang + cot nao anh xa duoc.
   * Dung de doi chieu COT_ALIAS voi AMOS that, thay vi doan.
   */
  async function soiCot() {
    const T = '[DWH_DB]..[STG_AMOS]';
    const bang = ['WP_HEADER', 'WP_SEQUENCE', 'WORKSTEP_LINK', 'WO_TEXT_DESCRIPTION',
      'WO_TEXT_ACTION', 'TIME_CAPTURED_ADDITIONAL', 'TIME_CAPTURED'];
    const kq = {};
    for (const b of bang) {
      try {
        const rows = await query(`SELECT TOP 1 * FROM ${T}.[${b}]`);
        kq[b] = { cot: rows.length ? Object.keys(rows[0]) : [], soDongMau: rows.length };
      } catch (e) {
        kq[b] = { loi: e.message };
      }
    }
    // Cot nghiep vu nao KHONG tim thay o bat ky bang nao
    const tatCa = new Set();
    Object.values(kq).forEach((v) => (v.cot || []).forEach((c) => tatCa.add(c.toLowerCase())));
    const thieu = Object.entries(COT_ALIAS)
      .filter(([, ds]) => !ds.some((t) => tatCa.has(t.toLowerCase())))
      .map(([k, ds]) => ({ truong: k, daThu: ds }));
    return { bang: kq, anhXa: COT_ALIAS, khongTimThay: thieu };
  }

  return { layWorkPackage, danhSachWp, soiCot, COT_ALIAS };
};
