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
const fs = require('fs');
const dns = require('dns');
const sql = require('mssql');

// ---------------------------------------------------------------------------
// 1. CAU HINH
// ---------------------------------------------------------------------------
const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  maxRows: parseInt(process.env.MAX_ROWS || '5000', 10),
  tzOffset: parseInt(process.env.AMOS_TZ_OFFSET_HOURS || '7', 10), // AMOS(UTC) -> VN
  // Moc (epoch) cua cot ngay AMOS: mutation = SO NGAY ke tu ngay nay.
  // Xac dinh tu moc neo: hom nay 2026-07-08 = AMOS 19913 -> epoch = 1971-12-31.
  amosEpoch: process.env.AMOS_DATE_EPOCH || '1971-12-31',
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
  connectionTimeout: 30000, // cho mang cham/DB ban (mac dinh 15s hay bi "Failed to connect ... in 15000ms")
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
        pool.on('error', (err) => {
          // Mat ket noi giua chung (mang/DB restart): bo pool hong de lan sau tao moi
          console.error('[DB] Pool error:', err.message);
          poolPromise = null;
        });
        return pool;
      })
      .catch((err) => {
        poolPromise = null; // cho phep thu lai lan sau
        throw err;
      });
  }
  return poolPromise;
}

/** Loi thuoc nhom KET NOI (dang thu lai duoc) hay khong. */
function isConnError(err) {
  const codes = ['ETIMEOUT', 'ESOCKET', 'ECONNCLOSED', 'ECONNRESET', 'ELOGIN', 'ENOTOPEN'];
  return codes.includes(err.code) || /Failed to connect|socket hang up|Connection lost/i.test(err.message || '');
}

/**
 * Chay 1 query co tham so.
 * @param {string} text  Cau SQL (dung @param)
 * @param {Object} params  { tenParam: giaTri }
 */
async function runQuery(text, params, multi) {
  const pool = await getPool();
  const req = pool.request();
  // Tham so mac dinh luon co san cho cac bieu thuc doi gio/ngay AMOS
  if (!('tzOffset' in params)) params.tzOffset = CONFIG.tzOffset;
  if (!('amosEpoch' in params)) params.amosEpoch = CONFIG.amosEpoch;
  for (const [key, val] of Object.entries(params)) req.input(key, val);
  const rs = await req.query(text);
  return multi ? rs.recordsets || [] : rs.recordset || [];
}

/** Chay query; neu loi KET NOI thi lam moi pool va thu lai 1 lan. */
async function withRetry(text, params, multi) {
  try {
    return await runQuery(text, params, multi);
  } catch (err) {
    if (!isConnError(err)) throw err;
    console.warn('[DB] Loi ket noi, thu lai 1 lan:', err.message);
    poolPromise = null; // bo pool hong, tao ket noi moi
    return runQuery(text, params, multi);
  }
}

async function query(text, params = {}) {
  return withRetry(text, params, false);
}

/** Nhu query() nhung tra ve TAT CA cac result set (batch nhieu SELECT). */
async function queryMulti(text, params = {}) {
  return withRetry(text, params, true);
}

// ---------------------------------------------------------------------------
// 3. CAC MANH SQL DUNG CHUNG (nghiep vu)
// ---------------------------------------------------------------------------

/**
 * Bieu thuc T-SQL doi gio AMOS -> gio Viet Nam.
 * mutation  = NGAY cua AMOS (UTC), mutation_t = GIO cua AMOS (UTC).
 * (Chi del_time / reci_time la kieu datetime that; mutation/mutation_t can ghep.)
 *
 * Dinh dang thuc te trong DB (AMOS/Progress) - xac nhan qua /debug.html:
 *   - mutation   : SO NGAY ke tu moc @amosEpoch (vd 19360). Kieu float.
 *   - mutation_t : SO MILLISECOND ke tu 00:00 (vd 71820341 = 19:57:00). Kieu float.
 *
 * Cach ghep: @amosEpoch + mutation(ngay) + mutation_t(ms) roi cong @tzOffset gio.
 * Dung TRY_CONVERT nen neu du lieu loi -> tra NULL thay vi bao loi truy van.
 *
 * >>> Neu ngay ra sai, chi can chinh AMOS_DATE_EPOCH trong .env (xem cot
 *     implied_epoch o /debug.html). <<<
 *
 * @param {string} a  alias cua bang (vd 'k')
 */
function amosToVN(a) {
  // So ngay ke tu moc epoch -> cong vao @amosEpoch.
  const days = `TRY_CONVERT(int, TRY_CONVERT(float, ${a}.[mutation]))`;
  const dateExpr = `DATEADD(DAY, ${days}, TRY_CONVERT(datetime, @amosEpoch))`;
  // Gio (mutation_t): SO MILLISECOND ke tu 00:00. Qua float truoc de chiu duoc
  //   ca kieu numeric/decimal lan chuoi co phan thap phan '71820341.000000'.
  const msExpr = `TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, ${a}.[mutation_t])) % 86400000)`;
  return `DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, ${msExpr}, ${dateExpr}))`;
}

/**
 * Doi khoang thoi gian [from, to) sang KHOANG SO NGAY AMOS (mutation).
 * Muc dich TOI UU: cot [mutation] la so thuan (float) nen dieu kien
 * "mutation BETWEEN @fromDay AND @toDay" dung duoc INDEX (sargable),
 * SQL loc tho truoc bang index roi moi tinh amosToVN() chinh xac cho so it dong.
 * Dem +/-2 ngay de bu tru chenh lech mui gio.
 */
function amosDayParams(range) {
  const epoch = new Date(CONFIG.amosEpoch + 'T00:00:00Z');
  const from = new Date(String(range.from) + 'Z');
  const to = new Date(String(range.to) + 'Z');
  const DAY = 86400000;
  return {
    fromDay: Math.floor((from - epoch) / DAY) - 2,
    toDay: Math.ceil((to - epoch) / DAY) + 2,
  };
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
 * SIGN lookup an toan qua LINKED SERVER Oracle (DWH_DB):
 *  - GROUP BY USER_SIGN de khong nhan ban dong (USER_SIGN trung van chi ra 1 dong).
 *  - LEFT JOIN voi bang con (derived table) de SQL keo SIGN ve MOT LAN,
 *    KHONG hoi Oracle tung dong (OUTER APPLY tung dong gay loi
 *    "Cannot get the data of the row from OLE DB provider OraOLEDB.Oracle").
 * @param {string} staffCol  cot nhan vien de tra (vd 'r.[action_per]')
 * @param {string} alias     alias cua bang con (vd 'sm')
 */
function signJoin(staffCol, alias) {
  return `LEFT JOIN (
      SELECT [USER_SIGN], MAX([DEPARTMENT]) AS [DEPARTMENT]
      FROM [DWH_DB]..[STG_AMOS].[SIGN]
      GROUP BY [USER_SIGN]
    ) ${alias} ON ${alias}.[USER_SIGN] = ${staffCol}`;
}

/**
 * Trung tam (department) cho bang real_us1:
 *   1) real_us1.department (bo '' / 'UNKNOWN')
 *   2) neu action_per bat dau bang 'PA' -> 'PA'
 *   3) tra SIGN theo action_per
 *   4) mac dinh 'PA'
 */
function deptFromReal(rAlias, smAlias) {
  return `COALESCE(
      ${cleanDept(`${rAlias}.[department]`)},
      CASE WHEN LEFT(LTRIM(RTRIM(${rAlias}.[action_per])), 2) = 'PA' THEN 'PA' END,
      ${cleanDept(`${smAlias}.[DEPARTMENT]`)},
      'PA')`;
}

/**
 * Trung tam cho bang kho_ser1 (khong co cot department): dung created_b2.
 *   1) created_b2 bat dau 'PA' -> 'PA'  2) SIGN theo created_b2  3) 'PA'
 */
function deptFromStaff(staffCol, smAlias) {
  return `COALESCE(
      CASE WHEN LEFT(LTRIM(RTRIM(${staffCol})), 2) = 'PA' THEN 'PA' END,
      ${cleanDept(`${smAlias}.[DEPARTMENT]`)},
      'PA')`;
}

// 3 station chinh cua VAECO; con lai gom vao 'OTHER' (hien thi 'Khac').
const MAIN_STATIONS = ['HAN', 'SGN', 'DAD'];
function normalizeStation(s) {
  const v = (s || '').trim().toUpperCase();
  return MAIN_STATIONS.includes(v) ? v : 'OTHER';
}

/**
 * Build menh de WHERE dong tu cac filter chung (station/store/department).
 * Tra ve { clause, params } - clause bat dau bang ' AND ...' hoac ''.
 * Rieng station='OTHER' -> loc tat ca station NGOAI HAN/SGN/DAD.
 * @param {Object} f  { station, store, department }
 * @param {Object} cols  ten cot tuong ung { station, store, department }
 */
function buildFilterClause(f, cols, params) {
  let clause = '';
  if (f.station && cols.station) {
    if (f.station.toUpperCase() === 'OTHER') {
      clause += ` AND UPPER(LTRIM(RTRIM(${cols.station}))) NOT IN ('HAN','SGN','DAD')`;
    } else {
      clause += ` AND ${cols.station} = @fStation`;
      params.fStation = f.station;
    }
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
 * Tuan bat dau tu THU 2 dau tuan: [T2 cua tuan chua ngay tham chieu, T2 tuan sau).
 * ref = ngay tham chieu (mac dinh hom nay).
 */
function weekRange(ref) {
  const base = ref ? new Date(ref) : new Date();
  // Ve mui gio dia phuong, lay 00:00
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const day = d.getDay(); // 0=CN, 1=T2 .. 6=T7
  const backToMon = (day - 1 + 7) % 7; // lui ve thu 2 dau tuan
  const monday = new Date(d);
  monday.setDate(d.getDate() - backToMon);
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  return { from: toLocalStr(monday), to: toLocalStr(nextMonday) };
}

/** Tra ve { from, to, label } tu query params. */
function resolveRange(q) {
  if (q.periodType === 'week') {
    const r = weekRange(q.week);
    return { ...r, label: 'Tuan (T2 dau tuan)' };
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
 *  - Link: kho_ser1(labelno,voucherno) = real_us1(labelno,voucher_s)
 *  - Department: UU TIEN bang SIGN (don vi moi nhat theo nhan vien) tra theo
 *    real_us1.action_per; neu SIGN khong co -> dung real_us1.department;
 *    van trong -> 'PA'. (Neu co khac biet don vi thi SIGN la nguon chuan.)
 */
async function qTatDepartments(range, f) {
  const params = { from: range.from, to: range.to, tzOffset: CONFIG.tzOffset, top: CONFIG.maxRows };
  // Trung tam: real_us1.department -> mutator('PA'/SIGN) -> 'PA'.
  const dept = deptFromReal('r', 'sm');
  let where = buildFilterClause(
    f,
    { station: 'k.[station]', store: 'k.[store]', department: dept },
    params
  );
  const text = `
    SELECT TOP (@top)
      k.[event_perf]  AS event_perf,
      k.[partno]      AS partno,
      k.[serialno]    AS serialno,
      k.[labelno]     AS labelno,
      k.[descriptio]  AS description,
      k.[receiver]    AS receiver,
      k.[station]     AS station,
      k.[store1]      AS store,   -- hien thi store1 (theo yeu cau); filter van theo [store]
      k.[voucherno]   AS voucher_issue,
      k.[picking_li]  AS picking_li,
      r.[partno_off]  AS partno_off,    -- thiet bi thao (tu real_us1)
      r.[serialno_o]  AS serialno_off,
      r.[action_per]  AS staff,
      ${dept} AS department,
      ${amosToVN('k')}                       AS issue_time_vn,
      r.[del_time]                           AS return_unservice_time,
      CAST(DATEDIFF(MINUTE, ${amosToVN('k')}, r.[del_time]) AS float) / 1440.0 AS tat_days
    FROM [NQT].[dbo].[kho_ser1] k
    INNER JOIN [NQT].[dbo].[real_us1] r
      ON k.[labelno] = r.[labelno]
      AND k.[voucherno] = r.[voucher_s]
    ${signJoin('r.[action_per]', 'sm')}
    WHERE k.[vm] = 'T'
      AND k.[voucherno] LIKE 'P-%'
      -- Bo qua ban ghi receiver rong; bo qua costcenter 'VN-SPL'
      AND LTRIM(RTRIM(ISNULL(k.[receiver], ''))) <> ''
      AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')  -- bo qua store MAIN/3RD
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'  -- bo qua condition US
      AND r.[del_time] >= @from AND r.[del_time] < @to
      ${where}
    ORDER BY tat_days DESC`;
  return query(text, params);
}

/**
 * TAT cua CUVT: tu luc TRA unservice (del_time) den luc NHAN unservice (reci_time).
 * Ca 2 cot deu la datetime gio VN san.
 */
async function qTatCuvt(range, f) {
  const params = { from: range.from, to: range.to, top: CONFIG.maxRows };
  const dept = deptFromReal('r', 'sm');
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
      r.[action_per] AS staff,
      ${dept} AS department,
      r.[del_time]   AS return_unservice_time,
      r.[reci_time]  AS receive_unservice_time,
      CAST(DATEDIFF(MINUTE, r.[del_time], r.[reci_time]) AS float) / 1440.0 AS tat_days
    FROM [NQT].[dbo].[real_us1] r
    ${signJoin('r.[action_per]', 'sm')}
    WHERE r.[del_time] IS NOT NULL
      AND r.[reci_time] IS NOT NULL
      AND r.[reci_time] >= r.[del_time]      -- loai ban ghi chua nhan (reci_time sentinel < del_time) -> tranh TAT am
      AND r.[del_time] >= @from AND r.[del_time] < @to
      ${where}
    ORDER BY tat_days DESC`;
  return query(text, params);
}

/**
 * TAT HOAN KHO: thiet bi hoan kho (vm='TC', voucher 'P-CA-<PS>') doi chieu voi
 * phieu XUAT tuong ung (vm='T', voucher 'P-<PS>') - CUNG so PS - va CUNG labelno.
 * TAT = thoi diem hoan kho - thoi diem xuat kho (gio).
 */
async function qTatReturnStore(range, f) {
  const params = { from: range.from, to: range.to, tzOffset: CONFIG.tzOffset, top: CONFIG.maxRows, ...amosDayParams(range) };
  const dept = deptFromStaff('t.[created_b2]', 'sm');
  let where = buildFilterClause(
    f,
    { station: 'tc.[station]', store: 'tc.[store]', department: dept },
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
      t.[picking_li]  AS picking_li,
      t.[created_b2]  AS staff,
      ${dept} AS department,
      ${amosToVN('t')}  AS issue_time_vn,
      ${amosToVN('tc')} AS return_store_time_vn,
      CAST(DATEDIFF(MINUTE, ${amosToVN('t')}, ${amosToVN('tc')}) AS float) / 1440.0 AS tat_days
    FROM [NQT].[dbo].[kho_ser1] tc
    INNER JOIN [NQT].[dbo].[kho_ser1] t
      -- Doi chieu so PS: 'P-CA-<PS>' (hoan) <-> 'P-<PS>' (xuat), va cung labelno
      ON RTRIM(t.[voucherno]) = 'P-' + SUBSTRING(RTRIM(tc.[voucherno]), 6, 50)
     AND t.[labelno] = tc.[labelno]
     AND t.[vm] = 'T'
     AND t.[voucherno] LIKE 'P-%'
    ${signJoin('t.[created_b2]', 'sm')}
    WHERE tc.[vm] = 'TC'
      AND tc.[voucherno] LIKE 'P-CA-%'
      AND LTRIM(RTRIM(ISNULL(t.[costcenter], ''))) <> 'VN-SPL'  -- bo qua costcenter VN-SPL
      AND UPPER(LTRIM(RTRIM(ISNULL(t.[store], '')))) NOT IN ('MAIN','3RD')  -- bo qua store MAIN/3RD
      AND UPPER(LTRIM(RTRIM(ISNULL(t.[condition], '')))) <> 'US'  -- bo qua condition US
      AND ${dept} <> 'CUVT'   -- khong tinh TAT hoan kho cho CUVT
      AND tc.[mutation] BETWEEN @fromDay AND @toDay  -- loc tho theo index (sargable)
      AND ${amosToVN('tc')} >= @from AND ${amosToVN('tc')} < @to
      ${where}
    ORDER BY tat_days DESC`;
  return query(text, params);
}

/**
 * BAO CAO 1: Thiet bi XUAT KHO nhung CHUA LAP LEN TAU.
 * kho_ser1 vm='T' (P-...) khong co ban ghi on_off vm='YE' (lap len tau).
 * Link kho_ser1 <-> on_off qua (partno, serialno, labelno).
 */
async function qIssuedNotInstalled(range, f) {
  const params = { from: range.from, to: range.to, tzOffset: CONFIG.tzOffset, top: CONFIG.maxRows, ...amosDayParams(range) };
  const dept = deptFromStaff('k.[created_b2]', 'sm');
  let where = buildFilterClause(
    f,
    { station: 'k.[station]', store: 'k.[store]', department: dept },
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
      k.[created_b2] AS staff,
      ${dept} AS department,
      ${amosToVN('k')} AS issue_time_vn,
      -- TAT ton dong = tu luc xuat kho den HIEN TAI (ngay)
      CAST(DATEDIFF(MINUTE, ${amosToVN('k')}, GETDATE()) AS float) / 1440.0 AS tat_days
    FROM [NQT].[dbo].[kho_ser1] k
    LEFT JOIN [NQT].[dbo].[on_off] o
      ON k.[partno] = o.[partno]
     AND k.[serialno] = o.[serialno]
     AND k.[labelno] = o.[labelno]
     AND o.[vm] = 'YE'
    ${signJoin('k.[created_b2]', 'sm')}
    WHERE k.[vm] = 'T'
      AND k.[voucherno] LIKE 'P-%'
      AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'  -- bo qua costcenter VN-SPL
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')  -- bo qua store MAIN/3RD
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'  -- bo qua condition US
      AND k.ac_registr IS NOT NULL                                   -- bo qua thiet bi khong co so truc (khong xac dinh duoc may bay nao)
      AND o.[partno] IS NULL
      -- Bo qua thiet bi da duoc RETURN (tra unservice real_us1 hoac hoan kho P-CA-...)
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[real_us1] r2
        WHERE r2.[partno] = k.[partno] AND r2.[serialno] = k.[serialno]
          AND r2.[voucher_s] = k.[voucherno]
      )
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
        WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
          AND tc.[partno] = k.[partno] AND tc.[serialno] = k.[serialno] AND tc.[labelno] = k.[labelno]
      )
      AND k.[mutation] BETWEEN @fromDay AND @toDay  -- loc tho theo index (sargable)
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
  const params = { from: range.from, to: range.to, tzOffset: CONFIG.tzOffset, top: CONFIG.maxRows, ...amosDayParams(range) };
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
      o.[created_by] AS staff,
      ${amosToVN('o')} AS removed_time_vn
    FROM [NQT].[dbo].[on_off] o
    LEFT JOIN [NQT].[dbo].[real_us1] r
      ON o.[historyno_] = r.[historyno_]   -- so sanh so truc tiep (cot so; RTRIM lam float->chuoi 6 chu so -> ghep nham)
    WHERE o.[vm] = 'YA'
      AND r.[historyno_] IS NULL
      AND o.[mutation] BETWEEN @fromDay AND @toDay  -- loc tho theo index (sargable)
      AND ${amosToVN('o')} >= @from AND ${amosToVN('o')} < @to
      ${where}
    ORDER BY removed_time_vn DESC`;
  return query(text, params);
}

/**
 * BAO CAO 3: Thiet bi CHUA DOI UNG.
 * Co XUAT service (kho_ser1 vm='T', P-...) nhung KHONG co tra unservice (real_us1).
 * Link kho_ser1 <-> real_us1 qua (partno, serialno, voucherno=voucher_s).
 * BO QUA thiet bi da HOAN KHO (vm='TC', P-CA-...) - coi nhu da xu ly xong.
 */
async function qNotReconciled(range, f) {
  const params = { from: range.from, to: range.to, tzOffset: CONFIG.tzOffset, top: CONFIG.maxRows, ...amosDayParams(range) };
  const dept = deptFromStaff('k.[created_b2]', 'sm');
  let where = buildFilterClause(
    f,
    { station: 'k.[station]', store: 'k.[store]', department: dept },
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
      k.[picking_li] AS picking_li,
      k.[created_b2] AS staff,
      k.[ac_registr] AS ac_registr,
      ${dept} AS department,
      ${amosToVN('k')} AS issue_time_vn,
      -- TAT ton dong = tu luc xuat kho den HIEN TAI (ngay)
      CAST(DATEDIFF(MINUTE, ${amosToVN('k')}, GETDATE()) AS float) / 1440.0 AS tat_days
    FROM [NQT].[dbo].[kho_ser1] k
    LEFT JOIN [NQT].[dbo].[real_us1] r
      ON k.[labelno] = r.[labelno]
      AND k.[voucherno] = r.[voucher_s]
    ${signJoin('k.[created_b2]', 'sm')}
    WHERE k.[vm] = 'T'
      AND k.[voucherno] LIKE 'P-%'
      AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'  -- bo qua costcenter VN-SPL
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')  -- bo qua store MAIN/3RD
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'  -- bo qua condition US
      AND r.[partno] IS NULL
      -- Bo qua neu thiet bi da duoc hoan kho (P-CA-...)
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
        WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
          AND tc.[partno] = k.[partno]
          AND tc.[serialno] = k.[serialno]
          AND tc.[labelno] = k.[labelno]
      )
      AND k.[mutation] BETWEEN @fromDay AND @toDay  -- loc tho theo index (sargable)
      AND ${amosToVN('k')} >= @from AND ${amosToVN('k')} < @to
      ${where}
    ORDER BY issue_time_vn DESC`;
  return query(text, params);
}

/**
 * BAO CAO 4: THAO TRUOC, LAP SAU (thiet bi thao ra truoc, phieu xuat kho lam sau).
 * Lien ket theo [labelno] (cung 1 label giao dich):
 *   - Thiet bi LAP (YE) va thiet bi THAO (YA) lay tu on_off theo labelno cua
 *     phieu xuat kho_ser1 (vm='T', P-...).
 *   - "Dung logic" khi NGAY XUAT KHO > NGAY LAP -> chi lay cac dong nay.
 *   - The hien RO thiet bi thao (partno/serial thao) vs thiet bi xuat (partno/serial xuat).
 *   - 2 TAT: xuat sau lap bao nhieu ngay (issue - install) va thao -> tra US.
 */
async function qRemovedBeforeInstalled(range, f) {
  const params = { from: range.from, to: range.to, top: CONFIG.maxRows, ...amosDayParams(range) };
  const dept = deptFromStaff('k.[created_b2]', 'sm');
  let where = buildFilterClause(
    f,
    { station: 'k.[station]', store: 'k.[store]', department: dept },
    params
  );
  const text = `
    SELECT TOP (@top)
      k.[labelno]    AS labelno,
      k.[partno]     AS partno,          -- thiet bi XUAT KHO (xuat sau)
      k.[serialno]   AS serialno,
      k.[descriptio] AS description,
      ya.partno      AS partno_removed,  -- thiet bi THAO (thao truoc)
      ya.serialno    AS serialno_removed,
      k.[ac_registr] AS ac_registr,
      k.[created_b2] AS staff,
      k.[station]    AS station,
      ${dept} AS department,
      ya.removal_time       AS removed_time_vn,     -- ngay thao
      ye.install_time       AS installed_time_vn,   -- ngay lap
      ${amosToVN('k')}      AS issue_time_vn,       -- ngay xuat kho (sau ngay lap)
      r.[del_time]          AS return_unservice_time,
      CAST(DATEDIFF(MINUTE, ye.install_time, ${amosToVN('k')}) AS float) / 1440.0 AS tat_issue_install_days,
      CAST(DATEDIFF(MINUTE, ya.removal_time, r.[del_time]) AS float) / 1440.0    AS tat_removal_return_days
    FROM [NQT].[dbo].[kho_ser1] k
    -- Su kien LAP (YE): lan lap GAN NHAT TRUOC ngay xuat kho (cung labelno;
    --  khong yeu cau cung part/serial - thiet bi lap co the khac phieu xuat)
    OUTER APPLY (
      SELECT TOP 1 ${amosToVN('o')} AS install_time
      FROM [NQT].[dbo].[on_off] o
      WHERE o.[labelno] = k.[labelno] AND o.[vm] = 'YE'
        AND ${amosToVN('o')} < ${amosToVN('k')}     -- lap TRUOC xuat (dung logic)
      ORDER BY o.[mutation] DESC, o.[mutation_t] DESC
    ) ye
    -- Su kien THAO (YA): lan thao gan nhat TRUOC/luc lap (trinh tu thao -> lap)
    OUTER APPLY (
      SELECT TOP 1 ${amosToVN('o')} AS removal_time, o.[historyno_] AS historyno,
             o.[partno] AS partno, o.[serialno] AS serialno
      FROM [NQT].[dbo].[on_off] o
      WHERE o.[labelno] = k.[labelno] AND o.[vm] = 'YA'
        AND ${amosToVN('o')} <= ye.install_time
      ORDER BY o.[mutation] DESC, o.[mutation_t] DESC
    ) ya
    LEFT JOIN [NQT].[dbo].[real_us1] r ON r.[historyno_] = ya.historyno
    ${signJoin('k.[created_b2]', 'sm')}
    WHERE k.[vm] = 'T'
      AND k.[voucherno] LIKE 'P-%'
      AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'  -- bo qua costcenter VN-SPL
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')  -- bo qua store MAIN/3RD
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'  -- bo qua condition US
      AND ye.install_time IS NOT NULL
      -- "Thao truoc lap sau" dung logic: NGAY XUAT KHO > NGAY LAP
      AND ${amosToVN('k')} > ye.install_time
      AND k.[mutation] BETWEEN @fromDay AND @toDay
      AND ${amosToVN('k')} >= @from AND ${amosToVN('k')} < @to
      ${where}
    ORDER BY k.[mutation] DESC`;
  return query(text, params);
}

/**
 * BAO CAO 4b: DANH MUC TRA UNSERVICE.
 * Liet ke thiet bi da tra unservice (real_us1) trong ky, kem del_time/del_staff
 * va cac thong tin nhu bang "thao xuong chua tra unservice".
 */
async function qReturnedUnservice(range, f) {
  const params = { from: range.from, to: range.to, top: CONFIG.maxRows };
  const dept = deptFromReal('r', 'sm');
  let where = buildFilterClause(
    f,
    { station: 'r.[station]', store: 'r.[store]', department: dept },
    params
  );
  const text = `
    SELECT TOP (@top)
      r.[partno_off]     AS partno,
      r.[serialno_o]   AS serialno,
      r.[labelno]    AS labelno,
      r.[descriptio] AS description,
      r.[historyno_] AS historyno,
      r.[ac_registr] AS ac_registr,
      r.[action_per] AS staff,
      r.[station]    AS station,
      ${dept} AS department,
      r.[del_staff]  AS del_staff,
      r.[del_time]   AS del_time,
      r.[reci_time]  AS reci_time
    FROM [NQT].[dbo].[real_us1] r
    ${signJoin('r.[action_per]', 'sm')}
    WHERE r.[del_time] IS NOT NULL
      AND r.[del_time] >= @from AND r.[del_time] < @to
      ${where}
    ORDER BY r.[del_time] DESC`;
  return query(text, params);
}

/**
 * BAO CAO 5: OTHER - lay note trong cot on_ac cua real_us1.
 * Cot: partno_off, serialno_o, batchno_of, qty_off, station, department, del_staff, del_time.
 */
async function qOther(range, f) {
  const params = { from: range.from, to: range.to, top: CONFIG.maxRows };
  const dept = deptFromReal('r', 'sm');
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
      r.[action_per]  AS staff,
      r.[station]     AS station,
      ${dept} AS department,
      r.[del_staff]   AS del_staff,
      r.[del_time]    AS del_time,
      r.[on_ac]       AS note
    FROM [NQT].[dbo].[real_us1] r
    ${signJoin('r.[action_per]', 'sm')}
    WHERE r.[on_ac] IS NOT NULL AND LTRIM(RTRIM(r.[on_ac])) <> ''
      -- Ke ca ban ghi chua co del_time (del_time null/sentinel van la note "other")
      AND (r.[del_time] IS NULL OR r.[del_time] < '1902-01-01'
           OR (r.[del_time] >= @from AND r.[del_time] < @to))
      ${where}
    ORDER BY r.[del_time] DESC`;
  return query(text, params);
}

/**
 * TONG HOP KPI + BIEU DO BANG SQL AGGREGATE (AVG/COUNT tren TOAN BO du lieu).
 * Ly do: cac query chi tiet co TOP @maxRows + ORDER BY tat DESC -> neu ky co
 * hon @maxRows dong thi trung binh tinh tu tap bi cat se THIEN LECH LEN.
 * Ham nay chay 1 batch nhieu SELECT GROUP BY, khong TOP -> so lieu chinh xac.
 *
 * Result sets (theo thu tu):
 *   [0] TAT don vi theo Trung tam:  department, cnt, avg_tat
 *   [1] TAT CUVT (scalar):          cnt, avg_tat
 *   [2] TAT hoan kho theo Trung tam: department, cnt, avg_tat
 *   [3] Chua doi ung theo Trung tam: department, cnt
 *   [4] Tra unservice theo Trung tam: department, cnt
 *   [5] Xuat kho chua lap (scalar):  cnt
 *   [6] Phan bo station (tap doi ung): station, cnt
 */
async function qDashboardAgg(range, f) {
  const params = { from: range.from, to: range.to, ...amosDayParams(range) };
  const deptR = deptFromReal('r', 'sm');
  const deptK = deptFromStaff('k.[created_b2]', 'sm');
  const deptT = deptFromStaff('t.[created_b2]', 'sm');

  // Dieu kien loc chung cua kho_ser1 (giong cac query chi tiet)
  const khoBase = `k.[vm] = 'T' AND k.[voucherno] LIKE 'P-%'
      AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'`;

  const wDept = buildFilterClause(f, { station: 'k.[station]', store: 'k.[store]', department: deptR }, params);
  const wCuvt = buildFilterClause(f, { station: 'r.[station]', store: 'r.[store]', department: deptR }, params);
  const wRet = buildFilterClause(f, { station: 'tc.[station]', store: 'tc.[store]', department: deptT }, params);
  const wNotRec = buildFilterClause(f, { station: 'k.[station]', store: 'k.[store]', department: deptK }, params);
  const wRetUS = buildFilterClause(f, { station: 'r.[station]', store: 'r.[store]', department: deptR }, params);
  const wNI = buildFilterClause(f, { station: 'k.[station]', store: 'k.[store]', department: deptK }, params);

  const text = `
    -- [0] TAT don vi theo Trung tam (toan bo, khong TOP)
    SELECT ${deptR} AS department, COUNT(*) AS cnt,
           AVG(CAST(DATEDIFF(MINUTE, ${amosToVN('k')}, r.[del_time]) AS float) / 1440.0) AS avg_tat
    FROM [NQT].[dbo].[kho_ser1] k
    INNER JOIN [NQT].[dbo].[real_us1] r
      ON k.[partno] = r.[partno] AND k.[serialno] = r.[serialno] AND k.[voucherno] = r.[voucher_s]
    ${signJoin('r.[action_per]', 'sm')}
    WHERE ${khoBase}
      AND LTRIM(RTRIM(ISNULL(k.[receiver], ''))) <> ''
      AND r.[del_time] >= @from AND r.[del_time] < @to
      ${wDept}
    GROUP BY ${deptR};

    -- [1] TAT CUVT (scalar)
    SELECT COUNT(*) AS cnt,
           AVG(CAST(DATEDIFF(MINUTE, r.[del_time], r.[reci_time]) AS float) / 1440.0) AS avg_tat
    FROM [NQT].[dbo].[real_us1] r
    ${signJoin('r.[action_per]', 'sm')}
    WHERE r.[del_time] IS NOT NULL AND r.[reci_time] IS NOT NULL
      AND r.[reci_time] >= r.[del_time]
      AND r.[del_time] >= @from AND r.[del_time] < @to
      ${wCuvt};

    -- [2] TAT hoan kho theo Trung tam
    SELECT ${deptT} AS department, COUNT(*) AS cnt,
           AVG(CAST(DATEDIFF(MINUTE, ${amosToVN('t')}, ${amosToVN('tc')}) AS float) / 1440.0) AS avg_tat
    FROM [NQT].[dbo].[kho_ser1] tc
    INNER JOIN [NQT].[dbo].[kho_ser1] t
      ON RTRIM(t.[voucherno]) = 'P-' + SUBSTRING(RTRIM(tc.[voucherno]), 6, 50)
     AND t.[labelno] = tc.[labelno] AND t.[vm] = 'T' AND t.[voucherno] LIKE 'P-%'
    ${signJoin('t.[created_b2]', 'sm')}
    WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
      AND LTRIM(RTRIM(ISNULL(t.[costcenter], ''))) <> 'VN-SPL'
      AND UPPER(LTRIM(RTRIM(ISNULL(t.[store], '')))) NOT IN ('MAIN','3RD')
      AND UPPER(LTRIM(RTRIM(ISNULL(t.[condition], '')))) <> 'US'
      AND ${deptT} <> 'CUVT'   -- khong tinh TAT hoan kho cho CUVT
      AND tc.[mutation] BETWEEN @fromDay AND @toDay
      AND ${amosToVN('tc')} >= @from AND ${amosToVN('tc')} < @to
      ${wRet}
    GROUP BY ${deptT};

    -- [3] Chua doi ung theo Trung tam
    SELECT ${deptK} AS department, COUNT(*) AS cnt
    FROM [NQT].[dbo].[kho_ser1] k
    LEFT JOIN [NQT].[dbo].[real_us1] r
      ON k.[partno] = r.[partno] AND k.[serialno] = r.[serialno] AND k.[voucherno] = r.[voucher_s]
    ${signJoin('k.[created_b2]', 'sm')}
    WHERE ${khoBase}
      AND r.[partno] IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
        WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
          AND tc.[partno] = k.[partno] AND tc.[serialno] = k.[serialno] AND tc.[labelno] = k.[labelno])
      AND k.[mutation] BETWEEN @fromDay AND @toDay
      AND ${amosToVN('k')} >= @from AND ${amosToVN('k')} < @to
      ${wNotRec}
    GROUP BY ${deptK};

    -- [4] Tra unservice theo Trung tam
    SELECT ${deptR} AS department, COUNT(*) AS cnt
    FROM [NQT].[dbo].[real_us1] r
    ${signJoin('r.[action_per]', 'sm')}
    WHERE r.[del_time] IS NOT NULL
      AND r.[del_time] >= @from AND r.[del_time] < @to
      ${wRetUS}
    GROUP BY ${deptR};

    -- [5] Xuat kho chua lap (scalar)
    SELECT COUNT(*) AS cnt
    FROM [NQT].[dbo].[kho_ser1] k
    LEFT JOIN [NQT].[dbo].[on_off] o
      ON k.[partno] = o.[partno] AND k.[serialno] = o.[serialno]
     AND k.[labelno] = o.[labelno] AND o.[vm] = 'YE'
    ${signJoin('k.[created_b2]', 'sm')}
    WHERE ${khoBase}
      AND o.[partno] IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[real_us1] r2
        WHERE r2.[partno] = k.[partno] AND r2.[serialno] = k.[serialno] AND r2.[voucher_s] = k.[voucherno])
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
        WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
          AND tc.[partno] = k.[partno] AND tc.[serialno] = k.[serialno] AND tc.[labelno] = k.[labelno])
      AND k.[mutation] BETWEEN @fromDay AND @toDay
      AND ${amosToVN('k')} >= @from AND ${amosToVN('k')} < @to
      ${wNI};

    -- [6] Phan bo station cua tap da doi ung
    SELECT k.[station] AS station, COUNT(*) AS cnt
    FROM [NQT].[dbo].[kho_ser1] k
    INNER JOIN [NQT].[dbo].[real_us1] r
      ON k.[partno] = r.[partno] AND k.[serialno] = r.[serialno] AND k.[voucherno] = r.[voucher_s]
    ${signJoin('r.[action_per]', 'sm')}
    WHERE ${khoBase}
      AND LTRIM(RTRIM(ISNULL(k.[receiver], ''))) <> ''
      AND r.[del_time] >= @from AND r.[del_time] < @to
      ${wDept}
    GROUP BY k.[station];`;

  const [deptAgg, cuvtAgg, retAgg, notRecAgg, retUSAgg, niAgg, stationAgg] = await queryMulti(text, params);
  return { deptAgg, cuvtAgg: cuvtAgg[0], retAgg, notRecAgg, retUSAgg, niAgg: niAgg[0], stationAgg };
}

/** Dung ket qua aggregate SQL de tao KPI + charts (chinh xac tren toan bo du lieu). */
function buildDashboardFromAgg(range, agg) {
  const sum = (arr, sel) => arr.reduce((a, b) => a + (Number(sel(b)) || 0), 0);
  const wavg = (arr) => {
    const c = sum(arr, (x) => x.cnt);
    return c ? sum(arr, (x) => (x.avg_tat || 0) * x.cnt) / c : 0;
  };

  const reconciled = sum(agg.deptAgg, (x) => x.cnt);
  const notRec = sum(agg.notRecAgg, (x) => x.cnt);

  const kpis = {
    tatDeptAvg: round1(wavg(agg.deptAgg)),
    tatCuvtAvg: round1(agg.cuvtAgg?.avg_tat || 0),
    tatReturnStoreAvg: round1(wavg(agg.retAgg)),
    countIssued: reconciled + notRec,
    countNotReconciled: notRec,
    countIssuedNotInstalled: agg.niAgg?.cnt || 0,
    reconcileRate: reconciled + notRec ? round1((reconciled / (reconciled + notRec)) * 100) : 0,
  };

  const byDept = [...agg.deptAgg].sort((a, b) => (b.avg_tat || 0) - (a.avg_tat || 0));
  const barDept = {
    labels: byDept.map((x) => x.department),
    values: byDept.map((x) => round1(x.avg_tat)),
    counts: byDept.map((x) => x.cnt),
  };

  const byRet = [...agg.retAgg].sort((a, b) => (b.avg_tat || 0) - (a.avg_tat || 0));
  const retStoreDept = {
    labels: byRet.map((x) => x.department),
    values: byRet.map((x) => round1(x.avg_tat)),
    counts: byRet.map((x) => x.cnt),
  };

  // So luong xuat kho (doi ung + chua doi ung) va tra US theo Trung tam
  const issuedCnt = new Map();
  for (const x of agg.deptAgg) issuedCnt.set(x.department, (issuedCnt.get(x.department) || 0) + x.cnt);
  for (const x of agg.notRecAgg) issuedCnt.set(x.department, (issuedCnt.get(x.department) || 0) + x.cnt);
  const returnedCnt = new Map(agg.retUSAgg.map((x) => [x.department, x.cnt]));
  const volLabels = [...new Set([...issuedCnt.keys(), ...returnedCnt.keys()])].sort(
    (a, b) => (issuedCnt.get(b) || 0) - (issuedCnt.get(a) || 0)
  );
  const deptVolume = {
    labels: volLabels,
    issued: volLabels.map((k) => issuedCnt.get(k) || 0),
    returned: volLabels.map((k) => returnedCnt.get(k) || 0),
  };

  // Station: gom HAN/SGN/DAD + Khac
  const stMap = new Map(MAIN_STATIONS.map((s) => [s, 0]));
  stMap.set('OTHER', 0);
  for (const x of agg.stationAgg) {
    const k = normalizeStation(x.station);
    stMap.set(k, (stMap.get(k) || 0) + x.cnt);
  }
  const pieOrder = [...MAIN_STATIONS, 'OTHER'];
  const pieStation = {
    labels: pieOrder.map((s) => (s === 'OTHER' ? 'Khác' : s)),
    values: pieOrder.map((s) => stMap.get(s) || 0),
  };

  return {
    range: { from: range.from, to: range.to, label: range.label },
    kpis,
    charts: { barDept, pieStation, deptVolume, retStoreDept },
  };
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
function buildDashboard(range, dept, cuvt, retStore, issuedNI, notRec, returned) {
  // --- KPI cards ---
  const kpis = {
    tatDeptAvg: round1(avg(dept, (d) => d.tat_days)),
    tatCuvtAvg: round1(avg(cuvt, (d) => d.tat_days)),
    tatReturnStoreAvg: round1(avg(retStore, (d) => d.tat_days)),
    countIssued: dept.length + notRec.length, // tong so thiet bi xuat kho (da/chua doi ung)
    countNotReconciled: notRec.length,
    countIssuedNotInstalled: issuedNI.length,
    reconcileRate:
      dept.length + notRec.length > 0
        ? round1((dept.length / (dept.length + notRec.length)) * 100)
        : 0,
  };

  // --- Bieu do cot: TAT trung binh theo tung don vi ---
  const byDept = groupAvg(dept, 'department', 'tat_days');
  const barDept = {
    labels: byDept.map((x) => x.key),
    values: byDept.map((x) => round1(x.avg)),
    counts: byDept.map((x) => x.count),
  };

  // --- TAT hoan kho trung binh theo Trung tam ---
  const byRet = groupAvg(retStore, 'department', 'tat_days');
  const retStoreDept = {
    labels: byRet.map((x) => x.key),
    values: byRet.map((x) => round1(x.avg)),
    counts: byRet.map((x) => x.count),
  };

  // --- Bieu do tron: phan bo thiet bi theo station (gom HAN/SGN/DAD + Khac) ---
  const stMap = new Map(MAIN_STATIONS.map((s) => [s, 0]));
  stMap.set('OTHER', 0);
  for (const r of dept) {
    const k = normalizeStation(r.station);
    stMap.set(k, (stMap.get(k) || 0) + 1);
  }
  const pieOrder = [...MAIN_STATIONS, 'OTHER'];
  const pieStation = {
    labels: pieOrder.map((s) => (s === 'OTHER' ? 'Khác' : s)),
    values: pieOrder.map((s) => stMap.get(s) || 0),
  };

  // --- Bieu do cot nhom: SO LUONG XUAT KHO va TRA UNSERVICE theo Trung tam ---
  //     Xuat kho = dept (da doi ung) + notRec (chua doi ung); tra US = returned.
  const issuedCnt = new Map();
  for (const r of [...dept, ...notRec]) {
    const k = r.department || 'PA';
    issuedCnt.set(k, (issuedCnt.get(k) || 0) + 1);
  }
  const returnedCnt = new Map();
  for (const r of returned || []) {
    const k = r.department || 'PA';
    returnedCnt.set(k, (returnedCnt.get(k) || 0) + 1);
  }
  const volLabels = [...new Set([...issuedCnt.keys(), ...returnedCnt.keys()])].sort(
    (a, b) => (issuedCnt.get(b) || 0) - (issuedCnt.get(a) || 0)
  );
  const deptVolume = {
    labels: volLabels,
    issued: volLabels.map((k) => issuedCnt.get(k) || 0),
    returned: volLabels.map((k) => returnedCnt.get(k) || 0),
  };

  return {
    range: { from: range.from, to: range.to, label: range.label },
    kpis,
    charts: { barDept, pieStation, deptVolume, retStoreDept },
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
// 7b. GHI LOG TRUY CAP (IP + ten may) - ghi ra file, 1 file/ngay
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Cache ket qua reverse-DNS (IP -> ten may) de khong tra cuu lai moi request.
// TTL 10 phut; loi/khong resolve duoc cung duoc cache (ghi 'N/A') de tranh
// tra cuu lai lien tuc cho cac IP khong co PTR record.
const hostnameCache = new Map(); // ip -> { name, t }
const HOSTNAME_CACHE_TTL = 10 * 60 * 1000;

function resolveHostname(ip) {
  const hit = hostnameCache.get(ip);
  if (hit && Date.now() - hit.t < HOSTNAME_CACHE_TTL) return Promise.resolve(hit.name);
  return new Promise((resolve) => {
    dns.reverse(ip, (err, hostnames) => {
      const name = !err && hostnames && hostnames.length ? hostnames[0] : 'N/A';
      hostnameCache.set(ip, { name, t: Date.now() });
      resolve(name);
    });
  });
}

/** Chuan hoa IP client (bo tien to IPv4-mapped-IPv6 "::ffff:"). */
function clientIp(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return ip.replace(/^::ffff:/, '') || 'unknown';
}

/**
 * Middleware ghi log truy cap: thoi gian, IP, ten may (reverse DNS), method,
 * duong dan, ma tra ve, thoi gian xu ly (ms). Moi ngay 1 file
 * logs/access-YYYY-MM-DD.log (dinh dang TSV, de mo bang Excel).
 * Ghi bat dong bo (khong chan response) va KHONG lam sap app neu ghi loi.
 */
function accessLogger(req, res, next) {
  const start = Date.now();
  const ip = clientIp(req);
  res.on('finish', () => {
    resolveHostname(ip)
      .then((hostname) => {
        const now = new Date();
        const day = now.toISOString().slice(0, 10);
        const line = [
          now.toISOString(),
          ip,
          hostname,
          req.method,
          req.originalUrl,
          res.statusCode,
          `${Date.now() - start}ms`,
        ].join('\t') + '\n';
        fs.appendFile(path.join(LOG_DIR, `access-${day}.log`), line, (err) => {
          if (err) console.error('[ACCESS-LOG] Loi ghi log:', err.message);
        });
      })
      .catch(() => {}); // khong de loi resolve DNS lam vo middleware
  });
  next();
}

// ---------------------------------------------------------------------------
// 8. EXPRESS APP + ROUTES
// ---------------------------------------------------------------------------
const app = express();
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(accessLogger); // ghi log IP + ten may cho MOI request (truoc static/API)
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

// --- CACHE bo nho (TTL) cho response API ---
//     Muc dich: doi tab / bam Ap dung lai / nhieu nguoi cung xem -> khong query lai DB.
//     Chi cache o che do LIVE; du lieu demo re nen khong can.
const apiCache = new Map(); // url -> { t: timestamp, data }
const CACHE_MAX_ENTRIES = 300;

/**
 * Boc route co cache theo URL day du (path + query string).
 * @param {number} ttlMs  thoi gian song cua cache (ms)
 */
function cached(ttlMs, fn) {
  return h(async (req, res) => {
    if (CONFIG.demoMode) return fn(req, res); // demo: khong cache
    const key = req.originalUrl;
    const hit = apiCache.get(key);
    if (hit && Date.now() - hit.t < ttlMs) {
      res.set('X-Cache', 'HIT');
      return res.json(hit.data);
    }
    // Chan res.json de luu ket qua vao cache truoc khi tra ve
    const origJson = res.json.bind(res);
    res.json = (data) => {
      if (!data || data.error !== true) {
        if (apiCache.size >= CACHE_MAX_ENTRIES) {
          apiCache.delete(apiCache.keys().next().value); // xoa entry cu nhat
        }
        apiCache.set(key, { t: Date.now(), data });
      }
      return origJson(data);
    };
    return fn(req, res);
  });
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
//     Cache 10 phut: danh muc it thay doi, do 3 lan DISTINCT scan moi luot mo trang.
app.get(
  '/api/filters',
  cached(10 * 60 * 1000, async (req, res) => {
    if (CONFIG.demoMode) return res.json(DEMO.filters());
    const stores = await query(
      `SELECT DISTINCT LTRIM(RTRIM([store])) AS v FROM [NQT].[dbo].[kho_ser1]
       WHERE [store] IS NOT NULL AND LTRIM(RTRIM([store])) <> '' ORDER BY v`
    );
    const departments = await query(
      `SELECT DISTINCT LTRIM(RTRIM([DEPARTMENT])) AS v FROM [DWH_DB]..[STG_AMOS].[SIGN]
       WHERE [DEPARTMENT] IS NOT NULL AND LTRIM(RTRIM([DEPARTMENT])) <> '' ORDER BY v`
    );
    res.json({
      // Chi 3 station chinh + Khac (OTHER = tat ca station con lai)
      stations: [...MAIN_STATIONS, 'OTHER'],
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
      // 0. TU TINH EPOCH: real_us1 co ca mutation (ngay AMOS) lan del_time (gio VN)
      //    cho CUNG 1 ban ghi -> cot implied_epoch = del_time - mutation ngay.
      //    Neu implied_epoch GIONG NHAU o moi dong => do la moc epoch dung.
      safe(
        'epochCalib',
        `SELECT TOP 12
           r.[mutation] AS mutation,
           r.[del_time] AS del_time,
           CAST(DATEADD(DAY, -TRY_CONVERT(int, TRY_CONVERT(float, r.[mutation])), CAST(r.[del_time] AS date)) AS date) AS implied_epoch,
           DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, r.[mutation])), TRY_CONVERT(datetime, @amosEpoch)) AS date_from_current_epoch
         FROM [NQT].[dbo].[real_us1] r
         WHERE r.[mutation] IS NOT NULL AND r.[del_time] IS NOT NULL
         ORDER BY r.[del_time] DESC`
      ),
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

// --- Dashboard tong hop (KPI + charts + rows) ---
//     Tra kem "rows" (chi tiet TAT) de frontend KHONG phai goi them
//     /api/tat/departments (tranh chay lai query nang 2 lan). Cache 60s.
app.get(
  '/api/dashboard',
  cached(60 * 1000, async (req, res) => {
    const range = resolveRange(req.query);
    const f = readFilters(req.query);
    if (CONFIG.demoMode) {
      const d = DEMO.dashboard(range, f);
      d.rows = DEMO.tatDepartments(range, f);
      return res.json(d);
    }

    // KPI/bieu do: SQL aggregate tren TOAN BO du lieu (khong bi cat boi TOP);
    // rows: chi de hien bang chi tiet (co the bi gioi han @maxRows).
    const [agg, rows] = await Promise.all([qDashboardAgg(range, f), qTatDepartments(range, f)]);
    const out = buildDashboardFromAgg(range, agg);
    out.rows = rows;
    res.json(out);
  })
);

// --- Bang du lieu chi tiet TAT theo don vi (van giu endpoint rieng) ---
app.get(
  '/api/tat/departments',
  cached(60 * 1000, async (req, res) => {
    const range = resolveRange(req.query);
    const f = readFilters(req.query);
    const data = CONFIG.demoMode ? DEMO.tatDepartments(range, f) : await qTatDepartments(range, f);
    res.json({ rows: data, count: data.length });
  })
);

app.get(
  '/api/tat/cuvt',
  cached(60 * 1000, async (req, res) => {
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
  'returned-unservice': { live: qReturnedUnservice, demo: 'returnedUnservice' },
  'not-reconciled': { live: qNotReconciled, demo: 'notReconciled' },
  'removed-before-installed': { live: qRemovedBeforeInstalled, demo: 'removedBeforeInstalled' },
  other: { live: qOther, demo: 'other' },
  'return-store-tat': { live: qTatReturnStore, demo: 'returnStoreTat' },
};

app.get(
  '/api/reports/:name',
  cached(60 * 1000, async (req, res) => {
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
