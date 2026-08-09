/**
 * SQLCHECK - soi CAU SQL THAT ma server dung cau, tim loi ma SQL Server chi bao
 * khi chay that.
 * ---------------------------------------------------------------------------
 * VI SAO CAN: `npm run smoke` chay cac ham dung cau SQL nhung chet o buoc KET
 * NOI, nen no chi bat duoc loi LAP TRINH JavaScript. Loi CU PHAP/NGU NGHIA SQL
 * van lot. Da dinh that mot lan:
 *
 *     SUM(CASE WHEN ... EXISTS (SELECT ...) ... END)
 *     -> Msg 130: "Cannot perform an aggregate function on an expression
 *        containing an aggregate or a subquery"
 *
 * Tab Receiving vo hoan toan khi chay that, trong khi smoke van bao DAT.
 *
 * CACH LAM: bat server o che do LIVE nhung thay module 'mssql' bang ban gia
 * (tools/sqlspy.js) - moi cau lenh duoc GHI LAI va tra ve ket qua rong, nen
 * endpoint chay het cac buoc. Sau do soi tung cau lenh bang cac luat duoi day.
 *
 * CHAY:  npm run sqlcheck   (da nam trong `npm run smoke`)
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = Number(process.env.SQLCHECK_PORT || 3398);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(os.tmpdir(), `sqlspy-${process.pid}.jsonl`);

const ENDPOINTS = [
  '/api/tat/departments', '/api/tat/cuvt', '/api/dashboard',
  '/api/reports/returned-unservice', '/api/reports/issued-not-installed',
  '/api/reports/removed-not-returned', '/api/reports/not-reconciled',
  '/api/reports/manual-pair', '/api/reports/removed-before-installed',
  '/api/reports/other', '/api/reports/return-store-tat', '/api/reports/repair-admin',
  '/api/pickslip', '/api/receiving',
  '/api/wp?wpno=SQLCHECK-WP', '/api/wp/list?q=SQLCHECK',
];

/** Tim vi tri dau ')' dong lai cho '(' o vi tri `open`. */
function matchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (!depth) return i; }
  }
  return -1;
}

/** Bo chu thich `-- ...` de khong bat nham tu khoa nam trong loi giai thich. */
function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '');
}

const AGG = /\b(SUM|MIN|MAX|AVG|COUNT|STRING_AGG)\s*\(/gi;

/**
 * LUAT 1: KHONG duoc co subquery (SELECT / EXISTS) BEN TRONG mot ham gom.
 * Day dung la loi da lam vo tab Receiving.
 */
function findAggWithSubquery(sql) {
  const s = stripComments(sql);
  const hits = [];
  let m;
  AGG.lastIndex = 0;
  while ((m = AGG.exec(s))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(s, open);
    if (close < 0) continue;
    const inner = s.slice(open + 1, close);
    if (/\bSELECT\b/i.test(inner)) {
      hits.push(`${m[1].toUpperCase()}(...) chua subquery: ${m[1]}(${inner.trim().slice(0, 90)}…`);
    }
    AGG.lastIndex = close; // khong soi lai phan da nam trong
  }
  return hits;
}

/**
 * LUAT 2: KHONG dat OUTER APPLY / APPLY vao bang tren LINKED SERVER - moi dong
 * se thanh mot lan goi qua mang. Day la ky luat da thong nhat cho du an.
 */
function findApplyOnLinkedServer(sql) {
  const s = stripComments(sql);
  const hits = [];
  const re = /\b(OUTER|CROSS)\s+APPLY\b([\s\S]{0,400})/gi;
  let m;
  while ((m = re.exec(s))) {
    if (/\[DWH_DB\]\.\./i.test(m[2])) hits.push(`${m[1].toUpperCase()} APPLY vao [DWH_DB].. (linked server)`);
  }
  return hits;
}

/**
 * LUAT 3: KHONG boc HAM quanh cot trong WHERE cua cau gui xuong LINKED SERVER.
 * Da DO THAT bang /api/admin/diag/linkserver: cung mot bang, cung khoang ngay,
 * chi them bo loc co LOWER/RTRIM/ISNULL/TRY_CONVERT vao WHERE la
 *     1.096 ms  ->  22.806 ms   (gap 21 lan)
 * vi cac ham do CHAN SQL Server day dieu kien xuong may chu AMOS.
 * Cach dung: keo COT THO ve #temp truoc, roi loc/cat got TAI CHO.
 *
 * CHI LA CANH BAO, KHONG lam TRUOT: luat nay khong du chinh xac de chan.
 * No soi theo tung lenh tach boi ';', ma mot lenh co the vua doc bang tam vua
 * noi sang [DWH_DB] (vd LEFT JOIN bang SIGN) - khi do ham nam o WHERE cua bang
 * TAM van bi bat nham. Muon chac chan thi do bang /api/admin/diag/linkserver.
 */
const HAM_CHAM = /\b(LOWER|UPPER|RTRIM|LTRIM|ISNULL|TRY_CONVERT|CONVERT|CAST|SUBSTRING|LEFT|RIGHT|REPLACE)\s*\(/i;
function findFuncInRemoteWhere(sql) {
  const hits = [];
  for (const lenh of stripComments(sql).split(';')) {
    if (!/\[DWH_DB\]\.\./i.test(lenh)) continue;      // khong cham linked server
    const iw = lenh.toUpperCase().lastIndexOf('WHERE');
    if (iw < 0) continue;
    let dk = lenh.slice(iw + 5);
    // Cat phan sau WHERE (GROUP BY / ORDER BY / OPTION) cho khoi bat nham
    dk = dk.split(/\bGROUP\s+BY\b|\bORDER\s+BY\b|\bOPTION\s*\(/i)[0];
    const m = dk.match(HAM_CHAM);
    if (m) {
      hits.push(`WHERE cua cau gui xuong [DWH_DB].. co ${m[1].toUpperCase()}(): `
        + dk.trim().replace(/\s+/g, ' ').slice(0, 110) + '…');
    }
  }
  return hits;
}

/**
 * LUAT 4: CHI duoc GHI vao BANG CUA APP.
 * ---------------------------------------------------------------------------
 * Yeu cau nghiep vu (bat di bat dich): tai khoan SQL nay co quyen SUA, nhung
 * app CHI duoc tao/ghi vao bang CUA RIENG NO. TUYET DOI khong duoc dong vao
 * bang khac cua SQL Server - lam hong du lieu AMOS/NQT la hong that, khong
 * quay lai duoc.
 *
 * Bang cua app: tien to `TAT_`, cong them `SIGN_CACHE` (co tu truoc).
 * Bang tam (#...) va bien bang (@...) khong tinh - chung nam trong tempdb va
 * tu bien mat khi dong ket noi.
 *
 * Day la luat LAM TRUOT, khong phai canh bao: mot cau UPDATE nham bang that
 * nguy hiem hon nhieu so voi mot truy van cham.
 */
const BANG_CUA_APP = /^(TAT_[A-Z0-9_]*|SIGN_CACHE)$/i;
const LENH_GHI = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE\s+TABLE|MERGE(?:\s+INTO)?|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\s+((?:\[[^\]]+\]|[A-Za-z0-9_#@]+)(?:\s*\.\s*(?:\[[^\]]+\]|[A-Za-z0-9_]*))*)/gi;

/** Lay ten bang tran trui tu "[NQT].[dbo].[TAT_USER]" -> "TAT_USER". */
function tenBangTran(raw) {
  const phan = String(raw).split('.').map((v) => v.trim().replace(/^\[|\]$/g, '')).filter(Boolean);
  return phan[phan.length - 1] || '';
}

function findWriteOutsideAppTables(sql) {
  const hits = [];
  const txt = stripComments(sql);
  let m;
  LENH_GHI.lastIndex = 0;
  while ((m = LENH_GHI.exec(txt)) !== null) {
    const lenh = m[1].replace(/\s+/g, ' ').toUpperCase();
    const bang = tenBangTran(m[2]);
    if (!bang) continue;
    if (bang.startsWith('#') || bang.startsWith('@')) continue;   // bang tam
    if (BANG_CUA_APP.test(bang)) continue;                        // bang cua app
    hits.push(`${lenh} vao bang KHONG PHAI cua app: ${m[2].trim()} `
      + '(chi duoc ghi vao bang tien to TAT_ hoac SIGN_CACHE)');
  }
  return hits;
}

const RULES = [
  { ten: 'Ghi vao bang KHONG phai cua app', tim: findWriteOutsideAppTables },
  { ten: 'Ham gom chua subquery (Msg 130)', tim: findAggWithSubquery },
  { ten: 'APPLY vao linked server', tim: findApplyOnLinkedServer },
  // canhBao = chi nhac, khong lam TRUOT (xem giai thich o findFuncInRemoteWhere)
  { ten: 'Ham trong WHERE gui xuong linked server (cham gap ~21 lan)',
    tim: findFuncInRemoteWhere, canhBao: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const srv = spawn(process.execPath, ['-r', path.join(__dirname, 'sqlspy.js'),
    path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      SQLSPY_OUT: OUT,
      DEMO_MODE: 'false',
      PORT: String(PORT),
      DB_SERVER: '127.0.0.1',
      DB_USER: 'sqlcheck',
      DB_PASSWORD: 'sqlcheck',
      SIGN_CACHE: 'false',
      // Tat cong LGC: o day ta kiem tra CAU SQL, khong kiem tra phan quyen.
      // Cong LGC co bai kiem tra rieng - xem tools/gatecheck.js.
      LGC_GATE: 'false',
    },
    stdio: 'ignore',
  });

  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await sleep(500);
    try { await fetch(`${BASE}/api/whoami`); up = true; } catch (_) { /* chua len */ }
  }
  if (!up) { srv.kill(); console.error('✖ Khong khoi dong duoc server de soi SQL.'); process.exit(1); }

  for (const ep of ENDPOINTS) {
    try { await fetch(BASE + ep); } catch (_) { /* khong quan trong: chi can no DUNG CAU */ }
  }
  // SIGN_CACHE=false o tren cho ra nhanh "LEFT JOIN (SELECT ... GROUP BY)";
  // chay them mot luot voi cache BAT de soi ca nhanh con lai.
  srv.kill();
  await sleep(300);

  const lines = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean) : [];
  if (!lines.length) {
    console.error('✖ Khong bat duoc cau SQL nao - kiem tra lai sqlspy.');
    process.exit(1);
  }

  const loi = [];
  const daSoi = new Set();
  for (const line of lines) {
    let sql;
    try { sql = JSON.parse(line).sql; } catch (_) { continue; }
    if (daSoi.has(sql)) continue;
    daSoi.add(sql);
    for (const r of RULES) {
      for (const h of r.tim(sql)) loi.push({ rule: r.ten, chiTiet: h, sql });
    }
  }

  console.log(`Da soi ${daSoi.size} cau SQL khac nhau (${lines.length} luot goi).`);
  const chan = [];
  for (const r of RULES) {
    const cua = loi.filter((x) => x.rule === r.ten);
    const dau = cua.length ? (r.canhBao ? '⚠' : '✖') : '✔';
    console.log(`  ${dau} ${r.ten}: ${cua.length ? cua.length + (r.canhBao ? ' cho can xem lai' : ' loi') : 'khong co'}`);
    if (r.canhBao) {
      for (const x of cua.slice(0, 3)) console.log(`      · ${x.chiTiet}`);
      if (cua.length > 3) console.log(`      · … va ${cua.length - 3} cho nua`);
    } else {
      chan.push(...cua);
    }
  }
  try { fs.unlinkSync(OUT); } catch (_) { /* khong sao */ }

  if (chan.length) {
    console.error('\n✖ TRUOT - SQL Server se bao loi khi chay that:');
    for (const x of chan) console.error(`   [${x.rule}] ${x.chiTiet}`);
    process.exit(1);
  }
  console.log('\n✔ DAT: khong cau SQL nao dinh cac loi CHAC CHAN vo khi chay that.');
}

main().catch((e) => { console.error(e); process.exit(1); });
