/**
 * ============================================================================
 *  server.js  -  Backend Node.js + Express + mssql
 *  Dashboard bao cao TAT (Turn-Around-Time) - VAECO
 * ----------------------------------------------------------------------------
 *  Chuc nang:
 *    - Ket noi SQL Server (pool), doc du lieu tu cac bang NQT.dbo.* va
 *      DWH_DB..STG_AMOS.SIGN.
 *    - Cung cap REST API cho frontend: KPI, bieu do, bang du lieu, cac bao cao.
 *    - Tinh toan TAT theo dinh nghia nghiep vu (xem phan SQL ben duoi).
 *    - Co DEMO_MODE de chay thu giao dien khi chua co SQL Server.
 *
 *  Chay:   npm install  ->  copy .env.example thanh .env  ->  npm start
 * ============================================================================
 */

'use strict';

require('dotenv').config();
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const sql = require('mssql');

// ---------------------------------------------------------------------------
// 1. CAU HINH
// ---------------------------------------------------------------------------
const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  maxRows: parseInt(process.env.MAX_ROWS || '5000', 10),
  tzOffset: parseInt(process.env.AMOS_TZ_OFFSET_HOURS || '7', 10), // AMOS(UTC) -> VN
  demoMode: String(process.env.DEMO_MODE || 'false').toLowerCase() === 'true',
};

// Cau hinh ket noi mssql - LAY TU BIEN MOI TRUONG, khong hardcode password.
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER || 'localhost',
  database: process.env.DB_DATABASE || 'NQT',
  port: parseInt(process.env.DB_PORT || '1433', 10),
  options: {
    encrypt: String(process.env.DB_ENCRYPT || 'false').toLowerCase() === 'true',
    trustServerCertificate:
      String(process.env.DB_TRUST_SERVER_CERTIFICATE || 'true').toLowerCase() === 'true',
    enableArithAbort: true,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  requestTimeout: 60000,
};
// Named instance (vd SQLEXPRESS) neu co
if (process.env.DB_INSTANCE) {
  dbConfig.options.instanceName = process.env.DB_INSTANCE;
  delete dbConfig.port; // dung instance thi khong dung port
}

// ---------------------------------------------------------------------------
// 2. QUAN LY CONNECTION POOL
// ---------------------------------------------------------------------------
let poolPromise = null;

/** Lay (hoac tao) connection pool dung chung cho toan app. */
function getPool() {
  if (CONFIG.demoMode) {
    throw new Error('Dang o DEMO_MODE, khong ket noi SQL Server.');
  }
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(dbConfig)
      .connect()
      .then((pool) => {
        console.log('[DB] Ket noi SQL Server thanh cong.');
        pool.on('error', (err) => console.error('[DB] Pool error:', err.message));
        return pool;
      })
      .catch((err) => {
        poolPromise = null; // cho phep thu lai lan sau
        throw err;
      });
  }
  return poolPromise;
}

/**
 * Chay 1 query co tham so.
 * @param {string} text  Cau SQL (dung @param)
 * @param {Object} params  { tenParam: giaTri }
 */
async function query(text, params = {}) {
  const pool = await getPool();
  const req = pool.request();
  for (const [key, val] of Object.entries(params)) {
    req.input(key, val);
  }
  const rs = await req.query(text);
  return rs.recordset || [];
}

// ---------------------------------------------------------------------------
// 3. CAC MANH SQL DUNG CHUNG (nghiep vu)
// ---------------------------------------------------------------------------

/**
 * Bieu thuc T-SQL doi gio AMOS -> gio Viet Nam.
 * mutation  = NGAY cua AMOS (UTC), mutation_t = GIO cua AMOS (UTC).
 * (Chi del_time / reci_time la kieu datetime that; mutation/mutation_t can ghep.)
 *
 * Dinh dang thuc te trong DB (AMOS/Progress):
 *   - mutation   : ngay dang yyyymmdd (vd 20260708) hoac kieu date.
 *   - mutation_t : SO MILLISECOND ke tu 00:00 (vd 71820341 = 19:57:00).
 *
 * Cach ghep: lay ngay (mutation) + so ms (mutation_t) roi cong @tzOffset gio.
 * Dung TRY_CONVERT nen neu du lieu loi -> tra NULL thay vi bao loi truy van.
 *
 * >>> DAY LA CHO DUY NHAT can chinh neu dinh dang mutation/mutation_t khac. <<<
 *
 * @param {string} a  alias cua bang (vd 'k')
 */
function amosToVN(a) {
  // Ngay (mutation): thu truc tiep (kieu date/datetime hoac chuoi 'yyyymmdd'),
  //   neu that bai thi coi la SO yyyymmdd (vd 20260708.000000) -> lay phan nguyen -> chuoi -> datetime.
  const dateExpr = `COALESCE(
      TRY_CONVERT(datetime, ${a}.[mutation]),
      TRY_CONVERT(datetime, TRY_CONVERT(varchar(8), TRY_CONVERT(bigint, TRY_CONVERT(float, ${a}.[mutation]))))
    )`;
  // Gio (mutation_t): SO MILLISECOND ke tu 00:00. Qua float truoc de chiu duoc
  //   ca kieu numeric/decimal lan chuoi co phan thap phan '71820341.000000'.
  const msExpr = `TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, ${a}.[mutation_t])) % 86400000)`;
  return `DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, ${msExpr}, ${dateExpr}))`;
}

/**
 * Lam sach 1 gia tri department: bo khoang trang, coi '' va 'UNKNOWN' la KHONG co.
 * @param {string} expr  bieu thuc cot (vd 's.[DEPARTMENT]')
 */
function cleanDept(expr) {
  return `NULLIF(NULLIF(LTRIM(RTRIM(${expr})), ''), 'UNKNOWN')`;
}

/**
 * Bieu thuc chon department theo thu tu uu tien (nguon nao co truoc thi dung).
 * Bo qua cac gia tri rong / 'UNKNOWN'. Cuoi cung mac dinh 'PA'.
 * @param {string[]} sources  danh sach bieu thuc cot department theo do uu tien
 */
function pickDept(sources) {
  return `COALESCE(${sources.map(cleanDept).join(', ')}, 'PA')`;
}

/**
 * Build menh de WHERE dong tu cac filter chung (station/store/department).
 * Tra ve { clause, params } - clause bat dau bang ' AND ...' hoac ''.
 * @param {Object} f  { station, store, department }
 * @param {Object} cols  ten cot tuong ung { station, store, department }
 */
function buildFilterClause(f, cols, params) {
  let clause = '';
  if (f.station && cols.station) {
    clause += ` AND ${cols.station} = @fStation`;
    params.fStation = f.station;
  }
  if (f.store && cols.store) {
    clause += ` AND ${cols.store} = @fStore`;
    params.fStore = f.store;
  }
  if (f.department && cols.department) {
    clause += ` AND ${cols.department} = @fDepartment`;
    params.fDepartment = f.department;
  }
  return clause;
}

// ---------------------------------------------------------------------------
// 4. TAO KHOANG THOI GIAN (thang / tuan)
// ---------------------------------------------------------------------------

/** Dinh dang 1 Date thanh chuoi datetime dia phuong 'YYYY-MM-DDTHH:mm:ss' (khong kem mui gio).
 *  Truyen chuoi nay xuong SQL de so sanh voi cot datetime (gio VN) -> tranh lech 7h do UTC. */
function toLocalStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Tra ve khoang [from, to) cua 1 thang (chuoi datetime dia phuong). period='YYYY-MM'. */
function monthRange(period) {
  let year, month;
  if (period && /^\d{4}-\d{2}$/.test(period)) {
    [year, month] = period.split('-').map(Number);
  } else {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
  }
  const from = new Date(year, month - 1, 1, 0, 0, 0);
  const to = new Date(year, month, 1, 0, 0, 0); // dau thang sau
  return { from: toLocalStr(from), to: toLocalStr(to) };
}

/**
 * Tuan theo dinh nghia: tu thu 5 tuan truoc den thu 5 tuan nay.
 * ref = ngay tham chieu (mac dinh hom nay). Tra ve [from(thu5 truoc), to(thu5 nay)).
 */
function weekRange(ref) {
  const base = ref ? new Date(ref) : new Date();
  // Ve mui gio dia phuong, lay 00:00
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const day = d.getDay(); // 0=CN..4=Thu5..6=Thu7
  // Khoang cach lui ve thu 5 gan nhat (thu 5 nay). Thu5=4
  const backToThu = (day - 4 + 7) % 7;
  const thisThu = new Date(d);
  thisThu.setDate(d.getDate() - backToThu);
  const lastThu = new Date(thisThu);
  lastThu.setDate(thisThu.getDate() - 7);
  return { from: toLocalStr(lastThu), to: toLocalStr(thisThu) };
}

/** Tra ve { from, to, label } tu query params. */
function resolveRange(q) {
  if (q.periodType === 'week') {
    const r = weekRange(q.week);
    return { ...r, label: 'Tuan (T5->T5)' };
  }
  const r = monthRange(q.month);
  return { ...r, label: 'Thang' };
}

// ---------------------------------------------------------------------------
// 5. CAC HAM TRUY VAN NGHIEP VU
//    (moi ham nhan filter + range, tra ve mang record)
// ---------------------------------------------------------------------------

/**
 * TAT theo tung thiet bi cho cac DON VI (department).
 * Dinh nghia: tu luc XUAT KHO (kho_ser1 vm='T', voucher P-...) den luc TRA
 * UNSERVICE (real_us1.del_time). TAT tinh theo GIO.
 *  - Link: kho_ser1(partno,serialno,voucherno) = real_us1(partno,serialno,voucher_s)
 *  - Department: UU TIEN bang SIGN (don vi moi nhat theo nhan vien) tra theo
 *    real_us1.action_per; neu SIGN khong co -> dung real_us1.department;
 *    van trong -> 'PA'. (Neu co khac biet don vi thi SIGN la nguon chuan.)
 */
async function qTatDepartments(range, f) {
  const params = { from: range.from, to: range.to, tzOffset: CONFIG.tzOffset, top: CONFIG.maxRows };
  // Department: SIGN theo action_per; neu UNKNOWN/rong -> SIGN theo del_staff;
  //   -> department luu trong real_us1; cuoi cung 'PA'.
  const dept = pickDept(['s.[DEPARTMENT]', 'sd.[DEPARTMENT]', 'r.[department]']);
  let where = buildFilterClause(
    f,
    { station: 'k.[station]', store: 'k.[store]', department: dept },
    params
  );
  const text = `
    SELECT TOP (@top)
      k.[partno]      AS partno,
      k.[serialno]    AS serialno,
      k.[labelno]     AS labelno,
      k.[descriptio]  AS description,
      k.[station]     AS station,
      k.[store]       AS store,
      k.[voucherno]   AS voucher_issue,
      ${dept} AS department,
      ${amosToVN('k')}                       AS issue_time_vn,
      r.[del_time]                           AS return_unservice_time,
      CAST(DATEDIFF(MINUTE, ${amosToVN('k')}, r.[del_time]) AS float) / 60.0 AS tat_hours
    FROM [NQT].[dbo].[kho_ser1] k
    INNER JOIN [NQT].[dbo].[real_us1] r
      ON k.[partno] = r.[partno]
     AND k.[serialno] = r.[serialno]
     AND k.[voucherno] = r.[voucher_s]
    LEFT JOIN [DWH_DB]..[STG_AMOS].[SIGN] s
      ON r.[action_per] = s.[USER_SIGN]
    LEFT JOIN [DWH_DB]..[STG_AMOS].[SIGN] sd
      ON r.[del_staff] = sd.[USER_SIGN]
    WHERE k.[vm] = 'T'
      AND k.[voucherno] LIKE 'P-%'
      AND r.[del_time] >= @from AND r.[del_time] < @to
      ${where}
    ORDER BY tat_hours DESC`;
  return query(text, params);
}

/**
 * TAT cua CUVT: tu luc TRA unservice (del_time) den luc NHAN unservice (reci_time).
 * Ca 2 cot deu la datetime gio VN san.
 */
async function qTatCuvt(range, f) {
  const params = { from: range.from, to: range.to, top: CONFIG.maxRows };
  const dept = pickDept(['s.[DEPARTMENT]', 'sd.[DEPARTMENT]', 'r.[department]']);
  let where = buildFilterClause(
    f,
    { station: 'r.[station]', store: 'r.[store]', department: dept },
    params
  );
  const text = `
    SELECT TOP (@top)
      r.[partno]     AS partno,
      r.[serialno]   AS serialno,
      r.[labelno]    AS labelno,
      r.[descriptio] AS description,
      r.[station]    AS station,
      r.[store]      AS store,
      ${dept} AS department,
      r.[del_time]   AS return_unservice_time,
      r.[reci_time]  AS receive_unservice_time,
      CAST(DATEDIFF(MINUTE, r.[del_time], r.[reci_time]) AS float) / 60.0 AS tat_hours
    FROM [NQT].[dbo].[real_us1] r
    LEFT JOIN [DWH_DB]..[STG_AMOS].[SIGN] s
      ON r.[action_per] = s.[USER_SIGN]
    LEFT JOIN [DWH_DB]..[STG_AMOS].[SIGN] sd
      ON r.[del_staff] = sd.[USER_SIGN]
    WHERE r.[del_time] IS NOT NULL
      AND r.[reci_time] IS NOT NULL
      AND r.[reci_time] >= r.[del_time]      -- loai ban ghi chua nhan (reci_time sentinel < del_time) -> tranh TAT am
      AND r.[del_time] >= @from AND r.[del_time] < @to
      ${where}
    ORDER BY tat_hours DESC`;
  return query(text, params);
}

/**
 * TAT HOAN KHO: thiet bi hoan kho (vm='TC', voucher P-CA-...) doi chieu voi
 * phieu xuat tuong ung (vm='T', voucher P-...) cung partno/serialno/labelno.
 * TAT = thoi diem hoan kho - thoi diem xuat kho (gio).
 */
async function qTatReturnStore(range, f) {
  const params = { from: range.from, to: range.to, tzOffset: CONFIG.tzOffset, top: CONFIG.maxRows };
  let where = buildFilterClause(
    f,
    { station: 'tc.[station]', store: 'tc.[store]', department: "COALESCE(NULLIF(NULLIF(LTRIM(RTRIM(s.[DEPARTMENT])), ''), 'UNKNOWN'), 'PA')" },
    params
  );
  const text = `
    SELECT TOP (@top)
      tc.[partno]     AS partno,
      tc.[serialno]   AS serialno,
      tc.[labelno]    AS labelno,
      tc.[descriptio] AS description,
      tc.[station]    AS station,
      tc.[store]      AS store,
      t.[voucherno]   AS voucher_issue,
      tc.[voucherno]  AS voucher_return,
      COALESCE(NULLIF(NULLIF(LTRIM(RTRIM(s.[DEPARTMENT])), ''), 'UNKNOWN'), 'PA') AS department,
      ${amosToVN('t')}  AS issue_time_vn,
      ${amosToVN('tc')} AS return_store_time_vn,
      CAST(DATEDIFF(MINUTE, ${amosToVN('t')}, ${amosToVN('tc')}) AS float) / 60.0 AS tat_hours
    FROM [NQT].[dbo].[kho_ser1] tc
    INNER JOIN [NQT].[dbo].[kho_ser1] t
      ON tc.[partno] = t.[partno]
     AND tc.[serialno] = t.[serialno]
     AND tc.[labelno] = t.[labelno]
     AND t.[vm] = 'T'
     AND t.[voucherno] LIKE 'P-%'
    LEFT JOIN [DWH_DB]..[STG_AMOS].[SIGN] s
      ON tc.[action_per] = s.[USER_SIGN]
    WHERE tc.[vm] = 'TC'
      AND tc.[voucherno] LIKE 'P-CA-%'
      AND ${amosToVN('tc')} >= @from AND ${amosToVN('tc')} < @to
      ${where}
    ORDER BY tat_hours DESC`;
  return query(text, params);
}

/**
 * BAO CAO 1: Thiet bi XUAT KHO nhung CHUA LAP LEN TAU.
 * kho_ser1 vm='T' (P-...) khong co ban ghi on_off vm='YE' (lap len tau).
 * Link kho_ser1 <-> on_off qua (partno, serialno, labelno).
 */
async function qIssuedNotInstalled(range, f) {
  const params = { from: range.from, to: range.to, tzOffset: CONFIG.tzOffset, top: CONFIG.maxRows };
  let where = buildFilterClause(
    f,
    { station: 'k.[station]', store: 'k.[store]', department: "COALESCE(NULLIF(NULLIF(LTRIM(RTRIM(s.[DEPARTMENT])), ''), 'UNKNOWN'), 'PA')" },
    params
  );
  const text = `
    SELECT TOP (@top)
      k.[partno]     AS partno,
      k.[serialno]   AS serialno,
      k.[labelno]    AS labelno,
      k.[descriptio] AS description,
      k.[station]    AS station,
      k.[store]      AS store,
      k.[voucherno]  AS voucher_issue,
      k.[ac_registr] AS ac_registr,
      COALESCE(NULLIF(NULLIF(LTRIM(RTRIM(s.[DEPARTMENT])), ''), 'UNKNOWN'), 'PA') AS department,
      ${amosToVN('k')} AS issue_time_vn
    FROM [NQT].[dbo].[kho_ser1] k
    LEFT JOIN [NQT].[dbo].[on_off] o
      ON k.[partno] = o.[partno]
     AND k.[serialno] = o.[serialno]
     AND k.[labelno] = o.[labelno]
     AND o.[vm] = 'YE'
    LEFT JOIN [DWH_DB]..[STG_AMOS].[SIGN] s
      ON k.[action_per] = s.[USER_SIGN]
    WHERE k.[vm] = 'T'
      AND k.[voucherno] LIKE 'P-%'
      AND o.[partno] IS NULL
      AND ${amosToVN('k')} >= @from AND ${amosToVN('k')} < @to
      ${where}
    ORDER BY issue_time_vn DESC`;
  return query(text, params);
}

/**
 * BAO CAO 2: Thiet bi THAO XUONG TU TAU nhung CHUA TRA UNSERVICE.
 * on_off vm='YA' (thao xuong) khong co ban ghi real_us1 (link qua historyno_).
 */
async function qRemovedNotReturned(range, f) {
  const params = { from: range.from, to: range.to, tzOffset: CONFIG.tzOffset, top: CONFIG.maxRows };
  let where = buildFilterClause(
    f,
    { station: 'o.[station]', store: 'o.[store]', department: null },
    params
  );
  const text = `
    SELECT TOP (@top)
      o.[partno]     AS partno,
      o.[serialno]   AS serialno,
      o.[labelno]    AS labelno,
      o.[historyno_] AS historyno,
      o.[station]    AS station,
      o.[store]      AS store,
      o.[ac_registr] AS ac_registr,
      ${amosToVN('o')} AS removed_time_vn
    FROM [NQT].[dbo].[on_off] o
    LEFT JOIN [NQT].[dbo].[real_us1] r
      ON o.[historyno_] = r.[historyno_]
    WHERE o.[vm] = 'YA'
      AND r.[historyno_] IS NULL
      AND ${amosToVN('o')} >= @from AND ${amosToVN('o')} < @to
      ${where}
    ORDER BY removed_time_vn DESC`;
  return query(text, params);
}

/**
 * BAO CAO 3: Thiet bi CHUA DOI UNG.
 * Co XUAT service (kho_ser1 vm='T', P-...) nhung KHONG co tra unservice (real_us1).
 * Link kho_ser1 <-> real_us1 qua (partno, serialno, voucherno=voucher_s).
 */
async function qNotReconciled(range, f) {
  const params = { from: range.from, to: range.to, tzOffset: CONFIG.tzOffset, top: CONFIG.maxRows };
  let where = buildFilterClause(
    f,
    { station: 'k.[station]', store: 'k.[store]', department: "COALESCE(NULLIF(NULLIF(LTRIM(RTRIM(s.[DEPARTMENT])), ''), 'UNKNOWN'), 'PA')" },
    params
  );
  const text = `
    SELECT TOP (@top)
      k.[partno]     AS partno,
      k.[serialno]   AS serialno,
      k.[labelno]    AS labelno,
      k.[descriptio] AS description,
      k.[station]    AS station,
      k.[store]      AS store,
      k.[voucherno]  AS voucher_issue,
      COALESCE(NULLIF(NULLIF(LTRIM(RTRIM(s.[DEPARTMENT])), ''), 'UNKNOWN'), 'PA') AS department,
      ${amosToVN('k')} AS issue_time_vn
    FROM [NQT].[dbo].[kho_ser1] k
    LEFT JOIN [NQT].[dbo].[real_us1] r
      ON k.[partno] = r.[partno]
     AND k.[serialno] = r.[serialno]
     AND k.[voucherno] = r.[voucher_s]
    LEFT JOIN [DWH_DB]..[STG_AMOS].[SIGN] s
      ON k.[action_per] = s.[USER_SIGN]
    WHERE k.[vm] = 'T'
      AND k.[voucherno] LIKE 'P-%'
      AND r.[partno] IS NULL
      AND ${amosToVN('k')} >= @from AND ${amosToVN('k')} < @to
      ${where}
    ORDER BY issue_time_vn DESC`;
  return query(text, params);
}

/**
 * BAO CAO 4: Thiet bi THAO TRUOC, LAP SAU -> co TAT rieng.
 * So sanh su kien thao (on_off vm='YA') va lap (on_off vm='YE') cung thiet bi,
 * lay cac cap ma thoi diem THAO < thoi diem LAP. TAT = lap - thao (gio).
 */
async function qRemovedBeforeInstalled(range, f) {
  const params = { from: range.from, to: range.to, tzOffset: CONFIG.tzOffset, top: CONFIG.maxRows };
  let where = buildFilterClause(
    f,
    { station: 'ya.[station]', store: 'ya.[store]', department: null },
    params
  );
  const text = `
    SELECT TOP (@top)
      ya.[partno]   AS partno,
      ya.[serialno] AS serialno,
      ya.[labelno]  AS labelno,
      ya.[station]  AS station,
      ya.[store]    AS store,
      ya.[ac_registr] AS ac_registr,
      ${amosToVN('ya')} AS removed_time_vn,
      ${amosToVN('ye')} AS installed_time_vn,
      CAST(DATEDIFF(MINUTE, ${amosToVN('ya')}, ${amosToVN('ye')}) AS float) / 60.0 AS tat_hours
    FROM [NQT].[dbo].[on_off] ya
    INNER JOIN [NQT].[dbo].[on_off] ye
      ON ya.[partno] = ye.[partno]
     AND ya.[serialno] = ye.[serialno]
     AND ya.[labelno] = ye.[labelno]
     AND ye.[vm] = 'YE'
    WHERE ya.[vm] = 'YA'
      AND ${amosToVN('ya')} < ${amosToVN('ye')}
      AND ${amosToVN('ya')} >= @from AND ${amosToVN('ya')} < @to
      ${where}
    ORDER BY tat_hours DESC`;
  return query(text, params);
}

/**
 * BAO CAO 5: OTHER - lay note trong cot on_ac cua real_us1.
 * Cot: partno_off, serialno_o, batchno_of, qty_off, station, department, del_staff, del_time.
 */
async function qOther(range, f) {
  const params = { from: range.from, to: range.to, top: CONFIG.maxRows };
  const dept = pickDept(['s.[DEPARTMENT]', 'sd.[DEPARTMENT]', 'r.[department]']);
  let where = buildFilterClause(
    f,
    { station: 'r.[station]', store: null, department: dept },
    params
  );
  const text = `
    SELECT TOP (@top)
      r.[partno_off]  AS partno_off,
      r.[serialno_o]  AS serialno_off,
      r.[batchno_of]  AS batchno_off,
      r.[qty_off]     AS qty_off,
      r.[station]     AS station,
      ${dept} AS department,
      r.[del_staff]   AS del_staff,
      r.[del_time]    AS del_time,
      r.[on_ac]       AS note
    FROM [NQT].[dbo].[real_us1] r
    LEFT JOIN [DWH_DB]..[STG_AMOS].[SIGN] s
      ON r.[action_per] = s.[USER_SIGN]
    LEFT JOIN [DWH_DB]..[STG_AMOS].[SIGN] sd
      ON r.[del_staff] = sd.[USER_SIGN]
    WHERE r.[on_ac] IS NOT NULL AND LTRIM(RTRIM(r.[on_ac])) <> ''
      AND r.[del_time] >= @from AND r.[del_time] < @to
      ${where}
    ORDER BY r.[del_time] DESC`;
  return query(text, params);
}

// ---------------------------------------------------------------------------
// 6. TONG HOP KPI + DU LIEU BIEU DO
// ---------------------------------------------------------------------------

/** Trung binh so hoc, bo qua null. */
function avg(arr, sel) {
  const vals = arr.map(sel).filter((v) => typeof v === 'number' && isFinite(v));
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Tong hop KPI + du lieu bieu do tu cac ket qua truy van. */
function buildDashboard(range, dept, cuvt, retStore, issuedNI, notRec) {
  // --- KPI cards ---
  const kpis = {
    tatDeptAvg: round1(avg(dept, (d) => d.tat_hours)),
    tatCuvtAvg: round1(avg(cuvt, (d) => d.tat_hours)),
    tatReturnStoreAvg: round1(avg(retStore, (d) => d.tat_hours)),
    countIssued: dept.length + notRec.length, // tong so thiet bi xuat kho (da/chua doi ung)
    countNotReconciled: notRec.length,
    countIssuedNotInstalled: issuedNI.length,
    reconcileRate:
      dept.length + notRec.length > 0
        ? round1((dept.length / (dept.length + notRec.length)) * 100)
        : 0,
  };

  // --- Bieu do cot: TAT trung binh theo tung don vi ---
  const byDept = groupAvg(dept, 'department', 'tat_hours');
  const barDept = {
    labels: byDept.map((x) => x.key),
    values: byDept.map((x) => round1(x.avg)),
    counts: byDept.map((x) => x.count),
  };

  // --- Top 10 don vi theo so luong thiet bi ---
  const topDept = [...byDept].sort((a, b) => b.count - a.count).slice(0, 10);
  const top10 = {
    labels: topDept.map((x) => x.key),
    values: topDept.map((x) => x.count),
    tat: topDept.map((x) => round1(x.avg)),
  };

  // --- Bieu do tron: phan bo thiet bi theo station ---
  const byStation = groupCount(dept, 'station');
  const pieStation = {
    labels: byStation.map((x) => x.key),
    values: byStation.map((x) => x.count),
  };

  // --- Bieu do duong: TAT trung binh theo ngay (theo return time) ---
  const byDay = groupAvgByDay(dept, 'return_unservice_time', 'tat_hours');
  const lineDay = {
    labels: byDay.map((x) => x.key),
    values: byDay.map((x) => round1(x.avg)),
  };

  return {
    range: { from: range.from, to: range.to, label: range.label },
    kpis,
    charts: { barDept, pieStation, lineDay, top10 },
  };
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/** Nhom + trung binh 1 truong theo key. */
function groupAvg(arr, keyField, valField) {
  const m = new Map();
  for (const r of arr) {
    const k = r[keyField] || '(trong)';
    if (!m.has(k)) m.set(k, { sum: 0, count: 0 });
    const g = m.get(k);
    const v = Number(r[valField]);
    if (isFinite(v)) {
      g.sum += v;
      g.count += 1;
    }
  }
  return [...m.entries()]
    .map(([key, g]) => ({ key, avg: g.count ? g.sum / g.count : 0, count: g.count }))
    .sort((a, b) => b.avg - a.avg);
}

/** Dem so luong theo key. */
function groupCount(arr, keyField) {
  const m = new Map();
  for (const r of arr) {
    const k = r[keyField] || '(trong)';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/** Nhom trung binh theo ngay (yyyy-mm-dd) tu 1 cot datetime. */
function groupAvgByDay(arr, dateField, valField) {
  const m = new Map();
  for (const r of arr) {
    const d = r[dateField] ? new Date(r[dateField]) : null;
    if (!d || isNaN(d)) continue;
    const key = d.toISOString().slice(0, 10);
    if (!m.has(key)) m.set(key, { sum: 0, count: 0 });
    const g = m.get(key);
    const v = Number(r[valField]);
    if (isFinite(v)) {
      g.sum += v;
      g.count += 1;
    }
  }
  return [...m.entries()]
    .map(([key, g]) => ({ key, avg: g.count ? g.sum / g.count : 0 }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// 7. DU LIEU MAU (DEMO_MODE) - de chay thu giao dien khi chua co SQL Server
// ---------------------------------------------------------------------------
const DEMO = require('./demo-data');

// ---------------------------------------------------------------------------
// 8. EXPRESS APP + ROUTES
// ---------------------------------------------------------------------------
const app = express();
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/** Boc route async + xu ly loi tap trung. */
function h(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error('[API ERROR]', req.path, '-', err.message);
      res.status(500).json({
        error: true,
        message: 'Loi truy van du lieu: ' + err.message,
        hint: CONFIG.demoMode
          ? 'Dang o DEMO_MODE.'
          : 'Kiem tra cau hinh .env va ket noi SQL Server.',
      });
    }
  };
}

/** Doc filter chung tu query string. */
function readFilters(q) {
  return {
    station: (q.station || '').trim(),
    store: (q.store || '').trim(),
    department: (q.department || '').trim(),
  };
}

// --- Health check: kiem tra ket noi DB ---
app.get(
  '/api/health',
  h(async (req, res) => {
    if (CONFIG.demoMode) {
      return res.json({ status: 'ok', mode: 'demo', message: 'Dang chay DEMO_MODE (du lieu mau).' });
    }
    await query('SELECT 1 AS ok');
    res.json({ status: 'ok', mode: 'live', message: 'Ket noi SQL Server OK.' });
  })
);

// --- Danh sach gia tri cho cac filter (station/store/department) ---
app.get(
  '/api/filters',
  h(async (req, res) => {
    if (CONFIG.demoMode) return res.json(DEMO.filters());
    const stations = await query(
      `SELECT DISTINCT LTRIM(RTRIM([station])) AS v FROM [NQT].[dbo].[kho_ser1]
       WHERE [station] IS NOT NULL AND LTRIM(RTRIM([station])) <> '' ORDER BY v`
    );
    const stores = await query(
      `SELECT DISTINCT LTRIM(RTRIM([store])) AS v FROM [NQT].[dbo].[kho_ser1]
       WHERE [store] IS NOT NULL AND LTRIM(RTRIM([store])) <> '' ORDER BY v`
    );
    const departments = await query(
      `SELECT DISTINCT LTRIM(RTRIM([DEPARTMENT])) AS v FROM [DWH_DB]..[STG_AMOS].[SIGN]
       WHERE [DEPARTMENT] IS NOT NULL AND LTRIM(RTRIM([DEPARTMENT])) <> '' ORDER BY v`
    );
    res.json({
      stations: stations.map((r) => r.v),
      stores: stores.map((r) => r.v),
      departments: departments.map((r) => r.v),
    });
  })
);

// --- DEBUG: khao sat du lieu that de kiem tra logic/dinh dang cot ---
//     Mo http://localhost:3000/api/debug roi gui ket qua JSON de doi chieu.
app.get(
  '/api/debug',
  h(async (req, res) => {
    if (CONFIG.demoMode) return res.json({ note: 'Dang o DEMO_MODE, khong co du lieu that.' });

    // Chay tung truy van doc lap, loi query nao thi ghi loi query do (khong vo het).
    const safe = async (label, text) => {
      try {
        return { [label]: await query(text, { tzOffset: CONFIG.tzOffset }) };
      } catch (e) {
        return { [label]: { error: e.message } };
      }
    };

    const parts = await Promise.all([
      // 1. Kieu du lieu + gia tri mau + gio tinh ra, doi chieu del_time
      safe(
        'timeSample',
        `SELECT TOP 8
           k.[mutation] AS mutation, k.[mutation_t] AS mutation_t,
           CAST(SQL_VARIANT_PROPERTY(CAST(k.[mutation] AS sql_variant),'BaseType') AS varchar(30))   AS mutation_type,
           CAST(SQL_VARIANT_PROPERTY(CAST(k.[mutation_t] AS sql_variant),'BaseType') AS varchar(30)) AS mutation_t_type,
           ${amosToVN('k')} AS issue_vn_computed,
           r.[del_time]     AS del_time
         FROM [NQT].[dbo].[kho_ser1] k
         JOIN [NQT].[dbo].[real_us1] r
           ON k.[partno]=r.[partno] AND k.[serialno]=r.[serialno] AND k.[voucherno]=r.[voucher_s]
         WHERE k.[vm]='T' AND k.[voucherno] LIKE 'P-%'`
      ),
      // 2. Phan bo vm trong kho_ser1
      safe('khoVm', `SELECT [vm] AS vm, COUNT(*) AS c FROM [NQT].[dbo].[kho_ser1] GROUP BY [vm]`),
      // 3. Phan bo vm trong on_off (YE=lap, YA=thao)
      safe('onoffVm', `SELECT [vm] AS vm, COUNT(*) AS c FROM [NQT].[dbo].[on_off] GROUP BY [vm]`),
      // 4. Mau voucher xuat/hoan trong kho_ser1
      safe(
        'voucherSample',
        `SELECT TOP 10 [vm] AS vm, [voucherno] AS voucherno FROM [NQT].[dbo].[kho_ser1]
         WHERE [voucherno] IS NOT NULL ORDER BY NEWID()`
      ),
      // 5. reci_time / del_time - kiem tra sentinel gay TAT am
      safe(
        'reciSample',
        `SELECT TOP 8 r.[del_time] AS del_time, r.[reci_time] AS reci_time,
           DATEDIFF(MINUTE, r.[del_time], r.[reci_time]) AS diff_minutes
         FROM [NQT].[dbo].[real_us1] r
         WHERE r.[reci_time] IS NOT NULL ORDER BY NEWID()`
      ),
      safe(
        'reciRange',
        `SELECT MIN(r.[reci_time]) AS min_reci, MAX(r.[reci_time]) AS max_reci,
           MIN(r.[del_time]) AS min_del, MAX(r.[del_time]) AS max_del
         FROM [NQT].[dbo].[real_us1] r`
      ),
      // 6. Dem link on_off <-> real_us1 va kho_ser1 <-> on_off (kiem tra join)
      safe(
        'joinCounts',
        `SELECT
          (SELECT COUNT(*) FROM [NQT].[dbo].[kho_ser1] WHERE [vm]='T' AND [voucherno] LIKE 'P-%')   AS issued_T,
          (SELECT COUNT(*) FROM [NQT].[dbo].[kho_ser1] WHERE [vm]='TC' AND [voucherno] LIKE 'P-CA-%') AS return_TC,
          (SELECT COUNT(*) FROM [NQT].[dbo].[on_off] WHERE [vm]='YE') AS install_YE,
          (SELECT COUNT(*) FROM [NQT].[dbo].[on_off] WHERE [vm]='YA') AS remove_YA`
      ),
    ]);

    res.json(Object.assign({ tzOffset: CONFIG.tzOffset }, ...parts));
  })
);

// --- Dashboard tong hop (KPI + charts) ---
app.get(
  '/api/dashboard',
  h(async (req, res) => {
    const range = resolveRange(req.query);
    const f = readFilters(req.query);
    if (CONFIG.demoMode) return res.json(DEMO.dashboard(range, f));

    // Chay song song cac truy van can thiet
    const [dept, cuvt, retStore, issuedNI, notRec] = await Promise.all([
      qTatDepartments(range, f),
      qTatCuvt(range, f),
      qTatReturnStore(range, f),
      qIssuedNotInstalled(range, f),
      qNotReconciled(range, f),
    ]);
    res.json(buildDashboard(range, dept, cuvt, retStore, issuedNI, notRec));
  })
);

// --- Bang du lieu chi tiet TAT theo don vi (cho bang chinh o Dashboard) ---
app.get(
  '/api/tat/departments',
  h(async (req, res) => {
    const range = resolveRange(req.query);
    const f = readFilters(req.query);
    const data = CONFIG.demoMode ? DEMO.tatDepartments(range, f) : await qTatDepartments(range, f);
    res.json({ rows: data, count: data.length });
  })
);

app.get(
  '/api/tat/cuvt',
  h(async (req, res) => {
    const range = resolveRange(req.query);
    const f = readFilters(req.query);
    const data = CONFIG.demoMode ? DEMO.tatCuvt(range, f) : await qTatCuvt(range, f);
    res.json({ rows: data, count: data.length });
  })
);

// --- Cac bao cao (moi bao cao tra { rows, count }) ---
const REPORTS = {
  'issued-not-installed': { live: qIssuedNotInstalled, demo: 'issuedNotInstalled' },
  'removed-not-returned': { live: qRemovedNotReturned, demo: 'removedNotReturned' },
  'not-reconciled': { live: qNotReconciled, demo: 'notReconciled' },
  'removed-before-installed': { live: qRemovedBeforeInstalled, demo: 'removedBeforeInstalled' },
  other: { live: qOther, demo: 'other' },
  'return-store-tat': { live: qTatReturnStore, demo: 'returnStoreTat' },
};

app.get(
  '/api/reports/:name',
  h(async (req, res) => {
    const def = REPORTS[req.params.name];
    if (!def) return res.status(404).json({ error: true, message: 'Bao cao khong ton tai.' });
    const range = resolveRange(req.query);
    const f = readFilters(req.query);
    const data = CONFIG.demoMode ? DEMO[def.demo](range, f) : await def.live(range, f);
    res.json({ rows: data, count: data.length, range });
  })
);

// Route mac dinh -> tra index.html (SPA)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------------------------------------------------------------------------
// 9. KHOI DONG SERVER
// ---------------------------------------------------------------------------
app.listen(CONFIG.port, () => {
  console.log('====================================================');
  console.log(`  Dashboard TAT dang chay: http://localhost:${CONFIG.port}`);
  console.log(`  Che do: ${CONFIG.demoMode ? 'DEMO (du lieu mau)' : 'LIVE (SQL Server)'}`);
  console.log(`  AMOS -> VN offset: +${CONFIG.tzOffset}h | MAX_ROWS: ${CONFIG.maxRows}`);
  console.log('====================================================');
  if (!CONFIG.demoMode) {
    // Thu ket noi som de bao loi ngay neu cau hinh sai
    getPool().catch((err) =>
      console.error('[DB] Chua ket noi duoc SQL Server:', err.message)
    );
  }
});
