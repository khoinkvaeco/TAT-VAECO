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
  '/api/wp?wp=SQLCHECK-WP',
  '/api/wp/tim?station=SGN&wpStatus=11', '/api/wp/tim?station=SGN&wpStatus=-2&tuNgay=2026-01-01',
  // Goi them MOT LUOT CO BO LOC station/store: menh de loc chi duoc sinh ra khi
  // nguoi dung thuc su chon gia tri, ma LUAT 7 soi chinh cac menh de do.
  '/api/dashboard?station=SGN&store=VNA',
  '/api/tat/cuvt?station=SGN&store=VNA',
  '/api/reports/returned-unservice?station=SGN&store=VNA',
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

/**
 * LUAT 5: CAU SQL PHAI SINH RA DU CAC COT MA NODE / GIAO DIEN DOC.
 * ---------------------------------------------------------------------------
 * ⚠️ LUAT NAY SINH RA TU MOT LOI THAT DA LOT LEN SAN XUAT.
 * Tab Receiving duoc bo sung cot `loai` (Receive/Return) va so phieu chuan
 * hoa. Bon bai kiem tra deu DAT vi chung chay o DEMO_MODE - ma o do du lieu
 * do demo-data.js sinh ra, LUON CO du cac cot. Cau SQL that thi KHONG he
 * duoc sua (mot khoi sua file bi loi giua chung nen khong ghi duoc). Ket qua:
 * tren du lieu that MOI dong deu bi xep 'Receive' va cot so phieu trong rong,
 * khong bai kiem nao thay.
 *
 * Bai nay soi CHINH CAU SQL nen no khong the bi che mat boi du lieu mau.
 * Cach doc: voi moi endpoint, liet ke cac ten cot BAT BUOC phai xuat hien
 * trong cac cau SQL ma endpoint do sinh ra.
 *
 * ⚠️ GIOI HAN DA BIET (do that, khong phai suy doan): luat nay bat truong hop
 * cot KHONG HE CO trong ca endpoint - dung cai da xay ra. No KHONG bat duoc
 * truong hop cot bi DOI TEN o mot lenh trong khi lenh khac van co ten cu
 * (vd doi ten cot cua #hi nhung [3] van con `MIN(x.loai) AS loai`). Truong hop
 * do KHONG nguy hiem bang: cac tham chieu `x.loai` con lai se thanh cot khong
 * ton tai va SQL Server BAO LOI NGAY khi chay that, chu khong am tham sai.
 */
const COT_BAT_BUOC = {
  '/api/receiving': [
    // Phan loai Receive/Return + so phieu hien thi + so goc de doi chieu
    'loai', 'voucherno', 'voucherno_goc',
    // Tach so dong theo loai cho the KPI cua tab
    'dong_receive', 'dong_return',
    // KPI inspector: so dong receive/return cua tung nguoi
    'so_receive', 'so_return',
    // ⚠️ Dong RETURN phai lay tu PHAN PHIEU XUAT (#ps): endpoint nay bat buoc
    // phai sinh ra cau lay seqno cua cac dong Return. Mat cot nay nghia la ai
    // do da quay lai kieu "loc HISTORY theo MUTATION" - cach lam da lam tab
    // Receiving chay rat lau va that bai tren du lieu that.
    'seq_ret',
  ],
  '/api/dashboard': [
    // Chi so SLA phai tinh o SQL (khong phai o trinh duyet tren bang bi cat)
    'tat_days', 'sla_n', 'sla_dat', 'sla_p50', 'sla_p90',
  ],
  // ⚠️ KHONG liet ke 'so_xuat' o day: cot do KHONG co trong SQL, Node tinh ra
  // tu (so_item - so_huy). Liet ke nham lam bai kiem bao loi oan - da gap ngay
  // luc viet luat nay.
  '/api/pickslip': ['so_item', 'so_huy', 'so_can_scan'],
};

/**
 * ⚠️ PHAI khop TRON TEN COT, khong duoc dung includes():
 * 'AS loai' van nam TRONG 'AS loai_DA_BI_THAO', nen khop chuoi con se bao DAT
 * ngay ca khi cot da bi doi ten. Da thu that luc chung minh luat nay.
 */
const reCot = (ten) => new RegExp(`\\bAS\\s+\\[?${ten}\\]?\\b`, 'i');

function soiCotBatBuoc(theoEndpoint) {
  const loi = [];
  for (const [ep, cots] of Object.entries(COT_BAT_BUOC)) {
    const sql = (theoEndpoint.get(ep) || []).join('\n');
    if (!sql) { loi.push(`${ep}: KHONG bat duoc cau SQL nao`); continue; }
    for (const cot of cots) {
      if (!reCot(cot).test(sql)) {
        loi.push(`${ep}: cau SQL THIEU cot "${cot}" (Node/giao dien co doc cot nay)`);
      }
    }
  }
  return loi;
}

/**
 * LUAT 6: CAU KEO PHIEU NHAP (INTO #hraw) CHI DUOC LOC TREN MOT COT NGAY.
 * ---------------------------------------------------------------------------
 * ⚠️ LUAT NAY CUNG SINH RA TU MOT SU CO THAT (18/08/2026).
 * De ghep dong RETURN vao tab Receiving, cau keo #hraw tung duoc viet thanh:
 *     WHERE VM IN ('B1','CR','EA','TC')
 *       AND ( (VM IN ('B1','CR') AND DEL_DATE trong ky)
 *          OR (VM IN ('EA','TC') AND MUTATION trong ky) )
 * HAI COT NGAY KHAC NHAU trong cung mot OR: AMOS khong dung duoc chi muc nao
 * nen phai QUET CA BANG HISTORY. Tren du lieu that cau nay chay rat lau va
 * HONG - nguoi dung bao "lay du lieu nhap kho rat lau va that bai".
 *
 * Cach sua da chon: keo phieu nhap NHU BAN DAU (chi B1+CR theo DEL_DATE), con
 * dong tra lay o phan phieu xuat roi tra cuu HISTORY theo PICKSLIPSEQNO_I (co
 * chi muc). Luat nay khoa cach lam do lai.
 *
 * Bai kiem chi soi CAU KEO (`INTO #hraw`), khong dung den ca cau - cac cau
 * chan doan co quyen loc kieu khac.
 */
function findHaiCotNgayTrongPull(sql) {
  const loi = [];
  const s = stripComments(sql);
  // Chi soi cau tao #hraw (SELECT ... INTO #hraw FROM ... HISTORY)
  const vt = s.search(/INTO\s+#hraw\b/i);
  if (vt < 0) return loi;
  // Cat tu INTO #hraw den dau cham phay ket thuc cau
  const dau = s.indexOf(';', vt);
  const cau = dau < 0 ? s.slice(vt) : s.slice(vt, dau);
  const coDel = /\[DEL_DATE\]\s*(>=|<|>|<=)/i.test(cau);
  const coMut = /\[MUTATION\]\s*(>=|<|>|<=)/i.test(cau);
  if (coDel && coMut) {
    loi.push('Cau keo phieu nhap (INTO #hraw) loc tren CA HAI cot [DEL_DATE] va '
      + '[MUTATION] - AMOS se quet ca bang HISTORY. Lay dong Return theo '
      + 'PICKSLIPSEQNO_I (xem layReturnSeqnos) thay vi loc theo MUTATION.');
  }
  return loi;
}

/**
 * LUAT 7: KHONG duoc ap BO LOC Station/Kho thang vao bang real_us1.
 * ---------------------------------------------------------------------------
 * ⚠️ SINH RA TU MOT LOI THAT (18/08/2026). The KPI "SL nhan / SL giao (CUVT)"
 * hien **2/2** trong khi cung ky co ~593 thiet bi da doi ung.
 *
 * Nguyen nhan: danh sach gia tri cua o loc "Kho" duoc dung TU kho_ser1.[store]
 * (xem /api/filters), nhung mot so truy van lai ap bo loc do vao
 * real_us1.[store] - bang nay ghi kho theo BO GIA TRI KHAC. Phep IN (...) vi
 * the gan nhu khong khop dong nao, va KHONG CO GI BAO LOI: so lieu chi lang
 * le teo lai. Day la loai loi nguy hiem nhat vi trang van chay binh thuong.
 *
 * Luat: tim moi alias duoc gan cho [NQT].[dbo].[real_us1] trong cau, roi cam
 * so alias do voi tham so @fStation / @fStore. Muon loc theo station/kho thi
 * phai di qua PHIEU XUAT (kho_ser1) - xem khoTheoPhieuXuatClause().
 */
function findLocKhoTrenRealUs(sql) {
  const loi = [];
  const s = stripComments(sql);
  const aliases = new Set();
  const re = /\[NQT\]\.\[dbo\]\.\[real_us1\]\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(s))) aliases.add(m[1]);
  for (const a of aliases) {
    for (const cot of ['station', 'store']) {
      // vd: "r.[store] IN (@fStore0, @fStore1)" hoac "r.[store] NOT IN (...)"
      const reXau = new RegExp(
        `\\b${a}\\.\\[${cot}\\]\\s+(?:NOT\\s+)?IN\\s*\\([^)]*@f(?:Station|Store)`, 'i');
      if (reXau.test(s)) {
        loi.push(`Bo loc Station/Kho ap thang vao real_us1 (${a}.[${cot}]) - `
          + 'danh sach gia tri cua o loc lay tu kho_ser1 nen phep IN se cat sach '
          + 'du lieu ma khong bao loi. Loc qua phieu xuat: khoTheoPhieuXuatClause().');
      }
    }
  }
  return loi;
}

const RULES = [
  { ten: 'Ghi vao bang KHONG phai cua app', tim: findWriteOutsideAppTables },
  { ten: 'Bo loc Station/Kho ap thang vao real_us1 (cat sach du lieu, khong bao loi)',
    tim: findLocKhoTrenRealUs },
  { ten: 'Cau keo phieu nhap loc tren 2 cot ngay (quet ca bang HISTORY)',
    tim: findHaiCotNgayTrongPull },
  { ten: 'Ham gom chua subquery (Msg 130)', tim: findAggWithSubquery },
  { ten: 'APPLY vao linked server', tim: findApplyOnLinkedServer },
  // Luat 5 chay MOT LAN tren toan bo (khong theo tung cau) - xem duoi main()
  { ten: 'Cau SQL thieu cot ma Node/giao dien doc', tim: () => [] },
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

  // Goi TUNG endpoint roi danh dau moc trong file log, de biet cau SQL nao
  // thuoc endpoint nao (phuc vu LUAT 5 - soi cot bat buoc).
  const moc = [];
  for (const ep of ENDPOINTS) {
    moc.push({ ep, tu: fs.existsSync(OUT) ? fs.statSync(OUT).size : 0 });
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

  // Gom cau SQL theo endpoint (theo thu tu goi - moi endpoint mot khoang)
  const theoEndpoint = new Map();
  {
    let i = 0;
    let tichLuy = 0;
    for (const line of lines) {
      tichLuy += Buffer.byteLength(line) + 1;
      while (i + 1 < moc.length && tichLuy > moc[i + 1].tu) i++;
      let sql;
      try { sql = JSON.parse(line).sql; } catch (_) { continue; }
      const ep = moc[i] ? moc[i].ep : '?';
      if (!theoEndpoint.has(ep)) theoEndpoint.set(ep, []);
      theoEndpoint.get(ep).push(sql);
    }
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

  for (const h of soiCotBatBuoc(theoEndpoint)) {
    loi.push({ rule: 'Cau SQL thieu cot ma Node/giao dien doc', chiTiet: h, sql: '' });
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
