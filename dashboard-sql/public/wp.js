/* ==========================================================================
 *  wp.js - Ra soat ho so bao duong (AMOS Documentation Validator)
 * --------------------------------------------------------------------------
 *  Ba phep kiem tra (giu NGUYEN logic cua cong cu Excel dang dung o TTBD
 *  Noi truong HCM, chi doi NGUON du lieu):
 *    3.2 Reference Validation - co tai lieu tham chieu + revision chua?
 *    3.3 Handover Check       - qua ca ma con do dang thi phai co ban giao
 *    3.4 Action Step Control  - workstep sau khong duoc som hon workstep truoc
 *
 *  KHAC voi ban Excel: du lieu KHONG con lay tu file .xlsx trong thu muc mang,
 *  ma hoi thang AMOS qua /api/wp?wpno=... (server tach truy van tung bang -
 *  xem wp-validator.js). Toan bo phan CHAM DIEM van chay TAI TRINH DUYET nen
 *  doi quy tac o tab "Quy tac" la tinh lai ngay, khong phai hoi AMOS lan nua.
 *
 *  KHONG co du lieu nao roi khoi mang cong ty: trang chi goi API cua chinh
 *  may chu nay; tab "Hoi dap" cung chay hoan toan tren may nguoi dung.
 * ========================================================================== */
'use strict';

let WO = [];       // {WP,AC,STATION,WO,SEQ,ST,TXT,HTML,REM:[],steps:[{ws,rawDat,rawTim,txt,html,hdr,sg,mh}]}
let C = [];        // da cham diem
const NOW = new Date();
const $ = (id) => document.getElementById(id);
$('nowLbl').textContent = NOW.toLocaleString('vi-VN');

/* ---------- CFG: toan bo quy trinh co the tuy chinh ---------- */
const DEFCFG = {
  thr: 8,
  skipStates: ['V'],
  defClosed: false,
  openOne: true,
  dateFmt: 'DMY',
  seq: { BYPASS: ['1', '2', '3', '8', '10'], EXEC: ['4', '5', '6'], STRICT: ['7', '9'] },
  jc: 'AVAILABILITY[\\s\\S]{0,40}REVISION\\s+STATUS',
  hov: ['^\\s*(\\d{2})\\/(\\d{2})\\/(\\d{4})\\s*-\\s*VAE\\s?\\d{4,6}\\s*-\\s*\\S.*$'],
  doc: ['\\b(AMM|SRM|CMM|IPC|TSM|EO|SB|AD|NEF|MEL|CDL|DDG|WDM|ASM|FIM|MPD|CPCP)\\b'],
  rev: ['\\bREV(?:ISION)?\\b[\\s:.]*[A-Z0-9]'],
  exec: ['\\bPERFORM(?:ED)?\\s*ALL\\s*STEPS?\\b', '\\bPERFORM(?:ED)?\\s*STEPS?\\s*[\\d.,\\s&-]+',
    '\\bPERFORMED\\b', '\\bN\\/?A\\b', '\\bDONE\\b', '\\bCLOSED\\b'],
};
const KHOA_CFG = 'wpValidatorCfg';

let CFG = JSON.parse(JSON.stringify(DEFCFG));
let R = {};   // regex da bien dich

/** Nap cau hinh da luu tren MAY NAY (neu co). Hong thi dung mac dinh. */
function napCfgLuu() {
  try {
    const s = localStorage.getItem(KHOA_CFG);
    if (!s) return;
    const o = JSON.parse(s);
    CFG = Object.assign(JSON.parse(JSON.stringify(DEFCFG)), o);
    CFG.seq = Object.assign({ BYPASS: [], EXEC: [], STRICT: [] }, o.seq || {});
  } catch (_) { CFG = JSON.parse(JSON.stringify(DEFCFG)); }
}
function luuCfg() { try { localStorage.setItem(KHOA_CFG, JSON.stringify(CFG)); } catch (_) {} }

function compileRules() {
  const mk = (a) => a.map((x) => new RegExp(x, 'i'));
  R = { hov: mk(CFG.hov), doc: mk(CFG.doc), rev: mk(CFG.rev), exec: mk(CFG.exec), jc: new RegExp(CFG.jc, 'i') };
}
const any = (arr, s) => arr.some((r) => r.test(s));
const lines = (el) => el.value.split('\n').map((x) => x.trim()).filter(Boolean);
const csv = (el) => el.value.split(',').map((x) => x.trim()).filter(Boolean);

function fillCfg() {   // CFG -> form
  $('cThr').value = CFG.thr; $('cSkip').value = CFG.skipStates.join(', ');
  $('cClosed').checked = CFG.defClosed; $('cOpenOne').checked = CFG.openOne;
  $('cDateFmt').value = CFG.dateFmt || 'DMY';
  $('cBypass').value = CFG.seq.BYPASS.join(', ');
  $('cExec').value = CFG.seq.EXEC.join(', ');
  $('cStrict').value = CFG.seq.STRICT.join(', ');
  $('cJC').value = CFG.jc;
  $('rHov').value = CFG.hov.join('\n'); $('rDoc').value = CFG.doc.join('\n');
  $('rRev').value = CFG.rev.join('\n'); $('rExec').value = CFG.exec.join('\n');
  $('thr').value = CFG.thr;
  $('incClosed').checked = CFG.defClosed;
}
function readCfg() {   // form -> CFG
  CFG = {
    thr: Math.max(1, +$('cThr').value || 8),
    skipStates: csv($('cSkip')).map((s) => s.toUpperCase()),
    defClosed: $('cClosed').checked,
    openOne: $('cOpenOne').checked,
    dateFmt: $('cDateFmt').value === 'MDY' ? 'MDY' : 'DMY',
    seq: { BYPASS: csv($('cBypass')), EXEC: csv($('cExec')), STRICT: csv($('cStrict')) },
    jc: $('cJC').value.trim() || '(?!)',
    hov: lines($('rHov')), doc: lines($('rDoc')), rev: lines($('rRev')), exec: lines($('rExec')),
  };
}
function applyCfg() {
  try {
    readCfg(); compileRules(); luuCfg();
    $('thr').value = CFG.thr;
    $('incClosed').checked = CFG.defClosed;
    refreshAll();
    $('ruleStatus').textContent = '✅ Đã áp dụng và ghi nhớ trên máy này lúc ' + new Date().toLocaleTimeString('vi-VN');
  } catch (e) { $('ruleStatus').textContent = '❌ Lỗi cấu hình: ' + e.message; }
}
function resetCfg() {
  CFG = JSON.parse(JSON.stringify(DEFCFG));
  fillCfg(); compileRules(); luuCfg(); refreshAll();
  $('ruleStatus').textContent = 'Đã khôi phục mặc định theo tài liệu';
}
function exportCfg() {
  readCfg();
  const blob = new Blob([JSON.stringify(CFG, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'amos_validator_config_' + new Date().toISOString().slice(0, 10) + '.json';
  a.click(); URL.revokeObjectURL(a.href);
  $('ruleStatus').textContent = '✅ Đã xuất cấu hình';
}
$('cfgFile').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = (ev) => {
    try {
      const o = JSON.parse(ev.target.result);
      CFG = Object.assign(JSON.parse(JSON.stringify(DEFCFG)), o);
      CFG.seq = Object.assign({ BYPASS: [], EXEC: [], STRICT: [] }, o.seq || {});
      fillCfg(); compileRules(); luuCfg(); refreshAll();
      $('ruleStatus').textContent = '✅ Đã nạp cấu hình từ ' + f.name;
    } catch (err) { $('ruleStatus').textContent = '❌ File cấu hình lỗi: ' + err.message; }
  };
  rd.readAsText(f);
  e.target.value = '';       // chon lai DUNG file do van chay lai duoc
});

/* ---------- LOGIC CHAM DIEM ---------- */
function seqGroup(seq) {
  const p = ('' + (seq || '')).split('.')[0];
  if (CFG.seq.EXEC.includes(p)) return 'EXEC';
  if (CFG.seq.STRICT.includes(p)) return 'STRICT';
  return 'BYPASS';
}
const stripSys = (c) => ('' + c).replace(/^\s*closed\.?\s*/i, '').trim();
const two = (n) => String(n).padStart(2, '0');
const dstr = (d) => `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`;

/** ACTION_DAT + ACTION_TIM -> chuoi ISO. Sai dinh dang -> tra '' (coi nhu chua lam). */
function mkDt(dat, tim) {
  const m = ('' + (dat || '')).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (!m) return '';
  let y = +m[3]; if (y < 100) y += 2000;
  const isMDY = CFG && CFG.dateFmt === 'MDY';
  const dd = isMDY ? +m[2] : +m[1];
  const mm = isMDY ? +m[1] : +m[2];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
  const t = /^\d{1,2}:\d{2}/.test(tim || '') ? tim : '00:00:00';
  return `${y}-${two(mm)}-${two(dd)}T${t}`;
}

// --- 3.3 Handover Check ---
function remOf(w) { return (w.REM || []).map(stripSys).filter(Boolean); }
function checkRemarks(w, needDates, ctx) {
  const rem = remOf(w);
  if (!rem.length) return { hov: 'Missing handover remark', na: 0, note: ctx + ' nhưng WO_REMARKS trống' };
  const good = rem.filter((r) => any(R.hov, r));
  if (!good.length) {
    return { hov: 'Wrong handover format', na: 0,
      note: ctx + ' — có ghi nhưng sai cú pháp: ' + rem.slice(0, 2).join(' | ') };
  }
  const covered = needDates.filter((d) => good.some((r) => r.trim().startsWith(d)));
  if (covered.length === needDates.length) {
    return { hov: 'Valid', na: 0, note: ctx + ' — đúng cú pháp, khớp ngày ' + needDates.join(', ') };
  }
  const missDates = needDates.filter((d) => !covered.includes(d));
  return { hov: 'Wrong handover date', na: 0,
    note: ctx + ` — cú pháp đúng nhưng thiếu/sai ngày: cần ${missDates.join(', ')}; đã ghi: ${good.map((g) => g.slice(0, 10)).join(', ')}` };
}
function sortSteps(steps) {
  return [...(steps || [])].sort((a, b) => {
    const wd = (parseFloat(a.ws) || 0) - (parseFloat(b.ws) || 0);
    if (wd !== 0) return wd;
    const ad = a.dt ? new Date(a.dt).getTime() : 0;
    const bd = b.dt ? new Date(b.dt).getTime() : 0;
    return ad - bd;
  });
}
function checkHov(w, thr, incClosed) {
  const steps = w.steps || [];
  if (CFG.skipStates.includes(w.ST)) return { hov: 'N/A (WO không thực hiện)', na: 1, note: 'State ' + w.ST + ' — bỏ qua theo cấu hình' };
  if (w.ST === 'C' && !incClosed) return { hov: 'N/A (WO đã đóng)', na: 1, note: 'WO ở trạng thái Closed' };
  if (steps.length <= 1) {
    const s0 = steps[0];
    // Ngoai le: WO 1 buoc nhung CHUA DONG va da thuc hien tu ngay truoc -> van phai ban giao
    if (CFG.openOne && w.ST !== 'C' && s0 && s0.dt) {
      const d = new Date(s0.dt);
      const d0 = new Date(d); d0.setHours(0, 0, 0, 0);
      const t0 = new Date(NOW); t0.setHours(0, 0, 0, 0);
      if (d0 < t0) {
        const base = { lastStr: d.toLocaleString('vi-VN'), lastWs: s0.ws,
          hrs: +((NOW - d) / 3600000).toFixed(1), ngap: 0 };
        return { ...base, ...checkRemarks(w, [dstr(d)],
          `WO 1 bước còn mở (State ${w.ST}), thực hiện ${dstr(d)} trước hôm nay`) };
      }
      return { hov: 'N/A (1 workstep)', na: 1, note: 'Chỉ 1 bước, thực hiện trong hôm nay' };
    }
    return { hov: 'N/A (1 workstep)', na: 1,
      note: (w.ST !== 'C' && s0 && !s0.dt) ? 'Chỉ 1 bước, chưa thực hiện' : 'Chỉ có 1 bước, không cần bàn giao' };
  }
  const perf = steps.filter((s) => s.dt);
  if (!perf.length) return { hov: 'Not performed', na: 1, note: 'Chưa bước nào được thực hiện' };

  // da lam het cac buoc
  if (perf.length === steps.length) {
    if (!incClosed) return { hov: 'N/A (all steps performed)', na: 1, note: 'Đã làm hết các bước, WO chờ đóng' };
    const seq = perf.map((s) => ({ s, d: new Date(s.dt) })).sort((a, b) => a.d - b.d);
    const gaps = [];
    for (let i = 1; i < seq.length; i++) {
      const hg = (seq[i].d - seq[i - 1].d) / 3600000;
      if (hg > thr) gaps.push({ from: seq[i - 1], to: seq[i], h: +hg.toFixed(1) });
    }
    const base = { lastStr: seq[seq.length - 1].d.toLocaleString('vi-VN'),
      lastWs: seq[seq.length - 1].s.ws, hrs: 0, ngap: gaps.length };
    if (!gaps.length) {
      return { ...base, hov: 'N/A (không qua ca)', na: 1,
        note: `Các bước thực hiện liên tục, không có khoảng cách > ${thr}h` };
    }
    const needDates = [...new Set(gaps.map((g) => dstr(g.from.d)))];
    const ctx = `${gaps.length} lần chuyển ca (` + gaps.map((g) => `ws ${g.from.s.ws}→${g.to.s.ws}: ${g.h}h`).join(', ') + ')';
    return { ...base, ...checkRemarks(w, needDates, ctx) };
  }

  // con buoc chua lam: so voi thoi diem hien tai
  const sorted = perf.map((s) => ({ s, d: new Date(s.dt) })).sort((a, b) => b.d - a.d);
  const last = sorted[0];
  const hrs = (NOW - last.d) / 3600000;
  const base = { lastStr: last.d.toLocaleString('vi-VN'), hrs: +hrs.toFixed(1), lastWs: last.s.ws, ngap: 0 };
  if (hrs < thr) return { ...base, hov: 'N/A (còn trong ca)', na: 1, note: `Mới ${hrs.toFixed(1)}h < ngưỡng ${thr}h` };
  return { ...base, ...checkRemarks(w, [dstr(last.d)], `Quá ${hrs.toFixed(1)}h kể từ bước cuối`) };
}

// --- 3.4 Action Step Control ---
function checkAsc(w) {
  if (CFG.skipStates.includes(w.ST)) return { ascKind: 'NA', note2: 'State ' + w.ST + ' — bỏ qua theo cấu hình' };
  const steps = sortSteps(w.steps);
  if (steps.length <= 1) return { ascKind: 'NA', note2: 'Chỉ 1 bước' };
  const miss = steps.filter((s) => !s.dt).map((s) => s.ws);
  const bad = []; let mx = null;
  steps.forEach((s) => {
    if (!s.dt) return;
    const d = new Date(s.dt);
    if (mx !== null && d < mx) bad.push(s.ws);
    if (mx === null || d > mx) mx = d;
  });
  if (bad.length) {
    return { ascKind: 'ORDER',
      note2: `Bước ${bad.join(', ')} có thời gian sớm hơn bước trước đó` + (miss.length ? ` · chưa thực hiện: ${miss.join(', ')}` : '') };
  }
  if (miss.length) return { ascKind: 'MISS', note2: `Bước chưa thực hiện: ${miss.join(', ')}` };
  return { ascKind: 'OK', note2: 'Thứ tự hợp lệ' };
}

// gop toan bo noi dung chu cua WO de kiem tra tai lieu: TEXT + DES (da bo tag)
function stripTag(s) { return ('' + (s || '')).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim(); }
function woContentText(w) {
  const parts = [w.TXT || '', stripTag(w.HTML)];
  (w.steps || []).forEach((s) => { parts.push(s.txt || ''); if (s.html) parts.push(stripTag(s.html)); });
  return parts.filter(Boolean).join(' ').trim();
}
// --- 3.2 Reference Validation ---
function checkRef(w, skipRev) {
  const grp = seqGroup(w.SEQ);
  const txt = woContentText(w);
  if (CFG.skipStates.includes(w.ST)) return { grp, ref: 'N/A', txt };
  if (!txt) return { grp, ref: 'N/A', txt: '' };
  if (grp === 'BYPASS') return { grp, ref: 'Valid', txt };
  if (grp === 'EXEC') return { grp, ref: any(R.exec, txt) ? 'Valid' : 'Wrong format', txt };
  const hasDoc = any(R.doc, txt); const hasRev = skipRev || any(R.rev, txt);
  return { grp, ref: (hasDoc && hasRev) ? 'Valid' : 'Missing reference / revision', txt };
}

function compute() {
  const thr = Math.max(1, +$('thr').value || 8);
  const incClosed = $('incClosed').checked;
  $('thrLbl').textContent = thr;
  // Tinh lai dt cho moi step theo CFG.dateFmt hien tai - de doi dinh dang ngay
  // o tab Quy tac co hieu luc ngay, khong phai tai lai du lieu.
  WO.forEach((w) => { (w.steps || []).forEach((s) => { s.dt = mkDt(s.rawDat, s.rawTim); }); });
  // JC 10.x -> bo qua revision cho ca WP
  const skipWP = new Set();
  WO.forEach((w) => { if (R.jc.test(woContentText(w))) skipWP.add(w.WP); });
  C = WO.map((w) => {
    const hv = checkHov(w, thr, incClosed); const a = checkAsc(w); const r = checkRef(w, skipWP.has(w.WP));
    const totalMH = (w.steps || []).reduce((acc, x) => acc + (x.mh || 0), 0);
    const signers = [...new Set((w.steps || []).flatMap((x) => (x.sg || '').split(',').map((s) => s.trim()).filter(Boolean)))];
    return { ...w, ...hv, ...a, ...r, nstep: (w.steps || []).length, skipRev: skipWP.has(w.WP),
      totalMH: +totalMH.toFixed(2), signers: signers.join(', ') };
  });
}
const wpSel = () => $('fWP').value;
const pool = () => { const w = wpSel(); return w ? C.filter((d) => d.WP === w) : C; };
const HOVNG = ['Missing handover remark', 'Wrong handover format', 'Wrong handover date'];

// loc theo WP + tien to SEQ + SEQ chinh xac cho tung tab
const seqPre = (s) => ('' + (s || '')).split('.')[0];
function applyWpSeq(arr, pfx) {
  const wp = $(pfx + 'WP').value;
  const sg = $(pfx + 'SeqG').value;
  const sq = $(pfx + 'Seq').value.trim().toLowerCase();
  if (wp) arr = arr.filter((d) => d.WP === wp);
  if (sg) arr = arr.filter((d) => seqPre(d.SEQ) === sg);
  if (sq) arr = arr.filter((d) => (d.SEQ || '').toLowerCase().includes(sq));
  return arr;
}
function fillTabFilters() {
  const wps = [...new Set(C.map((d) => d.WP).filter(Boolean))].sort();
  const segs = [...new Set(C.map((d) => seqPre(d.SEQ)).filter(Boolean))].sort((a, b) => (+a || 0) - (+b || 0));
  ['h', 'a', 'r'].forEach((p) => {
    const w = $(p + 'WP'); const g = $(p + 'SeqG');
    const cw = w.value; const cg = g.value;
    w.innerHTML = '<option value="">Tất cả WP</option>' + wps.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
    g.innerHTML = '<option value="">Tất cả SEQ</option>' + segs.map((x) => `<option value="${esc(x)}">SEQ ${esc(x)}.x</option>`).join('');
    if (wps.includes(cw)) w.value = cw;
    if (segs.includes(cg)) g.value = cg;
  });
}

/* ---------- HIEN THI ---------- */
const esc = (s) => ('' + (s === undefined || s === null ? '' : s))
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fdt = (v) => (v ? new Date(v).toLocaleString('vi-VN') : '');

/** Bang rong: noi RO vi sao rong thay vi de mot khung trang khong loi giai. */
function veTrong(id, coDuLieu, loiNhan) {
  const el = $(id); if (!el) return;
  el.classList.toggle('hidden', coDuLieu);
  if (!coDuLieu) el.innerHTML = loiNhan;
}

function renderKPI() {
  const p = pool();
  const need = p.filter((d) => !d.na).length;
  const ok = p.filter((d) => d.hov === 'Valid').length;
  const ng = p.filter((d) => HOVNG.includes(d.hov)).length;
  const asc = p.filter((d) => d.ascKind === 'ORDER').length;
  const ref = p.filter((d) => d.ref !== 'Valid' && d.ref !== 'N/A').length;
  const rate = need ? (100 * ok / need).toFixed(1) : 0;
  $('kpis').innerHTML = `
   <div class="kpi blue"><div class="label">Tổng WO</div><div class="val">${p.length}</div></div>
   <div class="kpi cyan"><div class="label">Cần bàn giao</div><div class="val">${need}</div></div>
   <div class="kpi green"><div class="label">HOV đạt</div><div class="val">${ok}</div></div>
   <div class="kpi red"><div class="label">HOV không đạt</div><div class="val">${ng}</div></div>
   <div class="kpi amber"><div class="label">ASC sai thứ tự</div><div class="val">${asc}</div></div>
   <div class="kpi purple"><div class="label">Ref thiếu/sai</div><div class="val">${ref}</div></div>
   <div class="kpi ${rate >= 70 ? 'green' : rate >= 40 ? 'amber' : 'red'}"><div class="label">Tỷ lệ HOV đạt</div><div class="val">${rate}%</div></div>`;
}
let wpSort = { k: 'ng', asc: false };
function renderWP() {
  const m = {};
  C.forEach((d) => {
    if (!m[d.WP]) m[d.WP] = { wp: d.WP, ac: d.AC, st: d.STATION, total: 0, need: 0, ok: 0, ng: 0, asc: 0, ref: 0 };
    const o = m[d.WP]; o.total++;
    if (!d.na) o.need++;
    if (d.hov === 'Valid') o.ok++;
    if (HOVNG.includes(d.hov)) o.ng++;
    if (d.ascKind === 'ORDER') o.asc++;
    if (d.ref !== 'Valid' && d.ref !== 'N/A') o.ref++;
  });
  const arr = Object.values(m).map((o) => { o.rate = o.need ? +(100 * o.ok / o.need).toFixed(1) : 0; return o; });
  arr.sort((x, y) => { const d = x[wpSort.k] > y[wpSort.k] ? 1 : x[wpSort.k] < y[wpSort.k] ? -1 : 0; return wpSort.asc ? d : -d; });
  document.querySelector('#wpTable tbody').innerHTML = arr.map((s) => `<tr>
   <td class="mono">${esc(s.wp)}</td><td>${esc(s.ac)}</td><td>${esc(s.st)}</td><td>${s.total}</td>
   <td>${s.need}</td><td><span class="badge g">${s.ok}</span></td><td><span class="badge r">${s.ng}</span></td>
   <td><span class="badge a">${s.asc}</span></td><td><span class="badge p">${s.ref}</span></td>
   <td class="rate ${s.rate >= 70 ? 'hi' : s.rate >= 40 ? 'mi' : 'lo'}">${s.rate}%</td>
   <td><div class="bar"><i style="width:${s.rate}%"></i></div></td></tr>`).join('');
  veTrong('wpTrong', arr.length,
    WO.length ? 'Không có WP nào khớp bộ lọc.'
      : 'Chưa có dữ liệu.<br>Nhập số Work Package ở ô phía trên rồi bấm <b>Lấy dữ liệu</b>.');
}
function hovBadge(s) {
  if (s === 'Valid') return '<span class="badge g">Valid</span>';
  if (s === 'Missing handover remark') return '<span class="badge r">Missing remark</span>';
  if (s === 'Wrong handover format') return '<span class="badge a">Wrong format</span>';
  if (s === 'Wrong handover date') return '<span class="badge a">Wrong date</span>';
  if (s === 'Not performed') return '<span class="badge n">Not performed</span>';
  return `<span class="badge n">${esc(s)}</span>`;
}

// to sang tai lieu tham chieu / revision trong TEXT
function hilite(t) {
  let out = esc(t);
  R.doc.forEach((r) => { const g = new RegExp(r.source, 'gi'); out = out.replace(g, (m) => `<mark>${m}</mark>`); });
  R.rev.forEach((r) => { const g = new RegExp(r.source, 'gi'); out = out.replace(g, (m) => `<mark class="rev">${m}</mark>`); });
  return out;
}
// lam sach HTML tu cot DES: chi giu the dinh dang co ban, bo script/style/thuoc tinh
function safeHtml(raw) {
  if (!raw) return '';
  let s = ('' + raw).replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const ok = /^(p|br|b|strong|i|em|u|ul|ol|li|span|div|sub|sup|table|thead|tbody|tr|td|th)$/i;
  s = s.replace(/<\s*\/?\s*([a-z0-9]+)([^>]*)>/gi, (m, tag) => {
    if (!ok.test(tag)) return '';
    return m.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+(href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  });
  return s;
}
function contentHtml(txt, html, doHilite) {
  if (txt) return doHilite ? hilite(txt) : esc(txt);
  if (html) return '<div class="deshtml">' + safeHtml(html) + '</div>';
  return '<span class="nores">(trống)</span>';
}
function badSteps(d) {
  const st = sortSteps(d.steps);
  let mx = null; const bad = new Set();
  st.forEach((x) => {
    if (!x.dt) return;
    const dd = new Date(x.dt);
    if (mx !== null && dd < mx) bad.add(x.ws);
    if (mx === null || dd > mx) mx = dd;
  });
  return bad;
}
function stepDetail(d, mode) {
  const st = sortSteps(d.steps);
  const bad = badSteps(d);
  const totalMH = st.reduce((a, x) => a + (x.mh || 0), 0);
  let h = '<div class="stepbox">';
  h += `<h4>Nội dung WO ${d.TXT ? '(WO_TEXT)' : (d.HTML ? '(DES)' : '')}</h4>`
     + `<div class="txtc" style="font-size:12px">${contentHtml(d.TXT, d.HTML, false)}</div>`;
  h += `<h4>Các workstep (${st.length} hành động &middot; Tổng MH: <span style="color:var(--green)">${totalMH.toFixed(2)}</span>)</h4><table class="stt"><thead><tr>
      <th style="width:46px">WS</th><th style="width:150px">Header</th>
      <th style="width:130px">Thực hiện</th><th style="width:90px">Người ký</th>
      <th style="width:60px">MH</th>
      <th>Nội dung (TEXT / DES)</th><th style="width:120px">Ghi chú</th></tr></thead><tbody>`;
  st.forEach((x) => {
    let cls = ''; let note = '';
    if (!x.dt) { cls = 'nodt'; note = '<span class="badge n">chưa thực hiện</span>'; }
    if (bad.has(x.ws)) { cls = 'bad'; note = '<span class="badge r">sai thứ tự</span>'; }
    if (mode === 'hov' && d.lastWs && x.ws === d.lastWs) { cls = 'last'; note = '<span class="badge b">bước cuối</span>' + note; }
    const body = contentHtml(x.txt, x.html, mode === 'ref');
    h += `<tr class="${cls}"><td class="mono">${esc(x.ws)}</td><td>${esc(x.hdr || '')}</td>
        <td class="mono">${fdt(x.dt) || '—'}</td><td class="mono">${esc(x.sg || '')}</td>
        <td class="mono">${(x.mh || 0).toFixed(2)}</td>
        <td class="txtc">${body}</td><td>${note || ''}</td></tr>`;
  });
  h += `<tfoot><tr style="font-weight:600"><td colspan="4" style="text-align:right">Tổng MH:</td>
      <td class="mono" style="color:var(--green)">${totalMH.toFixed(2)}</td><td></td><td></td></tr></tfoot>`;
  h += '</tbody></table>';
  // WO_REMARKS
  h += '<h4>WO_REMARKS (nội dung bàn giao)</h4>';
  const rem = (d.REM || []).map(stripSys).filter(Boolean);
  if (!rem.length) h += '<div class="nores">Không có nội dung bàn giao.</div>';
  else {
    h += rem.map((r) => {
      const ok = any(R.hov, r);
      return `<div class="remrow"><span class="badge ${ok ? 'g' : 'r'}">${ok ? 'đúng cú pháp' : 'sai cú pháp'}</span>
              <span class="t">${esc(r)}</span></div>`;
    }).join('');
    h += '<div class="small" style="margin-top:7px">Cú pháp yêu cầu: <code>DD/MM/YYYY - VAExxxxx - [Nội dung]</code>'
      + (d.lastStr ? ` · ngày bước cuối: <b>${esc(d.lastStr.split(' ').pop() || d.lastStr)}</b>` : '') + '</div>';
  }
  if (mode === 'ref') {
    h += '<h4>Kết quả kiểm tra tài liệu</h4>';
    const all = (d.steps || []).map((x) => x.txt).join(' ');
    h += `<div class="small">Nhóm SEQ <b>${esc(d.grp)}</b> · `
      + `tài liệu tham chiếu: <b class="${any(R.doc, all) ? 'hi' : 'lo'}">${any(R.doc, all) ? 'có' : 'không thấy'}</b> · `
      + `revision: <b class="${any(R.rev, all) ? 'hi' : 'lo'}">${any(R.rev, all) ? 'có' : 'không thấy'}</b>`
      + (d.skipRev ? ' · <b>bỏ qua revision do WP có JC 10.x</b>' : '') + '</div>';
  }
  h += `<div class="small" style="margin-top:9px">Kết luận: HOV <b>${esc(d.hov)}</b> · ASC <b>${esc(d.ascKind)}</b> · Reference <b>${esc(d.ref)}</b></div>`;
  return h + '</div>';
}
function toggleRow(tr, d, mode, cols) {
  const nx = tr.nextElementSibling;
  if (nx && nx.classList.contains('exp')) { nx.remove(); tr.classList.remove('clkopen'); return; }
  document.querySelectorAll('tr.exp').forEach((x) => x.remove());
  const r = document.createElement('tr'); r.className = 'exp';
  r.innerHTML = `<td class="expcell" colspan="${cols}">${stepDetail(d, mode)}</td>`;
  tr.after(r);
}
function wireRows(tblId, arr, mode, cols) {
  document.querySelectorAll('#' + tblId + ' tbody tr').forEach((tr, i) => {
    if (tr.classList.contains('exp')) return;
    tr.classList.add('clk');
    tr.onclick = () => toggleRow(tr, arr[i], mode, cols);
  });
}
let hSort = { k: 'hrs', asc: false };
function renderHov() {
  const sel = $('hStatus');
  if (sel.options.length <= 1) {
    [...new Set(C.map((d) => d.hov))].sort().forEach((s) => sel.add(new Option(s, s)));
  }
  let arr = applyWpSeq(pool(), 'h');
  if ($('hHideNA').checked) arr = arr.filter((d) => !d.na);
  const st = sel.value; const ss = $('hState').value; const q = $('hSearch').value.toLowerCase();
  if (st) arr = arr.filter((d) => d.hov === st);
  if (ss) arr = arr.filter((d) => d.ST === ss);
  if (q) arr = arr.filter((d) => ((d.WO || '') + (d.SEQ || '') + (d.TXT || '') + (d.note || '')).toLowerCase().includes(q));
  arr = arr.sort((x, y) => { const a = x[hSort.k] ?? ''; const b = y[hSort.k] ?? ''; const d = a > b ? 1 : a < b ? -1 : 0; return hSort.asc ? d : -d; }).slice(0, 400);
  document.querySelector('#hovTable tbody').innerHTML = arr.map((d) => `<tr>
   <td class="mono">${esc(d.WP)}</td><td>${esc(d.WO)}</td><td class="mono">${esc(d.SEQ) || '-'}</td>
   <td><span class="badge ${d.ST === 'C' ? 'b' : 'a'}">${esc(d.ST)}</span></td>
   <td class="mono">${esc(d.lastStr) || '-'}${d.lastWs ? ` <span class="small">(ws ${esc(d.lastWs)})</span>` : ''}</td>
   <td class="mono">${d.hrs !== undefined ? d.hrs : '-'}</td>
   <td class="mono">${d.ngap ? d.ngap : '-'}</td>
   <td class="mono" style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(d.signers)}">${esc(d.signers) || '-'}</td>
   <td class="mono">${d.totalMH.toFixed(2)}</td>
   <td>${hovBadge(d.hov)}</td><td class="det">${esc(d.note)}</td></tr>`).join('');
  wireRows('hovTable', arr, 'hov', 11);
  veTrong('hovTrong', arr.length, WO.length
    ? 'Không có WO nào khớp bộ lọc. Thử bỏ tích <b>Ẩn nhóm N/A</b> hoặc xóa ô tìm kiếm.'
    : 'Chưa có dữ liệu — hãy lấy một Work Package trước.');
}
let aSort = { k: 'WO', asc: true };
function renderAsc() {
  let arr = applyWpSeq(pool(), 'a').filter((d) => d.nstep > 1);
  const k = $('aKind').value; const q = $('aSearch').value.toLowerCase();
  if (k) arr = arr.filter((d) => d.ascKind === k);
  if (q) arr = arr.filter((d) => ((d.WO || '') + (d.TXT || '') + (d.note2 || '')).toLowerCase().includes(q));
  arr = arr.sort((x, y) => { const a = x[aSort.k] ?? ''; const b = y[aSort.k] ?? ''; const d = a > b ? 1 : a < b ? -1 : 0; return aSort.asc ? d : -d; }).slice(0, 400);
  const bd = { ORDER: '<span class="badge r">Sai thứ tự</span>', MISS: '<span class="badge a">Chưa thực hiện đủ</span>',
    OK: '<span class="badge g">Hợp lệ</span>', NA: '<span class="badge n">N/A</span>' };
  document.querySelector('#ascTable tbody').innerHTML = arr.map((d) => `<tr>
   <td class="mono">${esc(d.WP)}</td><td>${esc(d.WO)}</td><td class="mono">${esc(d.SEQ) || '-'}</td>
   <td><span class="badge ${d.ST === 'C' ? 'b' : 'a'}">${esc(d.ST)}</span></td>
   <td>${d.nstep}</td>
   <td class="mono" style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(d.signers)}">${esc(d.signers) || '-'}</td>
   <td class="mono">${d.totalMH.toFixed(2)}</td>
   <td>${bd[d.ascKind] || esc(d.ascKind)}</td><td class="det">${esc(d.note2)}</td></tr>`).join('');
  wireRows('ascTable', arr, 'asc', 9);
  veTrong('ascTrong', arr.length, WO.length
    ? 'Không có WO nhiều bước nào khớp bộ lọc (tab này chỉ xét WO có &gt; 1 workstep).'
    : 'Chưa có dữ liệu — hãy lấy một Work Package trước.');
}
let rSort = { k: 'WO', asc: true };
function renderRef() {
  const sel = $('rStatus');
  if (sel.options.length <= 1) { [...new Set(C.map((d) => d.ref))].sort().forEach((s) => sel.add(new Option(s, s))); }
  let arr = applyWpSeq(pool(), 'r');
  const g = $('rGroup').value; const s = sel.value; const q = $('rSearch').value.toLowerCase();
  if (g) arr = arr.filter((d) => d.grp === g);
  if (s) arr = arr.filter((d) => d.ref === s);
  if (q) arr = arr.filter((d) => ((d.WO || '') + (d.SEQ || '') + (d.txt || '')).toLowerCase().includes(q));
  arr = arr.sort((x, y) => { const a = x[rSort.k] ?? ''; const b = y[rSort.k] ?? ''; const d = a > b ? 1 : a < b ? -1 : 0; return rSort.asc ? d : -d; }).slice(0, 400);
  const gb = { BYPASS: '<span class="badge b">BYPASS</span>', EXEC: '<span class="badge a">EXECUTION</span>', STRICT: '<span class="badge r">STRICT_REF</span>' };
  const rb = (v) => (v === 'Valid' ? '<span class="badge g">Valid</span>' : v === 'N/A' ? '<span class="badge n">N/A</span>'
    : v === 'Wrong format' ? '<span class="badge a">Wrong format</span>' : '<span class="badge r">Missing ref/rev</span>');
  document.querySelector('#refTable tbody').innerHTML = arr.map((d) => `<tr>
   <td class="mono">${esc(d.WP)}</td><td>${esc(d.WO)}</td><td class="mono">${esc(d.SEQ) || '-'}</td>
   <td>${gb[d.grp] || esc(d.grp)}</td><td class="mono">${d.totalMH.toFixed(2)}</td>
   <td>${rb(d.ref)}${d.skipRev ? ' <span class="small">(JC10)</span>' : ''}</td>
   <td class="det">${esc((d.txt || '').slice(0, 150))}</td></tr>`).join('');
  wireRows('refTable', arr, 'ref', 7);
  veTrong('refTrong', arr.length, WO.length
    ? 'Không có WO nào khớp bộ lọc.'
    : 'Chưa có dữ liệu — hãy lấy một Work Package trước.');
}
function refreshWPFilter() {
  const sel = $('fWP'); const cur = sel.value;
  const wps = [...new Set(C.map((d) => d.WP).filter(Boolean))];
  sel.innerHTML = '<option value="">Tất cả</option>' + wps.map((w) => `<option value="${esc(w)}">${esc(w)}</option>`).join('');
  if (wps.includes(cur)) sel.value = cur;
}
function refreshAll() {
  compute(); refreshWPFilter(); fillTabFilters();
  renderKPI(); renderWP(); renderHov(); renderAsc(); renderRef();
}

/* ==========================================================================
 *  NAP DU LIEU TU AMOS  (thay cho viec chon file Excel o ban cu)
 * ========================================================================== */
let _jobDem = 0;
function taoMaJob() {
  return `w${Date.now().toString(36)}${(_jobDem++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Nhat ky tien trinh: cac dong den TRUOC khi khung log kip hien khong duoc mat. */
let _choLog = [];
function moLog(tieuDe) {
  _choLog = [];
  const box = $('logBox');
  box.classList.remove('hidden', 'xong');
  $('logTitle').textContent = tieuDe;
  $('logMs').textContent = '';
  $('logLines').innerHTML = '';
}
function themLog(b) {
  const el = $('logLines');
  if (!el || $('logBox').classList.contains('hidden')) { _choLog.push(b); return; }
  const d = document.createElement('div');
  const t = String(b.text || '');
  d.className = /^✔|^Chế độ/.test(t) ? 'ok' : /^✘/.test(t) ? 'er' : /^⏳/.test(t) ? 'wt' : '';
  d.textContent = (b.ms !== undefined ? `[${(b.ms / 1000).toFixed(1)}s] ` : '') + t;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
  $('logMs').textContent = b.ms !== undefined ? `${(b.ms / 1000).toFixed(1)} giây` : '';
}
function xongLog(coLoi) {
  $('logBox').classList.add('xong');
  $('logTitle').textContent = coLoi ? 'Dừng vì lỗi' : 'Đã lấy xong dữ liệu';
}

/**
 * Mo kenh nhat ky (SSE) cho mot lan tai. Trinh duyet cu khong co EventSource
 * thi van tai binh thuong, chi la khong co nhat ky - KHONG duoc lam hong viec tai.
 */
function moTienTrinh() {
  const job = taoMaJob();
  let es = null;
  try {
    es = new EventSource(`/api/progress/${job}`);
    es.onmessage = (ev) => {
      try {
        const b = JSON.parse(ev.data);
        themLog(b);
        if (b.xong) { es.close(); es = null; }
      } catch (_) { /* dong hong - bo qua */ }
    };
    es.onerror = () => { try { if (es) es.close(); } catch (_) {} es = null; };
  } catch (_) { es = null; }
  return { job, dong: () => { try { if (es) es.close(); } catch (_) {} es = null; } };
}

function baoLoi(msg, thuLai) {
  const el = $('errBox');
  el.classList.remove('hidden');
  el.innerHTML = `<b>Không lấy được dữ liệu.</b><br>${esc(msg)}`
    + '<br><button id="btnThuLai" class="primary">↻ Thử lại</button>';
  if (thuLai) $('btnThuLai').onclick = () => { el.classList.add('hidden'); thuLai(); };
}
const anLoi = () => $('errBox').classList.add('hidden');

let dangTai = false;
async function taiWp(boQuaCache) {
  if (dangTai) return;
  const wpno = $('wpno').value.trim();
  if (!wpno) { $('wpno').focus(); $('fileStatus').textContent = '⚠️ Hãy nhập số Work Package.'; return; }
  dangTai = true; anLoi();
  $('btnLoad').disabled = true; $('btnReload').disabled = true;
  $('fileStatus').textContent = 'Đang lấy dữ liệu…';
  moLog(`Đang lấy Work Package ${wpno} từ AMOS…`);
  setTimeout(() => { const c = _choLog; _choLog = []; c.forEach(themLog); }, 30);
  const tp = moTienTrinh();
  const t0 = Date.now();
  try {
    const u = `/api/wp?wpno=${encodeURIComponent(wpno)}&job=${tp.job}${boQuaCache ? '&nocache=1' : ''}`;
    const res = await fetch(u);
    const js = await res.json().catch(() => ({ error: true, message: `Máy chủ trả về mã ${res.status}.` }));
    if (!res.ok || js.error) throw new Error(js.message || `Máy chủ trả về mã ${res.status}.`);
    WO = Array.isArray(js.rows) ? js.rows : [];
    refreshAll();
    const giay = ((Date.now() - t0) / 1000).toFixed(1);
    $('fileStatus').textContent = `✅ Đã nạp ${WO.length} WO của ${js.wp || wpno}`
      + (js.demo ? ' (dữ liệu mẫu — DEMO_MODE)' : '') + ` · ${giay}s`;
    xongLog(false);
  } catch (e) {
    $('fileStatus').textContent = '❌ ' + e.message;
    xongLog(true);
    baoLoi(e.message, () => taiWp(boQuaCache));
  } finally {
    // KHONG dong kenh nhat ky ngay: khi ket qua ve rat nhanh (bo nho dem, hoac
    // che do DEMO) thi ket noi SSE con CHUA kip mo, dong ngay se huy no va
    // nhat ky trong tron - do that: 0/8 dong hien ra. Cho mot nhip de may chu
    // kip phat lai cac dong da ghi, roi moi dong.
    setTimeout(tp.dong, 1500);
    dangTai = false;
    $('btnLoad').disabled = false; $('btnReload').disabled = false;
  }
}

/** Goi y danh sach WP cho o nhap (datalist). Loi thi im lang - chi la goi y. */
async function goiYWp() {
  try {
    const res = await fetch('/api/wp/list?q=' + encodeURIComponent($('wpno').value.trim()));
    if (!res.ok) return;
    const js = await res.json();
    $('wpGoiY').innerHTML = (js.ds || []).map((w) => `<option value="${esc(w)}">`).join('');
  } catch (_) { /* khong co goi y cung khong sao */ }
}

/* ---------- TABS & SU KIEN ---------- */
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
    t.classList.add('on');
    ['wp', 'hov', 'asc', 'ref', 'chat', 'rule'].forEach((k) => $('s-' + k).classList.toggle('hidden', k !== t.dataset.t));
  };
});
const bind = (id, fn, ev) => $(id).addEventListener(ev || 'change', fn);
bind('thr', refreshAll); bind('incClosed', refreshAll);
bind('fWP', () => { renderKPI(); renderHov(); renderAsc(); renderRef(); });
['hStatus', 'hState', 'hHideNA', 'hWP', 'hSeqG'].forEach((i) => bind(i, renderHov));
bind('hSearch', renderHov, 'input'); bind('hSeq', renderHov, 'input');
bind('aKind', renderAsc); bind('aWP', renderAsc); bind('aSeqG', renderAsc);
bind('aSearch', renderAsc, 'input'); bind('aSeq', renderAsc, 'input');
bind('rGroup', renderRef); bind('rStatus', renderRef); bind('rWP', renderRef); bind('rSeqG', renderRef);
bind('rSearch', renderRef, 'input'); bind('rSeq', renderRef, 'input');
document.querySelectorAll('#wpTable th[data-k]').forEach((th) => { th.onclick = () => { const k = th.dataset.k; wpSort.asc = (wpSort.k === k) ? !wpSort.asc : false; wpSort.k = k; renderWP(); }; });
document.querySelectorAll('#hovTable th[data-k]').forEach((th) => { th.onclick = () => { const k = th.dataset.k; hSort.asc = (hSort.k === k) ? !hSort.asc : false; hSort.k = k; renderHov(); }; });
document.querySelectorAll('#ascTable th[data-k]').forEach((th) => { th.onclick = () => { const k = th.dataset.k; aSort.asc = (aSort.k === k) ? !aSort.asc : false; aSort.k = k; renderAsc(); }; });
document.querySelectorAll('#refTable th[data-k]').forEach((th) => { th.onclick = () => { const k = th.dataset.k; rSort.asc = (rSort.k === k) ? !rSort.asc : false; rSort.k = k; renderRef(); }; });

$('btnLoad').onclick = () => taiWp(false);
$('btnReload').onclick = () => taiWp(true);
$('wpno').addEventListener('keydown', (e) => { if (e.key === 'Enter') taiWp(false); });
$('wpno').addEventListener('input', () => { clearTimeout(goiYWp._t); goiYWp._t = setTimeout(goiYWp, 350); });
$('logHide').onclick = () => $('logBox').classList.add('hidden');
$('btnApplyCfg').onclick = applyCfg;
$('btnExportCfg').onclick = exportCfg;
$('btnResetCfg').onclick = resetCfg;
$('btnImportCfg').onclick = () => $('cfgFile').click();

/* ---------- HOI DAP (chay hoan toan tren may nguoi dung) ---------- */
const SUGGEST = ['Thống kê tổng', 'WO thiếu bàn giao', 'WO sai cú pháp bàn giao', 'WO sai thứ tự thực hiện', 'WO thiếu revision', 'WP nào nhiều lỗi nhất'];
function initChips() {
  $('chips').innerHTML = SUGGEST.map((t) => `<span class="chip">${t}</span>`).join('');
  document.querySelectorAll('#chips .chip').forEach((c) => { c.onclick = () => ask(c.textContent); });
}
function push(w, h) {
  const d = document.createElement('div'); d.className = 'msg ' + w; d.innerHTML = h;
  $('chatlog').appendChild(d); $('chatlog').scrollTop = $('chatlog').scrollHeight;
}
function clearChat() { $('chatlog').innerHTML = ''; greet(); }
function greet() {
  push('bb', WO.length
    ? `Đang phân tích <b>${C.length} WO</b>. Hỏi về: bàn giao ca (HOV), thứ tự thực hiện (ASC), tài liệu tham chiếu, hoặc tra cứu một WO cụ thể.`
    : 'Chưa có dữ liệu. Hãy nhập số Work Package ở phía trên rồi bấm <b>Lấy dữ liệu</b>, sau đó quay lại đây hỏi.');
}
const norm = (s) => (s || '').toLowerCase().replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a').replace(/[èéẹẻẽêềếệểễ]/g, 'e')
  .replace(/[ìíịỉĩ]/g, 'i').replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o').replace(/[ùúụủũưừứựửữ]/g, 'u')
  .replace(/[ỳýỵỷỹ]/g, 'y').replace(/đ/g, 'd');
function tbl(h, rs) {
  return '<table><thead><tr>' + h.map((x) => `<th>${x}</th>`).join('') + '</tr></thead><tbody>'
   + rs.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
}
function answer(q) {
  if (!C.length) return 'Chưa có dữ liệu để trả lời. Hãy lấy một Work Package trước.';
  const n = norm(q); let p = C;
  const wps = [...new Set(C.map((d) => d.WP))];
  const wp = wps.find((w) => n.includes(norm(w))) || wps.find((w) => { const s = w.split('-')[0]; return s && n.includes(norm(s)); });
  if (wp) p = p.filter((d) => d.WP === wp);
  const sc = wp ? ` (WP <code>${esc(wp)}</code>)` : '';
  const m = q.match(/\b(\d{6,8})\b/);
  if (m) {
    const r = C.find((d) => d.WO === m[1]);
    if (!r) return `Không tìm thấy WO <code>${esc(m[1])}</code>.`;
    return `<b>WO ${esc(r.WO)}</b> — WP ${esc(r.WP)} · SEQ ${esc(r.SEQ)} · State ${esc(r.ST)} · ${r.nstep} bước<br><br>`
     + `<b>Handover:</b> ${esc(r.hov)}<br><span class="small">${esc(r.note)}</span><br><br>`
     + `<b>Action Step Control:</b> ${esc(r.ascKind)}<br><span class="small">${esc(r.note2 || '')}</span><br><br>`
     + `<b>Reference (${esc(r.grp)}):</b> ${esc(r.ref)}`;
  }
  if (/thu tu|asc|sai thu tu|trinh tu/.test(n)) {
    const a = p.filter((d) => d.ascKind === 'ORDER');
    return `Có <b>${a.length}</b> WO <b>sai thứ tự thực hiện</b>${sc}.`
     + (a.length ? '<br><br>' + tbl(['WO', 'WP', 'Diễn giải'], a.slice(0, 15).map((d) => [esc(d.WO), esc(d.WP), esc((d.note2 || '').slice(0, 60))])) : '');
  }
  if (/revision|tham chieu|tai lieu|ref/.test(n)) {
    const a = p.filter((d) => d.ref === 'Missing reference / revision');
    return `Có <b>${a.length}</b> WO <b>thiếu tài liệu tham chiếu / revision</b>${sc} (nhóm STRICT_REF: SEQ 7.x, 9.x).`
     + (a.length ? '<br><br>' + tbl(['WO', 'SEQ', 'TEXT'], a.slice(0, 15).map((d) => [esc(d.WO), esc(d.SEQ), esc((d.txt || '').slice(0, 55))])) : '');
  }
  if (/thieu ban giao|missing|khong ghi|chua ghi/.test(n)) {
    const a = p.filter((d) => d.hov === 'Missing handover remark');
    return `Có <b>${a.length}</b> WO <b>quá ngưỡng ca nhưng không ghi bàn giao</b>${sc}.`
     + (a.length ? '<br><br>' + tbl(['WO', 'WP', 'Bước cuối', 'Trễ (h)'], a.slice(0, 15).map((d) => [esc(d.WO), esc(d.WP), esc(d.lastStr) || '-', d.hrs])) : '');
  }
  if (/sai cu phap|wrong format|sai dinh dang|sai ngay|wrong date/.test(n)) {
    const a = p.filter((d) => d.hov === 'Wrong handover format' || d.hov === 'Wrong handover date');
    return `Có <b>${a.length}</b> WO <b>ghi bàn giao sai cú pháp hoặc sai ngày</b>${sc}.`
     + (a.length ? '<br><br>' + tbl(['WO', 'Trạng thái', 'Chi tiết'], a.slice(0, 15).map((d) => [esc(d.WO), esc(d.hov), esc((d.note || '').slice(0, 60))])) : '');
  }
  if (/wp nao|nhieu loi|nhieu nhat|xep hang|top/.test(n)) {
    const mm = {};
    C.forEach((d) => {
      if (!mm[d.WP]) mm[d.WP] = { ng: 0, asc: 0, ref: 0, t: 0 };
      const o = mm[d.WP]; o.t++;
      if (HOVNG.includes(d.hov)) o.ng++;
      if (d.ascKind === 'ORDER') o.asc++;
      if (d.ref !== 'Valid' && d.ref !== 'N/A') o.ref++;
    });
    const arr = Object.entries(mm).sort((a, b) => (b[1].ng + b[1].asc + b[1].ref) - (a[1].ng + a[1].asc + a[1].ref));
    return 'Xếp theo tổng số lỗi:' + tbl(['WP', 'WO', 'HOV NG', 'ASC lỗi', 'Ref NG'], arr.map(([k, o]) => [esc(k), o.t, o.ng, o.asc, o.ref]));
  }
  const need = p.filter((d) => !d.na).length; const ok = p.filter((d) => d.hov === 'Valid').length;
  const ng = p.filter((d) => HOVNG.includes(d.hov)).length;
  return `Thống kê${sc}:` + tbl(['Chỉ tiêu', 'Số WO'], [
    ['Tổng WO', p.length], ['Cần bàn giao (đã loại N/A)', need],
    ['HOV Valid', ok], ['HOV không đạt', ng],
    ['ASC sai thứ tự', p.filter((d) => d.ascKind === 'ORDER').length],
    ['ASC có bước chưa thực hiện', p.filter((d) => d.ascKind === 'MISS').length],
    ['Ref thiếu/sai', p.filter((d) => d.ref !== 'Valid' && d.ref !== 'N/A').length]])
   + `<br>Tỷ lệ HOV đạt: <b>${need ? (100 * ok / need).toFixed(1) : 0}%</b>`;
}
function ask(t) {
  const i = $('chatq'); const q = (t !== undefined ? t : i.value).trim(); if (!q) return;
  push('u', esc(q)); i.value = '';
  try { push('bb', answer(q)); } catch (e) { push('bb', 'Lỗi: ' + esc(e.message)); }
}
$('chatq').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
$('btnAsk').onclick = () => ask();
$('btnClearChat').onclick = clearChat;

/* Dau bang dinh phai nam NGAY DUOI thanh loc. Thanh loc xuong dong tren man
   hinh hep nen chieu cao khong co dinh -> do that roi ghi vao bien CSS. */
function doThanhLoc() {
  const tb = document.querySelector('.topbar');
  if (tb) document.documentElement.style.setProperty('--topH', tb.offsetHeight + 'px');
}
window.addEventListener('resize', doThanhLoc);
new ResizeObserver(doThanhLoc).observe(document.querySelector('.topbar'));

/* ---------- KHOI DONG ---------- */
doThanhLoc();
napCfgLuu(); fillCfg(); compileRules();
refreshAll(); initChips(); greet(); goiYWp();
// Cho phep mo thang mot WP bang duong dan: /wp?wpno=A509-...
(() => {
  const w = new URLSearchParams(location.search).get('wpno');
  if (w) { $('wpno').value = w; taiWp(false); }
})();
