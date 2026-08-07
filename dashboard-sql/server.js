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
const path = require('path');
const fs = require('fs');
const dns = require('dns');
const { execFile } = require('child_process');
const sql = require('mssql');

// ---------------------------------------------------------------------------
// 1. CAU HINH
// ---------------------------------------------------------------------------
/** Cac station co thu muc scan rieng (dung y cong cu AMOS_GUI cua nghiep vu). */
const SCAN_STATIONS = ['HAN', 'SGN', 'DAD'];

/** Doc SCAN_x_DIR_HAN / _SGN / _DAD tu bien moi truong -> { HAN, SGN, DAD }. */
function envTheoStation(tienTo) {
  const out = {};
  for (const st of SCAN_STATIONS) {
    const v = (process.env[`${tienTo}_${st}`] || '').trim();
    if (v) out[st] = v;
  }
  return out;
}

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
  // Thu muc luu DU LIEU DO NGUOI DUNG TAO (cap doi ung thu cong, KB chatbot da
  // hoc, trang thai bao cao). MAC DINH nam trong thu muc app; NEN doi ra NGOAI
  // (vd D:\VAECO\dashboard-data) de cai lai/ghi de app KHONG lam mat du lieu.
  dataDir: (process.env.DATA_DIR || '').trim()
    ? path.resolve(process.env.DATA_DIR.trim())
    : path.join(__dirname, 'data'),
  // --- Thu muc chua FILE SCAN PDF (doi chieu phieu da scan hay chua) ---
  // MOI STATION MOT THU MUC RIENG: cong cu AMOS_GUI cua nghiep vu co o "Station"
  // (SGN/HAN/DAD) va o "Thu muc" nam canh nhau, nguoi dung doi station thi doi
  // luon thu muc. Dashboard cho xem NHIEU station cung luc nen phai tra cuu thu
  // muc THEO STATION CUA TUNG DONG, khong the dung mot thu muc chung.
  // SCAN_PICKING_DIR = thu muc MAC DINH (dung khi station khong ro);
  // SCAN_PICKING_DIR_HAN / _SGN / _DAD = thu muc rieng tung station.
  scanPickingDir: (process.env.SCAN_PICKING_DIR || '\\\\10.99.7.7\\picking list\\2026').trim(),
  scanReceivingDir: (process.env.SCAN_RECEIVING_DIR || '\\\\10.99.7.7\\certificates\\2026').trim(),
  scanPickingByStation: envTheoStation('SCAN_PICKING_DIR'),
  scanReceivingByStation: envTheoStation('SCAN_RECEIVING_DIR'),
  // Thoi gian toi da cho MOT cau truy van (ms). Truy van qua linked server
  // (AMOS) co the lau; mac dinh cu 60s hay bao "Timeout: Request failed to
  // complete in 60000ms" tren cac ky dai.
  dbRequestTimeout: parseInt(process.env.DB_REQUEST_TIMEOUT_MS || '180000', 10),
  signCache: String(process.env.SIGN_CACHE || 'true').toLowerCase() !== 'false',
  signCacheMinutes: parseInt(process.env.SIGN_CACHE_MINUTES || '360', 10), // mac dinh 6h
  // --- Bao cao dinh ky day len Teams / SharePoint (phuong an 3) - MAC DINH TAT ---
  // URL webhook cua Teams Workflows ("Post to a channel when a webhook request
  // is received"). De trong = khong gui. LUU Y: gui = so lieu TONG HOP len cloud M365.
  teamsWebhookUrl: (process.env.TEAMS_WEBHOOK_URL || '').trim(),
  // Thu muc xuat file bao cao (tro vao thu muc SharePoint/OneDrive dang sync
  // tren server -> file tu dong len thu vien SharePoint). De trong = khong xuat.
  reportExportDir: (process.env.REPORT_EXPORT_DIR || '').trim(),
  // Lich gui: "T2 06:30" | "T2,T5 06:30" | "MON 06:30" | "CN 18:00"
  reportSchedule: (process.env.REPORT_SCHEDULE || 'T2 06:30').trim(),
  // Ky bao cao (danh sach, phay): 'week' = tuan VUA ket thuc, 'month' = thang
  // VUA ket thuc. "week,month": moi lan chay gui the TUAN; the THANG chi gui
  // 1 lan/thang (lan chay dau tien cua thang moi).
  reportPeriods: (process.env.REPORT_PERIOD || 'week')
    .split(',').map((s) => s.trim().toLowerCase()).filter((s) => s === 'week' || s === 'month'),
};
if (!CONFIG.reportPeriods.length) CONFIG.reportPeriods = ['week'];

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
  requestTimeout: CONFIG.dbRequestTimeout,
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
    // Tai khoan DB chi co quyen DOC -> se KHONG BAO GIO tao duoc SIGN_CACHE.
    // Tat han de khoi thu lai vo ich moi 6 tieng va log rac.
    if (/permission|denied|CREATE TABLE|quyen|read-only|readonly/i.test(err.message || '')) {
      CONFIG.signCache = false;
      console.warn('[SIGN] Tai khoan SQL khong co quyen GHI -> tat SIGN_CACHE (dung linked server).');
      console.warn('[SIGN] App van chay dung, chi CHAM hon. Muon nhanh: nho DBA cap quyen');
      console.warn('[SIGN]   CREATE TABLE + INSERT + TRUNCATE tren rieng bang [NQT].[dbo].[SIGN_CACHE],');
      console.warn('[SIGN]   hoac dat SIGN_CACHE=false trong .env de bo qua thong bao nay.');
    } else {
      console.warn('[SIGN] Khong lam moi duoc SIGN_CACHE, tam dung linked server truc tiep:', err.message);
    }
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
 * Trung tam (department) cho bang real_us1. Thu tu uu tien:
 *   1) real_us1.department          <-- NGUON CHINH (bo '' / 'UNKNOWN')
 *   2) action_per bat dau bang 'PA' -> 'PA'
 *   3) SIGN theo action_per          (chi dung khi real_us1 khong co du lieu)
 *   4) mac dinh 'PA'
 *
 * VI SAO real_us1.department DUNG TRUOC (quyet dinh cua nguoi dung nghiep vu):
 * Day la don vi duoc ghi NGAY LUC PHAT SINH giao dich - dung voi thoi diem do.
 * Cac nguon suy ra tu NGUOI (kho_ser1.created_b2 hay SIGN) khong dang tin bang:
 * nguoi lap phieu co the khong thuoc don vi thuc su dung khi tai, va SIGN chi
 * co don vi HIEN TAI nen sai voi cac giao dich cu.
 * SIGN chi dung khi real_us1.department trong.
 *
 * LICH SU: da co lan doi sang uu tien SIGN (theo docstring cu cua
 * qTatDepartments), roi doi tiep sang uu tien nguoi lap phieu xuat. Ca hai deu
 * bi tra lai vi du lieu thuc te cho thay 2 nguon do kem chinh xac hon.
 * -> KHONG doi lai thu tu nay neu khong co yeu cau nghiep vu ro rang.
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
// 3d. DOI UNG THU CONG (cap thao <-> lap co LABEL LECH NHAU)
//     Nghiep vu: co ca "thao truoc, lap thiet bi khac len" -> label cua thiet bi
//     THAO va thiet bi XUAT KHO khac nhau nen join theo labelno KHONG tim duoc
//     doi ung. Nguoi dung xem goi y, XAC NHAN cap -> luu vao file JSON noi bo;
//     tu do phieu xuat do KHONG con nam trong "chua doi ung" va duoc tinh la
//     DA doi ung trong KPI.
// ---------------------------------------------------------------------------
const MANUAL_PAIR_FILE = path.join(DATA_DIR_EARLY(), 'reconcile-manual.json');

/** Thu muc du lieu (cau hinh qua DATA_DIR trong .env). Ham nho de dung som
 *  vi hang DATA_DIR duoc khai bao o muc 7c ben duoi. */
function DATA_DIR_EARLY() {
  return CONFIG.dataDir;
}

/**
 * GHI FILE JSON AN TOAN (chong mat du lieu):
 *   1. Ghi ra file .tmp truoc,
 *   2. Giu ban cu thanh .bak,
 *   3. Doi ten .tmp -> file that (thao tac NGUYEN TU tren cung o dia).
 * Neu service bi tat dot ngot giua chung, file that van con nguyen (hoac la
 * ban cu, hoac la ban moi) - KHONG bao gio bi cut doi/hong.
 */
function saveJsonSafe(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, file + '.bak'); } catch (_) { /* co ban bak la tot, khong bat buoc */ }
  }
  fs.renameSync(tmp, file);
}

function loadManualPairs() {
  try {
    if (!fs.existsSync(MANUAL_PAIR_FILE)) return [];
    const arr = JSON.parse(fs.readFileSync(MANUAL_PAIR_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('[PAIR] Khong doc duoc reconcile-manual.json:', e.message);
    return [];
  }
}

function saveManualPairs(arr) {
  saveJsonSafe(MANUAL_PAIR_FILE, arr);
}

// ---------------------------------------------------------------------------
// 3e. THU MUC FILE SCAN PDF (doi chieu "da scan hay chua")
//     Nghiep vu (lay tu cong cu AMOS_GUI cua nguoi dung):
//       - Picking list : ten file = <PICKING_LISTNO_I>-....pdf  -> lay PHAN DAU
//         truoc dau '-' lam khoa. Phieu TRA (return) dung khoa <HISTORYNO_I>.
//       - Receiving    : ten file = <VOUCHERNO>.pdf (nguyen ten, khong tach).
//         VOUCHERNO trong AMOS co tien to "R-" -> bo di truoc khi so.
//     Duong dan MAC DINH nam trong CONFIG; nguoi dung o trang /admin sua duoc
//     va luu vao data/scan-folders.json TREN MAY BACKEND (may khac chi xem).
// ---------------------------------------------------------------------------
const SCAN_DIR_FILE = path.join(DATA_DIR_EARLY(), 'scan-folders.json');
const _scanCache = new Map();
const SCAN_CACHE_MS = 60 * 1000;

/**
 * Doc duong dan da luu (neu co), lui ve mac dinh trong CONFIG.
 * Cau truc tra ve, moi loai la mot bang tra cuu THEO STATION:
 *   { picking: { HAN, SGN, DAD, '*': mac dinh }, receiving: {...} }
 * '*' dung khi station cua dong khong nam trong danh sach (hoac chua cau hinh
 * rieng cho station do).
 * TUONG THICH NGUOC: ban ghi cu luu picking/receiving la MOT CHUOI -> coi do
 * la thu muc mac dinh '*'.
 */
function loadScanDirs() {
  let saved = {};
  try {
    if (fs.existsSync(SCAN_DIR_FILE)) saved = JSON.parse(fs.readFileSync(SCAN_DIR_FILE, 'utf8')) || {};
  } catch (e) {
    console.warn('[SCAN] Khong doc duoc scan-folders.json:', e.message);
  }
  const sach = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

  /** Gop 3 nguon theo thu tu uu tien: file JSON > bien moi truong > mac dinh. */
  const gop = (luu, envSt, envMacDinh) => {
    const cu = typeof luu === 'string' ? { '*': sach(luu) } : (luu || {});
    const ra = {};
    for (const st of SCAN_STATIONS) {
      const v = sach(cu[st]) || sach(envSt[st]);
      if (v) ra[st] = v;
    }
    ra['*'] = sach(cu['*']) || sach(envMacDinh);
    return ra;
  };

  const picking = gop(saved.picking, CONFIG.scanPickingByStation, CONFIG.scanPickingDir);
  const receiving = gop(saved.receiving, CONFIG.scanReceivingByStation, CONFIG.scanReceivingDir);
  const daSua = (luu, st) => !!(luu && typeof luu === 'object' && sach(luu[st]));
  return {
    picking,
    receiving,
    updatedAt: saved.updatedAt || null,
    updatedBy: saved.updatedBy || null,
    // Cho giao dien biet o nao dang la ban SUA (nguoi dung tu dat)
    custom: {
      picking: Object.fromEntries([...SCAN_STATIONS, '*'].map((st) => [st, daSua(saved.picking, st)
        || (typeof saved.picking === 'string' && st === '*' && !!sach(saved.picking))])),
      receiving: Object.fromEntries([...SCAN_STATIONS, '*'].map((st) => [st, daSua(saved.receiving, st)
        || (typeof saved.receiving === 'string' && st === '*' && !!sach(saved.receiving))])),
    },
    stations: SCAN_STATIONS,
  };
}

/**
 * Ghi duong dan moi (chi goi tu API admin - da qua adminGuard theo IP).
 * Body: { picking: { HAN, SGN, DAD, '*' }, receiving: {...} } - o nao de trong
 * thi bo di (quay ve bien moi truong / mac dinh).
 */
function saveScanDirs(body, ip) {
  const loc = (o) => {
    const ra = {};
    if (!o || typeof o !== 'object') return ra;
    for (const st of [...SCAN_STATIONS, '*']) {
      const v = typeof o[st] === 'string' ? o[st].trim() : '';
      if (v) ra[st] = v;
    }
    return ra;
  };
  saveJsonSafe(SCAN_DIR_FILE, {
    picking: loc(body && body.picking),
    receiving: loc(body && body.receiving),
    updatedAt: new Date().toISOString(),
    updatedBy: ip || 'unknown',
  });
  _scanCache.clear(); // duong dan doi -> bo cache danh sach file cu
  return loadScanDirs();
}

/**
 * Cot STATION cua AMOS co dang 'VNA-HAN', 'VNA-SGN'... -> rut ra ma station.
 * Dung DUOI chuoi giong bo loc cua cong cu AMOS_GUI (endswith).
 */
function stationCode(v) {
  const s = String(v || '').trim().toUpperCase();
  return SCAN_STATIONS.find((st) => s.endsWith(st) || s === st) || '';
}

/**
 * Doc TAT CA thu muc can cho mot loai (picking / receiving) -> bang tra cuu
 * theo station. readScanFolder() cache theo duong dan nen hai station tro vao
 * CUNG mot thu muc chi ton MOT lan doc.
 * @param {object} bang  { HAN, SGN, DAD, '*' } duong dan
 * @param {'prefix'|'full'} mode  cach lay khoa tu ten file
 */
async function loadScanIndex(bang, mode) {
  const khoa = [...SCAN_STATIONS, '*'].filter((st) => bang[st]);
  const ket = await Promise.all(khoa.map((st) => readScanFolder(bang[st], mode)));
  const out = {};
  khoa.forEach((st, i) => { out[st] = ket[i]; });
  return out;
}

/**
 * Trang thai scan cua MOT dong: tra thu muc THEO STATION cua chinh dong do,
 * khong co rieng thi dung thu muc mac dinh '*'.
 * Tra '' khi khong doc duoc thu muc (KHONG ket luan la "chua scan").
 */
function scanStateTheoStation(index, station, key) {
  const folder = index[stationCode(station)] || index['*'];
  if (!folder) return '';
  return scanState(folder, key);
}

/**
 * Nhu tren nhung thu NHIEU cach dat ten file - moi station co the dat ten khac
 * nhau (vd HAN bo tien to 'R-', SGN giu nguyen 'R-...'). Khop bat ky khoa nao
 * la coi nhu DA SCAN.
 * @returns {{trangThai:string, khoaKhop:string}} khoaKhop = ten file da tim thay
 */
function scanStateNhieuKhoa(index, station, keys) {
  const folder = index[stationCode(station)] || index['*'];
  if (!folder || !folder.ok) return { trangThai: '', khoaKhop: '' };
  for (const k of keys) {
    if (k && folder.keys.has(k)) return { trangThai: 'SCANNED', khoaKhop: k };
  }
  return { trangThai: 'CHUA_SCAN', khoaKhop: '' };
}

/** Trang thai TAT CA thu muc de hien tren giao dien. */
function scanIndexStatus(index, bang) {
  return [...SCAN_STATIONS, '*']
    .filter((st) => bang[st])
    .map((st) => ({ station: st === '*' ? 'Mặc định' : st, ...scanFolderStatus(index[st]) }));
}

/**
 * Doc danh sach file PDF trong thu muc -> tap khoa de doi chieu.
 * @param {string} dir   duong dan (co the la UNC \\\\may\\thu muc)
 * @param {'prefix'|'full'} mode  'prefix' = cat truoc dau '-' (picking list)
 * KHONG NEM LOI: thu muc mang co the tam thoi khong voi toi duoc -> tra ve
 * { ok:false, error } de giao dien bao ro "khong kiem tra duoc" thay vi bao
 * nham la "chua scan".
 */
async function readScanFolder(dir, mode) {
  const key = `${dir}|${mode}`;
  const hit = _scanCache.get(key);
  if (hit && Date.now() - hit.at < SCAN_CACHE_MS) return hit;
  const out = { at: Date.now(), dir, mode, ok: false, count: 0, keys: new Set(), error: '' };
  if (!dir) {
    out.error = 'Chua cau hinh duong dan thu muc scan.';
    _scanCache.set(key, out);
    return out;
  }
  const t0 = Date.now();
  try {
    const files = await fs.promises.readdir(dir);
    for (const f of files) {
      if (!/\.pdf$/i.test(f)) continue;
      const name = f.slice(0, -4).trim();
      out.keys.add(mode === 'prefix' ? name.split('-')[0].trim() : name);
    }
    out.ok = true;
    out.count = out.keys.size;
    out.ms = Date.now() - t0;
    console.log(`[SCAN] ${dir} -> ${out.count} file PDF (${out.ms}ms)`);
  } catch (e) {
    out.error = e.code === 'ENOENT' ? 'Khong tim thay thu muc.'
      : e.code === 'EACCES' || e.code === 'EPERM' ? 'Khong co quyen doc thu muc.'
        : e.message;
    out.ms = Date.now() - t0;
    console.warn(`[SCAN] Khong doc duoc thu muc ${dir}: ${out.error}`);
  }
  _scanCache.set(key, out);
  return out;
}

/** Trang thai thu muc de tra ve cho giao dien (KHONG kem danh sach file). */
function scanFolderStatus(s) {
  return { dir: s.dir, ok: s.ok, count: s.count, error: s.error, ms: s.ms || 0 };
}

/**
 * Chuan hoa MOT SO ID (PICKING_LISTNO_I, HISTORYNO_I...) thanh chuoi so nguyen
 * de so voi ten file. Driver co the tra ve number / string / '123.0'.
 */
function idStr(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (Number.isFinite(n)) return String(Math.trunc(n));
  return String(v).trim();
}

/** Trang thai scan cua 1 dong: '' khi KHONG doc duoc thu muc (khong ket luan). */
function scanState(folder, key) {
  if (!folder.ok) return '';
  return key && folder.keys.has(key) ? 'SCANNED' : 'CHUA_SCAN';
}

/**
 * MOT BANG TREN LINKED SERVER CO COT NAY KHONG?
 * INFORMATION_SCHEMA khong dung duoc cho [DWH_DB].. (may chu tu xa), nen do
 * bang cach hoi TOP 0: co cot thi tra ve rong, khong co thi nem loi.
 * TOP 0 khong doc dong nao nen re. Ket qua duoc cache theo tien trinh.
 */
const _remoteColCache = new Map();
async function remoteHasColumn(fullTable, col) {
  const key = `${fullTable}.${col}`.toLowerCase();
  if (_remoteColCache.has(key)) return _remoteColCache.get(key);
  let co = false;
  try {
    await query(`SELECT TOP 0 [${col}] FROM ${fullTable}`);
    co = true;
  } catch (e) {
    console.warn(`[SCHEMA] ${fullTable} KHONG co cot [${col}] (${e.message.slice(0, 60)})`);
  }
  console.log(`[SCHEMA] ${key} -> ${co ? 'CO' : 'KHONG CO'}`);
  _remoteColCache.set(key, co);
  return co;
}

/**
 * Ghep NGAY AMOS + GIO AMOS thanh datetime GIO VN.
 *   dayCol  = so NGAY ke tu @amosEpoch   (vd [MUTATION], [PICKSLIP_DATE])
 *   timeCol = so MILLISECOND ke tu 00:00 (vd [MUTATION_TIME], [mutation_t])
 * timeCol de trong -> chi co ngay (00:00). Qua float truoc de chiu duoc ca
 * numeric/decimal lan chuoi co phan thap phan ('71820341.000000').
 */
function amosDayTimeToVN(dayCol, timeCol) {
  const ngay = `DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, ${dayCol})), TRY_CONVERT(datetime, @amosEpoch))`;
  if (!timeCol) return ngay;
  const ms = `TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, ${timeCol})) % 86400000)`;
  return `DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, ${ms}, ${ngay}))`;
}

/** Danh sach cot cua 1 bang trong NQT (cache) - de dung cot TUY CHON ma khong
 *  lam vo query neu cot do khong ton tai o moi truong khac. */
const _colsCache = new Map();
async function getColumns(table) {
  const key = String(table).toLowerCase();
  if (_colsCache.has(key)) return _colsCache.get(key);
  let set = new Set();
  try {
    const rows = await query(
      `SELECT COLUMN_NAME AS c FROM [NQT].[INFORMATION_SCHEMA].[COLUMNS]
       WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @t`,
      { t: table }
    );
    set = new Set(rows.map((r) => String(r.c || '').toLowerCase()));
  } catch (e) {
    console.warn(`[SCHEMA] Khong doc duoc cot cua ${table}:`, e.message);
  }
  _colsCache.set(key, set);
  return set;
}

/**
 * Cot EVENT (work order) = [event_perf] (nghiep vu VAECO xac nhan).
 * CHI chap nhan DUNG ten nay - KHONG fallback sang orderno/eventno... vi
 * ghep nham 2 cot khac y nghia se cho ra cap doi ung SAI (nguy hiem hon la
 * khong ghep duoc). Bang nao khong co cot -> dieu kien event tu tat.
 */
async function findEventColumn(table) {
  const cols = await getColumns(table);
  return cols.has('event_perf') ? 'event_perf' : null;
}

/**
 * KHOA SO SANH event: chuan hoa ve CHUOI de khop duoc ca khi cot luu kieu SO
 * lan kieu CHU (vd 8767380 vs '8767380' vs 'E8767380').
 * Dung 1 khoa duy nhat -> join khong bi NHAN BAN dong nhu khi dung OR.
 */
function eventKeyExpr(expr) {
  return `CASE
      WHEN TRY_CONVERT(bigint, ${expr}) IS NOT NULL
        THEN CONVERT(varchar(50), TRY_CONVERT(bigint, ${expr}))
      ELSE NULLIF(UPPER(LTRIM(RTRIM(CONVERT(varchar(50), ${expr})))), '')
    END`;
}

/** Khoa duy nhat cua 1 cap = (labelno phieu xuat, voucherno phieu xuat). */
const pairKey = (label, voucher) =>
  `${String(label ?? '').trim()}|${String(voucher ?? '').trim().toUpperCase()}`;

/** Cac cap doi ung thu cong THUOC KY + khop bo loc dang chon (station/store/
 *  department). Luc XAC NHAN da luu san cac truong nay nen loc duoc o JS. */
function manualPairsInRange(range, f) {
  const from = new Date(String(range.from) + 'Z').getTime();
  const to = new Date(String(range.to) + 'Z').getTime();
  const eq = (a, b) => String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();
  return loadManualPairs().filter((p) => {
    const t = new Date(String(p.issueTimeVn || '').replace(/Z?$/, 'Z')).getTime();
    if (!isFinite(t) || t < from || t >= to) return false;
    if (f && f.station && !eq(p.station, f.station)) return false;
    if (f && f.store && !eq(p.store, f.store)) return false;
    if (f && f.department && !eq(p.department, f.department)) return false;
    return true;
  });
}
const countManualPairsInRange = (range, f) => manualPairsInRange(range, f).length;

/**
 * Manh SQL loai cac phieu xuat DA duoc doi ung THU CONG ra khoi "chua doi ung".
 * Nhung cap da xac nhan duoc truyen vao bang THAM SO (@mpL0/@mpV0...) - khong
 * noi chuoi truc tiep de tranh SQL injection. Khong co cap nao -> chuoi rong.
 * CHI dua vao cac cap THUOC KY dang truy van (cap ngoai ky khong the trung
 * dong nao trong ket qua) -> danh sach tham so luon nho, khong cham gioi han
 * 2100 tham so cua SQL Server du sau nay xac nhan hang nghin cap.
 * Cap thieu issueTimeVn (ban ghi cu) -> LUON giu de khong bi tinh nham lai.
 * @param {string} kAlias alias bang kho_ser1
 * @param {Object} params doi tuong tham so cua query (duoc them @mpL_i, @mpV_i)
 * @param {Object} [range] { from, to } - de gioi han danh sach theo ky
 */
const MANUAL_PAIR_SQL_LIMIT = 900; // 900 cap = 1800 tham so, con xa moc 2100
function manualPairExclude(kAlias, params, range) {
  let pairs = loadManualPairs();
  if (range) {
    const from = new Date(String(range.from) + 'Z').getTime();
    const to = new Date(String(range.to) + 'Z').getTime();
    pairs = pairs.filter((p) => {
      const t = new Date(String(p.issueTimeVn || '').replace(/Z?$/, 'Z')).getTime();
      return !isFinite(t) || (t >= from && t < to); // thieu gio -> giu lai
    });
  }
  if (!pairs.length) return '';
  if (pairs.length > MANUAL_PAIR_SQL_LIMIT) {
    console.warn(`[PAIR] ${pairs.length} cap trong ky - cat con ${MANUAL_PAIR_SQL_LIMIT} de khong vuot gioi han tham so SQL.`);
    pairs = pairs.slice(-MANUAL_PAIR_SQL_LIMIT); // uu tien cap moi xac nhan
  }
  const values = pairs.map((p, i) => {
    params[`mpL${i}`] = String(p.issueLabel ?? '');
    params[`mpV${i}`] = String(p.issueVoucher ?? '');
    return `(@mpL${i}, @mpV${i})`;
  });
  return `
      AND NOT EXISTS (
        SELECT 1 FROM (VALUES ${values.join(', ')}) AS mp(labelno, voucherno)
        WHERE (TRY_CONVERT(float, mp.labelno) = TRY_CONVERT(float, ${kAlias}.[labelno])
               OR UPPER(RTRIM(mp.labelno)) = UPPER(RTRIM(${kAlias}.[labelno])))
          AND UPPER(RTRIM(mp.voucherno)) = UPPER(RTRIM(${kAlias}.[voucherno]))
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

/** Quy: period = 'YYYY-Qn' (vd 2026-Q3). Thieu/sai -> quy hien tai. */
function quarterRange(period) {
  let year, quarter;
  const m = /^(\d{4})-Q([1-4])$/i.exec(String(period || '').trim());
  if (m) {
    year = Number(m[1]);
    quarter = Number(m[2]);
  } else {
    const now = new Date();
    year = now.getFullYear();
    quarter = Math.floor(now.getMonth() / 3) + 1;
  }
  const from = new Date(year, (quarter - 1) * 3, 1, 0, 0, 0);
  const to = new Date(year, quarter * 3, 1, 0, 0, 0); // dau quy sau
  return { from: toLocalStr(from), to: toLocalStr(to) };
}

/** Nam: period = 'YYYY'. Thieu/sai -> nam hien tai. */
function yearRange(period) {
  let year = Number(String(period || '').trim());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) year = new Date().getFullYear();
  const from = new Date(year, 0, 1, 0, 0, 0);
  const to = new Date(year + 1, 0, 1, 0, 0, 0); // dau nam sau
  return { from: toLocalStr(from), to: toLocalStr(to) };
}

/** Query params cua KY LIEN TRUOC (de tinh delta KPI so voi ky truoc). */
function prevPeriodQuery(q) {
  const now = new Date();
  if (q.periodType === 'week') {
    const ref = q.week ? new Date(q.week) : now;
    const prev = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 7);
    return { ...q, week: `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}` };
  }
  if (q.periodType === 'quarter') {
    const m = /^(\d{4})-Q([1-4])$/i.exec(String(q.quarter || '').trim());
    let y = m ? Number(m[1]) : now.getFullYear();
    let qq = m ? Number(m[2]) : Math.floor(now.getMonth() / 3) + 1;
    qq -= 1;
    if (qq < 1) { qq = 4; y -= 1; }
    return { ...q, quarter: `${y}-Q${qq}` };
  }
  if (q.periodType === 'year') {
    const y = Number(String(q.year || '').trim()) || now.getFullYear();
    return { ...q, year: String(y - 1) };
  }
  // month (mac dinh)
  let [y, mm] = /^\d{4}-\d{2}$/.test(q.month || '')
    ? q.month.split('-').map(Number)
    : [now.getFullYear(), now.getMonth() + 1];
  mm -= 1;
  if (mm < 1) { mm = 12; y -= 1; }
  return { ...q, month: `${y}-${String(mm).padStart(2, '0')}` };
}

/** Tra ve { from, to, label } tu query params. */
function resolveRange(q) {
  if (q.periodType === 'week') {
    const r = weekRange(q.week);
    return { ...r, label: 'Tuan (T2 dau tuan)' };
  }
  if (q.periodType === 'quarter') {
    const r = quarterRange(q.quarter);
    return { ...r, label: 'Quy' };
  }
  if (q.periodType === 'year') {
    const r = yearRange(q.year);
    return { ...r, label: 'Nam' };
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
  // Trung tam nhanh (1) TRA US: lay tu real_us1 (xem deptFromReal) - do la don
  // vi ghi ngay luc phat sinh giao dich, dang tin hon cac nguon suy ra tu nguoi.
  // KHAI BAO TRUOC khi dung o buildFilterClause ben duoi.
  const dept = deptFromReal('r', 'sm');
  // Nhanh (2) TRA SERVICE khong co dong real_us1 -> buoc phai suy tu nguoi lap
  // phieu xuat (created_b2). Day la nguon duy nhat co cho nhanh nay.
  const deptSvc = deptFromStaff('k.[created_b2]', 'sm');
  let where = buildFilterClause(
    f,
    { station: 'k.[station]', store: 'k.[store]', department: dept },
    params
  );
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
      r.[action_per]  AS staff,          -- nguoi TRA US (cung nguon voi Trung tam)
      k.[created_b2]  AS issue_staff,    -- nguoi LAP PHIEU XUAT (giu de doi chieu)
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
      k.[created_b2],                    -- staff: nhanh nay khong co nguoi tra US
      k.[created_b2],                    -- issue_staff = nguoi lap phieu xuat
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
  const rows = await query(text, params);
  // (3) NHOM "CHI LAP LEN": thiet bi lap vao CUM CAO HON (khong len tau nen
  //     khong co su kien on_off YE). Lay tu WO_PART_ON_OFF - xem chi tiet o
  //     qInstalledIntoHigher(). Chi co chang LAP LEN: khong ngay thao/ngay tra.
  //     Loi o nhanh nay KHONG duoc lam vo bao cao chinh.
  try {
    const onlyInstall = await qInstalledIntoHigher(range, f);
    if (onlyInstall.length) rows.push(...onlyInstall);
  } catch (e) {
    console.warn('[TAT] Khong lay duoc nhom "chi lap len" (bo qua):', e.message);
  }
  return rows;
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
/** Chuan hoa psn de lam khoa doi chieu (Oracle tra so -> co the la float). */
function psnKey(v) {
  if (v == null) return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n)) : String(v).trim();
}

/**
 * Thong tin thiet bi tu [DWH_DB]..[STG_AMOS].[ROTABLES], noi qua khoa [psn]:
 *   location    -> VI TRI HIEN TAI
 *   PARTNONEW   -> Higher PN  (part/serial CAP TREN dang lap thiet bi nay)
 *   SERIALNONEW -> Higher SN
 * Cach lam: KHONG join truc tiep bang linked server trong query chinh (se hoi
 * Oracle theo tung dong -> rat cham / loi OLE DB). Thay vao do lay danh sach
 * psn tu ket qua roi hoi ROTABLES theo TUNG LO (WHERE psn IN (...)) -> dieu
 * kien duoc day xuong Oracle, chi vai luot goi.
 * Loi linked server -> tra Map rong (bao cao van hien binh thuong, cot de trong).
 * @returns {Promise<Map<string,{location:string,higher_pn:string,higher_sn:string}>>}
 */
async function fetchRotableInfo(psnList) {
  const uniq = [...new Set((psnList || []).map(psnKey).filter(Boolean))];
  const out = new Map();
  if (!uniq.length) return out;
  const CHUNK = 500; // 500 tham so/luot - xa nguong 2100 cua SQL Server
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const part = uniq.slice(i, i + CHUNK);
    const params = {};
    const names = part.map((v, j) => { params['rp' + j] = Number(v); return '@rp' + j; });
    try {
      const rows = await query(
        `SELECT [psn] AS psn, RTRIM([location]) AS location,
                RTRIM([PARTNONEW]) AS higher_pn, RTRIM([SERIALNONEW]) AS higher_sn
         FROM [DWH_DB]..[STG_AMOS].[ROTABLES]
         WHERE [psn] IN (${names.join(', ')})`,
        params
      );
      for (const r of rows) {
        out.set(psnKey(r.psn), {
          location: r.location || '',
          higher_pn: r.higher_pn || '',
          higher_sn: r.higher_sn || '',
        });
      }
    } catch (e) {
      console.warn('[ROTABLES] Khong lay duoc thong tin (bo qua cac cot nay):', e.message);
      return out; // loi lo dau -> dung han, khong lam vo bao cao
    }
  }
  return out;
}

/** Gan `location` / `higher_pn` / `higher_sn` vao cac dong da co truong `psn`. */
async function attachRotableInfo(rows) {
  if (!rows.length || !('psn' in rows[0])) return rows;
  const map = await fetchRotableInfo(rows.map((r) => r.psn));
  const EMPTY = { location: '', higher_pn: '', higher_sn: '' };
  return rows.map((r) => ({ ...r, ...(map.get(psnKey(r.psn)) || EMPTY) }));
}

/**
 * "LAP VAO CUM CAO HON" (higher assembly).
 * ---------------------------------------------------------------------------
 * NGHIEP VU: co thiet bi KHONG lap len tau (khong sinh su kien on_off vm='YE')
 * ma duoc gan vao mot CUM CAO HON - ROTABLES.PARTNONEW/SERIALNONEW cua no co
 * gia tri. Lan lap do CHI duoc ghi o [DWH_DB]..[STG_AMOS].WO_PART_ON_OFF.
 * Truoc day chung bi liet ke NHAM vao bao cao "Xuat kho chua lap".
 *
 * SO LIEU THUC DO tren 1 thang (docs/TEST-HIGHER-ASSY.sql, muc 5d):
 *   110 thiet bi "xuat kho chua lap"  ->  18 cai CO ban ghi lap trong
 *   WO_PART_ON_OFF (13 trong so do co higher_pn/higher_sn) = 16%.
 *
 * CACH NHAN DIEN (khong dua vao cot "danh dau" nao ca - da do thuc te khong
 * co cot nao nhu vay): thiet bi khong co su kien YE trong on_off NHUNG CO dong
 * WO_PART_ON_OFF voi (PARTNO, SERIALNO) trung va thoi diem lap SAU gio xuat kho
 * -> tuc la NO DA DUOC LAP (vao cum), khong con la "chua lap".
 *
 * LINKED SERVER: hoi THEO LO (SERIALNO IN (...), moi lo 400) sau khi truy van
 * chinh da tra ve - KHONG hoi tung dong.
 */
function woKey(pn, sn) {
  return String(pn || '').trim().toUpperCase() + '|' + String(sn || '').trim().toUpperCase();
}

/** Lay cac lan LAP trong WO_PART_ON_OFF cho danh sach thiet bi (theo lo).
 *  @returns Map<'PARTNO|SERIALNO', Array<{install_time_vn, ...}>> */
async function fetchWoInstalls(rows) {
  const out = new Map();
  const serials = [...new Set(
    rows.map((r) => String(r.serialno || '').trim().toUpperCase()).filter(Boolean)
  )];
  if (!serials.length) return out;
  // MUTATION = so ngay AMOS, MUTATION_TIME = so ms tu 0h (giong on_off) -> gio VN
  const mutVN =
    `DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND,
       TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, w.[MUTATION_TIME])) % 86400000),
       DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, w.[MUTATION])), TRY_CONVERT(datetime, @amosEpoch))))`;
  const CHUNK = 400;
  for (let i = 0; i < serials.length; i += CHUNK) {
    const part = serials.slice(i, i + CHUNK);
    const params = {};
    const names = [];
    part.forEach((s, j) => { params['s' + j] = s; names.push('@s' + j); });
    try {
      const res = await query(
        `SELECT RTRIM(w.[PARTNO])       AS partno,
                RTRIM(w.[SERIALNO])     AS serialno,
                ${mutVN}                AS install_time_vn,
                TRY_CONVERT(bigint, w.[EVENT_PERFNO_I]) AS event_perf,
                RTRIM(w.[AC_POSITION])  AS ac_position,
                RTRIM(w.[PARTNO_OFF])   AS partno_off,
                RTRIM(w.[SERIALNO_OFF]) AS serialno_off
         FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF] w
         WHERE w.[SERIALNO] IN (${names.join(', ')})`,
        params
      );
      for (const r of res) {
        const k = woKey(r.partno, r.serialno);
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(r);
      }
    } catch (e) {
      // Loi linked server -> KHONG lam vo bao cao: coi nhu khong tim thay lan lap
      console.warn('[WO_PART_ON_OFF] Khong lay duoc lan lap (bo qua):', e.message);
      return out;
    }
  }
  return out;
}

/** Tach danh sach "xuat kho chua co su kien YE" thanh 2 nhom:
 *   chuaLap   - thuc su chua lap (giu nguyen trong bao cao cu)
 *   lapVaoCum - da lap (vao cum cao hon), kem gio lap + TAT install */
async function splitIssuedByWoInstall(rows) {
  const chuaLap = [];
  const lapVaoCum = [];
  if (!rows.length) return { chuaLap, lapVaoCum };
  const map = await fetchWoInstalls(rows);
  for (const r of rows) {
    const issue = r.issue_time_vn ? new Date(r.issue_time_vn) : null;
    let best = null;
    for (const c of map.get(woKey(r.partno, r.serialno)) || []) {
      if (!c.install_time_vn) continue;
      const t = new Date(c.install_time_vn);
      // Chi nhan lan lap SAU gio xuat kho (tranh dinh lan lap cu cua ky truoc)
      if (issue && !(t >= issue)) continue;
      if (!best || t < new Date(best.install_time_vn)) best = c; // lan lap SOM NHAT
    }
    if (!best) { chuaLap.push(r); continue; }
    const inst = new Date(best.install_time_vn);
    lapVaoCum.push({
      ...r,
      installed_time_vn: best.install_time_vn,
      wo_event_perf: best.event_perf,
      wo_ac_position: best.ac_position,
      // THIET BI CU bi thay ra khoi cum - la thiet bi KHAC, khong phai thiet bi
      // cua dong nay bi thao xuong (dat ten wo_* de khong lan voi partno_off).
      wo_partno_off: best.partno_off || null,
      wo_serialno_off: best.serialno_off || null,
      tat_install_days: issue ? (inst - issue) / 86400000 : null,
    });
  }
  return { chuaLap, lapVaoCum };
}

// Chay 1 lan cho ca 2 bao cao ("Xuat kho chua lap" va "Chi tiet TAT") trong
// vong 60s - tranh goi lai truy van nang + linked server hai lan.
const _issuedSplitMemo = new Map();
async function getIssuedSplit(range, f) {
  const key = JSON.stringify([range.from, range.to, f]);
  const hit = _issuedSplitMemo.get(key);
  if (hit && Date.now() - hit.t < 60 * 1000) return hit.p;
  const p = (async () => splitIssuedByWoInstall(await qIssuedNotInstalledRaw(range, f)))();
  p.catch(() => _issuedSplitMemo.delete(key)); // loi thi khong giu cache hong
  _issuedSplitMemo.set(key, { t: Date.now(), p });
  if (_issuedSplitMemo.size > 20) {
    const oldest = [..._issuedSplitMemo.entries()].sort((a, b) => a[1].t - b[1].t)[0];
    if (oldest) _issuedSplitMemo.delete(oldest[0]);
  }
  return p;
}

/** BAO CAO: thiet bi da xuat kho nhung CHUA LAP (da loai nhom lap vao cum). */
async function qIssuedNotInstalled(range, f) {
  return (await getIssuedSplit(range, f)).chuaLap;
}

/** Cac thiet bi LAP VAO CUM CAO HON - dua vao "Chi tiet TAT", CHI the hien
 *  chang LAP LEN (khong co ngay thao / ngay tra / TAT tong).
 *
 *  VE 2 COT "Part No (off)" / "Serial No (off)":
 *  Trong WO_PART_ON_OFF, moi dong la 1 lan THAY THE tren cum: thiet bi cu ra
 *  (PARTNO_OFF/SERIALNO_OFF), thiet bi moi vao (PARTNO/SERIALNO). Nhung thiet
 *  bi cu do la MOT THIET BI KHAC - khong phai thiet bi cua dong nay bi thao
 *  xuong. Neu do vao 2 cot "(off)" thi dong "Chi lap len" lai hien du lieu thao
 *  (trong khi cot "Ngay thao" rong) -> mau thuan, va nguoi doc de tuong thiet
 *  bi nay da duoc doi ung.
 *  -> DE TRONG 2 cot do. Van giu gia tri o wo_partno_off / wo_serialno_off
 *     (khong hien tren bang) de con dung cho doi chieu ve sau.
 */
async function qInstalledIntoHigher(range, f) {
  const { lapVaoCum } = await getIssuedSplit(range, f);
  return lapVaoCum.map((r) => ({
    event_perf: r.event_perf ?? r.wo_event_perf ?? null,
    partno: r.partno,
    serialno: r.serialno,
    labelno: r.labelno,
    description: r.description,
    receiver: r.receiver ?? null,
    station: r.station,
    store: r.store1 ?? r.store,
    voucher_issue: r.voucher_issue,
    picking_li: r.picking_li ?? null,
    partno_off: null,                // xem chu thich tren: KHONG phai thiet bi
    serialno_off: null,              // nay bi thao xuong
    wo_partno_off: r.wo_partno_off ?? null,     // thiet bi CU bi thay ra khoi cum
    wo_serialno_off: r.wo_serialno_off ?? null, // (giu lai, khong hien tren bang)
    staff: r.staff,                  // nhom nay chua tra US -> lay nguoi lap phieu
    issue_staff: r.staff,
    department: r.department,
    issue_time_vn: r.issue_time_vn,
    installed_time_vn: r.installed_time_vn,
    removed_time_vn: null,           // chua thao xuong
    return_unservice_time: null,     // chua tra
    tat_days: null,                  // chua co TAT tong (chua tra)
    tat_install_days: r.tat_install_days,
    tat_usreturn_days: null,
    return_type: 'INSTALL',          // "Chi lap len" (lap vao cum cao hon)
    higher_pn: r.higher_pn || '',
    higher_sn: r.higher_sn || '',
    ac_position: r.wo_ac_position || '',
  }));
}

async function qIssuedNotInstalledRaw(range, f) {
  const params = { from: range.from, to: range.to, tzOffset: CONFIG.tzOffset, top: CONFIG.maxRows, ...amosDayParams(range) };
  const dept = deptFromStaff('k.[created_b2]', 'sm');
  // [psn] = khoa noi sang ROTABLES de lay VI TRI HIEN TAI. Uu tien lay tu
  // kho_ser1; neu bang do khong co cot thi lay tu on_off theo part+serial.
  // DO SCHEMA that (khong doan ten cot) -> thieu cot thi bo qua, query van chay.
  const khoCols = await getColumns('kho_ser1');
  const offCols = await getColumns('on_off');
  const psnFromKho = khoCols.has('psn');
  const psnFromOff = !psnFromKho && offCols.has('psn');
  const psnSelect = psnFromKho
    ? 'k.[psn]'
    : (psnFromOff
      ? `(SELECT TOP 1 op.[psn] FROM [NQT].[dbo].[on_off] op
           WHERE op.[partno] = k.[partno] AND op.[serialno] = k.[serialno]
             AND op.[psn] IS NOT NULL ORDER BY op.[mut_t] DESC)`
      : 'NULL');
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
      ${psnSelect} AS psn,
      -- Cac cot duoi CHI dung khi dong nay duoc chuyen sang "Chi tiet TAT"
      -- (nhom lap vao cum cao hon) - bao cao "Xuat kho chua lap" khong hien.
      k.[event_perf] AS event_perf,
      k.[receiver]   AS receiver,
      k.[picking_li] AS picking_li,
      k.[store1]     AS store1,
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
  // Gan VI TRI HIEN TAI + Higher PN/SN tu ROTABLES (noi qua psn) - lam sau khi
  // da co ket qua de chi hoi linked server theo lo, khong hoi tung dong.
  return attachRotableInfo(await query(text, params));
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
      -- Trung tam: chi con nguon SIGN(created_by). Truoc day bieu thuc nay con
      -- doc r.department / r.action_per cua real_us1, nhung dieu kien bao cao
      -- BAT BUOC khong co dong real_us1 nao -> 2 nhanh do LUON NULL, la code
      -- chet. Bo di, ket qua khong doi.
      ${deptFromStaff('o.[created_by]', 'sm')} AS trung_tam,
      -- VI TRI HIEN TAI (ROTABLES da duoc noi san o duoi va dang dung trong WHERE).
      -- Store hien tai lay tu LOCATION theo locationno_i cua ROTABLES - dung
      -- quan he ma chinh SQL cua Repair Admin dang dung. LEFT JOIN nen KHONG
      -- the lam mat dong nao; thieu du lieu thi lui ve store cua on_off.
      COALESCE(NULLIF(RTRIM(LOC.[store]), ''), RTRIM(o.[store])) AS store_now,
      RTRIM(RO.[location])   AS location,
      o.[psn]                AS psn,
      ${amosToVN('o')} AS removed_time_vn
    FROM [NQT].[dbo].[on_off] o
    LEFT JOIN [DWH_DB]..[STG_AMOS].ROTABLES RO ON o.PSN = RO.PSN
    LEFT JOIN [DWH_DB]..[STG_AMOS].[LOCATION] LOC ON LOC.[locationno_i] = RO.[locationno_i]
    ${signJoin('o.[created_by]', 'sm')}
    -- LUU Y: 2 dieu kien RO.MUTATION / RO.condition xet TRANG THAI HIEN TAI cua
    -- thiet bi, khong phai trang thai luc thao. Thiet bi da duoc nhan/xu ly ->
    -- condition doi khac 'US' -> BIEN MAT khoi bao cao, KE CA voi ky cu.
    -- Vi vay chay lai cung mot ky vao thoi diem khac se ra so khac (giam dan).
    -- Dung /api/admin/diag/rnr de xem tung buoc loc bot bao nhieu dong.
    WHERE o.[vm] = 'YA' AND RO.MUTATION > @fromDay and RO.condition ='US'
      -- "CHUA TRA UNSERVICE" - xet tai THOI DIEM XEM nen bao cao tu cap nhat:
      -- thao thang 7 ma tra US thang 8 thi xem lai thang 7 se khong con dong do.
      -- (1) Khong co dong tra US khop CHINH XAC lan thao nay (historyno_) - day
      --     la khoa ma docstring va qTatDepartments deu dung.
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[real_us1] r
        WHERE r.[historyno_] = o.[historyno_])
      -- (2) Va khong co dong tra US nao cung labelno XAY RA SAU lan thao nay
      --     (du phong cho ban ghi thieu historyno_). Bat buoc phai co dieu kien
      --     thoi gian: truoc day chi so labelno nen mot lan tra US cua CHU KY
      --     TRUOC cung lam mat dong - do thuc te loai OAN 672 dong trong 1 thang.
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[real_us1] r2
        WHERE r2.[labelno] = o.[labelno]
          AND r2.[del_time] >= ${amosToVN('o')})
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
      ${manualPairExclude('k', params, range)}
      AND k.[mutation] BETWEEN @fromDay AND @toDay  -- loc tho theo index (sargable)
      AND ${amosToVN('k')} >= @from AND ${amosToVN('k')} < @to
      ${where}
    ORDER BY issue_time_vn DESC`;
  return query(text, params);
}

/**
 * BAO CAO: DOI UNG THU CONG - cac phieu xuat CHUA doi ung, kem CAP GOI Y
 * (thiet bi da thao xuong) tim theo 3 cach, UU TIEN DAN:
 *   [1] WO_PART_ON_OFF: 1 dong ghi CA thiet bi lap (PARTNO/SERIALNO) va thiet bi
 *       thao (PARTNO_OFF/SERIALNO_OFF) -> cap CHINH XAC do AMOS ghi. Do cot nay
 *       nam tren linked server Oracle nen keo VE MOT LAN bang bang con (KHONG
 *       OUTER APPLY tung dong -> tranh loi OLE DB nhu bai hoc voi bang SIGN).
 *   [2] on_off cung ORDERNO/PSN: YE (lap thiet bi vua xuat) va YA (thao) cung
 *       phieu cong viec.
 *   [3] on_off cung SO TAU: lan thao YA gan nhat TRUOC gio lap YE tren cung tau.
 * Sau khi co thiet bi thao -> tim ban ghi TRA UNSERVICE (real_us1) cua no de
 * biet da tra ve kho hay chua (do chinh la ve con lai cua cap doi ung).
 */
async function qManualPairCandidates(range, f) {
  const params = { from: range.from, to: range.to, tzOffset: CONFIG.tzOffset, top: CONFIG.maxRows, ...amosDayParams(range) };
  // Noi rong cua so WO_PART_ON_OFF +/- 90 ngay quanh ky (thao/lap co the lech ky)
  params.woFrom = params.fromDay - 90;
  params.woTo = params.toDay + 90;
  const dept = deptFromStaff('k.[created_b2]', 'sm');
  let where = buildFilterClause(
    f,
    { station: 'k.[station]', store: 'k.[store]', department: dept },
    params
  );

  // Cot EVENT (work order) co the khac ten tuy he thong -> do schema, khong doan.
  const kEvCol = await findEventColumn('kho_ser1');
  const rEvCol = await findEventColumn('real_us1');
  const kEvKey = kEvCol ? eventKeyExpr(`k.[${kEvCol}]`) : 'NULL';
  // Khoa event cua ban ghi "Other" da tinh san khi do vao bang tam #other
  const sameEvent = (kEvCol && rEvCol)
    ? `((${kEvKey}) IS NOT NULL AND oa.event_key IS NOT NULL AND oa.event_key = (${kEvKey}))`
    : '(1 = 0)';
  const sameAc = `(oa.ac_registr <> '' AND oa.ac_registr = RTRIM(ISNULL(k.[ac_registr], '')))`;
  const samePn = `(oa.partno_off = RTRIM(k.[partno]))`;
  // Cot event cua real_us1 (neu co) - tinh khoa NGAY khi do vao bang tam
  const oaEvKey = rEvCol ? eventKeyExpr(`r0.[${rEvCol}]`) : 'NULL';

  const text = `
    -- Don bang tam con sot tu lan chay loi truoc (connection pool dung lai
    -- cung phien -> #temp co the van ton tai va gay loi "already an object").
    IF OBJECT_ID('tempdb..#wo')    IS NOT NULL DROP TABLE #wo;
    IF OBJECT_ID('tempdb..#wo_ps') IS NOT NULL DROP TABLE #wo_ps;
    IF OBJECT_ID('tempdb..#wo_ev') IS NOT NULL DROP TABLE #wo_ev;
    IF OBJECT_ID('tempdb..#other') IS NOT NULL DROP TABLE #other;

    -- Tap "Other" (real_us1 co on_ac) trong cua so cua CA KY -> quet real_us1
    -- DUNG MOT LAN roi APPLY tren bang tam nho (truoc day quet lai theo TUNG
    -- dong ung vien -> rat cham tren du lieu that).
    SELECT RTRIM(r0.[partno_off]) AS partno_off,
           RTRIM(r0.[serialno_o]) AS serialno_off,
           r0.[labelno]   AS ret_labelno,
           r0.[voucher_s] AS ret_voucher,
           r0.[del_time]  AS ret_del_time,
           RTRIM(r0.[on_ac]) AS on_ac,
           RTRIM(ISNULL(r0.[ac_registr], '')) AS ac_registr,
           ${oaEvKey} AS event_key
    INTO #other
    FROM [NQT].[dbo].[real_us1] r0
    WHERE r0.[on_ac] IS NOT NULL AND LTRIM(RTRIM(r0.[on_ac])) <> ''
      AND r0.[del_time] IS NOT NULL AND r0.[del_time] >= '1902-01-01'
      -- Bao ham moi cua so cua tung dong: [gio xuat - 30, gio xuat + 60]
      AND r0.[del_time] >= DATEADD(DAY, -30, @from)
      AND r0.[del_time] <  DATEADD(DAY,  60, @to);
    CREATE INDEX IX_other_pn ON #other (partno_off);

    -- Keo WO_PART_ON_OFF (linked server Oracle) ve bang tam MOT LAN, roi join
    -- nhieu lan tren bang tam -> khong hoi linked server theo tung dong.
    SELECT RTRIM(x.[PARTNO]) AS partno_on, RTRIM(x.[SERIALNO]) AS serialno_on,
           RTRIM(x.[PARTNO_OFF]) AS part_off, RTRIM(x.[SERIALNO_OFF]) AS serial_off,
           ${eventKeyExpr('x.[EVENT_PERFNO_I]')} AS event_key,
           TRY_CONVERT(float, x.[MUTATION]) AS mut
    INTO #wo
    FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF] x
    WHERE x.[MUTATION] BETWEEN @woFrom AND @woTo
      AND x.[SERIALNO_OFF] IS NOT NULL AND LTRIM(RTRIM(x.[SERIALNO_OFF])) <> '';

    -- Ban ghi MOI NHAT theo (part, serial) da lap
    SELECT partno_on, serialno_on, part_off, serial_off
    INTO #wo_ps
    FROM (SELECT z.*, ROW_NUMBER() OVER (PARTITION BY z.partno_on, z.serialno_on
                                         ORDER BY z.mut DESC) AS rn FROM #wo z) a
    WHERE a.rn = 1;

    -- Ban ghi MOI NHAT theo EVENT (work order). PARTITION theo khoa chuan hoa
    -- -> moi event chi 1 dong -> LEFT JOIN ben duoi khong the nhan ban dong.
    SELECT event_key, part_off, serial_off
    INTO #wo_ev
    FROM (SELECT z.*, ROW_NUMBER() OVER (PARTITION BY z.event_key ORDER BY z.mut DESC) AS rn
          FROM #wo z WHERE z.event_key IS NOT NULL) a
    WHERE a.rn = 1;

    SELECT TOP (@top)
      k.[partno]     AS partno,          -- thiet bi XUAT KHO (lap len tau)
      k.[serialno]   AS serialno,
      k.[labelno]    AS labelno,         -- label cua phieu xuat
      k.[descriptio] AS description,
      k.[voucherno]  AS voucher_issue,
      k.[station]    AS station,
      k.[store]      AS store,
      k.[ac_registr] AS ac_registr,
      ${kEvCol ? `k.[${kEvCol}]` : 'NULL'} AS event_perf,
      k.[created_b2] AS staff,
      ${dept} AS department,
      ${amosToVN('k')} AS issue_time_vn,
      CAST(DATEDIFF(MINUTE, ${amosToVN('k')}, GETDATE()) AS float) / 1440.0 AS tat_days,
      -- Cap GOI Y - chon theo DO TIN CAY giam dan (p.pick tinh 1 lan o CROSS APPLY):
      --   Cao : O4E Other khop event > WPS WO part+serial > WEV WO theo event
      --   TB  : O4A Other part+tau   > ORD cung orderno/psn
      --   Thap: O4P Other chi part   > AC  cung tau, gan thoi gian
      CASE p.pick WHEN 'O4E' THEN o4.partno_off WHEN 'O4A' THEN o4.partno_off
                  WHEN 'O4P' THEN o4.partno_off WHEN 'WPS' THEN w.part_off
                  WHEN 'WEV' THEN we.part_off   WHEN 'ORD' THEN o2.partno_off
                  WHEN 'AC'  THEN o3.partno_off END AS sug_partno_off,
      CASE p.pick WHEN 'O4E' THEN o4.serialno_off WHEN 'O4A' THEN o4.serialno_off
                  WHEN 'O4P' THEN o4.serialno_off WHEN 'WPS' THEN w.serial_off
                  WHEN 'WEV' THEN we.serial_off   WHEN 'ORD' THEN o2.serialno_off
                  WHEN 'AC'  THEN o3.serialno_off END AS sug_serialno_off,
      CASE WHEN p.pick IN ('O4E','O4A','O4P') THEN N'Other (on_ac)'
           WHEN p.pick = 'WPS' THEN N'WO_PART_ON_OFF'
           WHEN p.pick = 'WEV' THEN N'WO_PART_ON_OFF (theo event)'
           WHEN p.pick = 'ORD' THEN N'Cùng orderno/psn'
           WHEN p.pick = 'AC'  THEN N'Cùng tàu, gần thời gian'
      END AS match_method,
      CASE WHEN p.pick IN ('O4E','WPS','WEV') THEN N'Cao'
           WHEN p.pick IN ('O4A','ORD')       THEN N'Trung bình'
           WHEN p.pick IN ('O4P','AC')        THEN N'Thấp'
      END AS confidence,
      -- Ma ly do / tieu chi khop: chi co nghia khi ghep tu nguon Other
      CASE WHEN p.pick IN ('O4E','O4A','O4P') THEN o4.on_ac      END AS sug_on_ac,
      CASE WHEN p.pick IN ('O4E','O4A','O4P') THEN o4.match_note END AS sug_match_note,
      -- Ban ghi TRA UNSERVICE: nguon Other CHINH LA ban ghi tra -> lay tu o4;
      -- cac nguon khac phai tra cuu them (apply ret).
      CASE WHEN p.pick IN ('O4E','O4A','O4P') THEN o4.ret_labelno  ELSE ret.ret_labelno  END AS sug_ret_labelno,
      CASE WHEN p.pick IN ('O4E','O4A','O4P') THEN o4.ret_voucher  ELSE ret.ret_voucher  END AS sug_ret_voucher,
      CASE WHEN p.pick IN ('O4E','O4A','O4P') THEN o4.ret_del_time ELSE ret.ret_del_time END AS sug_ret_del_time,
      CASE WHEN (CASE WHEN p.pick IN ('O4E','O4A','O4P') THEN o4.ret_del_time ELSE ret.ret_del_time END) IS NOT NULL
        THEN CAST(DATEDIFF(MINUTE, ${amosToVN('k')},
             CASE WHEN p.pick IN ('O4E','O4A','O4P') THEN o4.ret_del_time ELSE ret.ret_del_time END) AS float) / 1440.0
      END AS sug_tat_days
    FROM [NQT].[dbo].[kho_ser1] k
    LEFT JOIN [NQT].[dbo].[real_us1] r
      ON k.[labelno] = r.[labelno] AND k.[voucherno] = r.[voucher_s]
    -- [4] UU TIEN 1: bang "Other" (real_us1 co on_ac) - thiet bi DA TRA US nhung
    --     chua co phieu xuat doi ung (dac biet ROB = thao xuong truoc).
    --     Cham diem: cung EVENT (WO) = 3 > cung PART + cung TAU = 2 > cung PART = 1.
    OUTER APPLY (
      SELECT TOP 1
             oa.partno_off, oa.serialno_off,
             oa.ret_labelno, oa.ret_voucher, oa.ret_del_time, oa.on_ac,
             CASE WHEN ${sameEvent} THEN 3
                  WHEN ${samePn} AND ${sameAc} THEN 2
                  ELSE 1 END AS score,
             CASE WHEN ${sameEvent} THEN N'Khớp event (WO)'
                  WHEN ${samePn} AND ${sameAc} THEN N'Khớp part no + số tàu'
                  ELSE N'Khớp part no' END AS match_note
      FROM #other oa
      -- Cua so +/- : ROB co the tra TRUOC ngay lam phieu xuat
      WHERE UPPER(RTRIM(oa.on_ac)) NOT IN (${ON_AC_EXCLUDE_FROM_MATCH.map((c) => `'${c}'`).join(', ')})
        AND oa.ret_del_time >= DATEADD(DAY, -30, ${amosToVN('k')})
        AND oa.ret_del_time <  DATEADD(DAY,  60, ${amosToVN('k')})
        AND (${sameEvent} OR ${samePn})
      ORDER BY score DESC, ABS(DATEDIFF(MINUTE, ${amosToVN('k')}, oa.ret_del_time)) ASC
    ) o4
    -- [1] WO_PART_ON_OFF theo (part, serial) da lap len tau
    LEFT JOIN #wo_ps w  ON w.partno_on = RTRIM(k.[partno]) AND w.serialno_on = RTRIM(k.[serialno])
    -- [1b] WO_PART_ON_OFF theo EVENT (work order) cua phieu xuat
    LEFT JOIN #wo_ev we ON we.event_key = (${kEvKey})
    -- [2] Cung ORDERNO/PSN: YE lap thiet bi vua xuat <-> YA thao
    OUTER APPLY (
      SELECT TOP 1 ya.[partno] AS partno_off, ya.[serialno] AS serialno_off
      FROM [NQT].[dbo].[on_off] ye
      INNER JOIN [NQT].[dbo].[on_off] ya
        ON ya.[orderno] = ye.[orderno] AND ya.[psn] = ye.[psn] AND ya.[vm] = 'YA'
      WHERE ye.[vm] = 'YE'
        AND ye.[partno] = k.[partno] AND ye.[serialno] = k.[serialno]
        AND ye.[mut_t] >= ${amosToVN('k')}
      ORDER BY ye.[mut_t] ASC
    ) o2
    -- [3] Cung SO TAU: YA gan nhat TRUOC gio lap YE
    OUTER APPLY (
      SELECT TOP 1 ya.[partno] AS partno_off, ya.[serialno] AS serialno_off
      FROM [NQT].[dbo].[on_off] ye
      INNER JOIN [NQT].[dbo].[on_off] ya
        ON ya.[ac_registr] = ye.[ac_registr] AND ya.[vm] = 'YA'
       AND ya.[mut_t] <= ye.[mut_t]
      WHERE ye.[vm] = 'YE'
        AND ye.[partno] = k.[partno] AND ye.[serialno] = k.[serialno]
        AND ye.[mut_t] >= ${amosToVN('k')}
        AND ye.[ac_registr] IS NOT NULL
      ORDER BY ye.[mut_t] ASC, ya.[mut_t] DESC
    ) o3
    -- CHON NGUON theo DO TIN CAY giam dan. Tinh MOT LAN o day roi dung lai o
    -- SELECT (SQL Server khong cho tham chieu alias cua SELECT trong cung cau).
    CROSS APPLY (VALUES (
      CASE
        WHEN o4.score = 3                THEN 'O4E'   -- Cao: Other khop event (WO)
        WHEN w.serial_off  IS NOT NULL   THEN 'WPS'   -- Cao: WO_PART_ON_OFF part+serial
        WHEN we.serial_off IS NOT NULL   THEN 'WEV'   -- Cao: WO_PART_ON_OFF theo event
        WHEN o4.score = 2                THEN 'O4A'   -- TB : Other part no + so tau
        WHEN o2.serialno_off IS NOT NULL THEN 'ORD'   -- TB : cung orderno/psn
        WHEN o4.score = 1                THEN 'O4P'   -- Thap: Other chi khop part no
        WHEN o3.serialno_off IS NOT NULL THEN 'AC'    -- Thap: cung tau, gan thoi gian
      END
    )) AS p(pick)
    -- Ban ghi tra unservice cua thiet bi THAO (chi cho nguon KHONG phai Other)
    OUTER APPLY (
      SELECT TOP 1 r2.[labelno] AS ret_labelno, r2.[voucher_s] AS ret_voucher,
             r2.[del_time] AS ret_del_time
      FROM [NQT].[dbo].[real_us1] r2
      WHERE RTRIM(r2.[serialno_o]) = CASE p.pick
              WHEN 'WPS' THEN w.serial_off  WHEN 'WEV' THEN we.serial_off
              WHEN 'ORD' THEN o2.serialno_off WHEN 'AC' THEN o3.serialno_off END
        AND r2.[del_time] IS NOT NULL
        AND r2.[del_time] >= ${amosToVN('k')}
      ORDER BY r2.[del_time] ASC
    ) ret
    ${signJoin('k.[created_b2]', 'sm')}
    WHERE k.[vm] = 'T'
      AND k.[voucherno] LIKE 'P-%'
      AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'
      AND ${dept} <> 'CUVT'
      AND r.[partno] IS NULL                       -- chua doi ung theo label
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
        WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
          AND tc.[partno] = k.[partno] AND tc.[serialno] = k.[serialno]
          AND tc.[labelno] = k.[labelno])
      AND NOT ${recertExists('k')}                 -- chua doi ung kieu tra service
      ${manualPairExclude('k', params, range)}            -- chua duoc doi ung THU CONG
      AND k.[mutation] BETWEEN @fromDay AND @toDay
      AND ${amosToVN('k')} >= @from AND ${amosToVN('k')} < @to
      ${where}
    ORDER BY issue_time_vn DESC;

    DROP TABLE #wo; DROP TABLE #wo_ps; DROP TABLE #wo_ev; DROP TABLE #other;`;

  // Batch nhieu lenh: SELECT...INTO / DROP TABLE khong tra recordset, nhung
  // KHONG phu thuoc vao gia dinh do - chon dung recordset cua SELECT chinh
  // bang cach kiem tra co cot 'voucher_issue'. Khong co dong nao -> [].
  const sets = await queryMulti(text, params);
  let rows = [];
  for (const rs of sets || []) {
    if (Array.isArray(rs) && rs.length && rs[0] &&
        Object.prototype.hasOwnProperty.call(rs[0], 'voucher_issue')) {
      rows = rs;
    }
  }
  // Ghep tu tab "Other" -> ghi ro MA LY DO + tieu chi da khop trong ten phuong phap
  // CANH BAO TRUNG: mot thiet bi da thao chi duoc doi ung cho DUNG MOT phieu
  // xuat. Neu cung 1 serial thao duoc goi y cho NHIEU phieu -> chi toi da 1 cai
  // dung; danh dau de nguoi dung khong xac nhan nham ca hai (se lam KPI sai).
  const dupCount = new Map();
  for (const r of rows) {
    const k = String(r.sug_serialno_off || '').trim().toUpperCase();
    if (k) dupCount.set(k, (dupCount.get(k) || 0) + 1);
  }
  return rows.map((r) => {
    const k = String(r.sug_serialno_off || '').trim().toUpperCase();
    const dup = k ? (dupCount.get(k) || 0) : 0;
    const out = { ...r, sug_duplicate: dup > 1 ? dup : 0 };
    if (r.match_method !== 'Other (on_ac)') return out;
    const d = decodeOnAc(r.sug_on_ac);
    const base = d ? `Other — ${d.code} (${d.name})` : 'Other (on_ac)';
    out.match_method = r.sug_match_note ? `${base} · ${r.sug_match_note}` : base;
    return out;
  });
}

/**
 * BAO CAO 4: THIET BI CHI CO MOT PHIA TRONG WO_PART_ON_OFF.
 * ---------------------------------------------------------------------------
 * Trong WO_PART_ON_OFF, mot dong BINH THUONG la 1 lan THAY THE: thiet bi cu ra
 * (PARTNO_OFF/SERIALNO_OFF) va thiet bi moi vao (PARTNO/SERIALNO). Nhung co
 * nhung dong CHI CO MOT PHIA:
 *   - CHI ON  (lap ma khong thao): gan them thiet bi, khong go cai nao ra.
 *   - CHI OFF (thao ma khong lap): go thiet bi ra, chua gan cai nao vao.
 * Day chinh la 2 dau cua nghiep vu "thao truoc - lap sau": lan THAO va lan LAP
 * duoc ghi thanh 2 dong rieng, khong ghep duoc voi nhau bang label.
 *
 * SO LIEU THUC DO (docs/TEST-HIGHER-ASSY.sql PHAN 7, 1 thang): trong 4.861 thiet
 * bi bi thay ra khoi cum co 154 cai KHONG co su kien on_off vm='YA' (22 da tra
 * unservice, 132 chua) -> cac bao cao dua tren on_off khong nhin thay chung.
 *
 * Moi dong tra ve kem: co su kien on_off tuong ung khong (YE cho phia ON, YA
 * cho phia OFF), co phieu xuat kho khong, va da tra unservice chua -> nhin ra
 * ngay dong nao dang bi bo sot.
 *
 * LINKED SERVER: keo WO_PART_ON_OFF ve #temp MOT LAN roi join noi bo.
 */
async function qOneSidedWoParts(range, f) {
  const d = amosDayParams(range);
  const params = {
    from: range.from, to: range.to, top: CONFIG.maxRows, ...d,
    // Cua so tra cuu phieu xuat / tra US quanh ky (thao va xuat co the lech ky)
    backDay: d.fromDay - 90,
  };
  // MUTATION = so ngay AMOS, MUTATION_TIME = so ms tu 0h -> gio VN
  const mutVN =
    `DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND,
       TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, x.[MUTATION_TIME])) % 86400000),
       DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, x.[MUTATION])), TRY_CONVERT(datetime, @amosEpoch))))`;
  const hasOn = `(x.[SERIALNO]     IS NOT NULL AND LTRIM(RTRIM(x.[SERIALNO]))     <> '')`;
  const hasOff = `(x.[SERIALNO_OFF] IS NOT NULL AND LTRIM(RTRIM(x.[SERIALNO_OFF])) <> '')`;

  // Bo loc station/department: WO_PART_ON_OFF khong co 2 cot nay -> lay tu ban
  // ghi noi bo tim duoc (phieu xuat / dong tra US). Dong KHONG tra ra duoc gia
  // tri thi VAN HIEN (khong am tham giau di) - da ghi ro trong mo ta bao cao.
  const deptExpr = `COALESCE(
      NULLIF(NULLIF(LTRIM(RTRIM(ret.department)), ''), 'UNKNOWN'),
      CASE WHEN LEFT(LTRIM(RTRIM(iss.staff)), 2) = 'PA' THEN 'PA' END,
      ${cleanDept('sm.[DEPARTMENT]')})`;
  const stationExpr = `COALESCE(NULLIF(LTRIM(RTRIM(iss.station)), ''), NULLIF(LTRIM(RTRIM(ret.station)), ''))`;
  let where = '';
  if (f.station) { params.fStation = f.station; where += `\n      AND (${stationExpr} IS NULL OR ${stationExpr} = @fStation)`; }
  if (f.store) { params.fStore = f.store; where += `\n      AND (iss.store IS NULL OR iss.store = @fStore)`; }
  if (f.department) { params.fDepartment = f.department; where += `\n      AND (${deptExpr} IS NULL OR ${deptExpr} = @fDepartment)`; }

  // TOI UU: cac bang NQT duoc keo ve #temp CO INDEX theo (partno, serialno) roi
  // moi join. Neu APPLY thang vao kho_ser1/real_us1/on_off voi RTRIM(...) =
  // ... thi khong dung duoc index (non-sargable) va phai quet lai bang cho
  // TUNG dong cua #w1 (co the vai nghin dong) -> rat cham.
  const text = `
    IF OBJECT_ID('tempdb..#w1')  IS NOT NULL DROP TABLE #w1;
    IF OBJECT_ID('tempdb..#iss') IS NOT NULL DROP TABLE #iss;
    IF OBJECT_ID('tempdb..#ret') IS NOT NULL DROP TABLE #ret;
    IF OBJECT_ID('tempdb..#oo')  IS NOT NULL DROP TABLE #oo;

    -- Keo ve MOT LAN: chi giu dong co DUNG MOT phia
    SELECT
      CASE WHEN ${hasOn} THEN 'ON' ELSE 'OFF' END                                AS phia,
      CASE WHEN ${hasOn} THEN RTRIM(x.[PARTNO])   ELSE RTRIM(x.[PARTNO_OFF])   END AS partno,
      CASE WHEN ${hasOn} THEN RTRIM(x.[SERIALNO]) ELSE RTRIM(x.[SERIALNO_OFF]) END AS serialno,
      TRY_CONVERT(bigint, x.[LABELNO])         AS labelno,
      TRY_CONVERT(bigint, x.[EVENT_PERFNO_I])  AS event_perf,
      RTRIM(x.[AC_POSITION])                   AS ac_position,
      ${mutVN}                                 AS thoi_diem_vn,
      RTRIM(x.[CREATED_BY])                    AS created_by
    INTO #w1
    FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF] x
    WHERE x.[MUTATION] BETWEEN @fromDay AND @toDay
      AND ((${hasOn} AND NOT ${hasOff}) OR (${hasOff} AND NOT ${hasOn}));
    CREATE INDEX IX_w1 ON #w1 (partno, serialno);

    -- Phieu xuat kho trong cua so [ky - 90 ngay, het ky]
    SELECT RTRIM(k.[partno]) AS partno, RTRIM(k.[serialno]) AS serialno,
           RTRIM(k.[voucherno]) AS voucher_issue, ${amosToVN('k')} AS issue_time_vn,
           RTRIM(k.[station]) AS station, RTRIM(k.[store]) AS store,
           k.[created_b2] AS staff
    INTO #iss
    FROM [NQT].[dbo].[kho_ser1] k
    WHERE k.[vm] = 'T' AND k.[voucherno] LIKE 'P-%'
      AND k.[mutation] BETWEEN @backDay AND @toDay;
    CREATE INDEX IX_iss ON #iss (partno, serialno);

    -- Dong tra unservice trong cua so quanh ky
    SELECT RTRIM(r.[partno]) AS partno, RTRIM(r.[serialno]) AS serialno,
           r.[del_time] AS return_unservice_time,
           RTRIM(r.[department]) AS department, RTRIM(r.[station]) AS station
    INTO #ret
    FROM [NQT].[dbo].[real_us1] r
    WHERE r.[del_time] >= DATEADD(DAY, -30, @from) AND r.[del_time] < DATEADD(DAY, 60, @to);
    CREATE INDEX IX_ret ON #ret (partno, serialno);

    -- Su kien on_off (YE/YA) trong cung cua so - de biet dong nao bi BO SOT
    SELECT DISTINCT RTRIM(o.[partno]) AS partno, RTRIM(o.[serialno]) AS serialno,
           RTRIM(o.[vm]) AS vm
    INTO #oo
    FROM [NQT].[dbo].[on_off] o
    WHERE o.[vm] IN ('YE','YA')
      AND o.[mutation] BETWEEN @backDay AND @toDay;
    CREATE INDEX IX_oo ON #oo (partno, serialno, vm);

    SELECT TOP (@top)
      w.phia          AS phia,
      w.partno        AS partno,
      w.serialno      AS serialno,
      w.labelno       AS labelno,
      w.event_perf    AS event_perf,
      w.ac_position   AS ac_position,
      w.thoi_diem_vn  AS thoi_diem_vn,
      w.created_by    AS created_by,
      -- Co su kien on_off tuong ung khong? (khong co = cac bao cao dua tren
      -- on_off dang BO SOT thiet bi nay)
      CASE WHEN EXISTS (
             SELECT 1 FROM #oo o
             WHERE o.partno = w.partno AND o.serialno = w.serialno
               AND o.vm = CASE WHEN w.phia = 'ON' THEN 'YE' ELSE 'YA' END)
           THEN N'Có' ELSE N'Không' END       AS co_su_kien_on_off,
      iss.voucher_issue  AS voucher_issue,
      iss.issue_time_vn  AS issue_time_vn,
      ret.return_unservice_time AS return_unservice_time,
      ${stationExpr}  AS station,
      ${deptExpr}     AS department
    FROM #w1 w
    -- Phieu xuat kho gan nhat TRUOC thoi diem (neu co)
    OUTER APPLY (
      SELECT TOP 1 i.voucher_issue, i.issue_time_vn, i.station, i.store, i.staff
      FROM #iss i
      WHERE i.partno = w.partno AND i.serialno = w.serialno
        AND i.issue_time_vn <= w.thoi_diem_vn
      ORDER BY i.issue_time_vn DESC
    ) iss
    -- Dong tra unservice DAU TIEN tu thoi diem do tro di (neu co)
    OUTER APPLY (
      SELECT TOP 1 t.return_unservice_time, t.department, t.station
      FROM #ret t
      WHERE t.partno = w.partno AND t.serialno = w.serialno
        AND t.return_unservice_time >= DATEADD(DAY, -30, w.thoi_diem_vn)
      ORDER BY t.return_unservice_time ASC
    ) ret
    ${signJoin('iss.staff', 'sm')}
    WHERE 1 = 1 ${where}
    ORDER BY w.thoi_diem_vn DESC;

    DROP TABLE #w1;
    DROP TABLE #iss;
    DROP TABLE #ret;
    DROP TABLE #oo;`;
  const sets = await queryMulti(text, params);
  return sets.find((s) => s.length && 'phia' in s[0]) || [];
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
/**
 * MA LY DO trong ghi chu [on_ac] cua real_us1 (nghiep vu VAECO cung cap).
 * Y nghia bao cao "Other": thiet bi DA TRA UNSERVICE nhung CHUA tim duoc phieu
 * xuat service doi ung -> ghi chu on_ac giai thich VI SAO khong co doi ung.
 */
const ON_AC_REASONS = [
  { code: 'NOI', name: 'Không có phiếu xuất', desc: 'NOI = no issue pickslip: thiết bị trả về nhưng không có phiếu xuất kho tương ứng.' },
  { code: 'SWP', name: 'Swap (hoán đổi thiết bị)', desc: 'SWP = swap: hoán đổi thiết bị — tháo thiết bị này xuống, lắp thiết bị khác lên.' },
  { code: 'ROB', name: 'Robbery (tháo xuống trước)', desc: 'ROB = robbery: tháo thiết bị xuống trước (lấy từ tàu/thiết bị khác) nên không phát sinh phiếu xuất kho.' },
  { code: 'DIR', name: 'Lắp thẳng từ kho', desc: 'DIR = direct: lắp thẳng lên tàu vật tư đang có trong kho, không qua phiếu xuất service.' },
  { code: 'CRO', name: 'Repairable / consumable', desc: 'CRO: tháo vật tư loại repairable / consumable.' },
];

/**
 * Cac ma on_ac KHONG dung de goi y ghep cap doi ung.
 * DIR = lap thang vat tu dang co trong kho -> KHONG phai ca "label lech" nen
 * goi y tu ma nay hau het la sai (nghiep vu xac nhan). Van hien binh thuong
 * trong tab Other, chi khong dung lam nguon ghep.
 */
const ON_AC_EXCLUDE_FROM_MATCH = ['DIR'];

/** Doc ma ly do tu ghi chu on_ac (khop nguyen tu, khong dinh vao chu khac). */
function decodeOnAc(note) {
  const s = String(note || '').toUpperCase();
  for (const r of ON_AC_REASONS) {
    if (new RegExp(`(^|[^A-Z])${r.code}([^A-Z]|$)`).test(s)) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5b. REPAIR ADMIN - ton dong tai cac vi tri UNSERVICEABLE (location_type = -4)
//     Nguon: LOCATION x ROTABLES x OD_DETAIL (noi psn + labelno), loc san
//     OD_DETAIL.status = 0; sau do chi giu backorder = 1 va state = 'O'.
//     Bao cao la ANH CHUP HIEN TRANG (dang nam o vi tri U/S), KHONG loc theo ky
//     bao cao; chi loc theo Station/Store dang chon tren dashboard.
// ---------------------------------------------------------------------------
const REPAIR_LOCATION_TYPE = -4;   // vi tri UNSERVICEABLE trong AMOS
const REPAIR_AGE_DAYS = 30;        // nguong chia < 30 ngay / >= 30 ngay

/**
 * Dong nao duoc TINH VAO BANG TONG HOP: OD_DETAIL.backorder = 1 VA state = 'O'.
 * (status = 0 da loc san trong cau SQL.)
 * So sanh chiu duoc ca so lan chuoi ('1' / 1) va khoang trang / chu thuong.
 * Dong KHONG dat dieu kien VAN NAM trong bang chi tiet, co cot danh dau rieng
 * -> nguoi dung thay duoc cai gi bi loai chu khong bien mat am tham.
 */
function isRepairCounted(backorder, state) {
  return Number(backorder) === 1
    && String(state == null ? '' : state).trim().toUpperCase() === 'O';
}

/**
 * Doi 1 gia tri ngay cua AMOS sang Date.
 * KHONG doan kieu du lieu: quyet dinh theo KIEU THAT driver tra ve.
 *   - Date  -> dung luon (cot Oracle kieu DATE)
 *   - so    -> SO NGAY ke tu @amosEpoch (cot Oracle kieu NUMBER, giong
 *              on_off.mutation / ROTABLES.MUTATION dang dung trong file nay)
 *   - chuoi -> thu parse ISO
 * Ket qua ra ngoai khoang 1990..2100 coi la KHONG hop le -> tra null (de con
 * hien "khong ro ngay" thay vi bia ra mot con so tuoi vo nghia).
 */
function amosValueToDate(v) {
  if (v === null || v === undefined || v === '') return null;
  let d = null;
  if (v instanceof Date) {
    d = v;
  } else if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()))) {
    const base = Date.parse(String(CONFIG.amosEpoch) + 'T00:00:00Z');
    d = new Date(base + Number(v) * 86400000);
  } else {
    d = new Date(String(v));
  }
  if (!d || !isFinite(d.getTime())) return null;
  const y = d.getUTCFullYear();
  return y >= 1990 && y <= 2100 ? d : null;
}

const _repairMemo = new Map();
/** Chay 1 lan cho ca 2 bao cao (tong hop + chi tiet) trong vong 60s. */
async function getRepairAdmin(f) {
  const key = JSON.stringify([f.station || '', f.store || '']);
  const hit = _repairMemo.get(key);
  if (hit && Date.now() - hit.t < 60 * 1000) return hit.p;
  const p = loadRepairAdmin(f);
  p.catch(() => _repairMemo.delete(key));
  _repairMemo.set(key, { t: Date.now(), p });
  if (_repairMemo.size > 20) {
    const oldest = [..._repairMemo.entries()].sort((a, b) => a[1].t - b[1].t)[0];
    if (oldest) _repairMemo.delete(oldest[0]);
  }
  return p;
}

/**
 * REPAIR ADMIN - LOCATION x ROTABLES x OD_DETAIL.
 *
 * Da DO THAT (/api/admin/diag/linkserver): phep NOI BANG tren linked server
 * KHONG phai cho cham - cai lam cham la cac HAM trong WHERE chan viec day dieu
 * kien xuong AMOS. (Da thu tach ra hoi tung bang roi truyen khoa sang bang ke
 * tiep - phuc tap hon ma khong nhanh hon, da bo.)
 *
 * Nen giu MOT cau noi 3 bang, nhung:
 *   - WHERE chi co dieu kien THUAN (so / chuoi dat TRUC TIEP, khong tham so @p
 *     vi tham so thuong khong duoc day xuong may chu tu xa);
 *   - SELECT chi lay COT THO (khong RTRIM) - cat got de lam o Node ben duoi.
 */
async function loadRepairAdmin(f) {
  const t0 = Date.now();
  // Dat gia tri TRUC TIEP vao cau lenh (khong dung @p) de dieu kien duoc day
  // xuong AMOS. Chuoi duoc nhan doi dau nhay -> khong the chen lenh.
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  let where = `WHERE l.[location_type] = ${Number(REPAIR_LOCATION_TYPE)} AND d.[status] = 0`;
  if (f.station) where += ` AND l.[station] = ${q(f.station)}`;
  if (f.store) where += ` AND l.[store] = ${q(f.store)}`;

  const rot = await query(
    `SELECT l.[locationno_i], l.[station], l.[store], l.[location],
            r.[partno], r.[serialno], r.[psn], r.[orderno], r.[orderdate], r.[labelno],
            d.[status] AS od_status, d.[state] AS od_state,
            d.[backorder] AS od_backorder, d.[ext_state] AS od_ext_state
     FROM [DWH_DB]..[STG_AMOS].[LOCATION] l
     JOIN [DWH_DB]..[STG_AMOS].[ROTABLES] r ON l.[locationno_i] = r.[locationno_i]
     JOIN [DWH_DB]..[STG_AMOS].[OD_DETAIL] d
       ON r.[psn] = d.[psn] AND r.[labelno] = d.[labelno]
     ${where}`
  );
  console.log(`[PERF] repair-admin: ${rot.length} dong (${Date.now() - t0}ms)`);
  const tr = (v) => (typeof v === 'string' ? v.trim() : v);

  // KHONG hoi [DWH_DB]..[STG_AMOS].[CONSUMABLES] nua: vat tu tieu hao khong co
  // cot [psn] nen khong noi duoc sang OD_DETAIL -> khong bao gio dat dieu kien
  // backorder = 1 & state = 'O', tuc moi dong deu bi loc bo. Giu lai chi ton
  // them mot luot hoi linked server ma khong ra dong nao.

  const now = Date.now();
  const items = [];
  for (const r of rot) {
    const d = amosValueToDate(r.orderdate);
    const age = d ? Math.floor((now - d.getTime()) / 86400000) : null;
    items.push({
      station: tr(r.station) || '', store: tr(r.store) || '', location: tr(r.location) || '',
      partno: tr(r.partno) || '', serialno: tr(r.serialno) || '',
      labelno: r.labelno ?? null, psn: r.psn ?? null,
      orderno: tr(r.orderno) || '', order_date_vn: d ? d.toISOString() : null,
      od_status: r.od_status ?? null,
      od_state: tr(r.od_state) || '',
      od_backorder: r.od_backorder ?? null,
      od_ext_state: tr(r.od_ext_state) || '',
      age_days: age,
      nhom: age === null ? 'unknown' : (age < REPAIR_AGE_DAYS ? 'less30' : 'over30'),
      tinh_tong_hop: isRepairCounted(r.od_backorder, r.od_state),
    });
  }
  return items;
}

/**
 * BAO CAO REPAIR ADMIN (mot tab duy nhat): tung thiet bi dang nam o vi tri U/S.
 * CHI tra ve cac dong dat OD_DETAIL.backorder = 1 AND state = 'O'
 * (status = 0 da loc trong cau SQL) - xem isRepairCounted().
 * Cac cot OD_DETAIL khong tra ra ngoai: chung chi dung de LOC, hien len bang
 * cung khong them thong tin gi vi moi dong deu co cung mot bo gia tri.
 * Bang tong hop (< 30 ngay / >= 30 ngay theo Station+Store+Vi tri) duoc dung
 * ngay tren trinh duyet tu chinh danh sach nay -> luon khop tuyet doi.
 */
async function qRepairAdmin(range, f) {
  const items = await getRepairAdmin(f);
  return items
    .filter((it) => it.tinh_tong_hop)
    .map(({ od_status, od_state, od_backorder, od_ext_state, tinh_tong_hop, ...rest }) => rest)
    .sort((a, b) => a.station.localeCompare(b.station)
      || a.location.localeCompare(b.location)
      || (b.age_days ?? -1) - (a.age_days ?? -1))
    .slice(0, CONFIG.maxRows);
}

// ---------------------------------------------------------------------------
// 5c. QUAN LY XUAT KHO (pickslip) - PICKSLIP_BOOKED x PICKSLIP_HEADER
//     Don vi dem: SO DONG (line), khong phai so luong QTY.
//     "Huy/tra": QTY_CANCELED > 0 (ke ca huy mot phan).
//     Ky bao cao: theo PICKSLIP_DATE.
// ---------------------------------------------------------------------------

/**
 * Do KIEU THAT cua mot cot ngay tren linked server (Date hay so ngay AMOS).
 * KHONG doan: lay 1 gia tri that roi xem driver tra ve kieu gi.
 * Da tung dinh loi nay o WO_PART_ON_OFF.CREATED_DATE (so ngay AMOS chu khong
 * phai datetime - doc nham ra nam 1954), nen o day do truoc khi dung.
 * Ket qua duoc cache theo tien trinh.
 */
const _dateKindCache = new Map();
async function detectDateKind(fullTable, col, expected) {
  const key = `${fullTable}.${col}`;
  if (_dateKindCache.has(key)) return _dateKindCache.get(key);
  // `expected` = kieu nghiep vu DA XAC NHAN. Dung lam mac dinh khi do that bai,
  // va canh bao neu do duoc mot kieu KHAC (du lieu doi hoac do sai).
  let kind = expected || 'date';
  try {
    const r = await query(`SELECT TOP 1 [${col}] AS v FROM ${fullTable} WHERE [${col}] IS NOT NULL`);
    const v = r.length ? r[0].v : null;
    let det = null;
    if (v instanceof Date) det = 'date';
    else if (typeof v === 'number') det = 'number';
    else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) det = 'number';
    if (det) {
      if (expected && det !== expected) {
        console.warn(`[SCHEMA] ${key}: nghiep vu bao '${expected}' nhung do duoc '${det}'`
          + ` -> dung '${det}'. Neu ngay hien sai, bao lai de chinh.`);
      }
      kind = det;
    }
    console.log(`[SCHEMA] ${key} -> ${kind}${expected ? ` (nghiep vu: ${expected})` : ''}`);
  } catch (e) {
    console.warn(`[SCHEMA] Khong do duoc kieu cua ${key}, dung mac dinh '${kind}':`, e.message);
  }
  _dateKindCache.set(key, kind);
  return kind;
}

/**
 * Keo du lieu pickslip cua ky ve bang tam #ps roi tra ve cac manh SQL dung lai.
 *
 * TOC DO: THU PHAM LA CAC HAM TRONG WHERE, KHONG PHAI PHEP NOI BANG.
 *   Da DO THAT bang /api/admin/diag/linkserver (ky 1 tuan, thang 7/2026):
 *
 *     PICKSLIP_BOOKED chi loc ngay (dieu kien thuan)      1.096 ms  81.452 dong
 *     PICKSLIP_BOOKED + bo loc nghiep vu (co ham)        22.806 ms  44.779 dong
 *     NOI CA 2 BANG, dieu kien ngay thuan                 1.080 ms   5.755 dong
 *
 *   => Phep noi 2 bang la NHANH NHAT trong nhom. Cai lam cham gap 21 lan la
 *      cac ham LOWER / RTRIM / ISNULL / TRY_CONVERT trong WHERE: chung chan
 *      SQL Server day dieu kien xuong may chu AMOS, nen AMOS phai tra ve rat
 *      nhieu dong roi moi loc tai cho.
 *   (Truoc do da thu tach ra hoi tung bang mot - CHAM HON, da bo.)
 *
 * VI VAY chia lam 2 buoc:
 *   #raw <- NOI 2 bang tren AMOS, chi lay COT THO, WHERE chi co dieu kien
 *           NGAY dang SO TRUC TIEP. Khong ham, khong tham so @p.
 *   #ps  <- tu #raw: cat got chuoi, phan loai Cancel/Return va ap bo loc
 *           nghiep vu - lam TAI CHO tren vai nghin dong nen khong ton gi.
 *
 * DIEU KIEN LOC DUNG SO TRUC TIEP, KHONG DUNG THAM SO (@p): voi linked server,
 * dieu kien co tham so thuong KHONG duoc day xuong may chu tu xa. Cac so nay do
 * server tu tinh (so ngay AMOS) nen khong co rui ro chen lenh.
 */
async function pickslipTemp(range, f) {
  // Nghiep vu da xac nhan: PICKSLIP_DATE la SO NGAY AMOS (khong phai datetime).
  const kindH = await detectDateKind(
    '[DWH_DB]..[STG_AMOS].[PICKSLIP_HEADER]', 'PICKSLIP_DATE', 'number');

  const d = amosDayExact(range);
  // SO TRUC TIEP, khong dung tham so @p
  const whereH = kindH === 'number'
    ? `h.[PICKSLIP_DATE] >= ${d.fromDayX} AND h.[PICKSLIP_DATE] < ${d.toDayX}`
    : 'h.[PICKSLIP_DATE] >= @from AND h.[PICKSLIP_DATE] < @to';

  // --- GIO CHINH XAC ---------------------------------------------------
  // PICKSLIP_DATE / MUTATION chi cho NGAY. Muon co GIO thi phai co them cot
  // MUTATION_TIME (so ms ke tu 00:00). Hai bang pickslip KHONG chac co cap
  // (MUTATION, MUTATION_TIME) o moi moi truong nen DO TRUOC, thieu thi lui ve
  // chi co ngay chu KHONG lam vo truy van.
  const H = '[DWH_DB]..[STG_AMOS].[PICKSLIP_HEADER]';
  const B = '[DWH_DB]..[STG_AMOS].[PICKSLIP_BOOKED]';
  const [hMut, hMutT, bMut, bMutT] = await Promise.all([
    remoteHasColumn(H, 'MUTATION'), remoteHasColumn(H, 'MUTATION_TIME'),
    remoteHasColumn(B, 'MUTATION'), remoteHasColumn(B, 'MUTATION_TIME'),
  ]);
  // Cot tho lay them (chi khi that su co) - van la COT THO nen khong lam cham
  const colH = (hMut ? ', h.[MUTATION] AS H_MUT' : '') + (hMutT ? ', h.[MUTATION_TIME] AS H_MUTT' : '');
  const colB = (bMut ? ', p.[MUTATION] AS B_MUT' : '') + (bMutT ? ', p.[MUTATION_TIME] AS B_MUTT' : '');

  // NGAY cua phieu (khong gio) - van la moc ky bao cao
  const dateVN = kindH === 'number'
    ? amosDayTimeToVN('r.[PICKSLIP_DATE]', null)
    : 'TRY_CONVERT(datetime, r.[PICKSLIP_DATE])';

  // GIO XUAT KHO - CAN THAN:
  //   [MUTATION] la lan SUA CUOI cua ban ghi, KHONG phai luc lap phieu. Da do
  //   that (/api/admin/diag/mutation-time): tren PICKSLIP_BOOKED co dong
  //   MUTATION = 19943 (07/08/2026) trong khi CREATED_DATE = 19701 (08/12/2025)
  //   - lech 8 THANG. Lay [MUTATION] lam gio xuat kho la SAI HAN.
  //   Chi khi MUTATION cua HEADER ROI DUNG VAO ngay phieu (PICKSLIP_DATE) thi
  //   MUTATION_TIME moi la gio lap phieu dang tin. Khong trung -> de TRONG,
  //   chi biet NGAY (thieu du lieu con hon so sai).
  const issueVN = (hMut && hMutT && kindH === 'number')
    ? `CASE WHEN TRY_CONVERT(float, r.[H_MUT]) = TRY_CONVERT(float, r.[PICKSLIP_DATE])
             THEN ${amosDayTimeToVN('r.[PICKSLIP_DATE]', 'r.[H_MUTT]')} END`
    : 'NULL';
  // Lan SUA CUOI cua ban ghi - chi de doi chieu, KHONG phai gio nghiep vu.
  const headerVN = hMut ? amosDayTimeToVN('r.[H_MUT]', hMutT ? 'r.[H_MUTT]' : null) : 'NULL';
  const bookedVN = bMut ? amosDayTimeToVN('r.[B_MUT]', bMutT ? 'r.[B_MUTT]' : null) : 'NULL';

  // PHAN LOAI theo DUOI cua PICKSLIP_TEXT (lay tu cong cu AMOS_GUI cua nguoi
  // dung): ket thuc bang 'cancel' / 'cancel booking' -> HUY; 'return' -> TRA.
  // Chi tinh khi QTY_CANCELED <> 0. Tinh TAI CHO tren #raw.
  const txt = "LOWER(RTRIM(ISNULL(r.[PICKSLIP_TEXT], '')))";
  const daHuy = 'TRY_CONVERT(float, r.[QTY_CANCELED]) <> 0';
  // QUAN TRONG: MOC de biet co huy/tra hay khong la QTY_CANCELED <> 0. Dong nao
  // QTY_CANCELED <> 0 ma PICKSLIP_TEXT KHONG co tu khoa nao thi VAN LA da
  // huy/tra - chi la chua biet thuoc loai nao. Truoc day cac dong do bi xep vao
  // 'NORMAL' (thuc xuat) => DEM THIEU so luong huy/tra. Nay tach rieng 'KHAC'.
  const loai = `CASE
        WHEN ${daHuy} AND (${txt} LIKE '%cancel' OR ${txt} LIKE '%cancel booking') THEN 'CANCEL'
        WHEN ${daHuy} AND ${txt} LIKE '%return' THEN 'RETURN'
        WHEN ${daHuy} THEN 'KHAC'
        ELSE 'NORMAL' END`;

  // BO LOC NGHIEP VU - lay nguyen tu cong cu AMOS_GUI:
  //   QTY_BOOKED <> 0; STATUS khong phai 1 va 11; LOCATION_FROM khong chua 'u/s';
  //   STORE ket thuc bang 'main' hoac 'vna'.
  // (STATUS NULL cung bi loai - giong pandas: NA <> 1 ra NA nen dong do rot.)
  // CHAY TAI CHO tren #raw, KHONG gui xuong AMOS - xem giai thich o tren.
  const bizFilter = `
      AND TRY_CONVERT(float, r.[QTY_BOOKED]) <> 0
      AND r.[STATUS] <> 1 AND r.[STATUS] <> 11
      AND LOWER(RTRIM(ISNULL(r.[LOCATION_FROM], ''))) NOT LIKE '%u/s%'
      AND (LOWER(RTRIM(ISNULL(r.[STORE], ''))) LIKE '%main'
        OR LOWER(RTRIM(ISNULL(r.[STORE], ''))) LIKE '%vna')`;

  const pull = `
    IF OBJECT_ID('tempdb..#raw') IS NOT NULL DROP TABLE #raw;
    IF OBJECT_ID('tempdb..#ps') IS NOT NULL DROP TABLE #ps;

    -- BUOC 1 (hoi AMOS): CHI lay COT THO + dieu kien NGAY dang SO TRUC TIEP.
    --   Khong RTRIM, khong ISNULL, khong TRY_CONVERT, khong tham so @p, khong
    --   bo loc nghiep vu -> AMOS nhan duoc mot cau don gian va loc duoc ngay.
    SELECT
      p.[PICKSLIPNO], p.[STATION], p.[STORE], p.[LOCATION_FROM],
      p.[PICKING_LISTNO_I], p.[PICKSLIPSEQNO_I], p.[PARTNO], p.[SERIALNO],
      p.[BATCHNO], p.[QTY_BOOKED], p.[QTY_CANCELED], p.[OWNER],
      p.[CREATED_BY], p.[STATUS],
      h.[PICKSLIP_DATE], h.[MECH_SIGN], h.[BOOKING_SIGN], h.[RECEIVER],
      h.[REMARKS], h.[PICKSLIP_TEXT]${colH}${colB}
    INTO #raw
    FROM [DWH_DB]..[STG_AMOS].[PICKSLIP_BOOKED] p
    JOIN [DWH_DB]..[STG_AMOS].[PICKSLIP_HEADER] h ON h.[PICKSLIPNO] = p.[PICKSLIPNO]
    WHERE ${whereH};

    -- BUOC 2 (TAI CHO): cat got chuoi, phan loai va ap bo loc nghiep vu tren
    --   #raw - da nam trong SQL Server nen cac ham nay khong ton gi.
    SELECT
      RTRIM(r.[STATION])       AS station,
      RTRIM(r.[STORE])         AS store,
      RTRIM(r.[LOCATION_FROM]) AS location_from,
      r.[PICKING_LISTNO_I]     AS picking_listno,
      RTRIM(r.[PICKSLIPNO])    AS pickslipno,
      r.[PICKSLIPSEQNO_I]      AS seqno,
      RTRIM(r.[PARTNO])        AS partno,
      ISNULL(LTRIM(RTRIM(r.[SERIALNO])), '') + ISNULL(LTRIM(RTRIM(r.[BATCHNO])), '') AS serialno,
      r.[QTY_BOOKED]           AS qty_booked,
      r.[QTY_CANCELED]         AS qty_canceled,
      ${loai}                  AS loai,
      CASE WHEN ${loai} = 'NORMAL' THEN 0 ELSE 1 END AS is_cancel,
      RTRIM(r.[OWNER])         AS owner,
      RTRIM(r.[CREATED_BY])    AS created_by,
      ${dateVN}                AS pickslip_date,
      ${issueVN}               AS issue_time_vn,
      ${headerVN}              AS header_time_vn,
      ${bookedVN}              AS booked_time_vn,
      -- Lan sua cuoi cua DONG: voi dong da huy thi day la moc gan nhat co the
      -- coi la luc huy, nhung KHONG chac (ban ghi con co the bi sua vi ly do
      -- khac) -> giao dien goi dung ten "Sua cuoi (dong)".
      CASE WHEN ${loai} = 'CANCEL' THEN ${bookedVN} END AS cancel_time_vn,
      RTRIM(r.[MECH_SIGN])     AS mech_sign,
      RTRIM(r.[BOOKING_SIGN])  AS booking_sign,
      RTRIM(r.[RECEIVER])      AS receiver,
      RTRIM(r.[REMARKS])       AS remarks,
      RTRIM(r.[PICKSLIP_TEXT]) AS pickslip_text
    INTO #ps
    FROM #raw r
    WHERE 1 = 1 ${bizFilter};
    CREATE INDEX IX_ps_mech ON #ps (mech_sign);
    DROP TABLE #raw;`;

  // Trung tam: SIGN theo MECH_SIGN (nguoi nhan hang), lui ve 'PA' - giong moi
  // bao cao khac. LEFT JOIN nen khong the lam mat dong.
  const dept = deptFromStaff('x.[mech_sign]', 'sm');
  const join = `FROM #ps x ${signJoin('x.[mech_sign]', 'sm')}`;
  return { pull, dept, join, drop: 'DROP TABLE #ps;' };
}

/** Bo loc station/store/department cho bang tam #ps. */
function pickslipWhere(f, dept, params) {
  let w = '';
  // AMOS_GUI loc station bang endswith (cot STATION co the la 'VNA-HAN'...)
  if (f.station) { params.fStation = f.station; w += " AND LOWER(x.station) LIKE '%' + LOWER(@fStation)"; }
  if (f.store) { params.fStore = f.store; w += ' AND x.store = @fStore'; }
  if (f.department) { params.fDepartment = f.department; w += ` AND ${dept} = @fDepartment`; }
  return w;
}

/**
 * PHIEU NHAP LAI KHO (return) cua cac dong "RETURN": tra ve theo PICKSLIPSEQNO_I.
 * Nguon: [STG_AMOS].HISTORY voi VM IN ('EA','TC') - dung y het cong cu AMOS_GUI.
 * MUTATION = SO NGAY AMOS -> ngay tra ve kho thuc te.
 *
 * LINKED SERVER: KHONG join theo tung dong. Goi theo LO (400 ID/lan) bang
 * "PICKSLIPSEQNO_I IN (@s0..@sN)" giong fetchWoInstalls().
 *
 * Mot seqno co the co NHIEU dong lich su (vd tra lam nhieu lan). Lay lan
 * SOM NHAT (MUTATION nho nhat) - do la lan tra ve dau tien, dung de tinh TAT.
 * @returns {Map<string, {historyno:number, return_date:Date, vm:string, so_lan:number}>}
 */
async function fetchReturnHistory(seqnos) {
  const out = new Map();
  const ids = [...new Set(seqnos.map((v) => idStr(v)).filter((v) => v && v !== '0'))];
  if (!ids.length) return out;
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const params = { amosEpoch: CONFIG.amosEpoch };
    const names = [];
    part.forEach((s, j) => { params['s' + j] = Number(s); names.push('@s' + j); });
    try {
      const res = await query(
        `SELECT TRY_CONVERT(bigint, HIS.[PICKSLIPSEQNO_I]) AS seqno,
                TRY_CONVERT(bigint, HIS.[HISTORYNO_I])     AS historyno,
                TRY_CONVERT(float,  HIS.[MUTATION])        AS mutation_day,
                -- NGAY (00:00) - de tinh so ngay tron nhu truoc
                ${amosDayTimeToVN('HIS.[MUTATION]', null)} AS return_date,
                -- NGAY GIO chinh xac (MUTATION_TIME = so ms ke tu 00:00) - gio VN
                ${amosDayTimeToVN('HIS.[MUTATION]', 'HIS.[MUTATION_TIME]')} AS return_time_vn,
                RTRIM(HIS.[VM]) AS vm
         FROM [DWH_DB]..[STG_AMOS].[HISTORY] HIS
         WHERE HIS.[PICKSLIPSEQNO_I] IN (${names.join(', ')})
           AND HIS.[VM] IN ('EA', 'TC')`,
        params
      );
      for (const r of res) {
        const k = idStr(r.seqno);
        const cur = out.get(k);
        if (!cur) out.set(k, { ...r, so_lan: 1 });
        else {
          cur.so_lan += 1;
          // Giu lan SOM NHAT
          if ((r.mutation_day ?? Infinity) < (cur.mutation_day ?? Infinity)) {
            Object.assign(cur, r, { so_lan: cur.so_lan });
          }
        }
      }
    } catch (e) {
      // Loi linked server -> KHONG lam vo bao cao: coi nhu chua tim thay phieu tra
      console.warn('[HISTORY] Khong lay duoc phieu tra (bo qua):', e.message);
      return out;
    }
  }
  return out;
}

/** So NGAY tron giua 2 moc (b - a). Tra null neu thieu mot dau. */
function dayDiff(a, b) {
  const da = a instanceof Date ? a : (a ? new Date(a) : null);
  const db = b instanceof Date ? b : (b ? new Date(b) : null);
  if (!da || !db || isNaN(da) || isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
}

/** So GIO giua 2 moc (b - a), lam tron 1 chu so thap phan. */
function hourDiff(a, b) {
  const da = a instanceof Date ? a : (a ? new Date(a) : null);
  const db = b instanceof Date ? b : (b ? new Date(b) : null);
  if (!da || !db || isNaN(da) || isNaN(db)) return null;
  return Math.round(((db - da) / 3600000) * 10) / 10;
}

/** Cac khoang TAT return de ve bieu do phan bo. */
const TAT_RETURN_BUCKETS = [
  { label: 'Trong ngay', min: -Infinity, max: 0 },
  { label: '1-3 ngay', min: 1, max: 3 },
  { label: '4-7 ngay', min: 4, max: 7 },
  { label: '8-14 ngay', min: 8, max: 14 },
  { label: '15-30 ngay', min: 15, max: 30 },
  { label: '> 30 ngay', min: 31, max: Infinity },
];

/**
 * BO SUNG cho tung dong pickslip (SUA TRUC TIEP tren `rows`):
 *   - scan        : SCANNED / CHUA_SCAN ('' neu khong doc duoc thu muc)
 *   - return_no   : <HISTORYNO_I>-R cua phieu nhap lai kho (NOT FOUND neu chua co)
 *   - return_date : ngay tra ve kho thuc te
 *   - tat_return  : SO NGAY tu ngay xuat kho (PICKSLIP_DATE) den ngay tra ve kho
 *   - return_scan : phieu tra da scan hay chua (cung thu muc picking list)
 *
 * DEM SCAN THEO **PHIEU**, TREN **TOAN KY** - khong dem theo dong va khong dem
 * tren `rows`. Hai ly do (nghiep vu yeu cau scan phai dat 100% nen so nay phai
 * dung tuyet doi):
 *   1. Mot picking list co NHIEU DONG. Dem theo dong thi mot phieu 50 dong chua
 *      scan hien thanh "50 chua scan", trong khi thuc te chi la 1 file can scan.
 *   2. `rows` da bi cat con TOP(MAX_ROWS). Ky lon thi cac phieu chua scan nam
 *      ngoai phan bi cat se BIEN MAT khoi KPI -> co the hien 100% trong khi thuc
 *      te van con thieu.
 * Vi vay danh sach phieu (`allPicking`) va danh sach dong Return (`allReturns`)
 * duoc lay RIENG bang SELECT DISTINCT tren #ps cho ca ky - danh sach nay nho
 * hon nhieu so voi bang chi tiet nen khong ton them dang ke.
 *
 * @param rows        bang chi tiet (da cat TOP) - chi dung de gan cot hien thi
 * @param allPicking  [{ pl_all }]              - phieu xuat DISTINCT ca ky
 * @param allReturns  [{ seq_ret, ngay_xuat }]  - dong Return DISTINCT ca ky
 */
async function enrichPickslipRows(rows, allPicking = [], allReturns = []) {
  const dirs = loadScanDirs();
  // MOI STATION MOT THU MUC (xem loadScanDirs): tra cuu theo station cua TUNG
  // dong, nho vay xem "Tat ca station" van doi chieu dung tung phieu.
  const index = await loadScanIndex(dirs.picking, 'prefix');

  // Hoi HISTORY cho TOAN BO dong Return cua ky (khong chi phan hien tren bang)
  const hist = allReturns.length
    ? await fetchReturnHistory(allReturns.map((r) => r.seq_ret))
    : new Map();

  const st = {
    daScan: 0, chuaScan: 0, tongPhieu: 0,
    daScanDong: 0, chuaScanDong: 0,
    returnCoPhieu: 0, returnKhongPhieu: 0,
    returnDaScan: 0, returnChuaScan: 0,
    tatReturnAvg: null, tatReturnMax: null,
    tatGioAvg: null, tatGioMax: null,
    soCoTat: 0, soChinhXacGio: 0,
  };

  // --- (1) Scan phieu xuat: dem theo PHIEU, ca ky ---
  for (const p of allPicking) {
    const s = scanStateTheoStation(index, p.station, idStr(p.pl_all));
    if (s === 'SCANNED') st.daScan += 1;
    else if (s === 'CHUA_SCAN') st.chuaScan += 1;
  }
  st.tongPhieu = st.daScan + st.chuaScan;

  // --- (2) Phieu tra + TAT return: cung tinh tren TOAN KY ---
  const tats = [];
  const gios = [];
  const buckets = TAT_RETURN_BUCKETS.map(() => 0);
  const theoTt = new Map(); // Trung tam -> { so, tongGio, maxGio }
  const retScanDone = new Set(); // moi phieu tra chi dem MOT lan
  for (const r of allReturns) {
    const h = hist.get(idStr(r.seq_ret));
    if (!h) { st.returnKhongPhieu += 1; continue; }
    st.returnCoPhieu += 1;
    const base = idStr(h.historyno);
    if (!retScanDone.has(base)) {
      retScanDone.add(base);
      const s = scanStateTheoStation(index, r.station, base);
      if (s === 'SCANNED') st.returnDaScan += 1;
      else if (s === 'CHUA_SCAN') st.returnChuaScan += 1;
    }
    const d = dayDiff(r.ngay_xuat, h.return_date);
    if (d !== null) {
      tats.push(d);
      const bi = TAT_RETURN_BUCKETS.findIndex((b) => d >= b.min && d <= b.max);
      if (bi >= 0) buckets[bi] += 1;
    }
    // TAT hoan kho theo GIO.
    //   Moc DAU  : gio xuat kho THAT neu biet, khong thi lui ve NGAY phieu.
    //   Moc CUOI : gio ve kho THAT neu biet, khong thi lui ve ngay tra.
    // Lui ve ngay chi kem chinh xac TRONG MOT NGAY - khac han viec dung
    // [MUTATION] cua dong booked (do duoc lech toi 8 THANG, da bo).
    // Truoc day bat buoc CA HAI dau phai co gio that nen bieu do "TAT hoan kho
    // theo Trung tam" gan nhu KHONG BAO GIO co du lieu - hien ra trong tron.
    const dau = r.gio_xuat || r.ngay_xuat;
    const cuoi = h.return_time_vn || h.return_date;
    const chinhXac = !!(r.gio_xuat && h.return_time_vn);
    const g = hourDiff(dau, cuoi);
    if (g !== null) {
      gios.push(g);
      if (chinhXac) st.soChinhXacGio += 1;
      const k = r.department || 'PA';
      const t = theoTt.get(k) || { so: 0, tongGio: 0, maxGio: 0, chinhXac: 0 };
      t.so += 1; t.tongGio += g; t.maxGio = Math.max(t.maxGio, g);
      if (chinhXac) t.chinhXac += 1;
      theoTt.set(k, t);
    }
  }
  if (tats.length) {
    st.tatReturnAvg = Math.round((tats.reduce((a, b) => a + b, 0) / tats.length) * 10) / 10;
    st.tatReturnMax = Math.max(...tats);
  }
  if (gios.length) {
    st.tatGioAvg = Math.round((gios.reduce((a, b) => a + b, 0) / gios.length) * 10) / 10;
    st.tatGioMax = Math.max(...gios);
  }
  st.soCoTat = gios.length;
  const ttSorted = [...theoTt.entries()].sort((a, b) => b[1].tongGio / b[1].so - a[1].tongGio / a[1].so);

  // --- (3) Gan cot hien thi cho tung dong cua bang chi tiet ---
  for (const r of rows) {
    r.scan = scanStateTheoStation(index, r.station, idStr(r.picking_listno));
    if (r.scan === 'SCANNED') st.daScanDong += 1;
    else if (r.scan === 'CHUA_SCAN') st.chuaScanDong += 1;

    r.return_no = '';
    r.return_date = null;
    r.return_time_vn = null;
    r.tat_return = null;
    r.tat_gio = null;
    r.tat_chinh_xac = false;
    r.return_scan = '';
    if (r.loai !== 'RETURN') continue;

    const h = hist.get(idStr(r.seqno));
    if (!h) { r.return_no = 'NOT FOUND'; continue; }
    const base = idStr(h.historyno);
    r.return_no = base + '-R';
    r.return_date = h.return_date;
    r.return_time_vn = h.return_time_vn || null;
    r.return_scan = scanStateTheoStation(index, r.station, base);
    r.tat_return = dayDiff(r.pickslip_date, h.return_date);
    // TAT den GIO. Thieu gio that o dau nao thi lui ve NGAY o dau do;
    // tat_chinh_xac cho biet dong nay co gio that ca hai dau khong.
    r.tat_gio = hourDiff(r.issue_time_vn || r.pickslip_date, h.return_time_vn || h.return_date);
    r.tat_chinh_xac = !!(r.issue_time_vn && h.return_time_vn);
  }

  return {
    stats: st,
    folder: scanIndexStatus(index, dirs.picking),
    charts: {
      tatReturn: { labels: TAT_RETURN_BUCKETS.map((b) => b.label), values: buckets },
      // TAT hoan kho TRUNG BINH (gio) theo tung Trung tam
      tatTheoTt: {
        labels: ttSorted.map(([k]) => k),
        gioTb: ttSorted.map(([, v]) => Math.round((v.tongGio / v.so) * 10) / 10),
        gioMax: ttSorted.map(([, v]) => Math.round(v.maxGio * 10) / 10),
        soDong: ttSorted.map(([, v]) => v.so),
        // Bao nhieu dong trong so do biet duoc GIO that (con lai lui ve ngay)
        soChinhXac: ttSorted.map(([, v]) => v.chinhXac),
      },
    },
  };
}

/**
 * DU LIEU TAB "QUAN LY XUAT KHO": KPI + bieu do + bang chi tiet.
 * Tat ca tinh tren #ps (da o local) nen nhieu phep gom cung chi ton 1 luot
 * hoi linked server duy nhat.
 */
async function qPickslip(range, f) {
  const params = { from: range.from, to: range.to, top: CONFIG.maxRows, ...amosDayParams(range) };
  const { pull, dept, join, drop } = await pickslipTemp(range, f);
  const w = pickslipWhere(f, dept, params);

  const text = `${pull}

    -- [0] KPI tong (don vi: SO DONG)
    SELECT COUNT(*) AS so_dong,
           SUM(CASE WHEN x.loai = 'CANCEL' THEN 1 ELSE 0 END) AS so_cancel,
           SUM(CASE WHEN x.loai = 'RETURN' THEN 1 ELSE 0 END) AS so_return,
           SUM(CASE WHEN x.loai = 'KHAC' THEN 1 ELSE 0 END) AS so_khac,
           SUM(x.is_cancel) AS so_dong_huy,
           COUNT(DISTINCT x.pickslipno) AS so_phieu,
           COUNT(DISTINCT CASE WHEN x.is_cancel = 1 THEN x.pickslipno END) AS so_phieu_co_huy
    ${join} WHERE 1 = 1 ${w};

    -- [1] Theo Trung tam
    SELECT ${dept} AS department, COUNT(*) AS so_dong,
           SUM(CASE WHEN x.loai = 'CANCEL' THEN 1 ELSE 0 END) AS so_cancel,
           SUM(CASE WHEN x.loai = 'RETURN' THEN 1 ELSE 0 END) AS so_return,
           SUM(CASE WHEN x.loai = 'KHAC' THEN 1 ELSE 0 END) AS so_khac
    ${join} WHERE 1 = 1 ${w}
    GROUP BY ${dept};

    -- [2] Theo NGAY (xu huong)
    SELECT CAST(x.pickslip_date AS date) AS ngay,
           COUNT(*) AS so_dong, SUM(x.is_cancel) AS so_dong_huy
    ${join} WHERE x.pickslip_date IS NOT NULL ${w}
    GROUP BY CAST(x.pickslip_date AS date)
    ORDER BY CAST(x.pickslip_date AS date);

    -- [3] Top Part No bi huy nhieu nhat
    SELECT TOP 10 x.partno AS partno, COUNT(*) AS so_dong_huy
    ${join} WHERE x.is_cancel = 1 ${w}
    GROUP BY x.partno
    ORDER BY COUNT(*) DESC;

    -- [4] Bang chi tiet
    SELECT TOP (@top)
      x.station, x.store, x.location_from, x.picking_listno, x.pickslipno, x.seqno,
      x.partno, x.serialno, x.qty_booked, x.qty_canceled, x.loai, x.is_cancel,
      x.owner, x.created_by, x.pickslip_date,
      x.issue_time_vn, x.booked_time_vn, x.header_time_vn, x.cancel_time_vn,
      x.mech_sign, x.booking_sign,
      ${dept} AS department,
      x.receiver, x.remarks, x.pickslip_text
    ${join} WHERE 1 = 1 ${w}
    ORDER BY x.pickslip_date DESC, x.pickslipno DESC;

    -- [5] DANH SACH PHIEU XUAT (distinct) cua TOAN KY.
    --     Dung de dem "da/chua scan" theo PHIEU va KHONG bi cat boi TOP(@top)
    --     nhu bang chi tiet - nghiep vu yeu cau scan dat 100% nen so nay phai
    --     phu het ky, khong duoc thieu.
    SELECT x.picking_listno AS pl_all, MIN(x.station) AS station
    ${join} WHERE 1 = 1 ${w}
    GROUP BY x.picking_listno;

    -- [6] CAC DONG RETURN cua TOAN KY: ngay GIO xuat kho + Trung tam, de tinh
    --     TAT hoan kho chinh xac den GIO va tach duoc theo tung Trung tam.
    SELECT x.seqno AS seq_ret,
           MIN(x.pickslip_date)   AS ngay_xuat,
           MIN(x.issue_time_vn)   AS gio_xuat,
           MIN(x.station)         AS station,
           MIN(${dept})           AS department
    ${join} WHERE x.loai = 'RETURN' ${w}
    GROUP BY x.seqno;

    ${drop}`;

  const tSql = Date.now();
  const sets = await queryMulti(text, params);
  console.log(`[PERF] pickslip: SQL ${Date.now() - tSql}ms (ky ${range.from} -> ${range.to})`);
  const pick = (k) => sets.find((s) => s.length && k in s[0]) || [];
  const kpi = (pick('so_phieu')[0]) || {};
  const byDept = pick('department').filter((r) => 'so_cancel' in r);
  const byDay = pick('ngay');
  const topPart = pick('partno').filter((r) => 'so_dong_huy' in r && !('station' in r));
  const rows = sets.find((s) => s.length && 'pickslipno' in s[0] && 'remarks' in s[0]) || [];

  // --- DOI CHIEU FILE SCAN + PHIEU TRA + TAT RETURN (tinh o Node, khong SQL) ---
  const scan = await enrichPickslipRows(rows, pick('pl_all'), pick('seq_ret'));

  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const deptSorted = [...byDept].sort((a, b) => b.so_dong - a.so_dong);
  const sc = scan.stats;
  return {
    range: { from: range.from, to: range.to, label: range.label },
    kpis: {
      soDong: kpi.so_dong || 0,
      soCancel: kpi.so_cancel || 0,
      soReturn: kpi.so_return || 0,
      soKhac: kpi.so_khac || 0,
      soDongHuy: kpi.so_dong_huy || 0,
      soDongThuc: (kpi.so_dong || 0) - (kpi.so_dong_huy || 0),
      tyLeHuy: pct(kpi.so_dong_huy || 0, kpi.so_dong || 0),
      soPhieu: kpi.so_phieu || 0,
      soPhieuCoHuy: kpi.so_phieu_co_huy || 0,
      tyLePhieuCoHuy: pct(kpi.so_phieu_co_huy || 0, kpi.so_phieu || 0),
      // Doi chieu file scan - dem theo PHIEU (picking list), tinh tren TOAN KY
      daScan: sc.daScan,
      chuaScan: sc.chuaScan,
      tongPhieuScan: sc.tongPhieu,
      tyLeScan: pct(sc.daScan, sc.tongPhieu),
      // Theo DONG (chi de doi chieu voi bang chi tiet, co the bi cat boi MAX_ROWS)
      daScanDong: sc.daScanDong,
      chuaScanDong: sc.chuaScanDong,
      // Phieu tra + TAT return
      returnCoPhieu: sc.returnCoPhieu,
      returnKhongPhieu: sc.returnKhongPhieu,
      tatReturnAvg: sc.tatReturnAvg,
      tatReturnMax: sc.tatReturnMax,
      // Chinh xac den GIO (chi tinh duoc khi AMOS co cot MUTATION_TIME)
      tatGioAvg: sc.tatGioAvg,
      tatGioMax: sc.tatGioMax,
      soCoTat: sc.soCoTat,
      soChinhXacGio: sc.soChinhXacGio,
      returnDaScan: sc.returnDaScan,
      returnChuaScan: sc.returnChuaScan,
    },
    scanFolder: scan.folder,
    charts: {
      tatReturn: scan.charts.tatReturn,
      tatTheoTt: scan.charts.tatTheoTt,
      byDept: {
        labels: deptSorted.map((r) => r.department),
        thuc: deptSorted.map((r) => r.so_dong - r.so_cancel - r.so_return - (r.so_khac || 0)),
        cancel: deptSorted.map((r) => r.so_cancel),
        ret: deptSorted.map((r) => r.so_return),
        khac: deptSorted.map((r) => r.so_khac || 0),
        tyLe: deptSorted.map((r) => pct(r.so_cancel + r.so_return + (r.so_khac || 0), r.so_dong)),
      },
      byDay: {
        labels: byDay.map((r) => (r.ngay instanceof Date ? r.ngay.toISOString().slice(0, 10) : String(r.ngay).slice(0, 10))),
        soDong: byDay.map((r) => r.so_dong),
        tyLe: byDay.map((r) => pct(r.so_dong_huy, r.so_dong)),
      },
      topPart: {
        labels: topPart.map((r) => r.partno),
        values: topPart.map((r) => r.so_dong_huy),
      },
    },
    rows,
    count: rows.length,
    truncated: rows.length >= CONFIG.maxRows,
  };
}

// ---------------------------------------------------------------------------
// 5d. RECEIVING (nhap kho) - [STG_AMOS].HISTORY, VM = 'B1'
//     Nghiep vu (lay tu cong cu AMOS_GUI cua nguoi dung):
//       - Keo ca VM 'B1' (phieu nhap) va 'CR' (huy nhap) trong ky theo DEL_DATE.
//       - LOAI BO dong B1 nao co RECDETAILNO_I trung voi mot dong CR
//         -> do la phieu nhap DA BI HUY.
//       - Loc: STATION CHUA station chon; CONDITION KHONG chua 'us';
//         STORE ket thuc 'main' hoac 'vna'; loai rieng STORE = 'main' ma
//         LOCATION thuoc ('shoploc','lg5').
//       - Doi chieu file scan: ten file PDF = VOUCHERNO (da bo tien to 'R-').
// ---------------------------------------------------------------------------

/**
 * Khoang SO NGAY AMOS CHINH XAC cua ky (khong dem +/-2 nhu amosDayParams).
 * Dung cho cot chi co NGAY (DEL_DATE) - khong co gio nen khong lech mui gio.
 */
function amosDayExact(range) {
  const epoch = new Date(CONFIG.amosEpoch + 'T00:00:00Z');
  const DAY = 86400000;
  return {
    fromDayX: Math.floor((new Date(String(range.from) + 'Z') - epoch) / DAY),
    toDayX: Math.floor((new Date(String(range.to) + 'Z') - epoch) / DAY),
  };
}

async function qReceiving(range, f) {
  const dx = amosDayExact(range);
  // SO TRUC TIEP, khong dung tham so @p (tham so hay chan viec day dieu kien
  // xuong may chu AMOS - xem giai thich o pickslipTemp).
  const dFrom = dx.fromDayX;
  const dTo = dx.toDayX;
  const params = {
    from: range.from, to: range.to, top: CONFIG.maxRows,
    amosEpoch: CONFIG.amosEpoch, ...dx,
  };
  const d2v = (col) =>
    `DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, ${col})), TRY_CONVERT(datetime, @amosEpoch))`;

  // Trung tam: theo nguoi tao phieu (CREATED_BY), lui ve 'PA' - giong cac bao
  // cao khac. LEFT JOIN SIGN nen khong the lam mat dong.
  // NGHIEP VU: phieu NHAP kho thong ke theo STATION va STORE, KHONG theo Trung
  // tam (nhap kho la viec cua kho, khong quy ve trung tam bao duong).
  // -> khong can noi sang bang SIGN nua, bot mot phep noi o moi cau.

  // Bo loc nghiep vu (nguyen van tu AMOS_GUI). STATION dung CONTAINS.
  let w = `
      AND LOWER(ISNULL(x.tinh_trang, '')) NOT LIKE '%us%'
      AND (LOWER(x.store) LIKE '%main' OR LOWER(x.store) LIKE '%vna')
      AND NOT (LOWER(x.store) = 'main' AND LOWER(x.location) IN ('shoploc', 'lg5'))`;
  if (f.station) { params.fStation = f.station; w += " AND LOWER(x.station) LIKE '%' + LOWER(@fStation) + '%'"; }
  if (f.store) { params.fStore = f.store; w += ' AND x.store = @fStore'; }

  // Dong B1 con hieu luc = khong co dong CR nao cung RECDETAILNO_I
  const conLai = `x.vm = 'B1' AND NOT EXISTS (
        SELECT 1 FROM #hi c WHERE c.vm = 'CR' AND c.recdetailno = x.recdetailno)`;

  const text = `
    IF OBJECT_ID('tempdb..#hraw') IS NOT NULL DROP TABLE #hraw;
    IF OBJECT_ID('tempdb..#hi') IS NOT NULL DROP TABLE #hi;

    -- BUOC 1 (hoi AMOS): CHI cot THO, WHERE chi co dieu kien thuan (VM va
    --   khoang ngay dang SO TRUC TIEP). Khong RTRIM/TRY_CONVERT/DATEADD o day:
    --   da do duoc rang cac ham trong cau gui xuong AMOS lam cham gap nhieu lan.
    SELECT
      h.[VOUCHERNO], h.[PARTNO], h.[SERIALNO], h.[BATCHNO], h.[PSN], h.[LABELNO],
      h.[HISTORYNO_I], h.[RECDETAILNO_I], h.[STATION], h.[STORE], h.[LOCATION],
      h.[VM], h.[CONDITION], h.[MAT_CLASS], h.[ORDERNO], h.[OWNER], h.[CREATED_BY],
      h.[QTY], h.[DEL_DATE], h.[ORDERDATE], h.[MUTATION]
    INTO #hraw
    FROM [DWH_DB]..[STG_AMOS].[HISTORY] h
    WHERE h.[VM] IN ('B1', 'CR')
      AND h.[DEL_DATE] >= ${dFrom} AND h.[DEL_DATE] < ${dTo};

    -- BUOC 2 (TAI CHO): cat got chuoi + doi ngay AMOS sang datetime.
    SELECT
      RTRIM(h.[VOUCHERNO])                  AS voucherno,
      RTRIM(h.[PARTNO])                     AS partno,
      RTRIM(h.[SERIALNO])                   AS serialno,
      RTRIM(h.[BATCHNO])                    AS batchno,
      RTRIM(h.[PSN])                        AS psn,
      RTRIM(h.[LABELNO])                    AS labelno,
      TRY_CONVERT(bigint, h.[HISTORYNO_I])  AS historyno,
      TRY_CONVERT(bigint, h.[RECDETAILNO_I]) AS recdetailno,
      RTRIM(h.[STATION])                    AS station,
      RTRIM(h.[STORE])                      AS store,
      RTRIM(h.[LOCATION])                   AS location,
      RTRIM(h.[VM])                         AS vm,
      RTRIM(h.[CONDITION])                  AS tinh_trang,
      RTRIM(h.[MAT_CLASS])                  AS mat_class,
      RTRIM(h.[ORDERNO])                    AS orderno,
      RTRIM(h.[OWNER])                      AS owner,
      RTRIM(h.[CREATED_BY])                 AS created_by,
      TRY_CONVERT(float, h.[QTY])           AS qty,
      ${d2v('h.[DEL_DATE]')}                AS del_date,
      ${d2v('h.[ORDERDATE]')}               AS orderdate,
      ${d2v('h.[MUTATION]')}                AS mutation_date
    INTO #hi
    FROM #hraw h;
    DROP TABLE #hraw;
    CREATE INDEX IX_hi_rec ON #hi (recdetailno);
    CREATE INDEX IX_hi_by  ON #hi (created_by);

    -- [0] Dem tong quan (truoc/sau khi loai phieu huy nhap)
    --     LUU Y: KHONG duoc dat EXISTS(...) BEN TRONG SUM(). SQL Server bao
    --     "Cannot perform an aggregate function on an expression containing an
    --     aggregate or a subquery". Vi vay danh dau co_cr o mot lop SELECT ben
    --     trong, lop ngoai chi cong tren cot thuong.
    SELECT
      SUM(CASE WHEN t.vm = 'B1' THEN 1 ELSE 0 END) AS b1_tho,
      SUM(CASE WHEN t.vm = 'CR' THEN 1 ELSE 0 END) AS cr_huy,
      SUM(CASE WHEN t.vm = 'B1' AND t.co_cr = 1 THEN 1 ELSE 0 END) AS b1_bi_huy
    FROM (
      SELECT x.vm,
             CASE WHEN EXISTS (SELECT 1 FROM #hi c
                               WHERE c.vm = 'CR' AND c.recdetailno = x.recdetailno)
                  THEN 1 ELSE 0 END AS co_cr
      FROM #hi x
    ) t;

    -- [1] Tong so dong sau khi loc (de biet bang chi tiet co bi cat khong)
    SELECT COUNT(*) AS tong_dong, COUNT(DISTINCT x.voucherno) AS tong_phieu
    FROM #hi x WHERE ${conLai} ${w};

    -- [2] Bang chi tiet
    SELECT TOP (@top)
      x.station, x.store, x.location, x.voucherno, x.partno, x.serialno, x.batchno,
      x.psn, x.labelno, x.qty, x.tinh_trang, x.mat_class, x.orderno, x.orderdate,
      x.del_date, x.mutation_date, x.owner, x.created_by,
      x.historyno, x.recdetailno
    FROM #hi x WHERE ${conLai} ${w}
    ORDER BY x.del_date DESC, x.voucherno;

    -- [3] DANH SACH VOUCHER (distinct) cua TOAN KY - de dem "da/chua scan"
    --     theo PHIEU (mot voucher co nhieu dong) va KHONG bi cat boi TOP(@top).
    --     Nghiep vu yeu cau scan dat 100% nen so nay phai phu het ky.
    SELECT x.voucherno AS vc_all, MIN(x.station) AS station, MIN(x.store) AS store
    FROM #hi x WHERE ${conLai} ${w}
    GROUP BY x.voucherno;

    DROP TABLE #hi;`;

  const sets = await queryMulti(text, params);
  const pick = (k) => sets.find((s) => s.length && k in s[0]) || [];
  const cnt = pick('b1_tho')[0] || {};
  const tot = pick('tong_dong')[0] || {};
  const rows = pick('voucherno').filter((r) => 'del_date' in r);

  // --- Doi chieu file scan PDF (ten file = VOUCHERNO da bo tien to 'R-') ---
  //     KPI + bieu do dem theo PHIEU (voucher) tren TOAN KY; bang chi tiet van
  //     theo dong. Xem giai thich o enrichPickslipRows().
  const vouchers = pick('vc_all');
  const dirs = loadScanDirs();
  // MOI STATION MOT THU MUC - tra cuu theo station cua tung voucher
  const index = await loadScanIndex(dirs.receiving, 'full');
  // TEN FILE SCAN KHAC NHAU THEO STATION:
  //   HAN bo tien to 'R-'  -> file '259454.pdf'
  //   SGN giu nguyen       -> file 'R-259454.pdf'
  // Thu CA HAI dang, khop dang nao cung coi la da scan. Hai dang deu tro ve
  // CUNG mot voucher nen khong the nham sang phieu khac.
  const scanKeys = (v) => {
    const raw = String(v || '').trim();
    const bo = raw.replace(/^R-/i, '').trim();
    return [...new Set([raw, bo].filter(Boolean))];
  };

  let daScan = 0;
  let chuaScan = 0;
  // Thong ke theo STATION va STORE (khong theo Trung tam - xem ghi chu o tren)
  const byStation = new Map();
  const byStore = new Map();
  const gom = (map, khoa, s) => {
    const k = (khoa || '').trim() || '(trống)';
    if (!map.has(k)) map.set(k, { daScan: 0, chuaScan: 0, tong: 0 });
    const g = map.get(k);
    g.tong += 1;
    if (s === 'SCANNED') g.daScan += 1; else if (s === 'CHUA_SCAN') g.chuaScan += 1;
  };
  for (const v of vouchers) {
    const { trangThai: s } = scanStateNhieuKhoa(index, v.station, scanKeys(v.vc_all));
    if (s === 'SCANNED') daScan += 1;
    else if (s === 'CHUA_SCAN') chuaScan += 1;
    gom(byStation, v.station, s);
    gom(byStore, v.store, s);
  }

  const byDay = new Map();
  let daScanDong = 0;
  let chuaScanDong = 0;
  for (const r of rows) {
    const ung = scanKeys(r.voucherno);
    const kq = scanStateNhieuKhoa(index, r.station, ung);
    r.scan = kq.trangThai;
    // Tim thay thi hien DUNG ten file da khop; chua thay thi liet ke ca hai
    // dang de nguoi dung biet can dat ten the nao.
    r.voucher_scan = kq.khoaKhop || ung.join(' hoặc ');
    if (r.scan === 'SCANNED') daScanDong += 1;
    else if (r.scan === 'CHUA_SCAN') chuaScanDong += 1;
    const day = r.del_date instanceof Date ? r.del_date.toISOString().slice(0, 10) : String(r.del_date || '').slice(0, 10);
    if (day) byDay.set(day, (byDay.get(day) || 0) + 1);
  }

  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const xepTheoTong = (m) => [...m.entries()].sort((a, b) => b[1].tong - a[1].tong);
  const stationSorted = xepTheoTong(byStation);
  const storeSorted = xepTheoTong(byStore);
  const daySorted = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return {
    range: { from: range.from, to: range.to, label: range.label },
    kpis: {
      soDong: tot.tong_dong || 0,
      soPhieu: tot.tong_phieu || 0,
      b1Tho: cnt.b1_tho || 0,
      crHuy: cnt.cr_huy || 0,
      b1BiHuy: cnt.b1_bi_huy || 0,
      daScan: daScan,
      chuaScan: chuaScan,
      tongPhieuScan: daScan + chuaScan,
      tyLeScan: pct(daScan, daScan + chuaScan),
      daScanDong, chuaScanDong,
    },
    scanFolder: scanIndexStatus(index, dirs.receiving),
    charts: {
      byStation: {
        labels: stationSorted.map(([k]) => k),
        daScan: stationSorted.map(([, v]) => v.daScan),
        chuaScan: stationSorted.map(([, v]) => v.chuaScan),
      },
      byStore: {
        labels: storeSorted.map(([k]) => k),
        daScan: storeSorted.map(([, v]) => v.daScan),
        chuaScan: storeSorted.map(([, v]) => v.chuaScan),
      },
      byDay: {
        labels: daySorted.map(([k]) => k),
        values: daySorted.map(([, v]) => v),
      },
    },
    rows,
    count: rows.length,
    truncated: rows.length >= CONFIG.maxRows,
  };
}

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
      r.[labelno]     AS labelno,
      r.[voucher_s]   AS voucher_issue,
      r.[on_ac]       AS note
    FROM [NQT].[dbo].[real_us1] r
    ${signJoin('r.[action_per]', 'sm')}
    WHERE r.[on_ac] IS NOT NULL AND LTRIM(RTRIM(r.[on_ac])) <> ''
      -- Ke ca ban ghi chua co del_time (del_time null/sentinel van la note "other")
      AND (r.[del_time] IS NULL OR r.[del_time] < '1902-01-01'
           OR (r.[del_time] >= @from AND r.[del_time] < @to))
      ${where}
    ORDER BY r.[del_time] DESC`;
  const rows = await query(text, params);
  // Giai ma ma ly do -> them cot rieng de LOC / DEM / xuat Excel duoc
  return rows.map((r) => {
    const d = decodeOnAc(r.note);
    return { ...r, reason_code: d ? d.code : '', reason_name: d ? d.name : 'Khác / chưa phân loại' };
  });
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

  // [0] va [6] co dong real_us1 -> Trung tam lay tu real_us1 (deptR).
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

    -- [1] TAT CUVT theo Trung tam (chang 3: tra US -> CUVT nhan).
    --     GROUP BY de xep chong duoc vao bieu do; tong the = trung binh CO TRONG SO
    --     theo cnt (bang dung AVG tren toan bo dong).
    SELECT ${deptR} AS department, COUNT(*) AS cnt,
           AVG(CAST(DATEDIFF(MINUTE, r.[del_time], r.[reci_time]) AS float) / 1440.0) AS avg_tat
    FROM [NQT].[dbo].[real_us1] r
    ${signJoin('r.[action_per]', 'sm')}
    WHERE r.[del_time] IS NOT NULL AND r.[reci_time] IS NOT NULL
      AND r.[reci_time] >= r.[del_time]
      AND r.[del_time] >= @from AND r.[del_time] < @to
      ${wCuvt}
    GROUP BY ${deptR};

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
      ${manualPairExclude('k', params, range)}
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
      -- (b) da doi ung kieu TRA SERVICE (recertify)
      SELECT k.[station]
      FROM [NQT].[dbo].[kho_ser1] k
      ${recertApply('k')}
      ${signJoin('k.[created_b2]', 'sm')}
      WHERE ${khoBase}
        ${svcWhere}
      UNION ALL
      -- (c) CHUA doi ung - phai co mat thi bieu do tron moi dem CUNG MOT TAP
      --     voi bieu do cot "So luong xuat kho" (da tra + chua tra). Dieu kien
      --     giong het [3] Chua doi ung theo Trung tam.
      SELECT k.[station]
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
        AND NOT ${recertExists('k')}
        ${manualPairExclude('k', params, range)}
        AND k.[mutation] BETWEEN @fromDay AND @toDay
        AND ${amosToVN('k')} >= @from AND ${amosToVN('k')} < @to
        ${wNotRec}
    ) s
    GROUP BY s.station;`;

  const [deptAgg, cuvtAgg, retAgg, notRecAgg, retUSAgg, niAgg, stationAgg] = await queryMulti(text, params);
  return { deptAgg, cuvtAgg, retAgg, notRecAgg, retUSAgg, niAgg: niAgg[0], stationAgg };
}

/** Dung ket qua aggregate SQL de tao KPI + charts (chinh xac tren toan bo du lieu). */
function buildDashboardFromAgg(range, agg, f) {
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
  const cuvtAgg = agg.cuvtAgg || [];
  const cntReci = sum(cuvtAgg, (x) => x.cnt);
  const cntDel = sum(agg.retUSAgg, (x) => x.cnt);

  // 3 chang cua CUNG mot vong doi -> cong lai = TAT tong:
  //   [1] install: xuat kho -> lap len tau
  //   [2] US return: thao khoi tau -> tra unservice
  //   [3] CUVT: tra unservice -> CUVT nhan
  const tatInstallAvg = round1(wavgBy(deptTat, 'avg_install', 'cnt_install'));
  const tatUsReturnAvg = round1(wavgBy(deptTat, 'avg_usret', 'cnt_usret'));
  const tatCuvtAvg = round1(wavgBy(cuvtAgg, 'avg_tat', 'cnt'));
  // So cap doi ung THU CONG thuoc ky nay (loc theo gio xuat + bo loc dang chon)
  const manualCnt = countManualPairsInRange(range, f);

  const kpis = {
    // TAT tach 3 thanh phan + TAT TONG (cong 3 chang)
    tatInstallAvg,
    tatUsReturnAvg,
    tatCuvtAvg,
    tatTotalAvg: round1(tatInstallAvg + tatUsReturnAvg + tatCuvtAvg),
    tatReturnStoreAvg: round1(wavg(agg.retAgg)),
    // Cap doi ung THU CONG (label lech, nguoi dung da xac nhan) -> tinh la DA
    // doi ung: da bi loai khoi notRec o SQL nen cong vao 'reconciled' de tong
    // so thiet bi xuat kho khong doi.
    countIssued: reconciled + manualCnt + notRec,
    countNotReconciled: notRec,
    countManualPaired: manualCnt,
    countIssuedNotInstalled: agg.niAgg?.cnt || 0,
    reconcileRate: reconciled + manualCnt + notRec
      ? round1(((reconciled + manualCnt) / (reconciled + manualCnt + notRec)) * 100) : 0,
    cntReci,
    cntDel,
  };

  // Bieu do cot XEP CHONG theo Trung tam: 3 chang cong don = TAT tong cua don vi.
  // Sap xep theo TONG 3 chang (cot cao nhat = don vi cham nhat toan chuoi).
  const cuvtByDept = new Map(cuvtAgg.map((x) => [x.department, round1(x.avg_tat)]));
  const stackTotal = (x) =>
    (x.avg_install || 0) + (x.avg_usret || 0) + (cuvtByDept.get(x.department) || 0);
  const byDept = [...deptTat].sort((a, b) => stackTotal(b) - stackTotal(a));
  const barDept = {
    labels: byDept.map((x) => x.department),
    install: byDept.map((x) => round1(x.avg_install)),
    usret: byDept.map((x) => round1(x.avg_usret)),
    cuvt: byDept.map((x) => cuvtByDept.get(x.department) || 0),
    total: byDept.map((x) => round1(stackTotal(x))),
    counts: byDept.map((x) => x.cnt),
  };

  const byRet = [...agg.retAgg].sort((a, b) => (b.avg_tat || 0) - (a.avg_tat || 0));
  const retStoreDept = {
    labels: byRet.map((x) => x.department),
    values: byRet.map((x) => round1(x.avg_tat)),
    counts: byRet.map((x) => x.cnt),
  };

  // So luong xuat kho theo Trung tam, TACH LAM 2 phan de xep chong:
  //   daTra   = da doi ung (deptAgg) + cap doi ung THU CONG cua trung tam do
  //   chuaTra = chua doi ung (notRecAgg)
  // Cong lai = tong so thiet bi xuat kho, khop voi KPI countIssued.
  const daTraCnt = new Map();
  for (const x of agg.deptAgg) daTraCnt.set(x.department, (daTraCnt.get(x.department) || 0) + x.cnt);
  for (const p of manualPairsInRange(range, f)) {
    const k = String(p.department || 'PA').trim() || 'PA';
    daTraCnt.set(k, (daTraCnt.get(k) || 0) + 1);
  }
  const chuaTraCnt = new Map(agg.notRecAgg.map((x) => [x.department, x.cnt]));
  const returnedCnt = new Map(agg.retUSAgg.map((x) => [x.department, x.cnt]));
  const tong = (k) => (daTraCnt.get(k) || 0) + (chuaTraCnt.get(k) || 0);
  const volLabels = [...new Set([...daTraCnt.keys(), ...chuaTraCnt.keys()])].sort(
    (a, b) => tong(b) - tong(a)
  );
  const deptVolume = {
    labels: volLabels,
    daTra: volLabels.map((k) => daTraCnt.get(k) || 0),
    chuaTra: volLabels.map((k) => chuaTraCnt.get(k) || 0),
    // Giu 2 truong cu (tong xuat kho / so dong tra US trong ky) de khong lam vo
    // cac cho khac dang dung; bieu do chinh dung daTra + chuaTra.
    issued: volLabels.map(tong),
    returned: volLabels.map((k) => returnedCnt.get(k) || 0),
  };

  // Bieu do tron: KHI CHUA CHON STATION -> chia theo STATION (HAN/SGN/DAD/Khac).
  // KHI DA CHON 1 STATION cu the -> chia theo STATION khong con y nghia (chi con
  // 1 mieng) nen chuyen sang chia theo TRUNG TAM trong station do.
  // Truong groupBy cho frontend biet de doi tieu de va khoa drill-down.
  //
  // CA HAI che do dem CUNG MOT TAP = TAT CA thiet bi xuat kho trong ky
  // (da tra + chua tra) -> khop voi bieu do cot "So luong xuat kho theo Trung
  // tam" va voi KPI "Thiet bi xuat kho". agg.stationAgg da gom 3 nhanh
  // (tra US + tra service + chua doi ung); cap doi ung THU CONG khong nam
  // trong nhanh nao nen cong them o day.
  let pieStation;
  if (f && f.station) {
    // Sap theo so luong giam dan (volLabels da sap theo TONG nhung loc lai cho chac)
    const pieLabels = volLabels.filter((k) => tong(k) > 0).sort((a, b) => tong(b) - tong(a));
    pieStation = {
      groupBy: 'department',
      labels: pieLabels,
      values: pieLabels.map(tong),   // = daTra + chuaTra, khop bieu do cot
    };
  } else {
    const stMap = new Map(MAIN_STATIONS.map((s) => [s, 0]));
    stMap.set('OTHER', 0);
    for (const x of agg.stationAgg) {
      const k = normalizeStation(x.station);
      stMap.set(k, (stMap.get(k) || 0) + x.cnt);
    }
    for (const p of manualPairsInRange(range, f)) {
      const k = normalizeStation(p.station);
      stMap.set(k, (stMap.get(k) || 0) + 1);
    }
    const pieOrder = [...MAIN_STATIONS, 'OTHER'];
    pieStation = {
      groupBy: 'station',
      labels: pieOrder.map((s) => (s === 'OTHER' ? 'Khác' : s)),
      values: pieOrder.map((s) => stMap.get(s) || 0),
    };
  }

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
    groupBy: 'station',
    labels: pieOrder.map((s) => (s === 'OTHER' ? 'Khác' : s)),
    values: pieOrder.map((s) => stMap.get(s) || 0),
  };

  // --- Bieu do cot XEP CHONG: SO LUONG XUAT KHO theo Trung tam ---
  //     daTra (da doi ung) + chuaTra (chua doi ung) = tong xuat kho.
  const daTraCnt = new Map();
  for (const r of dept) {
    const k = r.department || 'PA';
    daTraCnt.set(k, (daTraCnt.get(k) || 0) + 1);
  }
  const chuaTraCnt = new Map();
  for (const r of notRec) {
    const k = r.department || 'PA';
    chuaTraCnt.set(k, (chuaTraCnt.get(k) || 0) + 1);
  }
  const returnedCnt = new Map();
  for (const r of returned || []) {
    const k = r.department || 'PA';
    returnedCnt.set(k, (returnedCnt.get(k) || 0) + 1);
  }
  const tong = (k) => (daTraCnt.get(k) || 0) + (chuaTraCnt.get(k) || 0);
  const volLabels = [...new Set([...daTraCnt.keys(), ...chuaTraCnt.keys()])].sort(
    (a, b) => tong(b) - tong(a)
  );
  const deptVolume = {
    labels: volLabels,
    daTra: volLabels.map((k) => daTraCnt.get(k) || 0),
    chuaTra: volLabels.map((k) => chuaTraCnt.get(k) || 0),
    issued: volLabels.map(tong),
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
const DATA_DIR = CONFIG.dataDir;
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
  saveJsonSafe(KB_LEARNED_FILE, arr);
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

/**
 * TRA CUU PART ON/OFF (bang WO_PART_ON_OFF - linked server DWH_DB/Oracle).
 * 6 O TIM RIENG, khop CHINH XAC (=), dieu kien AND (o nao bo trong thi bo qua):
 *   - SO   : EVENT_PERFNO_I, LABELNO  (so sanh qua TRY_CONVERT(float))
 *   - CHU  : PARTNO, SERIALNO, PARTNO_OFF, SERIALNO_OFF
 * Ngay gio: MUTATION = so NGAY AMOS (ke tu @amosEpoch), MUTATION_TIME = so MS
 * tu 0h (GIONG mutation/mutation_t cua on_off - KHONG phai datetime!) ->
 * ghep 2 cot + @tzOffset ra gio VN thanh 1 cot mutation_time_vn duy nhat.
 * CREATED_DATE cung la SO NGAY kieu AMOS -> cong vao @amosEpoch (chi co ngay).
 */
async function qPartOnOff(crit) {
  const params = { top: CONFIG.maxRows };
  const conds = [];
  // Truong SO: ep kieu float ca 2 ve (cot Oracle NUMBER; nguoi dung go '43842')
  if (crit.event) { params.event = crit.event; conds.push(`TRY_CONVERT(float, w.[EVENT_PERFNO_I]) = TRY_CONVERT(float, @event)`); }
  if (crit.labelno) { params.labelno = crit.labelno; conds.push(`TRY_CONVERT(float, w.[LABELNO]) = TRY_CONVERT(float, @labelno)`); }
  // Truong CHU: so sanh = truc tiep (SQL Server bo qua khoang trang cuoi khi =).
  // UPPER gia tri nhap: AMOS chi luu CHU HOA -> go thuong van khop.
  const up = (s) => String(s).toUpperCase();
  if (crit.partno) { params.partno = up(crit.partno); conds.push(`w.[PARTNO] = @partno`); }
  if (crit.serialno) { params.serialno = up(crit.serialno); conds.push(`w.[SERIALNO] = @serialno`); }
  if (crit.partnoOff) { params.partnoOff = up(crit.partnoOff); conds.push(`w.[PARTNO_OFF] = @partnoOff`); }
  if (crit.serialnoOff) { params.serialnoOff = up(crit.serialnoOff); conds.push(`w.[SERIALNO_OFF] = @serialnoOff`); }
  if (!conds.length) return [];

  // MUTATION (ngay) + MUTATION_TIME (ms) -> datetime VN (nhu amosToVN nhung khac ten cot)
  const mutVN =
    `DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND,
       TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, w.[MUTATION_TIME])) % 86400000),
       DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, w.[MUTATION])), TRY_CONVERT(datetime, @amosEpoch))))`;

  // CREATED_DATE cung la SO NGAY kieu AMOS (khong phai datetime!) -> cong vao
  // @amosEpoch; giu phan le (neu co) lam gio trong ngay. Khong cong tzOffset:
  // gia tri chi co NGAY, cong 7h se hien 07:00 gay hieu lam.
  const createdF = `TRY_CONVERT(float, w.[CREATED_DATE])`;
  const createdVN =
    `DATEADD(SECOND,
       TRY_CONVERT(int, ROUND((${createdF} - FLOOR(${createdF})) * 86400, 0)),
       DATEADD(DAY, TRY_CONVERT(int, FLOOR(${createdF})), TRY_CONVERT(datetime, @amosEpoch)))`;

  const text = `
    SELECT TOP (@top)
      TRY_CONVERT(bigint, w.[EVENT_PERFNO_I]) AS event_perfno_i,
      RTRIM(w.[PARTNO])         AS partno,
      RTRIM(w.[SERIALNO])       AS serialno,
      RTRIM(w.[LABELNO])        AS labelno,
      RTRIM(w.[AC_POSITION])    AS ac_position,
      RTRIM(w.[LOCID_PK])       AS locid_pk,
      RTRIM(w.[PARTNO_OFF])     AS partno_off,
      RTRIM(w.[SERIALNO_OFF])   AS serialno_off,
      RTRIM(w.[RELEASENO])      AS releaseno,
      RTRIM(w.[MUTATOR])        AS mutator,
      RTRIM(w.[STATUS])         AS status,
      ${mutVN}                  AS mutation_time_vn,
      RTRIM(w.[CREATED_BY])     AS created_by,
      ${createdVN}              AS created_date_vn
    FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF] w
    WHERE ${conds.join('\n      AND ')}
    ORDER BY TRY_CONVERT(float, w.[MUTATION]) DESC, TRY_CONVERT(float, w.[MUTATION_TIME]) DESC`;
  return query(text, params);
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
    quarter: (intent.period && intent.period.quarter) || ctx.quarter || '',
    year: (intent.period && intent.period.year) || ctx.year || '',
    station: ctx.station || '',
    store: ctx.store || '',
    department: intent.department || ctx.department || '',
    excludeCC: ctx.excludeCC ? '1' : '',
  };
  const range = resolveRange(q);
  const f = readFilters(q);
  const dash = CONFIG.demoMode
    ? DEMO.dashboard(range, f)
    : buildDashboardFromAgg(range, await qDashboardAgg(range, f), f);
  const k = dash.kpis;
  const perLbl =
    q.periodType === 'month' ? (q.month ? ' ' + q.month : '')
    : q.periodType === 'quarter' ? (q.quarter ? ' ' + q.quarter : '')
    : q.periodType === 'year' ? (q.year ? ' ' + q.year : '')
    : '';
  const ctxLine =
    `Kỳ: ${range.label}${perLbl}` +
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
    ['tatTotalAvg', 'tatInstallAvg', 'tatUsReturnAvg', 'tatCuvtAvg', 'tatReturnStoreAvg',
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

/** Ghi log AUDIT moi lan goi LLM dam may (de kiem tra du lieu da gui ra ngoai).
 *  TSV: gio | provider | redacted | ok | noi_dung_da_gui (da che neu bat redact). */
function logCloudCall(provider, redacted, ok, sentText) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const vn = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
    const safe = String(sentText || '').replace(/[\t\r\n]+/g, ' ').trim();
    fs.appendFile(
      path.join(LOG_DIR, `llm-cloud-${day}.log`),
      `${vn}\t${provider}\tredacted=${redacted ? 1 : 0}\tok=${ok ? 1 : 0}\t${safe}\n`,
      () => {}
    );
  } catch (_) { /* khong de loi log lam vo chat */ }
}

/**
 * Cau chua hieu / nguoi dung bao sai -> neu co LLM (noi bo hoac dam may) thi nho
 * LLM tra loi, GROUNDING bang kho tri thuc (KB). Huong dan LLM: chi dung kien
 * thuc duoc cung cap, KHONG bia so lieu (cau hoi so lieu -> huong dan hoi lai co ky).
 * Voi LLM dam may: du lieu nhay cam da duoc CHE (redact) trong llm.ask + ghi audit.
 * Bat ky loi/khoa an toan -> tra null de fallback ve rule-based.
 * @returns {{reply:string, provider:string}|null}
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
    const out = await llm.ask(system, String(message || ''));
    if (out.provider === 'anthropic') logCloudCall(out.provider, out.redacted, !!out.text, out.sent);
    return out.text ? { reply: out.text, provider: out.provider } : null;
  } catch (err) {
    if (llm.CFG.provider === 'anthropic') logCloudCall('anthropic', llm.CFG.redact, false, err.message);
    console.warn('[LLM] Bo qua, dung rule-based:', err.message);
    return null;
  }
}

/**
 * Luu cau tra loi cua LLM vao KB "da hoc" (kinh nghiem) de lan sau khong phai
 * goi LLM nua. Danh dau source de admin KIEM TRA/xoa (dac biet source='cloud').
 */
function rememberFromLLM(question, answer, source) {
  try {
    const keyPhrase = chatbot.norm(question);
    if (!keyPhrase || !answer) return;
    const arr = loadLearnedKB().filter((x) => (x.keys[0] || '') !== keyPhrase);
    arr.push({
      keys: [keyPhrase], answer,
      addedAt: new Date().toISOString(), sample: question,
      source: source || 'cloud', reviewed: false,
    });
    saveLearnedKB(arr);
  } catch (e) {
    console.warn('[KB] Khong luu duoc kinh nghiem LLM:', e.message);
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
      // Thu LLM (noi bo hoac dam may, neu bat) truoc khi tra loi mac dinh
      const llmOut = await chatTryLLM(message);
      if (llmOut) {
        // Luu lai "kinh nghiem" de lan sau tra loi ngay, khong goi LLM lai.
        rememberFromLLM(message, llmOut.reply, llmOut.provider === 'anthropic' ? 'cloud' : 'llm');
        return { intent: 'llm', reply: llmOut.reply, source: llmOut.provider };
      }
      logChatGap(message); // ghi lai de bo sung kho tri thuc ve sau
      const sugg = (intent.suggestions && intent.suggestions.length)
        ? '\n\nCó phải anh/chị muốn hỏi:\n' + intent.suggestions.map((s) => '• ' + s).join('\n')
        : '\n\n' + chatbot.helpText();
      return { intent: 'unknown', reply: 'Xin lỗi, tôi chưa hiểu câu hỏi.' + sugg };
    }
  }
}

// ---------------------------------------------------------------------------
// 7d. BAO CAO DINH KY -> TEAMS (Adaptive Card qua Workflows webhook) +
//     FILE CSV vao thu muc SharePoint sync. MAC DINH TAT (chua cau hinh .env).
//     Du lieu gui di: CHI SO TONG HOP (KPI) + bang chi tiet TAT (CSV, neu bat
//     REPORT_EXPORT_DIR). Moi lan gui ghi audit logs/report-YYYY-MM-DD.log.
// ---------------------------------------------------------------------------
const REPORT_STATE_FILE = path.join(DATA_DIR, 'report-state.json');

/** Parse "T2 06:30" / "T2,T5 06:30" / "MON 6:30" / "CN 18:00" -> {days:Set, hh, mm}. */
function parseReportSchedule(str) {
  const m = /^\s*([A-Za-z0-9,]+)\s+(\d{1,2}):(\d{2})\s*$/.exec(String(str || ''));
  if (!m) return null;
  const MAP = { CN: 0, T2: 1, T3: 2, T4: 3, T5: 4, T6: 5, T7: 6,
    SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  const days = new Set();
  for (const tok of m[1].toUpperCase().split(',')) {
    if (!(tok in MAP)) return null;
    days.add(MAP[tok]);
  }
  const hh = parseInt(m[2], 10), mm = parseInt(m[3], 10);
  if (hh > 23 || mm > 59) return null;
  return { days, hh, mm };
}

/** Ky bao cao VUA KET THUC + ky lien truoc (de tinh delta).
 *  @param {string} period 'week' | 'month' */
function reportRanges(period) {
  const now = new Date();
  if (period === 'month') {
    const cur = new Date(now.getFullYear(), now.getMonth() - 1, 1); // thang truoc
    const prv = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const s = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return {
      label: `Tháng ${cur.getMonth() + 1}/${cur.getFullYear()}`,
      fileTag: `thang_${s(cur)}`,
      range: { ...monthRange(s(cur)), label: 'Thang' },
      prevRange: { ...monthRange(s(prv)), label: 'Thang' },
    };
  }
  // week (mac dinh): tuan VUA KET THUC = tuan chua (now - 7 ngay)
  const ref = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  const prevRef = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 14);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const r = weekRange(iso(ref));
  // Moc "to" la LOAI TRU (T2 tuan sau 00:00) -> ngay cuoi hien thi = to - 1 ngay (CN)
  const toD = new Date(r.to.slice(0, 10) + 'T00:00:00');
  const endD = new Date(toD.getFullYear(), toD.getMonth(), toD.getDate() - 1);
  const dd = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  return {
    label: `Tuần ${r.from.slice(8, 10)}/${r.from.slice(5, 7)}–${dd(endD)}/${endD.getFullYear()}`,
    fileTag: `tuan_${r.from.slice(0, 10)}`,
    range: { ...r, label: 'Tuan' },
    prevRange: { ...weekRange(iso(prevRef)), label: 'Tuan' },
  };
}

/** Dong delta "▲ x% / ▼ x%" so ky truoc (downGood: giam la tot). */
function deltaTxt(cur, prev, downGood) {
  const c = Number(cur), p = Number(prev);
  if (!isFinite(c) || !isFinite(p) || p === 0) return '';
  const pct = Math.round(((c - p) / Math.abs(p)) * 1000) / 10;
  if (pct === 0) return ' (= kỳ trước)';
  const good = downGood ? pct < 0 : pct > 0;
  return ` (${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% ${good ? 'tốt hơn' : 'xấu hơn'} kỳ trước)`;
}

/** Adaptive Card KPI cho Teams Workflows. */
function buildTeamsCard(label, k, p) {
  const facts = [
    { title: 'TAT tổng (3 chặng)', value: `${k.tatTotalAvg} ngày${deltaTxt(k.tatTotalAvg, p.tatTotalAvg, true)}` },
    { title: 'TAT install', value: `${k.tatInstallAvg} ngày${deltaTxt(k.tatInstallAvg, p.tatInstallAvg, true)}` },
    { title: 'TAT US return', value: `${k.tatUsReturnAvg} ngày${deltaTxt(k.tatUsReturnAvg, p.tatUsReturnAvg, true)}` },
    { title: 'TAT hoàn kho', value: `${k.tatReturnStoreAvg} ngày${deltaTxt(k.tatReturnStoreAvg, p.tatReturnStoreAvg, true)}` },
    { title: 'Thiết bị xuất kho', value: `${k.countIssued}` },
    { title: 'Chưa đối ứng', value: `${k.countNotReconciled}${deltaTxt(k.countNotReconciled, p.countNotReconciled, true)}` },
    { title: 'Tỷ lệ đối ứng', value: `${k.reconcileRate}%${deltaTxt(k.reconcileRate, p.reconcileRate, false)}` },
  ];
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', size: 'Large', weight: 'Bolder', text: '📊 Báo cáo TAT — VAECO' },
          { type: 'TextBlock', spacing: 'None', isSubtle: true, text: label },
          { type: 'FactSet', facts },
          { type: 'TextBlock', size: 'Small', isSubtle: true, wrap: true,
            text: 'Số liệu tổng hợp tự động từ Dashboard TAT (chi tiết xem trên dashboard trong mạng công ty).' },
        ],
      },
    }],
  };
}

/** Ghi audit moi lan gui bao cao ra ngoai. */
function logReport(line) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const vn = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
    fs.appendFile(path.join(LOG_DIR, `report-${day}.log`), `${vn}\t${line}\n`, () => {});
  } catch (_) { /* khong vo app vi log */ }
}

/** Bang KPI (dung chung cho Excel va CSV du phong). */
function kpiTable(kpis, prevKpis) {
  const pct = (cur, prev) => {
    const c = Number(cur), p = Number(prev);
    if (!isFinite(c) || !isFinite(p) || p === 0) return '';
    return Math.round(((c - p) / Math.abs(p)) * 1000) / 10;
  };
  return [
    ['TAT tổng (ngày) = install + US return + CUVT', kpis.tatTotalAvg, prevKpis.tatTotalAvg],
    ['TAT install (ngày)', kpis.tatInstallAvg, prevKpis.tatInstallAvg],
    ['TAT US return (ngày)', kpis.tatUsReturnAvg, prevKpis.tatUsReturnAvg],
    ['TAT CUVT (ngày)', kpis.tatCuvtAvg, prevKpis.tatCuvtAvg],
    ['TAT hoàn kho (ngày)', kpis.tatReturnStoreAvg, prevKpis.tatReturnStoreAvg],
    ['Thiết bị xuất kho', kpis.countIssued, prevKpis.countIssued],
    ['Chưa đối ứng', kpis.countNotReconciled, prevKpis.countNotReconciled],
    ['Tỷ lệ đối ứng (%)', kpis.reconcileRate, prevKpis.reconcileRate],
    ['SL nhận (CUVT)', kpis.cntReci, prevKpis.cntReci],
    ['SL giao (CUVT)', kpis.cntDel, prevKpis.cntDel],
  ].map((r) => [...r, pct(r[1], r[2])]);
}

/** DU PHONG khi server chua cai duoc 'exceljs' (vd bi chan npm registry):
 *  xuat CSV co BOM UTF-8 - Excel/SharePoint van mo duoc, chi khong co
 *  2 sheet/dinh dang. Tra ve danh sach file da ghi. */
function writeReportCsvFallback(dir, fileTag, kpis, prevKpis, rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const files = [];
  const kpiCsv = [['Chỉ số', 'Kỳ này', 'Kỳ trước', 'Chênh lệch (%)'], ...kpiTable(kpis, prevKpis)]
    .map((r) => r.map(cell).join(',')).join('\r\n');
  const f1 = path.join(dir, `TAT-KPI_${fileTag}.csv`);
  fs.writeFileSync(f1, '﻿' + kpiCsv, 'utf8');
  files.push(f1);
  if (rows && rows.length) {
    const cols = Object.keys(rows[0]);
    const body = [cols.join(',')]
      .concat(rows.map((r) => cols.map((c) => cell(r[c])).join(',')))
      .join('\r\n');
    const f2 = path.join(dir, `TAT-chitiet_${fileTag}.csv`);
    fs.writeFileSync(f2, '﻿' + body, 'utf8');
    files.push(f2);
  }
  return files;
}

/** Xuat file EXCEL (.xlsx) vao REPORT_EXPORT_DIR (thu muc OneDrive sync):
 *  Sheet "KPI" (ky nay / ky truoc / chenh lech %) + Sheet "Chi tiet TAT".
 *  Dung exceljs (lazy-require); THIEU goi -> tu dong lui ve CSV de van co file.
 *  @returns {{files: string[], fallback: boolean}} */
async function writeReportXlsx(fileTag, label, kpis, prevKpis, rows) {
  let ExcelJS = null;
  try {
    ExcelJS = require('exceljs');
  } catch (_) {
    ExcelJS = null; // chua npm install -> dung CSV du phong ben duoi
  }
  const dir = CONFIG.reportExportDir;
  fs.mkdirSync(dir, { recursive: true });
  if (!ExcelJS) {
    return { files: writeReportCsvFallback(dir, fileTag, kpis, prevKpis, rows), fallback: true };
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Dashboard TAT - VAECO';
  wb.created = new Date();

  // --- Sheet 1: KPI tong hop ---
  const ws = wb.addWorksheet('KPI');
  ws.addRow([`B\u00C1O C\u00C1O TAT \u2014 ${label}`]);
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.mergeCells('A1:D1');
  ws.addRow([]);
  const head = ws.addRow(['Ch\u1EC9 s\u1ED1', 'K\u1EF3 n\u00E0y', 'K\u1EF3 tr\u01B0\u1EDBc', 'Ch\u00EAnh l\u1EC7ch (%)']);
  head.font = { bold: true };
  head.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E5F' } };
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });
  for (const r of kpiTable(kpis, prevKpis)) ws.addRow(r);
  ws.columns = [{ width: 26 }, { width: 12 }, { width: 12 }, { width: 16 }];

  // --- Sheet 2: Chi tiet TAT theo thiet bi ---
  if (rows && rows.length) {
    const ws2 = wb.addWorksheet('Chi tiet TAT');
    const cols = Object.keys(rows[0]);
    ws2.columns = cols.map((c) => ({ header: c, key: c, width: Math.min(28, Math.max(12, c.length + 2)) }));
    ws2.getRow(1).font = { bold: true };
    ws2.getRow(1).eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E5F' } };
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });
    for (const r of rows) ws2.addRow(r);
    ws2.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    ws2.views = [{ state: 'frozen', ySplit: 1 }];
  }

  const file = path.join(dir, `TAT_${fileTag}.xlsx`);
  await wb.xlsx.writeFile(file);
  return { files: [file], fallback: false };
}

/** CHAY bao cao cho 1 KY (week|month): the Teams + file Excel. */
async function runReportForPeriod(period, reason) {
  const { label, fileTag, range, prevRange } = reportRanges(period);
  const f = {};
  const dash = CONFIG.demoMode
    ? DEMO.dashboard(range, f)
    : buildDashboardFromAgg(range, await qDashboardAgg(range, f), f);
  const prev = CONFIG.demoMode
    ? DEMO.dashboard(prevRange, f)
    : buildDashboardFromAgg(prevRange, await qDashboardAgg(prevRange, f), f);
  const out = { period, label, teams: null, files: [] };

  if (CONFIG.teamsWebhookUrl) {
    try {
      const res = await fetch(CONFIG.teamsWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTeamsCard(label, dash.kpis, prev.kpis)),
      });
      out.teams = res.ok || res.status === 202 ? 'ok' : `HTTP ${res.status}`;
      logReport(`teams\t${reason}\t${label}\t${out.teams}`);
    } catch (e) {
      out.teams = 'loi: ' + e.message;
      logReport(`teams\t${reason}\t${label}\tERROR ${e.message}`);
    }
  }
  if (CONFIG.reportExportDir) {
    try {
      const rows = CONFIG.demoMode ? DEMO.tatDepartments(range, f) : await qTatDepartments(range, f);
      const w = await writeReportXlsx(fileTag, label, dash.kpis, prev.kpis, rows);
      out.files = w.files;
      if (w.fallback) {
        out.xlsxWarn = "chua cai 'exceljs' -> da xuat CSV thay cho Excel (chay: npm install de co .xlsx)";
      }
      logReport(`${w.fallback ? 'csv-fallback' : 'xlsx'}\t${reason}\t${label}\t${out.files.join(' | ')}`);
    } catch (e) {
      out.files = [];
      out.xlsxError = e.message;
      logReport(`xlsx\t${reason}\t${label}\tERROR ${e.message}`);
    }
  }
  return out;
}

/** CHAY 1 LAN bao cao cho danh sach ky (mac dinh: tat ca ky da cau hinh).
 *  MOI KY chay trong try/catch RIENG: ky nay loi/timeout khong lam hong ky kia
 *  (truoc day ky "month" nang hon nen hay ngat -> mat luon ca bao cao tuan). */
async function runScheduledReport(reason, periods) {
  const enabled = CONFIG.teamsWebhookUrl || CONFIG.reportExportDir;
  if (!enabled) return { ok: false, message: 'Chua cau hinh TEAMS_WEBHOOK_URL / REPORT_EXPORT_DIR.' };
  const list = (periods && periods.length ? periods : CONFIG.reportPeriods);
  const results = [];
  for (const p of list) {
    const t0 = Date.now();
    try {
      const r = await runReportForPeriod(p, reason);
      results.push({ ...r, ms: Date.now() - t0 });
    } catch (e) {
      logReport(`period\t${reason}\t${p}\tERROR ${e.message}`);
      console.error(`[REPORT] Ky "${p}" that bai:`, e.message);
      results.push({ period: p, label: p === 'month' ? 'Tháng' : 'Tuần', teams: null, files: [], periodError: e.message, ms: Date.now() - t0 });
    }
  }
  const okAny = results.some((r) => !r.periodError);
  return {
    ok: okAny,
    label: results.map((r) => r.label).join(' + '),
    teams: results.map((r) => r.teams).filter((x) => x != null).join(', ') || null,
    files: results.flatMap((r) => r.files),
    exportConfigured: !!CONFIG.reportExportDir,
    xlsxError: results.map((r) => r.xlsxError).filter(Boolean).join('; ') || undefined,
    xlsxWarn: [...new Set(results.map((r) => r.xlsxWarn).filter(Boolean))].join('; ') || undefined,
    periodError: results.map((r) => r.periodError).filter(Boolean).join('; ') || undefined,
    results,
  };
}

/** Vong lap lich: moi 30s kiem tra den gio chua (chong gui trung theo ngay). */
function startReportScheduler() {
  const sched = parseReportSchedule(CONFIG.reportSchedule);
  if (!sched) {
    console.warn(`[REPORT] REPORT_SCHEDULE khong hop le: "${CONFIG.reportSchedule}" -> tat lich (van gui tay duoc qua admin).`);
    return;
  }
  const timer = setInterval(async () => {
    const now = new Date();
    if (!sched.days.has(now.getDay())) return;
    if (now.getHours() !== sched.hh || now.getMinutes() !== sched.mm) return;
    const todayKey = now.toISOString().slice(0, 10);
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let st = {};
    try { st = JSON.parse(fs.readFileSync(REPORT_STATE_FILE, 'utf8')); } catch (_) { /* chua co */ }
    if (st.lastRun === todayKey) return; // da gui hom nay roi
    try {
      // Ky TUAN: gui moi lan chay theo lich. Ky THANG: chi gui 1 lan/thang
      // (lan chay dau tien trong thang moi - bao cao cho thang vua ket thuc).
      const periods = [];
      if (CONFIG.reportPeriods.includes('week')) periods.push('week');
      if (CONFIG.reportPeriods.includes('month') && st.lastMonthSent !== monthKey) periods.push('month');
      if (!periods.length) return;
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(REPORT_STATE_FILE, JSON.stringify({
        lastRun: todayKey,
        lastMonthSent: periods.includes('month') ? monthKey : (st.lastMonthSent || ''),
      }), 'utf8');
      const r = await runScheduledReport('lich', periods);
      console.log(`[REPORT] Da gui bao cao dinh ky (${r.label}): teams=${r.teams}, files=${r.files.length}`);
    } catch (e) {
      console.error('[REPORT] Loi gui bao cao dinh ky:', e.message);
    }
  }, 30 * 1000);
  if (timer.unref) timer.unref();
}

// ---------------------------------------------------------------------------
// 8. EXPRESS APP + ROUTES
// ---------------------------------------------------------------------------
const app = express();
app.use(compression());
// KHONG bat CORS: trang va API cung origin; mo CORS nghia la trang web BAT KY
// nhan vien mo trong LAN cung doc duoc so lieu qua trinh duyet cua ho.
app.use(express.json());
app.use(accessLogger); // ghi log IP + ten may cho MOI request (truoc static/API)
app.use(adminGuard);   // chan truy cap admin tu IP la (truoc static de chan /admin.html)
app.use(express.static(path.join(__dirname, 'public')));

/** Boc route async + xu ly loi tap trung.
 *  Chi tiet loi SQL (co the lo ten bang/cau truc) chi tra cho may QUAN TRI
 *  (localhost + ADMIN_IPS) de debug; nguoi dung thuong nhan thong bao chung. */
function h(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error('[API ERROR]', req.path, '-', err.message);
      const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const detail = isAdminAllowed(ip);
      res.status(500).json({
        error: true,
        message: detail
          ? 'Loi truy van du lieu: ' + err.message
          : 'Lỗi truy vấn dữ liệu. Vui lòng thử lại; nếu lặp lại hãy báo quản trị viên (chi tiết đã ghi ở log server).',
        hint: CONFIG.demoMode
          ? 'Dang o DEMO_MODE.'
          : (detail ? 'Kiem tra cau hinh .env va ket noi SQL Server.' : undefined),
      });
    }
  };
}

// --- CACHE bo nho (TTL) cho response API ---
//     Muc dich: doi tab / bam Ap dung lai / nhieu nguoi cung xem -> khong query lai DB.
//     Chi cache o che do LIVE; du lieu demo re nen khong can.
const apiCache = new Map(); // url -> { t: timestamp, data, bytes }
const CACHE_MAX_ENTRIES = 300;
// GIOI HAN THEO DUNG LUONG: /api/dashboard ky NAM co the tra 10-20MB/entry
// (kem rows) -> chi dem so entry se phinh RAM den chet service. Tong ngan sach
// 150MB; entry qua lon (>30MB) khong cache (tra thang, query lai khi can).
const CACHE_MAX_BYTES = 150 * 1024 * 1024;
const CACHE_ENTRY_MAX_BYTES = 30 * 1024 * 1024;
let cacheTotalBytes = 0;

function cacheEvictUntilFits(needBytes) {
  for (const [k, v] of apiCache) {
    if (apiCache.size < CACHE_MAX_ENTRIES && cacheTotalBytes + needBytes <= CACHE_MAX_BYTES) break;
    apiCache.delete(k); // Map giu thu tu chen -> xoa tu entry CU nhat
    cacheTotalBytes -= v.bytes;
  }
}

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
        // Do dung luong 1 lan luc luu (res.json dang nao cung stringify sau do)
        let bytes = 0;
        try { bytes = Buffer.byteLength(JSON.stringify(data)); } catch (_) { bytes = CACHE_ENTRY_MAX_BYTES + 1; }
        if (bytes <= CACHE_ENTRY_MAX_BYTES) {
          const old = apiCache.get(key);
          if (old) { apiCache.delete(key); cacheTotalBytes -= old.bytes; }
          cacheEvictUntilFits(bytes);
          apiCache.set(key, { t: Date.now(), data, bytes });
          cacheTotalBytes += bytes;
        }
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

/**
 * PHIEN BAN CODE DANG CHAY (doc 1 lan luc khoi dong).
 * Muc dich: sau khi `git pull` ma quen restart service thi route/tinh nang moi
 * se bao "Cannot GET ..." - rat kho doan. Mo /api/health la biet ngay ban dang
 * chay la commit nao va chay tu bao gio.
 * Doc truc tiep tu thu muc .git (khong can cai git, khong chay lenh ngoai).
 */
const BUILD_INFO = (() => {
  const startedAt = new Date().toISOString();
  try {
    const gitDir = path.join(__dirname, '..', '.git');
    let head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    let branch = null;
    if (head.startsWith('ref:')) {
      const ref = head.slice(4).trim();
      branch = ref.replace(/^refs\/heads\//, '');
      head = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
    }
    return { commit: head.slice(0, 7), branch, startedAt };
  } catch (_) {
    return { commit: null, branch: null, startedAt };
  }
})();

// --- Health check: kiem tra ket noi DB + PHIEN BAN code dang chay ---
app.get(
  '/api/health',
  h(async (req, res) => {
    const base = {
      status: 'ok',
      ...BUILD_INFO,
      // Liet ke cac route chan doan de biet ban dang chay da co chua
      diagRoutes: ['/api/admin/diag/dept', '/api/admin/diag/higher', '/api/admin/diag/pairing', '/api/admin/diag/rbi'],
    };
    if (CONFIG.demoMode) {
      return res.json({ ...base, mode: 'demo', message: 'Dang chay DEMO_MODE (du lieu mau).' });
    }
    await query('SELECT 1 AS ok');
    res.json({ ...base, mode: 'live', message: 'Ket noi SQL Server OK.' });
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

// --- RATE LIMIT don gian theo IP cho cac endpoint TON TIEN (goi LLM dam may).
//     Trong cua so 60s, moi IP toi da N lan; qua nguong -> 429. Bo nho tu don.
const rateBuckets = new Map(); // key -> [timestamps]
function rateLimited(key, maxPerMinute) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter((t) => now - t < 60000);
  if (arr.length >= maxPerMinute) { rateBuckets.set(key, arr); return true; }
  arr.push(now);
  rateBuckets.set(key, arr);
  if (rateBuckets.size > 5000) rateBuckets.clear(); // chan phinh bo nho
  return false;
}

// --- Chatbot: nguoi dung "Bao sai" cau tra loi -> nho LLM (neu bat) tra loi lai,
//     luu lai kinh nghiem de lan sau tot hon. Neu LLM chua bat -> ghi log de admin
//     review va bao nguoi dung. KHONG bao gio tu tra "dung" ma khong co can cu. ---
app.post(
  '/api/chat/flag',
  h(async (req, res) => {
    const body = req.body || {};
    const message = String(body.message || '').slice(0, 500).trim();
    if (!message) return res.json({ ok: false, reply: 'Không có câu hỏi để xử lý.' });
    // Chan spam "Bao sai" (moi lan co the la 1 luot goi LLM ton phi): 5 lan/phut/IP
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (rateLimited('flag:' + ip, 5)) {
      return res.status(429).json({ ok: false, reply: 'Bạn thao tác quá nhanh. Vui lòng chờ một phút rồi thử lại.' });
    }
    logChatQuestion(message, 'flagged', clientIp(req)); // danh dau bi bao sai
    logChatGap(message); // luon ghi vao hang doi review cua admin
    // Cau tra loi sai den tu KB DA HOC -> danh dau muc do can kiem tra lai
    // (khong goi LLM lai - de tra loi giong het, chi ton phi; admin se sua/xoa).
    const key = chatbot.norm(message);
    const arr = loadLearnedKB();
    const known = arr.find((x) => (x.keys[0] || '') === key);
    if (known) {
      known.reviewed = false;
      known.flagged = true;
      known.flaggedAt = new Date().toISOString();
      saveLearnedKB(arr);
      return res.json({
        ok: false,
        reply: 'Cảm ơn phản hồi. Câu trả lời này đã được đánh dấu để quản trị viên kiểm tra và sửa lại.',
      });
    }
    const llmOut = await chatTryLLM(message);
    if (llmOut) {
      rememberFromLLM(message, llmOut.reply, llmOut.provider === 'anthropic' ? 'cloud' : 'llm');
      return res.json({ ok: true, reply: llmOut.reply, source: llmOut.provider });
    }
    return res.json({
      ok: false,
      reply: 'Cảm ơn phản hồi. Tôi đã ghi nhận câu hỏi này để quản trị viên xem lại và bổ sung kiến thức.',
    });
  })
);

// --- May dang xem CO QUYEN SUA khong? (khong chan IP - ai goi cung duoc)
//     Frontend dung de an/hien nut "Xac nhan doi ung". Day CHI la goi y giao
//     dien; chan that su van o adminGuard phia server (khong the gia mao). ---
app.get('/api/whoami', h(async (req, res) => {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
  res.json({ ip, isAdmin: isAdminAllowed(ip) });
}));

// --- XEM danh sach cap doi ung thu cong (CHI DOC - moi may deu xem duoc).
//     Sua/xoa van phai tu IP quan tri (/api/admin/manual-pair/*). ---
app.get('/api/manual-pairs', h(async (req, res) => {
  const items = loadManualPairs();
  res.json({ items, count: items.length });
}));

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
    const prevRange = resolveRange(prevPeriodQuery(req.query));
    const f = readFilters(req.query);
    if (CONFIG.demoMode) {
      const d = DEMO.dashboard(range, f);
      d.rows = DEMO.tatDepartments(range, f);
      d.prevKpis = DEMO.dashboard(prevRange, f).kpis; // so voi ky truoc
      return res.json(d);
    }

    // KPI/bieu do: SQL aggregate tren TOAN BO du lieu (khong bi cat boi TOP);
    // rows: chi de hien bang chi tiet (co the bi gioi han @maxRows);
    // prevAgg: KPI ky LIEN TRUOC de hien delta tren cac card.
    const [agg, rows, prevAgg] = await Promise.all([
      qDashboardAgg(range, f),
      qTatDepartments(range, f),
      qDashboardAgg(prevRange, f),
    ]);
    const out = buildDashboardFromAgg(range, agg, f);
    out.rows = rows;
    out.prevKpis = buildDashboardFromAgg(prevRange, prevAgg, f).kpis;
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
    const monthStrs = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(ay, am - 1 - i, 1);
      monthStrs.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    // Chay SONG SONG cac thang (pool max 10 chiu duoc) -> nhanh gap ~N lan
    // so voi cho tung thang noi duoi nhau nhu truoc.
    const series = await Promise.all(monthStrs.map(async (mstr) => {
      const range = { ...monthRange(mstr), label: 'Thang' };
      const dash = CONFIG.demoMode
        ? DEMO.dashboard(range, f)
        : buildDashboardFromAgg(range, await qDashboardAgg(range, f), f);
      const k = dash.kpis;
      return {
        month: mstr,
        tatTotal: k.tatTotalAvg, tatInstall: k.tatInstallAvg, tatUsReturn: k.tatUsReturnAvg, tatReturnStore: k.tatReturnStoreAvg,
        issued: k.countIssued, notReconciled: k.countNotReconciled, reconcileRate: k.reconcileRate,
        cntReci: k.cntReci, cntDel: k.cntDel,
      };
    }));
    res.json({ series, months });
  })
);

// --- QUAN LY XUAT KHO (pickslip): KPI + bieu do + bang chi tiet ---
app.get(
  '/api/pickslip',
  cached(60 * 1000, async (req, res) => {
    const range = resolveRange(req.query);
    const f = readFilters(req.query);
    if (CONFIG.demoMode) return res.json(DEMO.pickslip(range, f));
    res.json(await qPickslip(range, f));
  })
);

// --- RECEIVING (nhap kho): KPI + bieu do + bang chi tiet + doi chieu file scan ---
app.get(
  '/api/receiving',
  cached(60 * 1000, async (req, res) => {
    const range = resolveRange(req.query);
    const f = readFilters(req.query);
    if (CONFIG.demoMode) return res.json(DEMO.receiving(range, f));
    res.json(await qReceiving(range, f));
  })
);

// --- THU MUC FILE SCAN: AI CUNG XEM DUOC, chi may quan tri moi SUA duoc ---
//     (POST nam duoi /api/admin/... nen tu dong di qua adminGuard theo IP.)
//     MOI STATION MOT THU MUC - giong cong cu AMOS_GUI cua nghiep vu.

/** Gom trang thai ca hai loai thu muc de tra ve cho giao dien. */
async function trangThaiScan() {
  const dirs = loadScanDirs();
  const [pk, rc] = await Promise.all([
    loadScanIndex(dirs.picking, 'prefix'),
    loadScanIndex(dirs.receiving, 'full'),
  ]);
  const bang = (index, duong, custom) => Object.fromEntries(
    [...SCAN_STATIONS, '*'].map((st) => [st, {
      dir: duong[st] || '',
      custom: !!custom[st],
      ...(index[st] ? scanFolderStatus(index[st]) : { ok: false, count: 0, error: 'Chua cau hinh', ms: 0 }),
    }])
  );
  return {
    stations: SCAN_STATIONS,
    picking: bang(pk, dirs.picking, dirs.custom.picking),
    receiving: bang(rc, dirs.receiving, dirs.custom.receiving),
    updatedAt: dirs.updatedAt,
    updatedBy: dirs.updatedBy,
  };
}

app.get('/api/scan-config', h(async (req, res) => {
  res.json({
    ...(await trangThaiScan()),
    // Bao cho giao dien biet co hien nut Luu hay khong. Dung IP SOCKET that
    // (giong adminGuard, khong tin header) - server VAN chan lai o POST.
    canEdit: isAdminAllowed(String(req.socket.remoteAddress || '').replace(/^::ffff:/, '')),
  });
}));

app.post('/api/admin/scan-config', h(async (req, res) => {
  const b = req.body || {};
  for (const k of ['picking', 'receiving']) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'object' || Array.isArray(b[k])) {
      return res.status(400).json({
        error: true,
        message: `Truong "${k}" phai la doi tuong { HAN, SGN, DAD, "*" }.`,
      });
    }
    const sai = Object.entries(b[k]).find(([, v]) => v !== undefined && v !== null && typeof v !== 'string');
    if (sai) {
      return res.status(400).json({ error: true, message: `Duong dan "${k}.${sai[0]}" phai la chuoi.` });
    }
  }
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const dirs = saveScanDirs(b, ip);
  console.log(`[SCAN] IP ${ip} cap nhat thu muc scan:`
    + ` picking=${JSON.stringify(dirs.picking)} receiving=${JSON.stringify(dirs.receiving)}`);
  res.json({ ok: true, ...(await trangThaiScan()) });
}));

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
  'manual-pair': { live: qManualPairCandidates, demo: 'manualPairCandidates' },
  // Doc tu FILE (khong query DB) -> khong can nhanh demo rieng
  'manual-pair-done': { live: async (range, f) => manualPairsInRange(range, f) },
  'removed-before-installed': { live: qOneSidedWoParts, demo: 'removedBeforeInstalled' },
  other: { live: qOther, demo: 'other' },
  'return-store-tat': { live: qTatReturnStore, demo: 'returnStoreTat' },
  'repair-admin': { live: qRepairAdmin, demo: 'repairAdmin' },
};

app.get(
  '/api/reports/:name',
  cached(60 * 1000, async (req, res) => {
    const def = REPORTS[req.params.name];
    if (!def) return res.status(404).json({ error: true, message: 'Bao cao khong ton tai.' });
    const range = resolveRange(req.query);
    const f = readFilters(req.query);
    const data = (CONFIG.demoMode && def.demo) ? DEMO[def.demo](range, f) : await def.live(range, f);
    res.json({ rows: data, count: data.length, range });
  })
);

// --- Tra cuu Part On/Off (WO_PART_ON_OFF): 6 o rieng, khop chinh xac, AND ---
//     ?event=&partno=&serialno=&labelno=&partnoOff=&serialnoOff= (bo trong = bo qua).
//     Khong dien o nao -> tra rong (khong quet ca bang linked server).
app.get(
  '/api/part-onoff',
  cached(60 * 1000, async (req, res) => {
    const g = (k) => String(req.query[k] || '').trim();
    const crit = {
      event: g('event'), partno: g('partno'), serialno: g('serialno'),
      labelno: g('labelno'), partnoOff: g('partnoOff'), serialnoOff: g('serialnoOff'),
    };
    if (!Object.values(crit).some(Boolean)) return res.json({ rows: [], count: 0 });
    const rows = CONFIG.demoMode ? DEMO.partOnOff(crit) : await qPartOnOff(crit);
    res.json({ rows, count: rows.length, truncated: rows.length >= CONFIG.maxRows });
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
  arr.push({
    keys: [keyPhrase], answer, addedAt: new Date().toISOString(), sample: question,
    source: 'admin', reviewed: true,
  });
  saveLearnedKB(arr);
  res.json({ ok: true, count: arr.length });
}));

// --- ADMIN: XAC NHAN 1 muc AI dam may da hoc la DUNG (danh dau reviewed) ---
app.post('/api/admin/kb-review', h(async (req, res) => {
  const keyPhrase = String((req.body && req.body.key) || '').trim();
  const arr = loadLearnedKB();
  const it = arr.find((x) => (x.keys[0] || '') === keyPhrase);
  if (!it) return res.status(404).json({ error: true, message: 'Khong tim thay muc.' });
  it.reviewed = true;
  it.reviewedAt = new Date().toISOString();
  it.flagged = false; // da kiem tra -> xoa co "bi bao sai"
  saveLearnedKB(arr);
  res.json({ ok: true });
}));

// --- ADMIN: XOA 1 muc KB da hoc ---
app.post('/api/admin/kb-learn-delete', h(async (req, res) => {
  const keyPhrase = String((req.body && req.body.key) || '').trim();
  const arr = loadLearnedKB().filter((x) => (x.keys[0] || '') !== keyPhrase);
  saveLearnedKB(arr);
  res.json({ ok: true, count: arr.length });
}));

// --- ADMIN: BAO CAO DINH KY - trang thai + gui thu ngay ---
app.get('/api/admin/report-status', h(async (req, res) => {
  const sched = parseReportSchedule(CONFIG.reportSchedule);
  res.json({
    teamsConfigured: !!CONFIG.teamsWebhookUrl,
    exportDir: CONFIG.reportExportDir || null,
    schedule: CONFIG.reportSchedule,
    scheduleValid: !!sched,
    period: CONFIG.reportPeriods.join(','),
    enabled: !!(CONFIG.teamsWebhookUrl || CONFIG.reportExportDir),
  });
}));

// ?period=week|month  -> chi chay 1 ky (request ngan, tranh dut ket noi vi
// ky "month" quet du lieu nang). Khong truyen -> chay tat ca ky da cau hinh.
app.post('/api/admin/report-now', h(async (req, res) => {
  const p = String(req.query.period || '').trim().toLowerCase();
  const periods = (p === 'week' || p === 'month') ? [p] : null;
  const r = await runScheduledReport('tay', periods);
  res.json(r);
}));

// --- ADMIN: DOI UNG THU CONG (cap thao <-> lap co label lech) ---
//     Xac nhan 1 cap -> luu data/reconcile-manual.json; phieu xuat do se KHONG
//     con nam trong "chua doi ung" va duoc tinh la DA doi ung trong KPI.
app.get('/api/admin/manual-pairs', h(async (req, res) => {
  const items = loadManualPairs();
  let size = 0;
  try { size = fs.statSync(MANUAL_PAIR_FILE).size; } catch (_) { /* chua co file */ }
  res.json({
    items, count: items.length,
    // Cho biet RO du lieu nam o dau (KHONG ghi vao SQL Server - tai khoan DB
    // chi can quyen DOC). File nay khong nam trong git -> can tu sao luu.
    file: MANUAL_PAIR_FILE, bytes: size,
  });
}));

// Tai ve ban sao luu (JSON) - de phong cai lai server / doi may
app.get('/api/admin/manual-pairs/export', h(async (req, res) => {
  const day = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="reconcile-manual-${day}.json"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(loadManualPairs(), null, 2));
}));

app.post('/api/admin/manual-pair/confirm', h(async (req, res) => {
  const b = req.body || {};
  const issueLabel = String(b.issueLabel ?? '').trim();
  const issueVoucher = String(b.issueVoucher ?? '').trim();
  if (!issueLabel || !issueVoucher) {
    return res.status(400).json({ error: true, message: 'Thieu issueLabel / issueVoucher.' });
  }
  const key = pairKey(issueLabel, issueVoucher);
  const all = loadManualPairs();
  // CHAN TRUNG: 1 thiet bi da thao chi doi ung cho DUNG 1 phieu xuat. Neu serial
  // thao nay da duoc gan cho phieu KHAC -> tu choi (tranh dem 2 lan trong KPI).
  const offSn = String(b.offSerialno ?? '').trim().toUpperCase();
  if (offSn) {
    const clash = all.find((p) =>
      String(p.offSerialno ?? '').trim().toUpperCase() === offSn &&
      pairKey(p.issueLabel, p.issueVoucher) !== key);
    if (clash && !b.force) {
      return res.status(409).json({
        error: true, code: 'DUPLICATE_OFF_SERIAL',
        message: `Serial tháo ${b.offSerialno} đã được đối ứng cho phiếu ${clash.issueVoucher} ` +
          `(label ${clash.issueLabel}) lúc ${clash.confirmedAt || ''}. Một thiết bị tháo chỉ ` +
          `đối ứng cho MỘT phiếu xuất — hãy gỡ cặp cũ trước nếu cặp này mới đúng.`,
      });
    }
  }
  const arr = all.filter((p) => pairKey(p.issueLabel, p.issueVoucher) !== key);
  arr.push({
    issueLabel, issueVoucher,
    issuePartno: String(b.issuePartno ?? '').trim(),
    issueSerialno: String(b.issueSerialno ?? '').trim(),
    issueTimeVn: String(b.issueTimeVn ?? '').trim(),
    // Luu san de loc theo bo loc dashboard ma khong phai truy van lai
    department: String(b.department ?? '').trim(),
    station: String(b.station ?? '').trim(),
    store: String(b.store ?? '').trim(),
    // Ve con lai cua cap: thiet bi da THAO + ban ghi tra unservice (neu co)
    offPartno: String(b.offPartno ?? '').trim(),
    offSerialno: String(b.offSerialno ?? '').trim(),
    retLabelno: String(b.retLabelno ?? '').trim(),
    retVoucher: String(b.retVoucher ?? '').trim(),
    retDelTime: String(b.retDelTime ?? '').trim(),
    tatDays: Number(b.tatDays) || null,
    matchMethod: String(b.matchMethod ?? '').trim(),
    confidence: String(b.confidence ?? '').trim(),
    note: String(b.note ?? '').slice(0, 300),
    confirmedAt: new Date().toISOString(),
    confirmedBy: clientIp(req),
  });
  saveManualPairs(arr);
  apiCache.clear(); // KPI thay doi -> bo cache de so lieu cap nhat ngay
  cacheTotalBytes = 0;
  res.json({ ok: true, count: arr.length });
}));

app.post('/api/admin/manual-pair/delete', h(async (req, res) => {
  const b = req.body || {};
  const key = pairKey(b.issueLabel, b.issueVoucher);
  const arr = loadManualPairs().filter((p) => pairKey(p.issueLabel, p.issueVoucher) !== key);
  saveManualPairs(arr);
  apiCache.clear();
  cacheTotalBytes = 0;
  res.json({ ok: true, count: arr.length });
}));

// --- ADMIN: TU KIEM TRA truy van ghep cap (chay THU truoc khi dung that) ---
//     Cho biet: co tim thay cot [event_perf] o tung bang khong, truy van chay
//     duoc khong, mat bao lau, va phan bo cac cach ghep. Neu loi -> tra ve
//     dung thong bao loi SQL de sua, khong lam vo trang bao cao.
app.get('/api/admin/diag/pairing', h(async (req, res) => {
  if (CONFIG.demoMode) return res.json({ note: 'Dang o DEMO_MODE, khong co du lieu that.' });
  const out = {};
  // 1) Do schema: bang nao co cot event_perf
  for (const t of ['kho_ser1', 'real_us1']) {
    const cols = await getColumns(t);
    out[t] = {
      docDuocSchema: cols.size > 0,
      soCot: cols.size,
      coEventPerf: cols.has('event_perf'),
      coAcRegistr: cols.has('ac_registr'),
      coOnAc: cols.has('on_ac'),
    };
  }
  out.khopEventDuoc = !!(out.kho_ser1.coEventPerf && out.real_us1.coEventPerf);
  // Vi tri hien tai (ROTABLES.location noi qua psn) - bao cao "Xuat kho chua lap"
  const offCols = await getColumns('on_off');
  const khoCols = await getColumns('kho_ser1');
  out.viTriHienTai = {
    psnO_kho_ser1: khoCols.has('psn'),
    psnO_on_off: offCols.has('psn'),
    nguonPsn: khoCols.has('psn') ? 'kho_ser1.psn'
      : (offCols.has('psn') ? 'on_off.psn (tra theo part+serial)' : 'KHONG CO -> cot Vi tri se trong'),
  };
  try {
    const t = await query(`SELECT TOP 3 [psn] AS psn, RTRIM([location]) AS location,
                                  RTRIM([PARTNONEW]) AS higher_pn, RTRIM([SERIALNONEW]) AS higher_sn
                           FROM [DWH_DB]..[STG_AMOS].[ROTABLES]`);
    out.viTriHienTai.docDuocROTABLES = true;
    out.viTriHienTai.viDu = t;
  } catch (e) {
    out.viTriHienTai.docDuocROTABLES = false;
    out.viTriHienTai.loi = e.message;
  }
  if (!out.khopEventDuoc) {
    out.canhBao = 'Thiếu [event_perf] ở một trong hai bảng -> tiêu chí "Khớp event (WO)" TỰ TẮT, ' +
      'các cách ghép khác vẫn chạy bình thường.';
  }
  // 2) Chay THU truy van ghep cap tren ky dang chon
  const range = resolveRange(req.query);
  const f = readFilters(req.query);
  const t0 = Date.now();
  try {
    const rows = await qManualPairCandidates(range, f);
    const byMethod = {};
    let coGoiY = 0;
    for (const r of rows) {
      const k = r.match_method || '(không ghép được)';
      byMethod[k] = (byMethod[k] || 0) + 1;
      if (r.sug_serialno_off) coGoiY++;
    }
    out.truyVan = {
      ok: true, ms: Date.now() - t0, range,
      soDong: rows.length, coCapGoiY: coGoiY,
      khongGhepDuoc: rows.length - coGoiY,
      theoCachGhep: byMethod,
    };
  } catch (e) {
    out.truyVan = { ok: false, ms: Date.now() - t0, range, loi: e.message };
  }
  res.json(out);
}));

// --- ADMIN: CHAN DOAN bao cao "Thao truoc lap sau" (vi sao khong co du lieu) ---
//     Dem theo tung DIEU KIEN noi long dan -> biet dieu kien nao lam mat het dong.
app.get('/api/admin/diag/rbi', h(async (req, res) => {
  if (CONFIG.demoMode) return res.json({ note: 'Dang o DEMO_MODE, khong co du lieu that.' });
  const range = resolveRange(req.query);
  const params = { from: range.from, to: range.to, ...amosDayParams(range) };
  const safe = async (label, sql) => {
    try { return { [label]: (await query(sql, { ...params }))[0] }; }
    catch (e) { return { [label]: { error: e.message } }; }
  };
  // Cac dieu kien loc "co dinh" cua bao cao (khong ke ye/period)
  const baseFilters = `
      AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'`;
  const inPeriod = `
      AND k.[mutation] BETWEEN @fromDay AND @toDay
      AND ${amosToVN('k')} >= @from AND ${amosToVN('k')} < @to`;
  const yeBefore = `
      EXISTS (SELECT 1 FROM [NQT].[dbo].[on_off] o
              WHERE o.[labelno] = k.[labelno] AND o.[vm] = 'YE'
                AND ${amosToVN('o')} < ${amosToVN('k')})`;

  const parts = await Promise.all([
    // 1. Tong phieu xuat trong ky (sau cac bo loc co dinh)
    safe('b1_phieu_xuat_trong_ky', `
      SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[kho_ser1] k
      WHERE k.[vm]='T' AND k.[voucherno] LIKE 'P-%' ${baseFilters} ${inPeriod}`),
    // 2. ... co BAT KY su kien lap (YE) cung labelno
    safe('b2_co_YE_cung_label', `
      SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[kho_ser1] k
      WHERE k.[vm]='T' AND k.[voucherno] LIKE 'P-%' ${baseFilters} ${inPeriod}
        AND EXISTS (SELECT 1 FROM [NQT].[dbo].[on_off] o
                    WHERE o.[labelno] = k.[labelno] AND o.[vm]='YE')`),
    // 3. ... co YE TRUOC gio xuat  <-- DIEU KIEN CUA BAO CAO
    safe('b3_co_YE_TRUOC_gio_xuat_TRONG_KY', `
      SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[kho_ser1] k
      WHERE k.[vm]='T' AND k.[voucherno] LIKE 'P-%' ${baseFilters} ${inPeriod}
        AND ${yeBefore}`),
    // 4. Nhu (3) nhung KHONG gioi han ky -> xem co phai do ky bao cao khong
    safe('b4_co_YE_TRUOC_gio_xuat_TOAN_LICH_SU', `
      SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[kho_ser1] k
      WHERE k.[vm]='T' AND k.[voucherno] LIKE 'P-%' ${baseFilters}
        AND ${yeBefore}`),
    // 5. Nhu (4) nhung BO cac bo loc co dinh -> xem bo loc co giet het khong
    safe('b5_khong_bo_loc_costcenter_store_condition', `
      SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[kho_ser1] k
      WHERE k.[vm]='T' AND k.[voucherno] LIKE 'P-%'
        AND ${yeBefore}`),
    // 6. Phieu xuat trong ky KHONG co YE nao SAU gio xuat (TAT install = NULL)
    //    -> nhom "kha nghi" cua nghiep vu lap truoc/xuat sau
    safe('b6_trong_ky_khong_co_YE_SAU_gio_xuat', `
      SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[kho_ser1] k
      WHERE k.[vm]='T' AND k.[voucherno] LIKE 'P-%' ${baseFilters} ${inPeriod}
        AND NOT EXISTS (SELECT 1 FROM [NQT].[dbo].[on_off] o
                        WHERE o.[labelno] = k.[labelno] AND o.[vm]='YE'
                          AND ${amosToVN('o')} > ${amosToVN('k')})`),
  ]);
  res.json(Object.assign({ range }, ...parts));
}));

// --- ADMIN: SOI "LAP VAO HIGHER ASSEMBLY" -------------------------------------
//     Nghiep vu: co thiet bi KHONG lap len tau (khong co su kien YA/YE trong
//     on_off) ma duoc gan vao mot CUM CAO HON (higher_pn / higher_sn cua
//     ROTABLES). Nhung thiet bi nay dang bi liet ke nham vao "Xuat kho chua lap".
//     MUC DICH cua endpoint: DOC THAT du lieu de xac dinh COT NAO trong
//     WO_PART_ON_OFF danh dau viec do - KHONG doan ten cot.
//     Endpoint CHI DOC (SELECT), khong sua gi.
app.get('/api/admin/diag/higher', h(async (req, res) => {
  if (CONFIG.demoMode) return res.json({ note: 'Dang o DEMO_MODE, khong co du lieu that.' });
  const range = resolveRange(req.query);
  const f = readFilters(req.query);
  const out = { range };

  /** Rut gon 1 dong de tra ve JSON goc (cat chuoi qua dai, bo cot nhi phan). */
  const slim = (row) => {
    const o = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined) { o[k] = null; continue; }
      if (Buffer.isBuffer(v)) { o[k] = '(binary ' + v.length + ' bytes)'; continue; }
      if (v instanceof Date) { o[k] = v.toISOString(); continue; }
      const s = typeof v === 'string' ? v.trim() : v;
      o[k] = typeof s === 'string' && s.length > 120 ? s.slice(0, 120) + '…' : s;
    }
    return o;
  };

  // ---- 1) Danh sach COT THAT cua WO_PART_ON_OFF + vai dong mau -------------
  try {
    const s = await query('SELECT TOP 3 * FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF]');
    out.woPartOnOff = {
      docDuoc: true,
      soCot: s.length ? Object.keys(s[0]).length : 0,
      cot: s.length ? Object.keys(s[0]) : [],
      viDu: s.map(slim),
    };
  } catch (e) {
    out.woPartOnOff = { docDuoc: false, loi: e.message };
  }

  // ---- 2) on_off: cot [higher_par] dang duoc dung nhu the nao --------------
  //        (code hien tai coi vm='YE' + higher_par IS NULL = "lap thang len tau")
  const dayParams = { ...amosDayParams(range) };
  try {
    out.onOffHigherPar = {
      theoVm: await query(`
        SELECT RTRIM(o.[vm]) AS vm,
               COUNT(*) AS tong,
               SUM(CASE WHEN o.[higher_par] IS NULL THEN 1 ELSE 0 END) AS higher_par_rong,
               SUM(CASE WHEN o.[higher_par] IS NOT NULL THEN 1 ELSE 0 END) AS higher_par_co
        FROM [NQT].[dbo].[on_off] o
        WHERE o.[mutation] BETWEEN @fromDay AND @toDay
        GROUP BY o.[vm]
        ORDER BY COUNT(*) DESC`, dayParams),
    };
    out.onOffHigherPar.viDuYE_coHigherPar = (await query(`
      SELECT TOP 5 RTRIM(o.[partno]) AS partno, RTRIM(o.[serialno]) AS serialno,
             o.[labelno] AS labelno, RTRIM(o.[vm]) AS vm,
             o.[higher_par] AS higher_par, RTRIM(o.[ac_registr]) AS ac_registr,
             ${amosToVN('o')} AS time_vn
      FROM [NQT].[dbo].[on_off] o
      WHERE o.[vm] = 'YE' AND o.[higher_par] IS NOT NULL
        AND o.[mutation] BETWEEN @fromDay AND @toDay`, dayParams)).map(slim);
  } catch (e) {
    out.onOffHigherPar = { loi: e.message };
  }

  // ---- 3) DOI CHIEU: danh sach "Xuat kho chua lap" <-> WO_PART_ON_OFF ------
  //        Neu thiet bi "chua lap" thuc ra CO trong WO_PART_ON_OFF thi cac cot
  //        cua dong do se cho biet no duoc lap vao dau.
  let rows = [];   // dung lai o muc (3c) ben duoi
  try {
    // DUNG BAN GOC (chua loai nhom "lap vao cum") - de con do duoc bao nhieu cai
    // bi loai va vi sao.
    rows = await qIssuedNotInstalledRaw(range, f);
    const split = await splitIssuedByWoInstall(rows);
    out.ketQuaTach = {
      truocKhiLoai: rows.length,
      conLaiChuaLap: split.chuaLap.length,
      lapVaoCumCaoHon: split.lapVaoCum.length,
      trongDoCoHigherPnSn: split.lapVaoCum.filter(
        (r) => (r.higher_pn || '').trim() || (r.higher_sn || '').trim()
      ).length,
      viDu: split.lapVaoCum.slice(0, 5).map((r) => ({
        partno: r.partno, serialno: r.serialno, labelno: r.labelno,
        voucher_issue: r.voucher_issue,
        issue_time_vn: r.issue_time_vn, installed_time_vn: r.installed_time_vn,
        tat_install_days: r.tat_install_days == null ? null : Math.round(r.tat_install_days * 100) / 100,
        higher_pn: r.higher_pn, higher_sn: r.higher_sn,
        // Thiet bi CU bi thay ra khoi cum (thiet bi KHAC) - khong hien tren
        // bang "Chi tiet TAT" de tranh hieu nham la dong nay da thao xuong.
        wo_partno_off: r.wo_partno_off, wo_serialno_off: r.wo_serialno_off,
      })),
      soCoThayThe: split.lapVaoCum.filter((r) => r.wo_serialno_off).length,
    };
  } catch (e) {
    out.ketQuaTach = { loi: e.message };
  }

  // ---- 3b) CHIEU NGUOC LAI: "CHI THAO MA KHONG CO LAP" --------------------
  //      Thiet bi bi THAY RA khoi cum (WO_PART_ON_OFF.PARTNO_OFF/SERIALNO_OFF)
  //      cung khong sinh su kien on_off YA -> bao cao "Thao chua tra US"
  //      (dieu kien vm='YA' AND higher_par IS NULL) KHONG thay chung.
  //      Do xem nhom nay lon co nao va da tra unservice hay chua -> quyet dinh
  //      dua chung vao bao cao nao. CHI DEM, chua thay doi bao cao nao.
  try {
    const d = amosDayParams(range);
    const p = { ...d, woFrom: d.fromDay - 30, woTo: d.toDay + 30, from: range.from, to: range.to };
    const noYa = `NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[on_off] o
        WHERE RTRIM(o.[partno]) = t.partno_off AND RTRIM(o.[serialno]) = t.serialno_off
          AND o.[vm] = 'YA')`;
    const daTraUS = `EXISTS (
        SELECT 1 FROM [NQT].[dbo].[real_us1] r
        WHERE RTRIM(r.[partno]) = t.partno_off AND RTRIM(r.[serialno]) = t.serialno_off)`;
    const sets = await queryMulti(
      `IF OBJECT_ID('tempdb..#wooff') IS NOT NULL DROP TABLE #wooff;
       SELECT DISTINCT RTRIM(x.[PARTNO_OFF]) AS partno_off, RTRIM(x.[SERIALNO_OFF]) AS serialno_off
       INTO #wooff
       FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF] x
       WHERE x.[MUTATION] BETWEEN @woFrom AND @woTo
         AND x.[SERIALNO_OFF] IS NOT NULL AND LTRIM(RTRIM(x.[SERIALNO_OFF])) <> ''
         AND x.[PARTNO_OFF]   IS NOT NULL AND LTRIM(RTRIM(x.[PARTNO_OFF]))   <> '';

       SELECT
         (SELECT COUNT(*) FROM #wooff)                                  AS tongThietBiBiThayRa,
         (SELECT COUNT(*) FROM #wooff t WHERE ${noYa})                  AS khongCoYA_trongOnOff,
         (SELECT COUNT(*) FROM #wooff t WHERE ${noYa} AND ${daTraUS})   AS khongCoYA_daTraUS,
         (SELECT COUNT(*) FROM #wooff t WHERE ${noYa} AND NOT ${daTraUS}) AS khongCoYA_chuaTraUS;

       SELECT TOP 10 t.partno_off AS partno, t.serialno_off AS serialno,
              CASE WHEN ${daTraUS} THEN 1 ELSE 0 END AS da_tra_us
       FROM #wooff t WHERE ${noYa};

       DROP TABLE #wooff;`,
      p
    );
    const sum = (sets.find((s) => s.length && 'tongThietBiBiThayRa' in s[0]) || [])[0] || {};
    const ex = sets.find((s) => s.length && 'da_tra_us' in s[0]) || [];
    out.chiThaoKhongCoLap = { ...sum, viDu: ex };
  } catch (e) {
    out.chiThaoKhongCoLap = { loi: e.message };
  }

  // ---- 3c) Phan bo gia tri tung cot cua WO_PART_ON_OFF cho nhom "chua lap" --
  try {
    const coHigher = rows.filter((r) => (r.higher_pn || '').trim() || (r.higher_sn || '').trim());
    out.xuatKhoChuaLap = {
      soDong: rows.length,
      coHigherPnSn_tuROTABLES: coHigher.length,
      viDuCoHigher: coHigher.slice(0, 5).map((r) => ({
        partno: r.partno, serialno: r.serialno, labelno: r.labelno,
        ac_registr: r.ac_registr, psn: r.psn, location: r.location,
        higher_pn: r.higher_pn, higher_sn: r.higher_sn,
      })),
    };

    // Hoi WO_PART_ON_OFF THEO LO (1 lan) - KHONG hoi tung dong (linked server).
    const LIMIT = 200;
    const seen = new Set();
    const serials = [];
    for (const r of rows) {
      const s = String(r.serialno || '').trim().toUpperCase();
      if (!s || seen.has(s)) continue;
      seen.add(s); serials.push(s);
      if (serials.length >= LIMIT) break;
    }
    out.xuatKhoChuaLap.soSerialDemDoiChieu = serials.length;
    if (serials.length) {
      const p = {}; const names = [];
      serials.forEach((s, i) => { p['s' + i] = s; names.push('@s' + i); });
      const t0 = Date.now();
      const woRows = await query(
        `SELECT * FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF]
         WHERE [SERIALNO] IN (${names.join(', ')})`, p);
      // Khop chinh xac ca part + serial
      const key = (pn, sn) => String(pn || '').trim().toUpperCase() + '|' + String(sn || '').trim().toUpperCase();
      const want = new Set(rows.map((r) => key(r.partno, r.serialno)));
      const hit = woRows.filter((w) => want.has(key(w.PARTNO ?? w.partno, w.SERIALNO ?? w.serialno)));
      out.xuatKhoChuaLap.doiChieuWO = {
        ms: Date.now() - t0,
        soDongWO_theoSerial: woRows.length,
        soDongWO_khopCaPartVaSerial: hit.length,
        viDuDongWO: hit.slice(0, 5).map(slim),
      };
      // Phan bo GIA TRI cua tung cot trong cac dong khop -> cot nao la "dau hieu"
      // se lo ra ngay (vi du cot chi co 2 gia tri 'AC' / 'SHOP').
      const dist = {};
      for (const w of hit) {
        for (const [k, v] of Object.entries(w)) {
          const s = v === null || v === undefined ? '(NULL)'
            : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim().slice(0, 40));
          (dist[k] = dist[k] || new Map()).set(s, (dist[k].get(s) || 0) + 1);
        }
      }
      // Co dong nao trong on_off khong? (KHONG co dong nao = AMOS chi ghi lan
      // lap o WO_PART_ON_OFF -> dung la nhom "lap vao cum cao hon")
      const labels = [...new Set(rows.map((r) => Number(r.labelno)).filter(Number.isFinite))].slice(0, LIMIT);
      if (labels.length) {
        const lp = {}; const ln = [];
        labels.forEach((v, i) => { lp['L' + i] = v; ln.push('@L' + i); });
        const seenOff = await query(
          `SELECT DISTINCT o.[labelno] AS labelno FROM [NQT].[dbo].[on_off] o
           WHERE o.[labelno] IN (${ln.join(', ')})`, lp);
        const has = new Set(seenOff.map((x) => Number(x.labelno)));
        out.xuatKhoChuaLap.khongCoDongNaoTrongOnOff =
          labels.filter((v) => !has.has(v)).length + '/' + labels.length;
      }
      out.xuatKhoChuaLap.phanBoGiaTriCot = Object.fromEntries(
        Object.entries(dist).map(([k, m]) => [k, {
          soGiaTriKhacNhau: m.size,
          topGiaTri: [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([v, n]) => `${v} (${n})`),
        }])
      );
    }
  } catch (e) {
    out.xuatKhoChuaLap = { loi: e.message };
  }

  out.huongDan = 'Xem "phanBoGiaTriCot": cột nào chỉ có ít giá trị khác nhau ' +
    '(ví dụ 2-3 giá trị) chính là cột đánh dấu lắp vào tàu hay vào higher assembly. ' +
    'Báo tên cột + giá trị nào là "higher assembly" để cập nhật logic báo cáo.';
  res.json(out);
}));

// --- ADMIN: SOI DUOI CHUOI REMARKS de phan biet HUY / TRA ------------------
//     Nghiep vu cho biet phai "do tu cuoi cua remark" moi biet dong do la HUY
//     hay TRA. Nhung KHONG DOAN tu khoa - endpoint nay in ra cac DUOI THUC TE
//     hay gap nhat (tu cuoi cung, 8/12/20 ky tu cuoi) kem so lan xuat hien.
//     Co danh sach do roi moi viet ham phan loai. CHI DOC.
// --- DO TOC DO TUNG BUOC hoi linked server (de biet CHO NAO cham) -----------
//     Chay tung buoc RIENG RE va bam gio, thay vi doan. Tat ca chi DOC.
app.get('/api/admin/diag/linkserver', h(async (req, res) => {
  const range = resolveRange(req.query);
  const d = amosDayExact(range);
  const buoc = [];

  /** Chay 1 buoc, bam gio, KHONG lam vo ca bao cao neu buoc do loi. */
  const do1 = async (ten, ghiChu, sql, params = {}) => {
    const t = Date.now();
    try {
      const r = await query(sql, params);
      buoc.push({ ten, ghiChu, ms: Date.now() - t, soDong: r[0] ? r[0].so_dong : null });
    } catch (e) {
      buoc.push({ ten, ghiChu, ms: Date.now() - t, loi: e.message });
    }
  };

  const ngay = `h.[PICKSLIP_DATE] >= ${d.fromDayX} AND h.[PICKSLIP_DATE] < ${d.toDayX}`;
  // Bo loc nghiep vu - CHINH LA thu lam cham (do duoc gap ~21 lan)
  const bizAmos = `
       AND TRY_CONVERT(float, p.[QTY_BOOKED]) <> 0
       AND p.[STATUS] <> 1 AND p.[STATUS] <> 11
       AND LOWER(RTRIM(ISNULL(p.[LOCATION_FROM], ''))) NOT LIKE '%u/s%'
       AND (LOWER(RTRIM(ISNULL(p.[STORE], ''))) LIKE '%main'
         OR LOWER(RTRIM(ISNULL(p.[STORE], ''))) LIKE '%vna')`;

  await do1('A. NOI 2 BANG, dieu kien THUAN (cach DANG DUNG)',
    'Chi co dieu kien ngay dang so truc tiep, khong ham nao',
    `SELECT COUNT(*) AS so_dong
     FROM [DWH_DB]..[STG_AMOS].[PICKSLIP_BOOKED] p
     JOIN [DWH_DB]..[STG_AMOS].[PICKSLIP_HEADER] h ON h.[PICKSLIPNO] = p.[PICKSLIPNO]
     WHERE ${ngay}`);

  await do1('B. NOI 2 BANG + BO LOC NGHIEP VU gui xuong AMOS (cach CU)',
    'Neu B cham hon han A thi dung la cac ham LOWER/RTRIM/ISNULL/TRY_CONVERT chan viec day dieu kien',
    `SELECT COUNT(*) AS so_dong
     FROM [DWH_DB]..[STG_AMOS].[PICKSLIP_BOOKED] p
     JOIN [DWH_DB]..[STG_AMOS].[PICKSLIP_HEADER] h ON h.[PICKSLIPNO] = p.[PICKSLIPNO]
     WHERE ${ngay} ${bizAmos}`);

  await do1('C. NOI 2 BANG, dieu kien ngay dung THAM SO @p',
    'Neu C cham hon A thi tham so cung chan viec day dieu kien -> phai dat so truc tiep',
    `SELECT COUNT(*) AS so_dong
     FROM [DWH_DB]..[STG_AMOS].[PICKSLIP_BOOKED] p
     JOIN [DWH_DB]..[STG_AMOS].[PICKSLIP_HEADER] h ON h.[PICKSLIPNO] = p.[PICKSLIPNO]
     WHERE h.[PICKSLIP_DATE] >= @fromDayX AND h.[PICKSLIP_DATE] < @toDayX`,
    { fromDayX: d.fromDayX, toDayX: d.toDayX });

  await do1('D. REPAIR ADMIN - noi 3 bang, dieu kien thuan (cach DANG DUNG)',
    `location_type = ${REPAIR_LOCATION_TYPE}, OD_DETAIL.status = 0`,
    `SELECT COUNT(*) AS so_dong
     FROM [DWH_DB]..[STG_AMOS].[LOCATION] l
     JOIN [DWH_DB]..[STG_AMOS].[ROTABLES] r ON l.[locationno_i] = r.[locationno_i]
     JOIN [DWH_DB]..[STG_AMOS].[OD_DETAIL] dd ON r.[psn] = dd.[psn] AND r.[labelno] = dd.[labelno]
     WHERE l.[location_type] = ${Number(REPAIR_LOCATION_TYPE)} AND dd.[status] = 0`);

  await do1('E. RECEIVING - HISTORY, dieu kien thuan (cach DANG DUNG)',
    `DEL_DATE trong [${d.fromDayX}, ${d.toDayX}), VM IN (B1, CR)`,
    `SELECT COUNT(*) AS so_dong FROM [DWH_DB]..[STG_AMOS].[HISTORY] h
     WHERE h.[VM] IN ('B1', 'CR')
       AND h.[DEL_DATE] >= ${d.fromDayX} AND h.[DEL_DATE] < ${d.toDayX}`);

  res.json({
    ky: { tu: range.from, den: range.to, ngayAmos: d },
    thoiGianChoMotTruyVan: CONFIG.dbRequestTimeout,
    daBiet: 'Do ngay 2026-08 (ky 1 tuan): noi 2 bang voi dieu kien thuan chi 1.080ms, '
      + 'nhung cung bang do them bo loc nghiep vu co ham thi 22.806ms (gap 21 lan). '
      + 'Ket luan: PHEP NOI khong cham - CAC HAM trong WHERE moi lam cham.',
    giaiThich: 'A = cach dang dung. B/C la cac cach CU de doi chieu; A phai nhanh hon B va C.',
    buoc,
  });
}));

// --- KIEM CHUNG COT GIO (MUTATION_TIME) tren cac bang AMOS -------------------
//     Tra ve: bang nao CO cot gi, va vai dong THAT da giai ma sang gio VN, de
//     doi chieu mat thuong xem ghep (ngay + gio) co ra dung thoi diem khong.
//     Chi doc. Chi IP quan tri.
app.get('/api/admin/diag/mutation-time', h(async (req, res) => {
  const BANG = [
    { ten: 'PICKSLIP_HEADER', khoa: 'PICKSLIPNO', ngayNv: 'PICKSLIP_DATE' },
    { ten: 'PICKSLIP_BOOKED', khoa: 'PICKSLIPNO', ngayNv: 'CREATED_DATE' },
    { ten: 'HISTORY', khoa: 'HISTORYNO_I', ngayNv: 'DEL_DATE' },
  ];
  const ket = [];
  for (const b of BANG) {
    const full = `[DWH_DB]..[STG_AMOS].[${b.ten}]`;
    const [coMut, coMutT, coNgayNv] = await Promise.all([
      remoteHasColumn(full, 'MUTATION'),
      remoteHasColumn(full, 'MUTATION_TIME'),
      remoteHasColumn(full, b.ngayNv),
    ]);
    const muc = { bang: b.ten, coMUTATION: coMut, coMUTATION_TIME: coMutT };
    muc[`co${b.ngayNv}`] = coNgayNv;
    if (coMut) {
      // Lay vai dong that de MAT THUONG doi chieu duoc
      const cot = [
        `TOP 5 ${b.khoa} AS khoa`,
        'x.[MUTATION] AS mutation_tho',
        coMutT ? 'x.[MUTATION_TIME] AS mutation_time_tho' : "NULL AS mutation_time_tho",
        `${amosDayTimeToVN('x.[MUTATION]', null)} AS chi_ngay`,
        coMutT ? `${amosDayTimeToVN('x.[MUTATION]', 'x.[MUTATION_TIME]')} AS ngay_gio_VN` : 'NULL AS ngay_gio_VN',
        coNgayNv ? `x.[${b.ngayNv}] AS ngay_nghiep_vu_tho` : 'NULL AS ngay_nghiep_vu_tho',
        coNgayNv ? `${amosDayTimeToVN(`x.[${b.ngayNv}]`, null)} AS ngay_nghiep_vu` : 'NULL AS ngay_nghiep_vu',
      ].join(', ');
      try {
        muc.viDu = await query(
          `SELECT ${cot} FROM ${full} x WHERE x.[MUTATION] IS NOT NULL ORDER BY x.[MUTATION] DESC`
        );
      } catch (e) { muc.loi = e.message; }
    }
    ket.push(muc);
  }
  res.json({
    ynghia: 'MUTATION = so NGAY ke tu ' + CONFIG.amosEpoch
      + '; MUTATION_TIME = so MILLISECOND ke tu 00:00. Ghep lai + '
      + CONFIG.tzOffset + 'h ra gio Viet Nam.',
    canXacNhan: 'So cot ngay_gio_VN voi ngay_nghiep_vu: neu MUTATION la lan SUA CUOI '
      + '(khong phai luc lap phieu) thi hai cot se lech nhau nhieu -> bao lai de doi cach tinh.',
    bang: ket,
  });
}));

app.get('/api/admin/diag/remark', h(async (req, res) => {
  if (CONFIG.demoMode) return res.json({ note: 'Dang o DEMO_MODE, khong co du lieu that.' });
  const range = resolveRange(req.query);
  const f = readFilters(req.query);
  const params = { from: range.from, to: range.to, top: CONFIG.maxRows, ...amosDayParams(range) };
  const { pull, dept, join, drop } = await pickslipTemp(range, f);
  const w = pickslipWhere(f, dept, params);

  // Tu CUOI CUNG cua chuoi: dao nguoc -> cat den dau cach dau tien -> dao lai
  const lastWord = `REVERSE(LEFT(REVERSE(RTRIM(x.remarks)),
      CHARINDEX(' ', REVERSE(RTRIM(x.remarks)) + ' ') - 1))`;
  const coRemark = `LTRIM(RTRIM(ISNULL(x.remarks, ''))) <> ''`;

  const text = `${pull}

    -- [0] Tong quan: bao nhieu dong huy/tra, bao nhieu dong co ghi chu
    SELECT COUNT(*) AS tong_dong,
           SUM(x.is_cancel) AS so_dong_qty_canceled,
           SUM(CASE WHEN x.is_cancel = 1 AND ${coRemark} THEN 1 ELSE 0 END) AS co_remark,
           SUM(CASE WHEN x.is_cancel = 1 AND NOT (${coRemark}) THEN 1 ELSE 0 END) AS remark_rong
    ${join} WHERE 1 = 1 ${w};

    -- [1] TU CUOI CUNG cua remark (dong co QTY_CANCELED > 0)
    SELECT TOP 40 UPPER(${lastWord}) AS tu_cuoi, COUNT(*) AS so_dong
    ${join} WHERE x.is_cancel = 1 AND ${coRemark} ${w}
    GROUP BY UPPER(${lastWord})
    ORDER BY COUNT(*) DESC;

    -- [2] 8 / 12 / 20 ky tu CUOI (phong khi dau hieu khong tach bang dau cach)
    SELECT TOP 40 UPPER(RIGHT(RTRIM(x.remarks), 8)) AS duoi_8, COUNT(*) AS so_dong
    ${join} WHERE x.is_cancel = 1 AND ${coRemark} ${w}
    GROUP BY UPPER(RIGHT(RTRIM(x.remarks), 8)) ORDER BY COUNT(*) DESC;

    SELECT TOP 40 UPPER(RIGHT(RTRIM(x.remarks), 12)) AS duoi_12, COUNT(*) AS so_dong
    ${join} WHERE x.is_cancel = 1 AND ${coRemark} ${w}
    GROUP BY UPPER(RIGHT(RTRIM(x.remarks), 12)) ORDER BY COUNT(*) DESC;

    SELECT TOP 40 UPPER(RIGHT(RTRIM(x.remarks), 20)) AS duoi_20, COUNT(*) AS so_dong
    ${join} WHERE x.is_cancel = 1 AND ${coRemark} ${w}
    GROUP BY UPPER(RIGHT(RTRIM(x.remarks), 20)) ORDER BY COUNT(*) DESC;

    -- [3] Vai remark NGUYEN VAN de doc cho de hinh dung
    SELECT TOP 20 x.pickslipno, x.partno, x.qty_booked, x.qty_canceled, x.remarks
    ${join} WHERE x.is_cancel = 1 AND ${coRemark} ${w}
    ORDER BY LEN(RTRIM(x.remarks)) DESC;

    ${drop}`;

  try {
    const sets = await queryMulti(text, params);
    const pick = (k) => sets.find((s) => s.length && k in s[0]) || [];
    res.json({
      range,
      huongDan: 'Nhin bang tuCuoi truoc: neu cac gia tri hay gap tach bach thanh vai nhom '
        + '(vi du CANCEL / RETURN / HUY / TRA) thi do chinh la dau hieu can dung. '
        + 'Neu tu cuoi khong ro thi xem duoi8 / duoi12 / duoi20. '
        + 'Bao lai tu khoa nao la HUY, tu khoa nao la TRA -> se viet ham phan loai theo dung do.',
      tongQuan: pick('tong_dong')[0] || {},
      tuCuoi: pick('tu_cuoi'),
      duoi8: pick('duoi_8'),
      duoi12: pick('duoi_12'),
      duoi20: pick('duoi_20'),
      viDuNguyenVan: pick('remarks'),
    });
  } catch (e) {
    res.json({ range, loi: e.message });
  }
}));

// --- ADMIN: CHAN DOAN bao cao "Thao chua tra US" (vi sao so dong thay doi) ---
//     Dem theo TUNG DIEU KIEN cong don -> thay ngay dieu kien nao cat bot bao
//     nhieu dong. Quan trong nhat la 2 dieu kien tren ROTABLES: chung xet
//     TRANG THAI HIEN TAI cua thiet bi chu khong phai trang thai luc thao, nen
//     cung mot ky chay lai vao thoi diem khac se ra so khac (giam dan).
app.get('/api/admin/diag/rnr', h(async (req, res) => {
  if (CONFIG.demoMode) return res.json({ note: 'Dang o DEMO_MODE, khong co du lieu that.' });
  const range = resolveRange(req.query);
  const f = readFilters(req.query);
  const params = { from: range.from, to: range.to, ...amosDayParams(range) };
  const where = buildFilterClause(f, { station: 'o.[station]', store: 'o.[store]', department: null }, params);

  const inPeriod = `o.[vm] = 'YA'
      AND o.[mutation] BETWEEN @fromDay AND @toDay
      AND ${amosToVN('o')} >= @from AND ${amosToVN('o')} < @to
      ${where}`;
  // Cach bao cao dang dung: khong co dong real_us1 nao CUNG LABEL
  const noUs = `AND NOT EXISTS (SELECT 1 FROM [NQT].[dbo].[real_us1] r
                    WHERE r.[labelno] = o.[labelno])`;
  // Cach CHINH XAC hon: khop dung dong tra US cua CHINH lan thao nay
  // (historyno_ - la khoa ma docstring va qTatDepartments deu dung)
  const noUsHist = `AND NOT EXISTS (SELECT 1 FROM [NQT].[dbo].[real_us1] r
                    WHERE r.[historyno_] = o.[historyno_])`;
  // Quy tac DANG DUNG trong bao cao (xem qRemovedNotReturned)
  const noUsNow = `${noUsHist}
      AND NOT EXISTS (SELECT 1 FROM [NQT].[dbo].[real_us1] r2
                      WHERE r2.[labelno] = o.[labelno]
                        AND r2.[del_time] >= ${amosToVN('o')})`;
  const noHigher = 'AND o.[higher_par] IS NULL';
  const joinRo = 'INNER JOIN [DWH_DB]..[STG_AMOS].ROTABLES RO ON o.PSN = RO.PSN';

  const step = async (label, sql) => {
    try { return { buoc: label, so_dong: (await query(sql, { ...params }))[0].cnt }; }
    catch (e) { return { buoc: label, loi: e.message }; }
  };

  const buoc = [];
  buoc.push(await step('1. Thao (YA) trong ky',
    `SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[on_off] o WHERE ${inPeriod}`));
  buoc.push(await step('2. [cach CU] chua tra US - chi khop labelno',
    `SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[on_off] o WHERE ${inPeriod} ${noUs}`));
  buoc.push(await step('3. ... va higher_par IS NULL (thao thang tu tau)',
    `SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[on_off] o WHERE ${inPeriod} ${noUsNow} ${noHigher}`));
  buoc.push(await step('4. ... va CO ban ghi trong ROTABLES (theo psn)',
    `SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[on_off] o ${joinRo} WHERE ${inPeriod} ${noUsNow} ${noHigher}`));
  buoc.push(await step('5. ... va ROTABLES.MUTATION > dau ky',
    `SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[on_off] o ${joinRo}
     WHERE ${inPeriod} ${noUsNow} ${noHigher} AND RO.MUTATION > @fromDay`));
  buoc.push(await step('6. ... va ROTABLES.condition = US  <<< KET QUA BAO CAO',
    `SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[on_off] o ${joinRo}
     WHERE ${inPeriod} ${noUsNow} ${noHigher} AND RO.MUTATION > @fromDay AND RO.condition = 'US'`));

  // So sanh 2 cach xac dinh "chua tra US": theo labelno (dang dung) va theo
  // historyno_ (khop dung lan thao nay). Chenh lech = so dong co the dang bi
  // loai OAN vi cung labelno do da tung co mot lan tra US KHAC.
  buoc.push(await step('2b. [doi chieu] chua tra US - khop theo historyno_',
    `SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[on_off] o WHERE ${inPeriod} ${noUsHist}`));
  buoc.push(await step('2c. [doi chieu] bi loai theo labelno NHUNG con theo historyno_',
    `SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[on_off] o
     WHERE ${inPeriod} ${noUsHist}
       AND EXISTS (SELECT 1 FROM [NQT].[dbo].[real_us1] r WHERE r.[labelno] = o.[labelno])`));
  // Quy tac DANG DUNG tu ban sua: historyno_ HOAC labelno nhung phai tra SAU
  // lan thao nay (lan tra cua chu ky truoc khong duoc tinh).
  buoc.push(await step('2d. QUY TAC MOI: historyno_ + labelno co del_time SAU gio thao',
    `SELECT COUNT(*) AS cnt FROM [NQT].[dbo].[on_off] o
     WHERE ${inPeriod} ${noUsHist}
       AND NOT EXISTS (SELECT 1 FROM [NQT].[dbo].[real_us1] r2
                       WHERE r2.[labelno] = o.[labelno]
                         AND r2.[del_time] >= ${amosToVN('o')})`));

  // Cac thiet bi bi loai o buoc 6: hien nay condition la gi?
  let theoCondition = null;
  try {
    theoCondition = await query(`
      SELECT RTRIM(RO.condition) AS condition_hien_tai, COUNT(*) AS so_dong
      FROM [NQT].[dbo].[on_off] o ${joinRo}
      WHERE ${inPeriod} ${noUsNow} ${noHigher} AND RO.MUTATION > @fromDay
      GROUP BY RTRIM(RO.condition)
      ORDER BY COUNT(*) DESC`, { ...params });
  } catch (e) { theoCondition = { loi: e.message }; }

  res.json({
    range,
    ghiChu: 'Bao cao CO TU CAP NHAT theo thuc te: buoc 2 xet real_us1 tai THOI DIEM '
      + 'XEM, nen thiet bi thao thang 7 ma tra US thang 8 se tu bien mat khoi bao cao '
      + 'thang 7 - dung nhu mong muon.',
    caanXem: 'Buoc 2c: so dong bi loai vi CUNG LABELNO da tung co mot lan tra US KHAC '
      + '(khong phai lan thao nay) -> dang bi loai OAN. Buoc 5 va 6 loc theo condition/'
      + 'MUTATION HIEN TAI cua ROTABLES - day la tieu chi KHAC voi "da tra US hay chua", '
      + 'co the loai ca thiet bi thuc su CHUA tra. Neu 2 con so nay lon, nen bo bot dieu '
      + 'kien de bao cao phan anh dung thuc te hon.',
    buoc,
    phanBoConditionSauBuoc5: theoCondition,
  });
}));

// --- ADMIN: SOI CACH XAC DINH TRUNG TAM (vi sao 1 trung tam la lai xuat hien
//     duoi 1 station khac). Nguyen nhan co the la: 2 nhanh so lieu dung 2 CACH
//     KHAC NHAU de suy ra Trung tam.
//       - DA doi ung (deptAgg)   : real_us1.department -> SIGN(nguoi TRA US) -> 'PA'
//       - CHUA doi ung (notRecAgg): SIGN(nguoi LAP PHIEU XUAT)              -> 'PA'
//     Con Station thi LUON lay tu phieu xuat (kho_ser1.station).
//     Endpoint CHI DOC.
app.get('/api/admin/diag/dept', h(async (req, res) => {
  if (CONFIG.demoMode) return res.json({ note: 'Dang o DEMO_MODE, khong co du lieu that.' });
  const range = resolveRange(req.query);
  const f = readFilters(req.query);
  const target = String(req.query.department || '').trim().toUpperCase();
  const out = { range, locDangLoc: { station: f.station || '(tat ca)', store: f.store || '(tat ca)' }, trungTamCanSoi: target || '(chua chon)' };

  const deptR = deptFromReal('r', 'sm');                  // cach DANG DUNG
  const deptK = deptFromStaff('k.[created_b2]', 'smK');   // cach thay the (de doi chieu)
  const khoBase = `k.[vm] = 'T' AND k.[voucherno] LIKE 'P-%'
      AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'
      ${excludeCostcenterClause(f, 'k')}`;

  // 1) Hai nhanh dang dung 2 cach suy ra Trung tam khac nhau -> neu ro
  out.cachXacDinhTrungTam = {
    daTra_deptAgg: 'real_us1.department -> PA-prefix -> SIGN(real_us1.action_per) -> PA',
    chuaTra_notRecAgg: 'SIGN(kho_ser1.created_b2 = nguoi LAP PHIEU XUAT) -> PA',
    station: 'LUON lay tu kho_ser1.station (phieu xuat)',
    ghiChu: 'Nhanh DA doi ung lay Trung tam tu real_us1.department (don vi ghi ngay luc '
      + 'phat sinh giao dich). Nhanh CHUA doi ung khong co dong real_us1 nen buoc phai suy tu '
      + 'nguoi LAP PHIEU XUAT - do la nguon duy nhat co. Cot dept_neu_theo_nguoi_lap_phieu ben '
      + 'duoi cho biet neu quy theo nguoi lap phieu thi se ra trung tam nao (chi de doi chieu).',
  };

  // 2) Cac dong DA DOI UNG trong ky, kem DU cac nguon de biet dept den tu dau
  try {
    const params = { from: range.from, to: range.to, ...amosDayParams(range) };
    let where = buildFilterClause(f, { station: 'k.[station]', store: 'k.[store]', department: null }, params);
    if (target) { params.fTarget = target; where += ` AND UPPER(${deptR}) = @fTarget`; }
    const rows = await query(`
      SELECT TOP 30
        RTRIM(k.[station])      AS station_phieu_xuat,
        RTRIM(k.[store])        AS store_phieu_xuat,
        RTRIM(k.[created_b2])   AS nguoi_lap_phieu,
        RTRIM(k.[voucherno])    AS voucher,
        k.[labelno]             AS labelno,
        RTRIM(r.[station])      AS station_tra_us,
        RTRIM(r.[action_per])   AS nguoi_tra_us,
        RTRIM(r.[department])   AS dept_ghi_trong_real_us1,
        RTRIM(sm.[DEPARTMENT])  AS dept_tu_SIGN_theo_nguoi_tra,
        RTRIM(smK.[DEPARTMENT]) AS dept_tu_SIGN_theo_nguoi_lap_phieu,
        ${deptR}                AS dept_dung_de_ve_bieu_do,
        ${deptK}                AS dept_neu_theo_nguoi_lap_phieu
      FROM [NQT].[dbo].[kho_ser1] k
      INNER JOIN [NQT].[dbo].[real_us1] r
        ON k.[labelno] = r.[labelno] AND k.[voucherno] = r.[voucher_s]
      ${signJoin('r.[action_per]', 'sm')}
      ${signJoin('k.[created_b2]', 'smK')}
      WHERE ${khoBase}
        AND LTRIM(RTRIM(ISNULL(k.[receiver], ''))) <> ''
        AND r.[del_time] >= @from AND r.[del_time] < @to
        ${usPairDedup()}
        ${where}
      ORDER BY r.[del_time] DESC`, params);
    out.viDuDaDoiUng = {
      soDongLay: rows.length,
      giaiThich: 'dept_dung_de_ve_bieu_do = real_us1.department (neu trong thi moi tra SIGN '
        + 'theo nguoi tra US). So sanh voi dept_neu_theo_nguoi_lap_phieu de thay muc chenh lech '
        + 'giua 2 cach quy trung tam.',
      rows,
    };
  } catch (e) {
    out.viDuDaDoiUng = { loi: e.message };
  }

  // 2b) QUY MO VAN DE: bao nhieu dong co real_us1.department KHAC voi SIGN?
  //     Tu ban sua nay SIGN duoc uu tien hon real_us1.department (xem
  //     deptFromReal), nen dong lech se lay theo SIGN. Van do de theo doi.
  try {
    const params = { from: range.from, to: range.to, ...amosDayParams(range) };
    const where = buildFilterClause(f, { station: 'k.[station]', store: 'k.[store]', department: null }, params);
    const rDept = cleanDept('r.[department]');
    const sDept = cleanDept('sm.[DEPARTMENT]');
    const from = `
      FROM [NQT].[dbo].[kho_ser1] k
      INNER JOIN [NQT].[dbo].[real_us1] r
        ON k.[labelno] = r.[labelno] AND k.[voucherno] = r.[voucher_s]
      ${signJoin('r.[action_per]', 'sm')}
      WHERE ${khoBase}
        AND LTRIM(RTRIM(ISNULL(k.[receiver], ''))) <> ''
        AND r.[del_time] >= @from AND r.[del_time] < @to
        ${usPairDedup()}
        ${where}`;
    const sets = await queryMulti(`
      SELECT COUNT(*) AS tongDong,
             SUM(CASE WHEN ${rDept} IS NOT NULL AND ${sDept} IS NOT NULL
                       AND ${rDept} <> ${sDept} THEN 1 ELSE 0 END) AS soDongLech,
             SUM(CASE WHEN ${rDept} IS NULL THEN 1 ELSE 0 END) AS soDongThieuDeptRealUs1
      ${from};

      SELECT TOP 20 ${rDept} AS dept_real_us1, ${sDept} AS dept_SIGN, COUNT(*) AS so_dong
      ${from}
        AND ${rDept} IS NOT NULL AND ${sDept} IS NOT NULL AND ${rDept} <> ${sDept}
      GROUP BY ${rDept}, ${sDept}
      ORDER BY COUNT(*) DESC;`, params);
    const sum = (sets.find((s) => s.length && 'tongDong' in s[0]) || [])[0] || {};
    out.quyMoLechNguon = {
      ...sum,
      giaiThich: 'SIGN dang duoc UU TIEN hon real_us1.department. Cac cap duoi day '
        + 'la nhung dong ma 2 nguon KHAC nhau -> bieu do lay cot dept_SIGN.',
      cacCapLech: sets.find((s) => s.length && 'dept_real_us1' in s[0]) || [],
    };
  } catch (e) {
    out.quyMoLechNguon = { loi: e.message };
  }

  // 3) Doi chieu so luong 2 nhanh theo tung Trung tam (voi bo loc dang chon)
  try {
    const agg = await qDashboardAgg(range, f);
    const m = new Map();
    for (const x of agg.deptAgg) m.set(x.department, { department: x.department, daTra: x.cnt, chuaTra: 0 });
    for (const x of agg.notRecAgg) {
      const g = m.get(x.department) || { department: x.department, daTra: 0, chuaTra: 0 };
      g.chuaTra = x.cnt;
      m.set(x.department, g);
    }
    out.theoTrungTam = [...m.values()].sort((a, b) => (b.daTra + b.chuaTra) - (a.daTra + a.chuaTra));
  } catch (e) {
    out.theoTrungTam = { loi: e.message };
  }
  res.json(out);
}));

// --- ADMIN: TRANG THAI LLM (de kiem tra cau hinh da dung chua) ---
app.get('/api/admin/llm-status', h(async (req, res) => {
  res.json({
    provider: llm.CFG.provider || '(tat)',
    enabled: llm.isEnabled(),
    blockReason: llm.blockReason(),           // null = san sang goi
    ready: llm.isEnabled() && !llm.blockReason(),
    model: llm.modelName(),
    redact: llm.CFG.redact,
    allowPublic: llm.CFG.allowPublic,
    hasApiKey: !!llm.CFG.apiKey,              // chi bao co/khong, KHONG lo khoa
    url: llm.CFG.provider === 'local' ? llm.CFG.url : undefined,
    note: 'LLM chi tra loi cau HOI bot chua hieu / bam Bao sai. Cau so lieu do SQL noi bo.',
  });
}));

// --- ADMIN: GOI THU LLM 1 lan (kiem tra ket noi that + xem loi neu co) ---
app.post('/api/admin/llm-test', h(async (req, res) => {
  const message = String((req.body && req.body.message) || 'Bạn có hoạt động không? Trả lời ngắn gọn.').slice(0, 500);
  const reason = llm.blockReason();
  if (!llm.isEnabled() || reason) {
    return res.json({ ok: false, provider: llm.CFG.provider || '(tat)', blockReason: reason || 'LLM chua bat', model: llm.modelName() });
  }
  const kb = [...chatbot.DEFINITIONS, ...chatbot.USAGE].map((x) => '- ' + x.answer).join('\n');
  const system = 'Bạn là trợ lý nội bộ Dashboard TAT VAECO. Trả lời tiếng Việt, ngắn gọn, không bịa số liệu.\n\nKIẾN THỨC:\n' + kb;
  const t0 = Date.now();
  try {
    const out = await llm.ask(system, message);
    if (out.provider === 'anthropic') logCloudCall(out.provider, out.redacted, !!out.text, out.sent);
    res.json({
      ok: true, provider: out.provider, model: llm.modelName(),
      ms: Date.now() - t0, redacted: out.redacted,
      sent: out.sent,          // NOI DUNG that su da gui (da che neu bat redact)
      reply: out.text,
    });
  } catch (err) {
    if (llm.CFG.provider === 'anthropic') logCloudCall('anthropic', llm.CFG.redact, false, err.message);
    res.json({ ok: false, provider: llm.CFG.provider, model: llm.modelName(), ms: Date.now() - t0, error: err.message });
  }
}));

// Route tien: /admin -> trang admin review log cau hoi chua hieu
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Route: /beta -> trang dashboard beta (de xuat cai tien, lay y kien)
app.get('/beta', (req, res) => res.sendFile(path.join(__dirname, 'public', 'beta.html')));

// Route: /lgc -> VAN LA index.html, chi khac diem vao. Frontend thay duong dan
// la /lgc thi mo thang nhom "LGC" va an cac tab TAT (che do LGC).
// Lam nhu vay de LGC co mot dia chi rieng de danh dau (bookmark) MA KHONG phai
// nhan doi trang/dich vu - moi thu van dung chung mot ban ma nguon.
// (/kho la dia chi CU, van giu de link da gui di khong chet.)
// LUU Y: day chi la don gian hoa GIAO DIEN, KHONG phai phan quyen. Ai go '/'
// cung van xem duoc day du - dung nhu hien nay (moi don vi deu duoc xem).
app.get(['/lgc', '/lgc.html', '/kho', '/kho.html'], (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
  // Du lieu do NGUOI DUNG tao (cap doi ung thu cong, KB da hoc) - nhac sao luu
  console.log(`  Thu muc du lieu: ${CONFIG.dataDir}`);
  if (CONFIG.dataDir === path.join(__dirname, 'data')) {
    console.log('  ⚠️  Du lieu dang nam TRONG thu muc app -> cai lai/ghi de app co the MAT.');
    console.log('     Nen dat DATA_DIR trong .env tro ra ngoai, vd: D:\\VAECO\\dashboard-data');
  }
  // Trang thai chatbot: rule-based luon bat; LLM (noi bo/dam may) neu cau hinh + hop le
  if (!llm.isEnabled()) {
    console.log('  Chatbot: rule/intent noi bo (LLM: TAT)');
  } else if (llm.blockReason()) {
    console.log(`  Chatbot: rule/intent (LLM BI CHAN: ${llm.blockReason()})`);
  } else if (llm.CFG.provider === 'anthropic') {
    console.log(`  Chatbot: rule/intent + LLM DAM MAY [Anthropic] (model ${llm.modelName()}, che du lieu=${llm.CFG.redact ? 'BAT' : 'TAT'})`);
    console.log('  ⚠️  LLM dam may GUI DU LIEU RA NGOAI cong ty. Tat bang cach xoa LLM_PROVIDER trong .env.');
  } else {
    console.log(`  Chatbot: rule/intent + LLM noi bo (${llm.CFG.url}, model ${llm.modelName()})`);
  }
  // Bao cao dinh ky Teams/SharePoint
  if (CONFIG.teamsWebhookUrl || CONFIG.reportExportDir) {
    console.log(`  Bao cao dinh ky: ${CONFIG.reportSchedule} (ky: ${CONFIG.reportPeriods.join(',')})` +
      `${CONFIG.teamsWebhookUrl ? ' -> Teams' : ''}${CONFIG.reportExportDir ? ' -> CSV: ' + CONFIG.reportExportDir : ''}`);
    console.log('  ⚠️  Bao cao gui SO LIEU TONG HOP len cloud M365 (Teams/SharePoint).');
    startReportScheduler();
  } else {
    console.log('  Bao cao dinh ky Teams/SharePoint: TAT (chua cau hinh)');
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
