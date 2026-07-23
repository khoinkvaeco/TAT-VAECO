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
const { execFile } = require('child_process');
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
  // IP duoc phep vao trang ADMIN (localhost + IP quan tri). Cau hinh qua .env
  // ADMIN_IPS (danh sach, ngan cach dau phay). Localhost luon duoc phep.
  adminIps: (process.env.ADMIN_IPS || '10.99.89.120')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // Cache bang SIGN (Oracle linked server DWH_DB) vao bang local NQT.dbo.SIGN_CACHE
  // de moi query khong phai keo qua linked server (cham). Tu lam moi dinh ky.
  signCache: String(process.env.SIGN_CACHE || 'true').toLowerCase() !== 'false',
  signCacheMinutes: parseInt(process.env.SIGN_CACHE_MINUTES || '360', 10), // mac dinh 6h
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
// 2b. CACHE BANG SIGN VE BANG LOCAL (tang toc: bo truy van linked server Oracle)
//     Moi lan load dashboard co ~10 luot join SIGN; truoc day moi luot deu keo
//     [DWH_DB]..[STG_AMOS].[SIGN] qua linked server -> rat cham. Nay:
//       - Dinh ky do SIGN (da GROUP BY USER_SIGN) vao bang local
//         [NQT].[dbo].[SIGN_CACHE] (co clustered index theo USER_SIGN).
//       - signJoin() se join bang local; neu chua/refresh loi -> tu dong
//         fallback ve join linked server truc tiep nhu cu (khong hong app).
//     Ky thuat: keo ve #temp truoc (chi la READ tu linked server, khong can
//     MSDTC), roi TRUNCATE + INSERT local -> khong co distributed transaction.
// ---------------------------------------------------------------------------
let signCacheReady = false;

async function refreshSignCache() {
  if (CONFIG.demoMode || !CONFIG.signCache) return;
  try {
    await query(`
      SELECT [USER_SIGN], MAX([DEPARTMENT]) AS [DEPARTMENT]
      INTO #sign_new
      FROM [DWH_DB]..[STG_AMOS].[SIGN]
      GROUP BY [USER_SIGN];

      IF OBJECT_ID('[NQT].[dbo].[SIGN_CACHE]', 'U') IS NULL
      BEGIN
        SELECT [USER_SIGN], [DEPARTMENT] INTO [NQT].[dbo].[SIGN_CACHE] FROM #sign_new;
        CREATE CLUSTERED INDEX [IX_SIGN_CACHE_USER] ON [NQT].[dbo].[SIGN_CACHE]([USER_SIGN]);
      END
      ELSE
      BEGIN
        TRUNCATE TABLE [NQT].[dbo].[SIGN_CACHE];
        INSERT INTO [NQT].[dbo].[SIGN_CACHE] ([USER_SIGN], [DEPARTMENT])
        SELECT [USER_SIGN], [DEPARTMENT] FROM #sign_new;
      END`);
    signCacheReady = true;
    console.log(`[SIGN] Da lam moi SIGN_CACHE (chu ky ${CONFIG.signCacheMinutes} phut).`);
  } catch (err) {
    // Khong co quyen tao bang / linked server loi -> dung duong cu (linked server)
    signCacheReady = false;
    console.warn('[SIGN] Khong lam moi duoc SIGN_CACHE, tam dung linked server truc tiep:', err.message);
  }
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
  // Uu tien bang cache local (nhanh, co index) - xem refreshSignCache().
  if (signCacheReady) {
    return `LEFT JOIN [NQT].[dbo].[SIGN_CACHE] ${alias} ON ${alias}.[USER_SIGN] = ${staffCol}`;
  }
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

/**
 * Dieu kien "Bo qua xuat costcenter" (checkbox tren dashboard).
 * Loai cac phieu xuat co receiver LA SO: dung 2 chu so ('15') hoac so thuan
 * (chi gom chu so va dau . , - vi du '1234', '12.5') - day la xuat cho
 * costcenter, khong phai xuat cho tau (so tau co chu cai, vi du 'VN-A868').
 * @param f     filter tu readFilters() (dung f.excludeCC)
 * @param alias alias bang kho_ser1 chua cot [receiver] (vd 'k' hoac 't')
 */
function excludeCostcenterClause(f, alias) {
  if (!f.excludeCC) return '';
  const rcv = `LTRIM(RTRIM(ISNULL(${alias}.[receiver], '')))`;
  // "la so" = co it nhat 1 chu so VA khong chua ky tu nao ngoai 0-9 . ,
  return ` AND NOT (${rcv} LIKE '%[0-9]%' AND ${rcv} NOT LIKE '%[^0-9.,]%')`;
}

// ---------------------------------------------------------------------------
// 3b. DOI UNG KIEU "TRA SERVICE" (RECERTIFY) QUA on_off
//     Chuoi su kien cua 1 phieu xuat (kho_ser1 k):
//       - Thiet bi (labelno) da LAP len tau: on_off vm='YE', higher_par IS NULL
//       - Sau do THAO xuong:                 on_off vm='YA' (cung labelno)
//       - Va duoc RECERTIFY tai shop:        on_off vm='CI', location='SHOPLOC',
//         lien ket voi YA qua (psn, orderno) -> chuyen thanh SERVICEABLE.
//     Thiet bi nay KHONG co dong tra unservice (real_us1) nhung van la DA DOI
//     UNG ("tra service"); thoi diem tra = gio recertify (CI).
//     LUU Y: on_off.[mut_t] la cot datetime GIO VN co san -> dung truc tiep,
//     khong can quy doi mutation/mutation_t.
// ---------------------------------------------------------------------------

/** CROSS APPLY lay lan recertify DAU TIEN sau gio xuat kho cua phieu xuat.
 *  Tra ve rc.removal_time (gio thao YA), rc.recert_time (gio CI) va
 *  rc.partno_off / rc.serialno_off (thiet bi THAO xuong - tu dong YA). */
function recertApply(kAlias) {
  return `
    CROSS APPLY (
      SELECT TOP 1
        t1.[partno]   AS partno_off,
        t1.[serialno] AS serialno_off,
        t1.[mut_t]    AS removal_time,
        t2.[mut_t]    AS recert_time
      FROM [NQT].[dbo].[on_off] t1
      INNER JOIN [NQT].[dbo].[on_off] t2
        ON t2.[psn] = t1.[psn] AND t2.[orderno] = t1.[orderno]
       AND t2.[vm] = 'CI' AND t2.[location] = 'SHOPLOC'
      WHERE t1.[vm] = 'YA'
        AND t1.[labelno] = ${kAlias}.[labelno]
        AND t2.[mut_t] > ${amosToVN(kAlias)}   -- CI phai SAU gio xuat kho
      ORDER BY t2.[mut_t] ASC, t1.[mut_t] ASC  -- lan recertify dau tien
    ) rc`;
}

/** CHONG TRUNG LAP cho cap XUAT <-> TRA US (alias co dinh: k = kho_ser1,
 *  r = real_us1). 1 cap (labelno, voucher) co the co NHIEU dong booking
 *  (lich su T cu con sot / dong tra ghi nhieu lan) -> join nhan ban dong
 *  va dinh ca phieu xuat cu (vd xuat 28/02 ghep tra 12/07 trong khi da co
 *  dong doi ung dung). Quy tac:
 *   1) phieu xuat phai TRUOC gio tra US;
 *   2) nhieu dong T cung (labelno, voucherno) -> chi lay dong XUAT GAN NHAT
 *      truoc gio tra (nguyen tac "lay ngay xuat gan nhat");
 *   3) nhieu dong tra cung (labelno, voucher_s) -> chi lay dong tra MOI NHAT
 *      (del_time lon nhat; hoa thi historyno_ lon nhat). */
function usPairDedup() {
  return `
      AND ${amosToVN('k')} < r.[del_time]
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[kho_ser1] k2
        WHERE k2.[vm] = 'T' AND k2.[labelno] = k.[labelno]
          AND k2.[voucherno] = k.[voucherno]
          AND ${amosToVN('k2')} < r.[del_time]
          AND (k2.[mutation] > k.[mutation]
               OR (k2.[mutation] = k.[mutation] AND k2.[mutation_t] > k.[mutation_t])))
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[real_us1] r3
        WHERE r3.[labelno] = r.[labelno] AND r3.[voucher_s] = r.[voucher_s]
          AND (r3.[del_time] > r.[del_time]
               OR (r3.[del_time] = r.[del_time] AND r3.[historyno_] > r.[historyno_])))`;
}

/** Phieu xuat CHUA bi huy/hoan kho: khong co dong TC voucher 'P-CA-<so PS>'
 *  CUNG SO PHIEU + labelno (TRANSFER CANCELLED trong AMOS). */
function issueNotCancelled(a) {
  return `NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
        WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
          AND tc.[labelno] = ${a}.[labelno]
          AND RTRIM(tc.[voucherno]) = 'P-CA-' + SUBSTRING(RTRIM(${a}.[voucherno]), 3, 50))`;
}

/** Dieu kien bo sung cho nhanh TRA SERVICE (dat SAU recertApply -> co rc.*):
 *  (1) phieu xuat chua bi huy (TRANSFER CANCELLED) - phieu huy khong tinh TAT;
 *  (2) chi ghep lan recertify (CI) voi PHIEU XUAT GAN NHAT truoc gio CI:
 *      1 thiet bi (labelno) xuat nhieu lan -> chi lan xuat moi nhat duoc tinh,
 *      tranh ghep CI moi voi phieu xuat cu lam TAT phong dai (215+ ngay). */
function svcLatestIssueOnly(kAlias) {
  return `
      AND ${issueNotCancelled(kAlias)}
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[kho_ser1] k2
        WHERE k2.[vm] = 'T' AND k2.[voucherno] LIKE 'P-%'
          AND k2.[labelno] = ${kAlias}.[labelno]
          AND ${amosToVN('k2')} > ${amosToVN(kAlias)}   -- phieu xuat MOI HON
          AND ${amosToVN('k2')} < rc.recert_time        -- van truoc gio CI
          AND ${issueNotCancelled('k2')})`;
}

/** Dieu kien: phieu xuat da duoc doi ung kieu TRA SERVICE (recertify).
 *  Tra ve bieu thuc boolean co ngoac -> co the dung voi NOT (...) . */
function recertExists(kAlias) {
  return `(
    EXISTS (
      SELECT 1
      FROM [NQT].[dbo].[on_off] t1
      INNER JOIN [NQT].[dbo].[on_off] t2
        ON t2.[psn] = t1.[psn] AND t2.[orderno] = t1.[orderno]
       AND t2.[vm] = 'CI' AND t2.[location] = 'SHOPLOC'
      WHERE t1.[vm] = 'YA'
        AND t1.[labelno] = ${kAlias}.[labelno]
        AND t2.[mut_t] > ${amosToVN(kAlias)}
    )
    AND EXISTS (
      SELECT 1 FROM [NQT].[dbo].[on_off] t3
      WHERE t3.[labelno] = ${kAlias}.[labelno]
        AND t3.[vm] = 'YE' AND t3.[higher_par] IS NULL
    )
  )`;
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
  // amosDayParams: loc tho sargable theo [mutation] cho nhanh "tra service"
  // (nhanh nay xet PHIEU XUAT trong ky, khong quet toan bo lich su)
  const params = { from: range.from, to: range.to, tzOffset: CONFIG.tzOffset, top: CONFIG.maxRows, ...amosDayParams(range) };
  // Trung tam: real_us1.department -> mutator('PA'/SIGN) -> 'PA'.
  const dept = deptFromReal('r', 'sm');
  let where = buildFilterClause(
    f,
    { station: 'k.[station]', store: 'k.[store]', department: dept },
    params
  );
  // Nhanh "tra service" (recertify): khong co dong real_us1 -> Trung tam tra
  // theo nguoi lap phieu xuat (created_b2), giong cac bao cao kho_ser1 khac.
  const deptSvc = deptFromStaff('k.[created_b2]', 'sm');
  const whereSvc = buildFilterClause(
    f,
    { station: 'k.[station]', store: 'k.[store]', department: deptSvc },
    params
  );
  const text = `
    SELECT TOP (@top) u.* FROM (
    -- (1) DOI UNG TRA UNSERVICE: kho_ser1 <-> real_us1 (nhu truoc)
    SELECT
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
      ye.install_time                        AS installed_time_vn,   -- ngay lap len tau
      ya.removal_time                        AS removed_time_vn,     -- ngay thao tu tau
      r.[del_time]                           AS return_unservice_time,
      -- TAT tong (xuat kho -> tra US) giu nguyen de tham khao
      CAST(DATEDIFF(MINUTE, ${amosToVN('k')}, r.[del_time]) AS float) / 1440.0 AS tat_days,
      -- TAT_install = lap len tau - xuat kho (trong neu chua tim thay lan lap)
      CAST(DATEDIFF(MINUTE, ${amosToVN('k')}, ye.install_time) AS float) / 1440.0 AS tat_install_days,
      -- TAT_US_return = tra US - thao tu tau (trong neu khong co su kien thao)
      CAST(DATEDIFF(MINUTE, ya.removal_time, r.[del_time]) AS float) / 1440.0 AS tat_usreturn_days,
      'US' AS return_type
    FROM [NQT].[dbo].[kho_ser1] k
    INNER JOIN [NQT].[dbo].[real_us1] r
      ON k.[labelno] = r.[labelno]
      AND k.[voucherno] = r.[voucher_s]
    -- Su kien LAP: lan YE DAU TIEN cung labelno SAU gio xuat kho
    OUTER APPLY (
      SELECT TOP 1 ${amosToVN('o')} AS install_time
      FROM [NQT].[dbo].[on_off] o
      WHERE o.[labelno] = k.[labelno] AND o.[vm] = 'YE'
        AND ${amosToVN('o')} > ${amosToVN('k')}
      ORDER BY o.[mutation] ASC, o.[mutation_t] ASC
    ) ye
    -- Su kien THAO: on_off YA khop CHINH XAC historyno_ cua dong tra US
    OUTER APPLY (
      SELECT TOP 1 ${amosToVN('o')} AS removal_time
      FROM [NQT].[dbo].[on_off] o
      WHERE o.[historyno_] = r.[historyno_] AND o.[vm] = 'YA'
      ORDER BY o.[mutation] ASC, o.[mutation_t] ASC
    ) ya
    ${signJoin('r.[action_per]', 'sm')}
    WHERE k.[vm] = 'T'
      AND k.[voucherno] LIKE 'P-%'
      -- Bo qua ban ghi receiver rong; bo qua costcenter 'VN-SPL'
      AND LTRIM(RTRIM(ISNULL(k.[receiver], ''))) <> ''
      AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')  -- bo qua store MAIN/3RD
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'  -- bo qua condition US
      AND r.[del_time] >= @from AND r.[del_time] < @to
      ${usPairDedup()}
      ${excludeCostcenterClause(f, 'k')}
      ${where}

    UNION ALL

    -- (2) DOI UNG TRA SERVICE (recertify): khong co real_us1; thiet bi thao (YA)
    --     duoc recertify (CI @SHOPLOC) -> "tra" = gio recertify (rc.recert_time)
    SELECT
      k.[event_perf], k.[partno], k.[serialno], k.[labelno], k.[descriptio],
      k.[receiver], k.[station], k.[store1],
      k.[voucherno], k.[picking_li],
      rc.[partno_off],                   -- thiet bi thao (tu dong YA cua chuoi recertify)
      rc.[serialno_off],
      k.[created_b2],                    -- staff = nguoi lap phieu xuat
      ${deptSvc},
      ${amosToVN('k')},
      ye.install_time,
      rc.removal_time,                   -- ngay thao (YA cua chuoi recertify)
      rc.recert_time,                    -- "ngay tra" = gio recertify CI
      CAST(DATEDIFF(MINUTE, ${amosToVN('k')}, rc.recert_time) AS float) / 1440.0,
      CAST(DATEDIFF(MINUTE, ${amosToVN('k')}, ye.install_time) AS float) / 1440.0,
      CAST(DATEDIFF(MINUTE, rc.removal_time, rc.recert_time) AS float) / 1440.0,
      'SERVICE'
    FROM [NQT].[dbo].[kho_ser1] k
    ${recertApply('k')}
    OUTER APPLY (
      SELECT TOP 1 ${amosToVN('o')} AS install_time
      FROM [NQT].[dbo].[on_off] o
      WHERE o.[labelno] = k.[labelno] AND o.[vm] = 'YE'
        AND ${amosToVN('o')} > ${amosToVN('k')}
      ORDER BY o.[mutation] ASC, o.[mutation_t] ASC
    ) ye
    ${signJoin('k.[created_b2]', 'sm')}
    WHERE k.[vm] = 'T'
      AND k.[voucherno] LIKE 'P-%'
      AND LTRIM(RTRIM(ISNULL(k.[receiver], ''))) <> ''
      AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'
      -- CHI XET tap "CHUA DOI UNG TRONG KY" (nhu bao cao Chua doi ung):
      -- phieu xuat trong ky, chua tra US, chua hoan kho, khong phai CUVT.
      -- KHONG quet toan bo lich su phieu xuat.
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[real_us1] r2
        WHERE r2.[labelno] = k.[labelno] AND r2.[voucher_s] = k.[voucherno])
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
        WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
          AND tc.[partno] = k.[partno] AND tc.[serialno] = k.[serialno] AND tc.[labelno] = k.[labelno])
      AND ${deptSvc} <> 'CUVT'
      -- Thiet bi phai co su kien LAP (YE, higher_par NULL) - theo T3 cua SQL goc
      AND EXISTS (
        SELECT 1 FROM [NQT].[dbo].[on_off] t3
        WHERE t3.[labelno] = k.[labelno] AND t3.[vm] = 'YE' AND t3.[higher_par] IS NULL)
      -- Ky bao cao = PHIEU XUAT trong ky (mutation loc tho theo index truoc)
      AND k.[mutation] BETWEEN @fromDay AND @toDay
      AND ${amosToVN('k')} >= @from AND ${amosToVN('k')} < @to
      ${svcLatestIssueOnly('k')}
      ${excludeCostcenterClause(f, 'k')}
      ${whereSvc}
    ) u
    ORDER BY u.tat_days DESC`;
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
      ON k.[labelno] = o.[labelno]
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
        WHERE r2.[labelno] = k.[labelno]
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
      COALESCE(NULLIF(NULLIF(LTRIM(RTRIM(r.department)), ''), 'UNKNOWN'),
         CASE WHEN LEFT(LTRIM(RTRIM(r.action_per)), 2) = 'PA' THEN 'PA' END,
         NULLIF(NULLIF(LTRIM(RTRIM(sm.DEPARTMENT)), ''), 'UNKNOWN'),
         'PA')  AS trung_tam,
      ${amosToVN('o')} AS removed_time_vn
    FROM [NQT].[dbo].[on_off] o
    LEFT JOIN [NQT].[dbo].[real_us1] r
      ON o.[labelno] = r.[labelno]   -- so sanh so truc tiep (cot so; RTRIM lam float->chuoi 6 chu so -> ghep nham)
    LEFT JOIN [DWH_DB]..[STG_AMOS].ROTABLES RO ON o.PSN = RO.PSN
    ${signJoin('o.[created_by]', 'sm')}
    WHERE o.[vm] = 'YA' AND RO.MUTATION > @fromDay and RO.condition ='US'
      AND r.[historyno_] IS NULL
      AND o.higher_par IS NULL
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
      AND ${dept} <> 'CUVT'   -- khong tinh doi ung khi xuat kho cho CUVT
      AND r.[partno] IS NULL
      -- Bo qua neu thiet bi da duoc hoan kho (P-CA-...)
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
        WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
          AND tc.[partno] = k.[partno]
          AND tc.[serialno] = k.[serialno]
          AND tc.[labelno] = k.[labelno]
      )
      -- Bo qua neu da doi ung kieu TRA SERVICE (thao YA -> recertify CI @SHOPLOC)
      AND NOT ${recertExists('k')}
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
 *   [0] TAT theo Trung tam (2 thanh phan): department, cnt,
 *       avg_install/cnt_install (lap-xuat), avg_usret/cnt_usret (traUS-thao)
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

  // Dieu kien loc chung cua kho_ser1 (giong cac query chi tiet).
  // Kem dieu kien "Bo qua xuat costcenter" (neu checkbox bat) cho MOI subquery
  // dua tren phieu xuat kho_ser1 (alias k) -> KPI + bieu do dong nhat.
  const khoBase = `k.[vm] = 'T' AND k.[voucherno] LIKE 'P-%'
      AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'
      ${excludeCostcenterClause(f, 'k')}`;

  const wDept = buildFilterClause(f, { station: 'k.[station]', store: 'k.[store]', department: deptR }, params);
  const wCuvt = buildFilterClause(f, { station: 'r.[station]', store: 'r.[store]', department: deptR }, params);
  const wRet = buildFilterClause(f, { station: 'tc.[station]', store: 'tc.[store]', department: deptT }, params);
  const wNotRec = buildFilterClause(f, { station: 'k.[station]', store: 'k.[store]', department: deptK }, params);
  const wRetUS = buildFilterClause(f, { station: 'r.[station]', store: 'r.[store]', department: deptR }, params);
  const wNI = buildFilterClause(f, { station: 'k.[station]', store: 'k.[store]', department: deptK }, params);
  // Nhanh "tra service": dept theo created_b2 (khong co real_us1)
  const wSvc = buildFilterClause(f, { station: 'k.[station]', store: 'k.[store]', department: deptK }, params);

  // Dieu kien chung cua nhanh TRA SERVICE (dung trong [0] va [6]).
  // CHI XET tap "CHUA DOI UNG TRONG KY" (phieu xuat trong ky, chua tra US,
  // chua hoan kho, khong phai CUVT) - KHONG quet toan bo lich su phieu xuat.
  // + phieu chua bi huy & la PHIEU XUAT GAN NHAT truoc gio CI (svcLatestIssueOnly).
  const svcWhere = `
      AND LTRIM(RTRIM(ISNULL(k.[receiver], ''))) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[real_us1] r2
        WHERE r2.[labelno] = k.[labelno] AND r2.[voucher_s] = k.[voucherno])
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
        WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
          AND tc.[partno] = k.[partno] AND tc.[serialno] = k.[serialno] AND tc.[labelno] = k.[labelno])
      AND ${deptK} <> 'CUVT'
      AND EXISTS (
        SELECT 1 FROM [NQT].[dbo].[on_off] t3
        WHERE t3.[labelno] = k.[labelno] AND t3.[vm] = 'YE' AND t3.[higher_par] IS NULL)
      AND k.[mutation] BETWEEN @fromDay AND @toDay
      AND ${amosToVN('k')} >= @from AND ${amosToVN('k')} < @to
      ${svcLatestIssueOnly('k')}
      ${wSvc}`;

  const text = `
    -- [0] TAT theo Trung tam (toan bo, khong TOP) - TACH 2 THANH PHAN:
    --     tat_install = lap len tau (YE dau tien cung labelno SAU gio xuat) - gio xuat kho
    --     tat_usret   = tra US (del_time) - thao tu tau (YA khop historyno_)
    --     AVG() tu bo qua NULL -> dong thieu su kien lap/thao KHONG tinh vao TB.
    SELECT x.department, COUNT(*) AS cnt,
           AVG(x.tat_install) AS avg_install, COUNT(x.tat_install) AS cnt_install,
           AVG(x.tat_usret)   AS avg_usret,   COUNT(x.tat_usret)   AS cnt_usret
    FROM (
      SELECT ${deptR} AS department,
             CAST(DATEDIFF(MINUTE, ${amosToVN('k')}, ye.install_time) AS float) / 1440.0 AS tat_install,
             CAST(DATEDIFF(MINUTE, ya.removal_time, r.[del_time]) AS float) / 1440.0    AS tat_usret
      FROM [NQT].[dbo].[kho_ser1] k
      INNER JOIN [NQT].[dbo].[real_us1] r
        ON k.[labelno] = r.[labelno] AND k.[voucherno] = r.[voucher_s]
      OUTER APPLY (
        SELECT TOP 1 ${amosToVN('o')} AS install_time
        FROM [NQT].[dbo].[on_off] o
        WHERE o.[labelno] = k.[labelno] AND o.[vm] = 'YE'
          AND ${amosToVN('o')} > ${amosToVN('k')}
        ORDER BY o.[mutation] ASC, o.[mutation_t] ASC
      ) ye
      OUTER APPLY (
        SELECT TOP 1 ${amosToVN('o')} AS removal_time
        FROM [NQT].[dbo].[on_off] o
        WHERE o.[historyno_] = r.[historyno_] AND o.[vm] = 'YA'
        ORDER BY o.[mutation] ASC, o.[mutation_t] ASC
      ) ya
      ${signJoin('r.[action_per]', 'sm')}
      WHERE ${khoBase}
        AND LTRIM(RTRIM(ISNULL(k.[receiver], ''))) <> ''
        AND r.[del_time] >= @from AND r.[del_time] < @to
        ${usPairDedup()}
        ${wDept}

      UNION ALL

      -- Nhanh TRA SERVICE (recertify): tat_usret = gio CI - gio thao YA
      SELECT ${deptK} AS department,
             CAST(DATEDIFF(MINUTE, ${amosToVN('k')}, ye.install_time) AS float) / 1440.0 AS tat_install,
             CAST(DATEDIFF(MINUTE, rc.removal_time, rc.recert_time) AS float) / 1440.0   AS tat_usret
      FROM [NQT].[dbo].[kho_ser1] k
      ${recertApply('k')}
      OUTER APPLY (
        SELECT TOP 1 ${amosToVN('o')} AS install_time
        FROM [NQT].[dbo].[on_off] o
        WHERE o.[labelno] = k.[labelno] AND o.[vm] = 'YE'
          AND ${amosToVN('o')} > ${amosToVN('k')}
        ORDER BY o.[mutation] ASC, o.[mutation_t] ASC
      ) ye
      ${signJoin('k.[created_b2]', 'sm')}
      WHERE ${khoBase}
        ${svcWhere}
    ) x
    GROUP BY x.department;

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
      ${excludeCostcenterClause(f, 't')}
      AND ${deptT} <> 'CUVT'   -- khong tinh TAT hoan kho cho CUVT
      AND tc.[mutation] BETWEEN @fromDay AND @toDay
      AND ${amosToVN('tc')} >= @from AND ${amosToVN('tc')} < @to
      ${wRet}
    GROUP BY ${deptT};

    -- [3] Chua doi ung theo Trung tam
    SELECT ${deptK} AS department, COUNT(*) AS cnt
    FROM [NQT].[dbo].[kho_ser1] k
    LEFT JOIN [NQT].[dbo].[real_us1] r
      ON k.[labelno] = r.[labelno] AND k.[voucherno] = r.[voucher_s]
    ${signJoin('k.[created_b2]', 'sm')}
    WHERE ${khoBase} AND ${deptK} <> 'CUVT'
      AND r.[partno] IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
        WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
          AND tc.[partno] = k.[partno] AND tc.[serialno] = k.[serialno] AND tc.[labelno] = k.[labelno])
      -- Bo qua neu da doi ung kieu TRA SERVICE (recertify)
      AND NOT ${recertExists('k')}
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
        WHERE r2.[labelno] = k.[labelno] AND r2.[voucher_s] = k.[voucherno])
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
        WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
          AND tc.[partno] = k.[partno] AND tc.[serialno] = k.[serialno] AND tc.[labelno] = k.[labelno])
      AND k.[mutation] BETWEEN @fromDay AND @toDay
      AND ${amosToVN('k')} >= @from AND ${amosToVN('k')} < @to
      ${wNI};

    -- [6] Phan bo station cua tap da doi ung (tra unservice + tra service)
    SELECT s.station AS station, COUNT(*) AS cnt
    FROM (
      SELECT k.[station] AS station
      FROM [NQT].[dbo].[kho_ser1] k
      INNER JOIN [NQT].[dbo].[real_us1] r
        ON k.[labelno] = r.[labelno] AND k.[voucherno] = r.[voucher_s]
      ${signJoin('r.[action_per]', 'sm')}
      WHERE ${khoBase}
        AND LTRIM(RTRIM(ISNULL(k.[receiver], ''))) <> ''
        AND r.[del_time] >= @from AND r.[del_time] < @to
        ${usPairDedup()}
        ${wDept}
      UNION ALL
      SELECT k.[station]
      FROM [NQT].[dbo].[kho_ser1] k
      ${recertApply('k')}
      ${signJoin('k.[created_b2]', 'sm')}
      WHERE ${khoBase}
        ${svcWhere}
    ) s
    GROUP BY s.station;`;

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

  // Trung binh co trong so theo so dong CO du lieu (AVG da bo NULL trong SQL)
  const wavgBy = (arr, avgField, cntField) => {
    const c = sum(arr, (x) => x[cntField]);
    return c ? sum(arr, (x) => (x[avgField] || 0) * x[cntField]) / c : 0;
  };

  const reconciled = sum(agg.deptAgg, (x) => x.cnt);
  const notRec = sum(agg.notRecAgg, (x) => x.cnt);

  // KHONG tinh TAT install / US return cho CUVT (TAT cua CUVT do rieng bang
  // KPI "TAT CUVT" = reci - del). Chi loai khoi TRUNG BINH TAT + bieu do cot;
  // cac so dem (Thiet bi xuat kho, Ty le doi ung, phan bo...) van giu CUVT.
  const deptTat = agg.deptAgg.filter(
    (x) => String(x.department || '').trim().toUpperCase() !== 'CUVT'
  );

  // So luong CUVT: reci = so thiet bi da NHAN (real_us1.reci_time hop le, cuvtAgg.cnt);
  // del = tong so thiet bi da GIAO/tra unservice trong ky (real_us1.del_time,
  // = tong retUSAgg.cnt - cung dieu kien filter voi cuvtAgg nen so sanh duoc truc tiep).
  const cntReci = agg.cuvtAgg?.cnt || 0;
  const cntDel = sum(agg.retUSAgg, (x) => x.cnt);

  const kpis = {
    // TAT tach 2 thanh phan (thay cho TAT TB tong truoc day) - KHONG gom CUVT
    tatInstallAvg: round1(wavgBy(deptTat, 'avg_install', 'cnt_install')),
    tatUsReturnAvg: round1(wavgBy(deptTat, 'avg_usret', 'cnt_usret')),
    tatCuvtAvg: round1(agg.cuvtAgg?.avg_tat || 0),
    tatReturnStoreAvg: round1(wavg(agg.retAgg)),
    countIssued: reconciled + notRec,
    countNotReconciled: notRec,
    countIssuedNotInstalled: agg.niAgg?.cnt || 0,
    reconcileRate: reconciled + notRec ? round1((reconciled / (reconciled + notRec)) * 100) : 0,
    cntReci,
    cntDel,
  };

  // Bieu do cot theo Trung tam: 2 series (install / US return) - KHONG gom CUVT
  const byDept = [...deptTat].sort((a, b) => (b.avg_install || 0) - (a.avg_install || 0));
  const barDept = {
    labels: byDept.map((x) => x.department),
    install: byDept.map((x) => round1(x.avg_install)),
    usret: byDept.map((x) => round1(x.avg_usret)),
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
const chatbot = require('./chatbot');
const llm = require('./llm');

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

/** Reverse-DNS (PTR record) - chi hoat dong neu DNS noi bo co khai bao PTR. */
function dnsReverseLookup(ip) {
  return new Promise((resolve) => {
    dns.reverse(ip, (err, hostnames) => {
      resolve(!err && hostnames && hostnames.length ? hostnames[0] : null);
    });
  });
}

/**
 * Tra ten may qua NETBIOS (lenh `nbtstat -A <ip>`, chi co tren Windows).
 * KHONG phu thuoc DNS - hoi truc tiep may client qua UDP 137, thuong hoat
 * dong ngay ca khi mang LAN chua khai bao PTR record (truong hop pho bien
 * o mang noi bo Windows). Chi dung khi reverse-DNS that bai.
 * >>> Chi hieu qua neu server chay tren Windows VA client cung mang/broadcast
 *     domain co bat NetBIOS over TCP/IP (mac dinh bat tren hau het may Windows). <<<
 */
function nbtstatLookup(ip) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('nbtstat', ['-A', ip], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      // Dong "<TEN_MAY>  <20>  UNIQUE" (Workstation Service) la ten may that;
      // du phong sang <00> UNIQUE (Workstation/Computer Name) neu khong co <20>.
      const m =
        stdout.match(/^\s*(\S+)\s*<20>\s*UNIQUE/m) || stdout.match(/^\s*(\S+)\s*<00>\s*UNIQUE/m);
      resolve(m ? m[1] : null);
    });
  });
}

/** Tra ten may: uu tien reverse-DNS, that bai thi thu NetBIOS (Windows), cuoi cung 'N/A'. */
function resolveHostname(ip) {
  const hit = hostnameCache.get(ip);
  if (hit && Date.now() - hit.t < HOSTNAME_CACHE_TTL) return Promise.resolve(hit.name);
  return dnsReverseLookup(ip)
    .then((name) => name || nbtstatLookup(ip))
    .catch(() => null)
    .then((name) => {
      const final = name || 'N/A';
      hostnameCache.set(ip, { name: final, t: Date.now() });
      return final;
    });
}

/** Chuan hoa IP client (bo tien to IPv4-mapped-IPv6 "::ffff:"). */
function clientIp(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return ip.replace(/^::ffff:/, '') || 'unknown';
}

// --- Han che truy cap trang ADMIN theo IP (localhost + danh sach ADMIN_IPS) ---
const LOCALHOST_IPS = ['127.0.0.1', '::1', 'localhost', '0.0.0.0'];
function isAdminAllowed(ip) {
  return LOCALHOST_IPS.includes(ip) || CONFIG.adminIps.includes(ip);
}
/** Duong dan thuoc khu vuc ADMIN (trang + API). */
function isAdminPath(p) {
  return p === '/admin' || p === '/admin.html' || p.startsWith('/api/admin');
}
/**
 * Middleware chan truy cap admin tu IP la. Ghi CANH BAO ra console +
 * logs/admin-access-YYYY-MM-DD.log (ke ca truy cap hop le lan bi tu choi).
 */
function adminGuard(req, res, next) {
  if (!isAdminPath(req.path)) return next();
  // Dung IP SOCKET that (khong tin x-forwarded-for) -> chong gia mao header.
  // Neu chay sau reverse proxy, them IP proxy vao ADMIN_IPS hoac bo proxy.
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
  const allowed = isAdminAllowed(ip);
  const day = new Date().toISOString().slice(0, 10);
  const vn = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const line = [vn, ip, allowed ? 'ALLOW' : 'DENY', req.method, req.originalUrl].join('\t') + '\n';
  fs.appendFile(path.join(LOG_DIR, `admin-access-${day}.log`), line, () => {});
  if (!allowed) {
    console.warn(`[ADMIN] ⚠ CANH BAO: IP la ${ip} thu truy cap trang admin (${req.originalUrl}) -> TU CHOI`);
    res.status(403);
    if (req.path.startsWith('/api/')) {
      return res.json({ error: true, code: 'ADMIN_FORBIDDEN', message: `Truy cap bi tu choi. IP ${ip} khong nam trong danh sach quan tri.` });
    }
    return res.type('html').send(
      `<!doctype html><meta charset="utf-8"><div style="font-family:system-ui;max-width:640px;margin:60px auto;padding:24px;border:1px solid #fecaca;background:#fef2f2;border-radius:12px;color:#991b1b">
      <h2 style="margin:0 0 8px">⛔ Truy cập bị từ chối</h2>
      <p>Trang quản trị này chỉ cho phép truy cập từ máy quản trị.</p>
      <p style="font-size:13px;color:#7f1d1d">IP của bạn: <b>${ip}</b> — không nằm trong danh sách được phép.<br>
      Lần truy cập này đã được ghi log.</p>
      <p><a href="/" style="color:#0e6b74">← Về Dashboard</a></p></div>`
    );
  }
  next();
}

/**
 * Middleware ghi log truy cap: thoi gian, IP, ten may (reverse DNS), method,
 * duong dan, ma tra ve, thoi gian xu ly (ms). Moi ngay 1 file
 * logs/access-YYYY-MM-DD.log (dinh dang TSV, de mo bang Excel).
 * Ghi bat dong bo (khong chan response) va KHONG lam sap app neu ghi loi.
 */
function accessLogger(req, res, next) {
  const start = Date.now();
  const vnTime = new Date(start).toLocaleString('vi-VN', { 
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false
  });
  const ip = clientIp(req);
  res.on('finish', () => {
    resolveHostname(ip)
      .then((hostname) => {
        const now = new Date();
        const day = now.toISOString().slice(0, 10);
        const line = [
          vnTime,
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
// 7c. CHATBOT NOI BO (rule/intent) - xu ly du lieu, KHONG goi dich vu ngoai
// ---------------------------------------------------------------------------

// --- KHO TRI THUC "DA HOC" (admin duyet) - luu NOI BO o data/kb-learned.json ---
const DATA_DIR = path.join(__dirname, 'data');
const KB_LEARNED_FILE = path.join(DATA_DIR, 'kb-learned.json');
function loadLearnedKB() {
  try {
    if (!fs.existsSync(KB_LEARNED_FILE)) return [];
    const arr = JSON.parse(fs.readFileSync(KB_LEARNED_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('[KB] Khong doc duoc kb-learned.json:', e.message);
    return [];
  }
}
function saveLearnedKB(arr) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KB_LEARNED_FILE, JSON.stringify(arr, null, 2), 'utf8');
  chatbot.setLearned(arr); // nap ngay cho chatbot
}
// Nap luc khoi dong
chatbot.setLearned(loadLearnedKB());

// Ma booking on_off -> nhan tieng Viet (de hien lich su thiet bi de doc).
const VM_LABELS = {
  YE: 'Lắp lên tàu', YA: 'Tháo khỏi tàu', T: 'Xuất/chuyển kho', TC: 'Hủy chuyển kho',
  CI: 'Kiểm định (recertify)', B1: 'Nhận hàng', SX: 'Gửi ngoài', IN: 'Hàng đến',
  TR: 'Nhận chuyển', OU: 'Gửi đi', TS: 'Ship chuyển', EX: 'Trao đổi', LC: 'Đổi vị trí',
};
const vmLabel = (vm) => VM_LABELS[String(vm || '').trim().toUpperCase()] || String(vm || '').trim();

/** Dinh dang datetime VN cho chat (doc getUTC* de khong bi cong them mui gio). */
function fmtVNServer(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d) || d.getUTCFullYear() <= 1901) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Danh sach Trung tam (cache 10 phut) - de chatbot nhan dien ten trong cau hoi. */
let _deptCache = { at: 0, list: [] };
async function getDepartments() {
  if (CONFIG.demoMode) return DEMO.filters().departments;
  if (Date.now() - _deptCache.at < 10 * 60 * 1000 && _deptCache.list.length) return _deptCache.list;
  const src = signCacheReady ? '[NQT].[dbo].[SIGN_CACHE]' : '[DWH_DB]..[STG_AMOS].[SIGN]';
  const rows = await query(
    `SELECT DISTINCT LTRIM(RTRIM([DEPARTMENT])) AS v FROM ${src}
     WHERE [DEPARTMENT] IS NOT NULL AND LTRIM(RTRIM([DEPARTMENT])) <> ''`
  );
  _deptCache = { at: Date.now(), list: rows.map((r) => r.v) };
  return _deptCache.list;
}

/** Tra cuu lich su booking cua 1 thiet bi theo part/serial/label (on_off). */
async function qDeviceLookup(term) {
  const params = { term: String(term || '').trim() };
  const text = `
    SELECT TOP 40
      o.[vm] AS vm, o.[voucherno] AS voucherno, o.[labelno] AS labelno,
      RTRIM(o.[partno]) AS partno, RTRIM(o.[serialno]) AS serialno,
      o.[mut_t] AS time, o.[ac_registr] AS ac_registr, o.[station] AS station
    FROM [NQT].[dbo].[on_off] o
    WHERE RTRIM(o.[partno]) = @term
       OR RTRIM(o.[serialno]) = @term
       OR TRY_CONVERT(float, o.[labelno]) = TRY_CONVERT(float, @term)
    ORDER BY o.[mut_t] DESC`;
  return query(text, params);
}

/**
 * TRA CUU TRANG THAI DOI UNG cua 1 thiet bi (part/serial/label).
 * Voi cac PHIEU XUAT gan nhat (kho_ser1 vm=T) cua thiet bi, kiem tra tung
 * duong "dong vong": tra unservice / tra service (recertify) / hoan kho /
 * phieu da bi huy -> con lai la CHUA doi ung.
 */
async function qReconcileStatus(term) {
  const params = { term: String(term || '').trim() };
  const text = `
    SELECT TOP 5
      k.[labelno] AS labelno, RTRIM(k.[partno]) AS partno, RTRIM(k.[serialno]) AS serialno,
      RTRIM(k.[voucherno]) AS voucherno, ${amosToVN('k')} AS issue_time_vn,
      -- (1) TRA UNSERVICE: real_us1 khop labelno+voucherno -> lay SN duoc tra + gio tra
      us.[part_off] AS us_part, us.[serial_off] AS us_serial, us.[del_time] AS us_del_time,
      -- (2) TRA SERVICE: chuoi thao YA -> recertify CI @SHOPLOC -> gio recertify
      sv.[removal_serial] AS svc_serial, sv.[recert_time] AS svc_recert_time,
      -- (3) hoan kho: TC 'P-CA-...' cung thiet bi
      CASE WHEN EXISTS (SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
             WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
               AND tc.[partno] = k.[partno] AND tc.[serialno] = k.[serialno]
               AND tc.[labelno] = k.[labelno]) THEN 1 ELSE 0 END AS has_return,
      -- (4) phieu bi HUY (TRANSFER CANCELLED cung so phieu)
      CASE WHEN EXISTS (SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc2
             WHERE tc2.[vm] = 'TC' AND tc2.[voucherno] LIKE 'P-CA-%'
               AND tc2.[labelno] = k.[labelno]
               AND RTRIM(tc2.[voucherno]) = 'P-CA-' + SUBSTRING(RTRIM(k.[voucherno]), 3, 50)) THEN 1 ELSE 0 END AS cancelled
    FROM [NQT].[dbo].[kho_ser1] k
    -- Chi tiet TRA UNSERVICE (dong tra moi nhat): SN thao tra ve + gio tra
    OUTER APPLY (
      SELECT TOP 1 RTRIM(r.[partno_off]) AS part_off, RTRIM(r.[serialno_o]) AS serial_off, r.[del_time] AS del_time
      FROM [NQT].[dbo].[real_us1] r
      WHERE r.[labelno] = k.[labelno] AND r.[voucher_s] = k.[voucherno]
      ORDER BY r.[del_time] DESC
    ) us
    -- Chi tiet TRA SERVICE (recertify dau tien sau gio xuat): SN thao + gio CI
    OUTER APPLY (
      SELECT TOP 1 RTRIM(t1.[serialno]) AS removal_serial, t2.[mut_t] AS recert_time
      FROM [NQT].[dbo].[on_off] t1
      INNER JOIN [NQT].[dbo].[on_off] t2
        ON t2.[psn] = t1.[psn] AND t2.[orderno] = t1.[orderno]
       AND t2.[vm] = 'CI' AND t2.[location] = 'SHOPLOC'
      WHERE t1.[vm] = 'YA' AND t1.[labelno] = k.[labelno]
        AND t2.[mut_t] > ${amosToVN('k')}
      ORDER BY t2.[mut_t] ASC, t1.[mut_t] ASC
    ) sv
    WHERE k.[vm] = 'T' AND k.[voucherno] LIKE 'P-%'
      AND ( RTRIM(k.[partno]) = @term
         OR RTRIM(k.[serialno]) = @term
         OR TRY_CONVERT(float, k.[labelno]) = TRY_CONVERT(float, @term) )
    ORDER BY k.[mutation] DESC, k.[mutation_t] DESC`;
  return query(text, params);
}

/**
 * DOI UNG NGUOC: hoi ve 1 SN UNSERVICE (thiet bi da tra ve kho) -> tim PHIEU
 * XUAT doi ung tuong ung. Lien ket real_us1(labelno,voucher_s) = kho_ser1
 * (labelno,voucherno). Tra ve thiet bi da tra + phieu xuat + thiet bi xuat.
 */
async function qReconcileReverse(term) {
  const params = { term: String(term || '').trim() };
  const text = `
    SELECT TOP 5
      r.[labelno] AS labelno,
      RTRIM(r.[partno_off]) AS returned_part, RTRIM(r.[serialno_o]) AS returned_serial,
      RTRIM(r.[voucher_s]) AS voucher_s, r.[del_time] AS del_time,
      RTRIM(k.[partno]) AS issued_part, RTRIM(k.[serialno]) AS issued_serial,
      RTRIM(k.[voucherno]) AS issue_voucher, ${amosToVN('k')} AS issue_time_vn
    FROM [NQT].[dbo].[real_us1] r
    LEFT JOIN [NQT].[dbo].[kho_ser1] k
      ON k.[labelno] = r.[labelno] AND k.[voucherno] = r.[voucher_s] AND k.[vm] = 'T'
    WHERE r.[del_time] IS NOT NULL
      AND ( RTRIM(r.[serialno_o]) = @term
         OR RTRIM(r.[partno_off]) = @term
         OR RTRIM(r.[serialno]) = @term
         OR TRY_CONVERT(float, r.[labelno]) = TRY_CONVERT(float, @term) )
    ORDER BY r.[del_time] DESC`;
  return query(text, params);
}

/** Tao cau tra loi cho intent 'kpi' (truy van so lieu). */
async function chatAnswerKpi(intent, ctx) {
  // Uu tien ky + trung tam LAY TU CAU HOI; thieu thi dung filter hien tai cua trang.
  const q = {
    periodType: (intent.period && intent.period.periodType) || ctx.periodType || 'month',
    month: (intent.period && intent.period.month) || ctx.month || '',
    week: (intent.period && intent.period.week) || ctx.week || '',
    station: ctx.station || '',
    store: ctx.store || '',
    department: intent.department || ctx.department || '',
    excludeCC: ctx.excludeCC ? '1' : '',
  };
  const range = resolveRange(q);
  const f = readFilters(q);
  const dash = CONFIG.demoMode
    ? DEMO.dashboard(range, f)
    : buildDashboardFromAgg(range, await qDashboardAgg(range, f));
  const k = dash.kpis;
  const ctxLine =
    `Kỳ: ${range.label}${q.periodType === 'month' && q.month ? ' ' + q.month : ''}` +
    (q.department ? ` · Trung tâm: ${q.department}` : '') +
    (q.station ? ` · Station: ${q.station}` : '');

  // Xep hang trung tam theo TAT install (tu bieu do cot)
  if (intent.rank) {
    const bar = dash.charts.barDept;
    const rows = bar.labels.map((lb, i) => ({ dep: lb, v: bar.install[i] }))
      .filter((x) => isFinite(x.v));
    rows.sort((a, b) => (intent.rank === 'top' ? b.v - a.v : a.v - b.v));
    const top = rows.slice(0, 5).map((x, i) => `${i + 1}. ${x.dep}: ${x.v} ngày`);
    return `${ctxLine}\nTrung tâm TAT install ${intent.rank === 'top' ? 'CAO' : 'THẤP'} nhất:\n` +
      (top.length ? top.join('\n') : 'Không có dữ liệu.');
  }

  const fmtMetric = (field) => {
    const meta = chatbot.METRICS.find((m) => m.field === field);
    const val = k[field];
    return `• ${meta ? meta.label : field}: ${val ?? 0}${meta && meta.unit ? ' ' + meta.unit : ''}`;
  };

  if (intent.metrics && intent.metrics.length) {
    return `${ctxLine}\n` + intent.metrics.map(fmtMetric).join('\n');
  }

  // Khong chi ro chi so -> tom tat cac KPI chinh
  return `${ctxLine}\n` +
    ['tatInstallAvg', 'tatUsReturnAvg', 'tatCuvtAvg', 'tatReturnStoreAvg',
     'countIssued', 'countNotReconciled', 'reconcileRate'].map(fmtMetric).join('\n');
}

/** Tao cau tra loi cho intent 'device' (tra cuu 1 thiet bi). */
async function chatAnswerDevice(term) {
  const rows = CONFIG.demoMode ? DEMO.deviceLookup(term) : await qDeviceLookup(term);
  if (!rows || !rows.length) {
    return `Không tìm thấy booking nào cho "${term}". Hãy thử nhập Part No / Serial No / Label khác.`;
  }
  const h0 = rows[0];
  const lines = rows.slice(0, 12).map(
    (r) => `• ${fmtVNServer(r.time)} — ${vmLabel(r.vm)}${r.ac_registr ? ' · ' + r.ac_registr : ''}${r.voucherno ? ' · ' + String(r.voucherno).trim() : ''}`
  );
  const more = rows.length > 12 ? `\n… và ${rows.length - 12} booking cũ hơn.` : '';
  return `Thiết bị ${h0.partno || ''} / SN ${h0.serialno || ''} (label ${h0.labelno || ''}) — ${rows.length} booking gần đây:\n` +
    lines.join('\n') + more;
}

/** Tao cau tra loi cho intent 'reconcile' (tim doi ung cua 1 thiet bi).
 *  direction='reverse' -> hoi ve SN unservice, tim nguoc ra phieu xuat. */
async function chatAnswerReconcile(term, direction) {
  if (direction === 'reverse') return chatAnswerReconcileReverse(term);

  const rows = CONFIG.demoMode ? DEMO.reconcileStatus(term) : await qReconcileStatus(term);
  if (!rows || !rows.length) {
    return `Không tìm thấy phiếu xuất kho nào cho "${term}" để kiểm tra đối ứng. Hãy thử Part No / Serial No / Label khác.`;
  }
  // Chi tiet tung trang thai: tra unservice (SN + gio), tra service (gio recertify)
  const statusOf = (r) => {
    if (r.cancelled) return '⛔ Phiếu đã hủy (TRANSFER CANCELLED)';
    if (r.us_del_time) {
      const sn = r.us_serial ? `SN ${r.us_serial}` : 'SN (trống)';
      const pn = r.us_part ? ` / PN ${r.us_part}` : '';
      return `✅ Trả unservice: ${sn}${pn} — trả lúc ${fmtVNServer(r.us_del_time)}`;
    }
    if (r.svc_recert_time) {
      const sn = r.svc_serial ? ` (SN tháo ${r.svc_serial})` : '';
      return `✅ Trả service (recertify)${sn} — lúc ${fmtVNServer(r.svc_recert_time)}`;
    }
    if (r.has_return) return '✅ Đã hoàn kho';
    return '⚠️ CHƯA đối ứng';
  };
  const h0 = rows[0];
  const lines = rows.map(
    (r) => `• Phiếu ${r.voucherno} (xuất ${fmtVNServer(r.issue_time_vn)}): ${statusOf(r)}`
  );
  return `Đối ứng của ${h0.partno || ''} / SN ${h0.serialno || ''} (label ${h0.labelno || ''}) — ${rows.length} phiếu xuất gần nhất:\n` +
    lines.join('\n');
}

/** Chieu NGUOC: hoi ve 1 SN unservice -> phieu xuat doi ung tuong ung. */
async function chatAnswerReconcileReverse(term) {
  const rows = CONFIG.demoMode ? DEMO.reconcileReverse(term) : await qReconcileReverse(term);
  if (!rows || !rows.length) {
    return `Không tìm thấy bản ghi trả unservice nào cho "${term}". Hãy thử Serial No / Part No / Label của thiết bị đã trả về kho.`;
  }
  const h0 = rows[0];
  const lines = rows.map((r) => {
    const back = r.issue_voucher
      ? `đối ứng phiếu xuất ${r.issue_voucher} (thiết bị xuất ${r.issued_part || ''}/${r.issued_serial || ''}, xuất ${fmtVNServer(r.issue_time_vn)})`
      : '⚠️ chưa tìm thấy phiếu xuất đối ứng';
    return `• Trả unservice lúc ${fmtVNServer(r.del_time)} (label ${r.labelno}) — ${back}`;
  });
  return `SN ${h0.returned_serial || term} (đơn vị trả unservice) — ${rows.length} lần trả gần nhất:\n` +
    lines.join('\n');
}

/** Ghi lai cau hoi bot CHUA tra loi duoc de review + bo sung kho tri thuc. */
function logChatGap(message) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const vn = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
    fs.appendFile(path.join(LOG_DIR, `chat-unknown-${day}.log`), `${vn}\t${message}\n`, () => {});
  } catch (_) { /* khong de loi ghi log lam vo chat */ }
}

/** Ghi lai MOI cau hoi gui toi chatbot (TSV: gio, IP, intent, noi dung).
 *  1 file/ngay: logs/chat-YYYY-MM-DD.log. Luu NOI BO (khong gui ra ngoai). */
function logChatQuestion(message, intent, ip) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const vn = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
    const safe = String(message || '').replace(/[\t\r\n]+/g, ' ').trim();
    fs.appendFile(path.join(LOG_DIR, `chat-${day}.log`), `${vn}\t${ip || ''}\t${intent || ''}\t${safe}\n`, () => {});
  } catch (_) { /* khong de loi ghi log lam vo chat */ }
}

/**
 * Cau chua hieu -> neu co LLM NOI BO (LLM_URL) thi nho LLM tra loi, GROUNDING
 * bang kho tri thuc (KB). Huong dan LLM: chi dung kien thuc duoc cung cap,
 * KHONG bia so lieu (cau hoi so lieu -> huong dan nguoi dung hoi lai co ky).
 * Bat ky loi/khoa an toan -> tra null de fallback ve rule-based.
 */
async function chatTryLLM(message) {
  if (!llm.isEnabled() || llm.blockReason()) return null;
  const kb = [...chatbot.DEFINITIONS, ...chatbot.USAGE].map((x) => '- ' + x.answer).join('\n');
  const system =
    'Bạn là trợ lý nội bộ cho Dashboard TAT của VAECO (bảo dưỡng khí tài hàng không). ' +
    'CHỈ trả lời dựa trên KIẾN THỨC được cung cấp dưới đây, bằng tiếng Việt, ngắn gọn. ' +
    'TUYỆT ĐỐI KHÔNG bịa số liệu. Nếu là câu hỏi số liệu cụ thể, hãy hướng dẫn người dùng ' +
    'hỏi lại kèm kỳ và trung tâm (ví dụ: "TAT install tháng 7 của CNBDNT"). ' +
    'Nếu ngoài phạm vi, nói không có thông tin.\n\nKIẾN THỨC:\n' + kb;
  try {
    const text = await llm.ask(system, String(message || ''));
    return text || null;
  } catch (err) {
    console.warn('[LLM] Bo qua, dung rule-based:', err.message);
    return null;
  }
}

/** Dieu phoi: tu intent -> cau tra loi (text). */
async function chatRespond(message, ctx) {
  const departments = await getDepartments().catch(() => []);
  const intent = chatbot.interpret(message, { departments });
  switch (intent.intent) {
    case 'kb': return { intent: intent.intent, reply: intent.answer };
    case 'learned': return { intent: intent.intent, reply: intent.answer };
    case 'reconcile': return { intent: intent.intent, reply: await chatAnswerReconcile(intent.term, intent.direction) };
    case 'device': return { intent: intent.intent, reply: await chatAnswerDevice(intent.term) };
    case 'kpi': return { intent: intent.intent, reply: await chatAnswerKpi(intent, ctx) };
    case 'help': return { intent: intent.intent, reply: chatbot.helpText() };
    default: {
      // Thu LLM noi bo (neu bat) truoc khi tra loi mac dinh
      const llmReply = await chatTryLLM(message);
      if (llmReply) return { intent: 'llm', reply: llmReply };
      logChatGap(message); // ghi lai de bo sung kho tri thuc ve sau
      const sugg = (intent.suggestions && intent.suggestions.length)
        ? '\n\nCó phải anh/chị muốn hỏi:\n' + intent.suggestions.map((s) => '• ' + s).join('\n')
        : '\n\n' + chatbot.helpText();
      return { intent: 'unknown', reply: 'Xin lỗi, tôi chưa hiểu câu hỏi.' + sugg };
    }
  }
}

// ---------------------------------------------------------------------------
// 8. EXPRESS APP + ROUTES
// ---------------------------------------------------------------------------
const app = express();
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(accessLogger); // ghi log IP + ten may cho MOI request (truoc static/API)
app.use(adminGuard);   // chan truy cap admin tu IP la (truoc static de chan /admin.html)
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
    // Checkbox "Bo qua xuat costcenter": loai receiver la so (khong phai so tau)
    excludeCC: ['1', 'true'].includes((q.excludeCC || '').trim().toLowerCase()),
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

// --- Chatbot noi bo: nhan { message, ...filter hien tai } -> { reply, intent } ---
//     Xu ly cuc bo (rule/intent), KHONG goi dich vu ngoai, khong gui du lieu ra.
app.post(
  '/api/chat',
  h(async (req, res) => {
    const body = req.body || {};
    const message = String(body.message || '').slice(0, 500);
    if (!message.trim()) return res.json({ reply: chatbot.helpText(), intent: 'help' });
    const out = await chatRespond(message, body);
    logChatQuestion(message, out.intent, clientIp(req)); // ghi log MOI cau hoi (noi bo)
    res.json(out);
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
    const signSrc = signCacheReady ? '[NQT].[dbo].[SIGN_CACHE]' : '[DWH_DB]..[STG_AMOS].[SIGN]';
    const departments = await query(
      `SELECT DISTINCT LTRIM(RTRIM([DEPARTMENT])) AS v FROM ${signSrc}
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
           ON k.[labelno]=r.[labelno] AND k.[voucherno]=r.[voucher_s]
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

// --- BETA: XU HUONG theo THANG (N thang gan nhat) cho trang dashboard beta ---
//     Lap tung thang -> dung lai qDashboardAgg/buildDashboardFromAgg. Cache 5'.
app.get(
  '/api/beta/trend',
  cached(5 * 60 * 1000, async (req, res) => {
    const months = Math.min(12, Math.max(2, parseInt(req.query.months || '6', 10)));
    const f = readFilters(req.query);
    const anchor = /^\d{4}-\d{2}$/.test(req.query.month || '')
      ? req.query.month
      : (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
    const [ay, am] = anchor.split('-').map(Number);
    const series = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(ay, am - 1 - i, 1);
      const mstr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const range = { ...monthRange(mstr), label: 'Thang' };
      const dash = CONFIG.demoMode
        ? DEMO.dashboard(range, f)
        : buildDashboardFromAgg(range, await qDashboardAgg(range, f));
      const k = dash.kpis;
      series.push({
        month: mstr,
        tatInstall: k.tatInstallAvg, tatUsReturn: k.tatUsReturnAvg, tatReturnStore: k.tatReturnStoreAvg,
        issued: k.countIssued, notReconciled: k.countNotReconciled, reconcileRate: k.reconcileRate,
        cntReci: k.cntReci, cntDel: k.cntDel,
      });
    }
    res.json({ series, months });
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

// --- ADMIN: gop log cau hoi chatbot CHUA HIEU de review + bo sung KB ---
//     Doc cac file logs/chat-unknown-YYYY-MM-DD.log, gom theo NOI DUNG cau hoi
//     (dem so lan, lan dau/cuoi) de admin xem nhung gi nguoi dung hay hoi ma
//     bot chua tra loi duoc -> bo sung vao chatbot.js.
app.get(
  '/api/admin/chat-unknown',
  h(async (req, res) => {
    const days = Math.max(0, parseInt(req.query.days || '0', 10)); // 0 = tat ca
    const cutoff = days ? Date.now() - days * 86400000 : 0;
    let files = [];
    try {
      files = fs.readdirSync(LOG_DIR).filter((f) => /^chat-unknown-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    } catch (_) { /* thu muc log co the chua co */ }

    const byMsg = new Map(); // message -> { message, count, first, last }
    let totalLines = 0;
    for (const f of files) {
      const day = f.slice('chat-unknown-'.length, -4); // YYYY-MM-DD
      if (cutoff && new Date(day + 'T23:59:59Z').getTime() < cutoff) continue;
      let content = '';
      try { content = fs.readFileSync(path.join(LOG_DIR, f), 'utf8'); } catch (_) { continue; }
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const tab = line.indexOf('\t');
        const time = tab >= 0 ? line.slice(0, tab) : '';
        const message = (tab >= 0 ? line.slice(tab + 1) : line).trim();
        if (!message) continue;
        totalLines++;
        const stamp = time || day; // dong log da co dang 'HH:MM:SS DD/MM/YYYY'
        const key = message.toLowerCase();
        const cur = byMsg.get(key) || { message, count: 0, first: stamp, last: '' };
        cur.count++;
        cur.last = stamp;
        byMsg.set(key, cur);
      }
    }
    const items = [...byMsg.values()].sort((a, b) => b.count - a.count);
    res.json({ items, totalLines, totalUnique: items.length, days, files });
  })
);

/** Doc + parse cac file log chat theo prefix, trong khoang `days` ngay.
 *  Moi dong chat-*.log: 'time \t ip \t intent \t message'. Tra ve mang dong. */
function readChatLogLines(prefix, days) {
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  let files = [];
  try {
    files = fs.readdirSync(LOG_DIR)
      .filter((f) => new RegExp(`^${prefix}\\d{4}-\\d{2}-\\d{2}\\.log$`).test(f)).sort();
  } catch (_) { /* chua co thu muc log */ }
  const rows = [];
  for (const f of files) {
    const day = f.slice(prefix.length, -4);
    if (cutoff && new Date(day + 'T23:59:59Z').getTime() < cutoff) continue;
    let content = '';
    try { content = fs.readFileSync(path.join(LOG_DIR, f), 'utf8'); } catch (_) { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      // Ho tro CA 2 dinh dang: chat-unknown ('time \t message') va
      // chat-log ('time \t ip \t intent \t message'). Message LUON la cot cuoi.
      const p = line.split('\t');
      const message = (p[p.length - 1] || '').trim();
      rows.push({
        time: p[0] || day,
        ip: p.length >= 4 ? p[1] : '',
        intent: p.length >= 4 ? p[2] : '',
        message,
      });
    }
  }
  return rows;
}

// --- ADMIN: TAT CA cau hoi chatbot (gom theo noi dung + thong ke theo intent) ---
app.get(
  '/api/admin/chat-log',
  h(async (req, res) => {
    const days = Math.max(0, parseInt(req.query.days || '0', 10));
    const rows = readChatLogLines('chat-', days).filter((r) => r.message);
    const byMsg = new Map();
    const byIntent = {};
    for (const r of rows) {
      byIntent[r.intent || '(none)'] = (byIntent[r.intent || '(none)'] || 0) + 1;
      const key = r.message.toLowerCase();
      const cur = byMsg.get(key) || { message: r.message, count: 0, intents: new Set(), last: '' };
      cur.count++;
      if (r.intent) cur.intents.add(r.intent);
      cur.last = r.time;
      byMsg.set(key, cur);
    }
    const items = [...byMsg.values()]
      .map((x) => ({ message: x.message, count: x.count, intents: [...x.intents].join(', '), last: x.last }))
      .sort((a, b) => b.count - a.count);
    res.json({ items, total: rows.length, totalUnique: items.length, byIntent, days });
  })
);

// --- ADMIN: GOI Y bo sung KB tu cac cau hoi CHUA HIEU (vong hoc noi bo) ---
//     Voi moi cau hoi chua hieu: tim chu de KB gan nhat (trung nhieu tu) de
//     admin them dong nghia, hoac tao muc moi (admin tu nhap cau tra loi).
app.get(
  '/api/admin/kb-suggestions',
  h(async (req, res) => {
    const days = Math.max(0, parseInt(req.query.days || '0', 10));
    const rows = readChatLogLines('chat-unknown-', days).filter((r) => r.message);
    const byMsg = new Map();
    for (const r of rows) {
      const key = r.message.toLowerCase();
      const cur = byMsg.get(key) || { question: r.message, count: 0, last: '' };
      cur.count++; cur.last = r.time;
      byMsg.set(key, cur);
    }
    const learnedKeys = new Set(loadLearnedKB().map((x) => (x.keys[0] || '').toLowerCase()));
    const items = [...byMsg.values()]
      .filter((x) => !learnedKeys.has(chatbot.norm(x.question))) // bo cai da hoc
      .map((x) => {
        const m = chatbot.bestMatch(x.question);
        return {
          question: x.question, count: x.count, last: x.last,
          matchTopic: m.score > 0 ? m.topic : '',
          matchAnswer: m.score > 0 ? m.answer : '',
          suggestedAnswer: m.score > 0 ? m.answer : '', // admin co the sua
        };
      })
      .sort((a, b) => b.count - a.count);
    res.json({ items, days });
  })
);

// --- ADMIN: liet ke KB da hoc ---
app.get('/api/admin/kb-learned', h(async (req, res) => {
  res.json({ items: loadLearnedKB() });
}));

// --- ADMIN: DUYET 1 goi y -> luu vao KB da hoc (chatbot dung ngay) ---
app.post('/api/admin/kb-learn', h(async (req, res) => {
  const question = String((req.body && req.body.question) || '').trim();
  const answer = String((req.body && req.body.answer) || '').trim();
  if (!question || !answer) {
    return res.status(400).json({ error: true, message: 'Thieu question hoac answer.' });
  }
  const keyPhrase = chatbot.norm(question); // cau hoi da bo dau lam khoa
  const arr = loadLearnedKB().filter((x) => (x.keys[0] || '') !== keyPhrase); // thay neu trung
  arr.push({ keys: [keyPhrase], answer, addedAt: new Date().toISOString(), sample: question });
  saveLearnedKB(arr);
  res.json({ ok: true, count: arr.length });
}));

// --- ADMIN: XOA 1 muc KB da hoc ---
app.post('/api/admin/kb-learn-delete', h(async (req, res) => {
  const keyPhrase = String((req.body && req.body.key) || '').trim();
  const arr = loadLearnedKB().filter((x) => (x.keys[0] || '') !== keyPhrase);
  saveLearnedKB(arr);
  res.json({ ok: true, count: arr.length });
}));

// Route tien: /admin -> trang admin review log cau hoi chua hieu
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Route: /beta -> trang dashboard beta (de xuat cai tien, lay y kien)
app.get('/beta', (req, res) => res.sendFile(path.join(__dirname, 'public', 'beta.html')));

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
  console.log(`  Admin IPs (ngoai localhost): ${CONFIG.adminIps.join(', ') || '(khong co)'}`);
  // Trang thai chatbot: rule-based luon bat; local LLM neu co cau hinh + hop le
  if (!llm.isEnabled()) {
    console.log('  Chatbot: rule/intent noi bo (local LLM: TAT)');
  } else if (llm.blockReason()) {
    console.log(`  Chatbot: rule/intent (local LLM BI CHAN: ${llm.blockReason()})`);
  } else {
    console.log(`  Chatbot: rule/intent + local LLM (${llm.CFG.url}, model ${llm.CFG.model})`);
  }
  console.log('====================================================');
  if (!CONFIG.demoMode) {
    // Thu ket noi som de bao loi ngay neu cau hinh sai
    getPool().catch((err) =>
      console.error('[DB] Chua ket noi duoc SQL Server:', err.message)
    );
    // Lam moi SIGN_CACHE ngay khi khoi dong + dinh ky (bo linked server khoi query)
    if (CONFIG.signCache) {
      refreshSignCache();
      const t = setInterval(refreshSignCache, CONFIG.signCacheMinutes * 60 * 1000);
      if (t.unref) t.unref();
    }
  }
});
