/* ==========================================================================
 *  script.js  -  Logic frontend Dashboard TAT
 *  - Goi REST API cua server.js
 *  - Ve KPI cards, bieu do (Chart.js), bang (Tabulator)
 *  - Bo loc (station/store/department/ky), export Excel
 * ========================================================================== */
'use strict';

// --------------------------------------------------------------------------
// 0. Tien ich chung
// --------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/** Doc gia tri bien mau CSS hien tai (theo theme). */
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Bang mau categorical theo thu tu (dung cho pie/top). */
function seriesColors() {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar(`--series-${i}`));
}

/** Dinh dang ngay gio (VN).
 *  LUU Y: gia tri tu API la gio VN nhung duoc serialize dang UTC ('...Z').
 *  Phai doc bang getUTC* de KHONG bi trinh duyet cong them mui gio lan nua.
 *  Chuoi KHONG kem mui gio (vd range.from = '2026-07-01T00:00:00') se bi
 *  trinh duyet hieu la GIO DIA PHUONG -> lech -7h (hien 17h ngay hom truoc);
 *  nen them 'Z' de doc dung gio da ghi. */
function fmtDateTime(v) {
  if (!v) return '';
  const s = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(v)
    ? v + 'Z'
    : v;
  const d = new Date(s);
  if (isNaN(d)) return v;
  // Record trong / gia tri sentinel (1900-01-01, hoac nam <= 1901) -> de trong.
  if (d.getUTCFullYear() <= 1901) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Moc CUOI cua ky la LOAI TRU (vd quy 3 -> to = 01/10 00:00). De nhan ky de
 *  hieu, hien thi thoi diem CUOI CUNG duoc tinh (to - 1 phut -> 30/09 23:59). */
function fmtRangeEnd(v) {
  if (!v) return '';
  const s = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(v) ? v + 'Z' : v;
  const d = new Date(s);
  if (isNaN(d)) return fmtDateTime(v);
  return fmtDateTime(new Date(d.getTime() - 60000).toISOString());
}

// --------------------------------------------------------------------------
// 1. Trang thai ung dung
// --------------------------------------------------------------------------
const state = {
  periodType: 'month',
  month: '',       // 'YYYY-MM'
  week: '',        // 'YYYY-MM-DD' (ngay tham chieu)
  quarter: '',     // 'YYYY-Qn' (vd 2026-Q3)
  year: '',        // 'YYYY'
  // Ba o loc duoi day deu CHON NHIEU GIA TRI - mang rong = tat ca
  station: [],
  store: [],
  department: [],
  excludeCC: false, // checkbox "Bo qua xuat costcenter" (receiver la so, khong phai so tau)
  excludeCab: false, // checkbox "Bo qua cac kho CAB" (CAB, CAB-TD, P-THA, P-SAF, P-PAN)
  isAdmin: false,   // may nay co quyen SUA (xac nhan doi ung) khong - hoi server
  clientIp: '',
  currentReport: 'returned-unservice',
  lgcTab: 'pickslip',   // tab con dang mo trong nhom LGC
};

/**
 * CHE DO LGC (/lgc; /kho van chay - dia chi cu): nhan vien LGC vao THANG nhom
 * "LGC", cac tab TAT cua don vi khac duoc AN di cho do roi. Van la CUNG MOT
 * trang, cung script - chi khac diem vao - nen khong co ban sao thu hai de
 * lech nhau.
 */
const LGC_ONLY = /^\/(lgc|kho)(\.html)?\/?$/.test(location.pathname);

let mainTable = null;   // Tabulator bang chinh
const charts = {};      // luu instance Chart.js

// Cache du lieu bao cao PHIA TRINH DUYET theo (ten bao cao + filter):
// doi qua lai giua cac tab khong goi lai API/DB. Xoa khi bam "Ap dung".
const reportCache = new Map();

// --- Luu / khoi phuc cau hinh filter (localStorage) de lan sau mo lai dung ngay ---
const FILTER_STORE_KEY = 'tat-filters-v1';
function saveFilters() {
  const { periodType, month, week, quarter, year, station, store, department, excludeCC, excludeCab, lgcTab } = state;
  localStorage.setItem(FILTER_STORE_KEY, JSON.stringify({ periodType, month, week, quarter, year, station, store, department, excludeCC, excludeCab, lgcTab }));
}
function loadSavedFilters() {
  try {
    return JSON.parse(localStorage.getItem(FILTER_STORE_KEY) || 'null');
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// 2. Goi API
// --------------------------------------------------------------------------
/** Ghep query string tu state. */
function buildQuery() {
  const p = new URLSearchParams();
  p.set('periodType', state.periodType);
  if (state.periodType === 'month' && state.month) p.set('month', state.month);
  if (state.periodType === 'week' && state.week) p.set('week', state.week);
  if (state.periodType === 'quarter' && state.quarter) p.set('quarter', state.quarter);
  if (state.periodType === 'year' && state.year) p.set('year', state.year);
  if (state.station.length) p.set('station', state.station.join(','));
  if (state.store.length) p.set('store', state.store.join(','));
  if (state.department.length) p.set('department', state.department.join(','));
  if (state.excludeCC) p.set('excludeCC', '1');
  if (state.excludeCab) p.set('excludeCab', '1');
  return p.toString();
}

/**
 * @param {string} path
 * @param {string} [job] ma viec de server ban nhat ky tien trinh ve (xem §3b).
 *                       Server BO tham so nay khi tinh khoa cache.
 */
async function api(path, job) {
  const qs = buildQuery()
    + (job ? `&job=${encodeURIComponent(job)}` : '')
    + (boQuaCacheLanToi ? '&nocache=1' : '');
  const url = path.includes('?') ? `${path}&${qs}` : `${path}?${qs}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    const e = new Error(data.message || `Lỗi ${res.status}`);
    e.status = res.status;
    e.code = data.code;
    throw e;
  }
  // Server bao thoi diem SO LIEU duoc tinh (khong phai luc tai trang): du lieu
  // co the den tu bo nho dem nen hai thu KHAC nhau.
  ghiNhanGioSoLieu(res.headers.get('X-Data-Time'), res.headers.get('X-Cache'));
  return data;
}

// --- "So lieu luc HH:MM" ---------------------------------------------------
// Cache cua truy van nang nay song vai phut (xem API_CACHE_MINUTES). Khong noi
// ro thi hai nguoi mo cung mot man hinh o hai thoi diem se thay so KHAC nhau
// va tuong la phan mem sai. Nhan nay + nut Tai lai giai quyet chuyen do.
let boQuaCacheLanToi = false;   // nut "Tai lai" bat co nay cho DUNG mot luot

function ghiNhanGioSoLieu(iso, cache) {
  const el = $('#dataAge');
  if (!el) return;
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const gio = d.toLocaleTimeString('vi', { hour: '2-digit', minute: '2-digit', hour12: false });
  const cu = Date.now() - d.getTime() > 90 * 1000;
  el.querySelector('.dataAge-text').textContent = `Số liệu lúc ${gio}`;
  el.classList.toggle('cu', cu);
  el.title = cache === 'HIT'
    ? `Lấy từ bộ nhớ đệm của máy chủ (tính lúc ${d.toLocaleString('vi')}). Bấm Tải lại để hỏi SQL Server.`
    : `Vừa hỏi SQL Server lúc ${d.toLocaleString('vi')}.`;
}

function showLoading(on) {
  $('#loading').classList.toggle('hidden', !on);
  $('#loading').classList.toggle('flex', on);
}

/**
 * LOP PHU "DANG TAI" tren MOT VUNG DU LIEU cu the.
 * Vi sao can: dong chu "Dang tai" o thanh tren qua nho, nhieu nguoi khong thay,
 * trong khi du lieu CU van hien ro -> de doc nham. Lop phu nay lam mo du lieu
 * cu, chan thao tac, va noi ro dang cho.
 *
 * @param {string} sel   selector cua vung du lieu
 * @param {boolean} on   bat/tat
 * @param {string} text  chu hien duoi vong xoay
 * @param {number} delay ms cho truoc khi hien (mac dinh 120ms) - tranh nhap
 *                       nhay khi du lieu lay tu cache, ve gan nhu tuc thi
 */
const _busyTimers = new Map();
function setBusy(sel, on, text = 'Đang tải dữ liệu…', delay = 120) {
  const host = $(sel);
  if (!host) return;
  clearTimeout(_busyTimers.get(sel));
  const paint = () => {
    host.classList.add('busy-host', 'is-busy');
    let ov = host.querySelector(':scope > .busy-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'busy-overlay';
      ov.innerHTML = '<div class="spinner-lg"></div><div class="busy-text"></div>';
      host.appendChild(ov);
    }
    ov.querySelector('.busy-text').textContent = text;
  };
  if (on) {
    _busyTimers.set(sel, setTimeout(paint, delay));
  } else {
    host.classList.remove('is-busy');
    const ov = host.querySelector(':scope > .busy-overlay');
    if (ov) ov.remove();
    _nhatKyCho.delete(sel);   // bo cac dong con cho: lan tai nay da xong
  }
}

// --------------------------------------------------------------------------
// 3b. NHAT KY TIEN TRINH THOI GIAN THUC
//     Truy van LGC di qua linked server, co cau mat hang chuc giay. Chi mot
//     vong xoay thi nguoi dung khong biet chuong trinh dang lam gi, con bao
//     lau, hay da treo. Nay server ban tung buoc ve qua SSE va hien ngay o day.
// --------------------------------------------------------------------------
let _jobDem = 0;

/** Ma viec duy nhat cho MOI lan bam (server dung lam khoa kenh SSE). */
function taoMaJob() {
  return `j${Date.now().toString(36)}${(_jobDem++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Dong log den TRUOC khi lop phu kip ve thi giu tam o day.
// setBusy() ve lop phu trong setTimeout, nen ngay ca voi delay 0 no van ve o
// tick SAU - trong khi dong dau tien (vd "lay lai tu bo nho dem") co the toi
// trong cung tick. Khong dem thi dong do BIEN MAT (da gap khi chay kiem thu).
const _nhatKyCho = new Map();   // sel -> [dong dang cho]

function veDongNhatKy(ov, b) {
  let log = ov.querySelector('.busy-log');
  if (!log) {
    log = document.createElement('div');
    log.className = 'busy-log';
    ov.appendChild(log);
  }
  const d = document.createElement('div');
  d.className = 'busy-log-dong';
  // Gio thuc te: nguoi dung doi lau thi con biet buoc nao dung tu luc nao
  const gio = new Date().toLocaleTimeString('vi', { hour12: false });
  d.innerHTML = `<span class="busy-log-gio">${gio}</span> ${escapeHtml(b.text)}`;
  log.appendChild(d);
  while (log.children.length > 40) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

/** Do cac dong dang cho ra lop phu (neu no da duoc ve). */
function xaNhatKyCho(sel) {
  const ds = _nhatKyCho.get(sel);
  if (!ds || !ds.length) return;
  const ov = $(sel)?.querySelector(':scope > .busy-overlay');
  if (!ov) return;                       // van chua ve -> cho luot sau
  _nhatKyCho.delete(sel);
  ds.forEach((b) => veDongNhatKy(ov, b));
}

/** Them mot dong vao nhat ky trong lop phu "dang tai" cua vung `sel`. */
function themDongNhatKy(sel, b) {
  if (!$(sel)) return;
  const ov = $(sel).querySelector(':scope > .busy-overlay');
  if (ov) { xaNhatKyCho(sel); veDongNhatKy(ov, b); return; }
  const ds = _nhatKyCho.get(sel) || [];
  ds.push(b);
  _nhatKyCho.set(sel, ds.slice(-40));
  setTimeout(() => xaNhatKyCho(sel), 30);
}

/**
 * Mo kenh nhat ky cho mot lan tai du lieu.
 * Tra ve { job, dong() }: dua `job` vao URL API, goi `dong()` o finally.
 * Neu trinh duyet khong ho tro EventSource thi van chay binh thuong, chi la
 * khong co nhat ky - KHONG duoc lam hong viec tai du lieu.
 */
function moTienTrinh(sel) {
  const job = taoMaJob();
  let es = null;
  try {
    es = new EventSource(`/api/progress/${job}`);
    es.onmessage = (ev) => {
      try {
        const b = JSON.parse(ev.data);
        themDongNhatKy(sel, b);
        if (b.xong) { es.close(); es = null; }
      } catch (_) { /* dong hong - bo qua */ }
    };
    es.onerror = () => { try { es && es.close(); } catch (_) {} es = null; };
  } catch (_) { es = null; }
  return { job, dong: () => { try { es && es.close(); } catch (_) {} es = null; } };
}

/** Cham nhay tren nut tab dang tai (bao cao / tab chinh). */
function setTabLoading(selector, name, on) {
  $$(selector).forEach((b) => {
    const mine = b.dataset.report === name || b.dataset.tab === name;
    b.classList.toggle('loading', on && mine);
  });
}
/**
 * Hien loi kem NUT THU LAI.
 * Loi hay gap nhat o day la linked server cham/nghen nhat thoi - thu lai la
 * duoc. Truoc day nguoi dung phai F5 ca trang, tai lai het moi thu tu dau.
 * @param {string} msg
 * @param {Function} [thuLai] ham chay lai dung viec vua that bai
 */
function showError(msg, thuLai) {
  const box = $('#errorBox');
  const nut = $('#errorRetry');
  if (!msg) { box.classList.add('hidden'); return; }
  $('#errorMsg').textContent = msg;
  box.classList.remove('hidden');
  if (!nut) return;
  nut.classList.toggle('hidden', typeof thuLai !== 'function');
  nut.onclick = typeof thuLai === 'function'
    ? () => { showError(''); thuLai(); }
    : null;
}

/**
 * Chu hien trong bang khi KHONG co dong nao.
 * "Khong co du lieu" khong giup gi: nguoi dung khong biet la ky nay that su
 * khong co, hay minh loc nham. Neu dang co bo loc thi noi thang ra.
 */
function chuBangRong() {
  const dk = [];
  if (state.station.length) dk.push(`Station: ${state.station.join(', ')}`);
  if (state.store.length) dk.push(`Kho: ${state.store.join(', ')}`);
  if (state.department.length) dk.push(`Trung tâm: ${state.department.join(', ')}`);
  if (state.excludeCC) dk.push('bỏ xuất costcenter');
  if (state.excludeCab) dk.push('bỏ các kho CAB');
  if (!dk.length) return 'Kỳ báo cáo này không có dữ liệu.';
  return `Không có dòng nào khớp bộ lọc (${dk.join(' · ')}).`
    + ' Thử bỏ bớt điều kiện ở thanh lọc phía trên.';
}

/**
 * Cap nhat chu "bang rong" cho MOI bang dang hien.
 * Tabulator chi tao the placeholder khi bang KHONG co dong nao, nen cu quet ca
 * trang: bang nao dang rong thi co the do, bang nao co du lieu thi khong.
 */
function veChuBangRong() {
  const chu = chuBangRong();
  document.querySelectorAll('.tabulator-placeholder-contents').forEach((el) => {
    el.textContent = chu;
  });
}

// --------------------------------------------------------------------------
// 3. KPI Cards
// --------------------------------------------------------------------------
/** Chip ▲▼ so voi ky truoc.
 *  dir: 'down' = giam la TOT (cac chi so TAT), 'up' = tang la TOT (ty le doi ung),
 *  'neutral' = chi thong tin (so luong). prev 0/thieu -> khong hien. */
function kpiDelta(cur, prev, dir) {
  const c = Number(cur), p = Number(prev);
  if (!isFinite(c) || !isFinite(p) || p === 0) return '';
  const pct = ((c - p) / Math.abs(p)) * 100;
  if (!isFinite(pct)) return '';
  const rounded = Math.round(pct * 10) / 10;
  if (rounded === 0) return `<span class="kpi-delta neutral" title="Bằng kỳ trước (kỳ trước: ${p})">= kỳ trước</span>`;
  const upArrow = rounded > 0;
  let cls = 'neutral';
  if (dir === 'down') cls = upArrow ? 'bad' : 'good';   // TAT: tang = xau
  if (dir === 'up') cls = upArrow ? 'good' : 'bad';     // ty le doi ung: tang = tot
  return `<span class="kpi-delta ${cls}" title="Kỳ trước: ${p}">${upArrow ? '▲' : '▼'} ${Math.abs(rounded)}%</span>`;
}

function renderKPIs(kpis, prev) {
  prev = prev || {};
  const cards = [
    // TAT TONG = install + US return + CUVT (3 chang lien tiep cua 1 vong doi)
    { label: 'TAT tổng (3 chặng)', value: kpis.tatTotalAvg, prev: prev.tatTotalAvg, dir: 'down', unit: 'ngày', accent: '--series-4' },
    { label: 'TAT install', value: kpis.tatInstallAvg, prev: prev.tatInstallAvg, dir: 'down', unit: 'ngày', accent: '--series-1' },
    { label: 'TAT US return', value: kpis.tatUsReturnAvg, prev: prev.tatUsReturnAvg, dir: 'down', unit: 'ngày', accent: '--series-8' },
    { label: 'TAT CUVT', value: kpis.tatCuvtAvg, prev: prev.tatCuvtAvg, dir: 'down', unit: 'ngày', accent: '--series-2' },
    { label: 'TAT hoàn kho', value: kpis.tatReturnStoreAvg, prev: prev.tatReturnStoreAvg, dir: 'down', unit: 'ngày', accent: '--series-5' },
    { label: 'Thiết bị xuất kho', value: kpis.countIssued, prev: prev.countIssued, dir: 'neutral', unit: 'thiết bị', accent: '--series-3' },
    { label: 'Chưa đối ứng', value: kpis.countNotReconciled, prev: prev.countNotReconciled, dir: 'down', unit: 'thiết bị', accent: '--series-6' },
    { label: 'Tỷ lệ đối ứng', value: kpis.reconcileRate, prev: prev.reconcileRate, dir: 'up', unit: '%', accent: '--series-7' },
    // SL da NHAN (reci) / SL da GIAO (del) cua CUVT trong ky (2 so -> khong tinh delta)
    { label: 'SL nhận / SL giao (CUVT)', value: `${kpis.cntReci ?? 0}/${kpis.cntDel ?? 0}`, unit: '', accent: '--series-7' },
  ];
  $('#kpiGrid').innerHTML = cards
    .map(
      (c) => `
      <div class="kpi" style="--accent:${cssVar(c.accent)}" title="${c.label}: ${c.value ?? 0} ${c.unit}">
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${c.value ?? 0} <span class="kpi-unit">${c.unit}</span></div>
        ${c.dir ? kpiDelta(c.value, c.prev, c.dir) : ''}
      </div>`
    )
    .join('');
}

// --------------------------------------------------------------------------
// 4. Bieu do (Chart.js)
// --------------------------------------------------------------------------
/** Cau hinh mac dinh theo theme. */
function chartDefaults() {
  const grid = cssVar('--hair');
  const tick = cssVar('--text-muted');
  return {
    grid,
    tick,
    common: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: cssVar('--text-secondary') } },
      },
      scales: {
        x: { grid: { color: grid }, ticks: { color: tick } },
        y: { grid: { color: grid }, ticks: { color: tick }, beginAtZero: true },
      },
    },
  };
}

/** Plugin nho: ve so TONG ngay TREN DINH moi cot xep chong (khong can thu vien
 *  ngoai). Chi cong cac series DANG HIEN (bam tat legend -> tong tu tinh lai). */
const stackTotalLabel = {
  id: 'stackTotalLabel',
  afterDatasetsDraw(chart) {
    const x = chart.scales.x, y = chart.scales.y;
    if (!x || !y) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = '700 11px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = cssVar('--text-secondary') || '#666';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    chart.data.labels.forEach((_, i) => {
      let total = 0;
      chart.data.datasets.forEach((ds, di) => {
        if (chart.isDatasetVisible(di)) total += Number(ds.data[i]) || 0;
      });
      if (!total) return;
      ctx.fillText(String(Math.round(total * 10) / 10), x.getPixelForValue(i), y.getPixelForValue(total) - 4);
    });
    ctx.restore();
  },
};

/** Ve SO LUONG vao GIUA tung doan cua cot xep chong.
 *  Bo qua doan qua thap (< 16px) de chu khong de len nhau, va bo qua gia tri 0.
 *  Mau chu trang/den chon theo do sang cua nen doan -> luon doc duoc o ca 2 theme. */
const segmentValueLabel = {
  id: 'segmentValueLabel',
  afterDatasetsDraw(chart) {
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = '700 11px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    chart.data.datasets.forEach((ds, di) => {
      if (!chart.isDatasetVisible(di)) return;
      const meta = chart.getDatasetMeta(di);
      ctx.fillStyle = isLightColor(ds.backgroundColor) ? '#1a1a1a' : '#ffffff';
      meta.data.forEach((bar, i) => {
        const v = Number(ds.data[i]) || 0;
        if (!v) return;
        const { y, base } = bar.getProps(['y', 'base'], true);
        if (Math.abs(base - y) < 16) return;   // doan qua mong -> khong ve
        ctx.fillText(String(v), bar.x, (y + base) / 2);
      });
    });
    ctx.restore();
  },
};

/** Mau nen sang hay toi (de chon mau chu tuong phan). Nhan '#rgb'/'#rrggbb'. */
function isLightColor(hex) {
  const s = String(hex || '').trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) return false;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // Do sang cam nhan (ITU-R BT.601)
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

function destroyChart(key) {
  if (charts[key]) {
    charts[key].destroy();
    charts[key] = null;
  }
}

/** DRILL-DOWN: click 1 cot/mieng bieu do -> loc dashboard theo gia tri do.
 *  Click lan nua (cung gia tri) -> bo loc. filterKey: 'department' | 'station'. */
function chartDrill(labels, filterKey) {
  return (evt, elements) => {
    if (!elements || !elements.length) return;
    const label = labels[elements[0].index];
    if (!label) return;
    // Click cot dang duoc loc rieng le -> bo loc; nguoc lai -> loc dung cot do.
    const dangLocRieng = state[filterKey].length === 1 && state[filterKey][0] === label;
    state[filterKey] = dangLocRieng ? [] : [label];
    renderMultiSelects();
    if (typeof window.__applyFilters === 'function') window.__applyFilters();
  };
}

function renderCharts(c) {
  const d = chartDefaults();
  const colors = seriesColors();

  // 4.1 Bieu do cot XEP CHONG theo Trung tam - 3 chang cong don = TAT tong:
  //     install (xuat->lap) + US return (thao->tra US) + CUVT (tra US->CUVT nhan).
  //     Chieu cao ca cot = TAT tong cua trung tam do.
  destroyChart('bar');
  charts.bar = new Chart($('#chartBarDept'), {
    type: 'bar',
    data: {
      labels: c.barDept.labels,
      datasets: [
        { label: 'TAT install', data: c.barDept.install, backgroundColor: cssVar('--series-1') },
        { label: 'TAT US return', data: c.barDept.usret, backgroundColor: cssVar('--series-8') },
        { label: 'TAT CUVT', data: c.barDept.cuvt || [], backgroundColor: cssVar('--series-2'), borderRadius: 4 },
      ],
    },
    options: {
      ...d.common,
      // mode 'index': tooltip gom CA 3 lop tai cot dang tro (mac dinh chi lay
      // dung lop duoi con tro -> dong "TAT tong" se thieu cac lop con lai).
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ...d.common.scales.x, stacked: true },
        // grace: chua khoang trong tren dinh de so TONG khong bi cat
        y: { ...d.common.scales.y, stacked: true, grace: '8%' },
      },
      plugins: {
        ...d.common.plugins,
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            // Them dong TONG 3 chang o cuoi tooltip cho de doi chieu
            footer: (items) => {
              const t = items.reduce((s, it) => s + (Number(it.parsed.y) || 0), 0);
              return `TAT tổng: ${Math.round(t * 10) / 10} ngày`;
            },
          },
        },
      },
      onClick: chartDrill(c.barDept.labels, 'department'),
    },
    plugins: [stackTotalLabel], // ve so tong tren dinh moi cot
  });

  // 4.2 Bieu do tron - phan bo thiet bi.
  //     CHUA chon Station -> chia theo STATION.
  //     DA chon 1 Station  -> chia theo TRUNG TAM (chia theo station luc do chi
  //     con dung 1 mieng, khong noi len dieu gi). Server bao qua truong groupBy;
  //     drill-down cung phai doi khoa loc theo do.
  const pieBy = c.pieStation.groupBy === 'department' ? 'department' : 'station';
  const pieTitle = $('#pieStationTitle');
  if (pieTitle) {
    pieTitle.innerHTML = pieBy === 'department'
      ? `Phân bổ thiết bị theo Trung tâm <span class="unit">(station ${escapeHtml(state.station.join(', '))})</span>`
      : 'Phân bổ thiết bị theo Station';
  }
  destroyChart('pie');
  charts.pie = new Chart($('#chartPieStation'), {
    type: 'doughnut',
    data: {
      labels: c.pieStation.labels,
      datasets: [{ data: c.pieStation.values, backgroundColor: colors, borderColor: cssVar('--surface-1'), borderWidth: 2 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { color: cssVar('--text-secondary') } },
        tooltip: {
          callbacks: {
            // Them ty le % cho de doc (bieu do tron khong co truc so)
            label: (it) => {
              const v = Number(it.parsed) || 0;
              const t = it.dataset.data.reduce((s, x) => s + (Number(x) || 0), 0);
              const pct = t ? Math.round((v / t) * 1000) / 10 : 0;
              return `${it.label}: ${v} thiết bị (${pct}%)`;
            },
          },
        },
      },
      onClick: chartDrill(c.pieStation.labels, pieBy),
    },
  });

  // 4.3 Bieu do cot XEP CHONG - So luong xuat kho theo Trung tam
  //     Da tra (xanh) + Chua tra (vang) = tong so thiet bi xuat kho.
  //     So luong hien o GIUA tung doan, tong hien tren dinh cot.
  destroyChart('line');
  charts.line = new Chart($('#chartLineDay'), {
    type: 'bar',
    data: {
      labels: c.deptVolume.labels,
      datasets: [
        { label: 'Đã trả', data: c.deptVolume.daTra || [], backgroundColor: cssVar('--good') },
        { label: 'Chưa trả', data: c.deptVolume.chuaTra || [], backgroundColor: cssVar('--warning'), borderRadius: 4 },
      ],
    },
    options: {
      ...d.common,
      // mode 'index': tooltip gom CA 2 lop tai cot dang tro (mac dinh chi lay
      // lop duoi con tro -> dong "Tong" se thieu lop con lai).
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ...d.common.scales.x, stacked: true },
        y: { ...d.common.scales.y, stacked: true, grace: '8%' }, // chua cho so tong
      },
      plugins: {
        ...d.common.plugins,
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            footer: (items) => {
              const t = items.reduce((s, it) => s + (Number(it.parsed.y) || 0), 0);
              return `Tổng xuất kho: ${t} thiết bị`;
            },
          },
        },
      },
      onClick: chartDrill(c.deptVolume.labels, 'department'),
    },
    plugins: [segmentValueLabel, stackTotalLabel],
  });

  // 4.4 TAT hoan kho trung binh theo Trung tam (1 series -> series-5)
  destroyChart('top');
  charts.top = new Chart($('#chartTop10'), {
    type: 'bar',
    data: {
      labels: c.retStoreDept.labels,
      datasets: [{ label: 'TAT hoàn kho (ngày)', data: c.retStoreDept.values, backgroundColor: cssVar('--series-5'), borderRadius: 4 }],
    },
    options: {
      ...d.common,
      plugins: { ...d.common.plugins, legend: { display: false } },
      onClick: chartDrill(c.retStoreDept.labels, 'department'),
    },
  });
}

// --------------------------------------------------------------------------
// 5. Bang Tabulator - cell formatters dung chung
// --------------------------------------------------------------------------
const fmtDateCell = (cell) => fmtDateTime(cell.getValue());
const fmtTatCell = (cell) => {
  const v = Number(cell.getValue());
  if (!isFinite(v)) return '';
  // Mau theo nguong (chi de nhan biet nhanh; kem chu so nen khong phu thuoc mau)
  let color = cssVar('--good');
  if (v > 2) color = cssVar('--critical');   // nguong theo NGAY
  else if (v > 1) color = cssVar('--warning');
  return `<span class="tat-badge" style="background:${color}22;color:${color}">${v.toFixed(1)}</span>`;
};

// Loc cot NGAY theo CHUOI HIEN THI (dd/mm/yyyy hh:mm) thay vi chuoi ISO tho,
// de nguoi dung go '12/04' hay '2026' deu tim duoc.
const dateFilterFunc = (term, rowVal) =>
  fmtDateTime(rowVal).toLowerCase().includes(String(term ?? '').toLowerCase());

/**
 * COT NGAY+GIO GOP LAM MOT.
 *
 * AMOS khong phai luc nao cung co GIO (xem §5b README): cho nao thieu thi truoc
 * day phai bay THEM mot cot "Ngay ..." rieng, vua ton cho vua kho doc. Nay mot
 * cot lo het: co gio that -> hien `dd/mm/yyyy hh:mm`; khong co -> hien NGAY kem
 * ghi chu "(chỉ có ngày)" chu mo.
 *
 * ⚠️ Khi khong co gio that thi CAT HAN phan gio (`slice(0, 10)`) chu KHONG cat
 * chuoi "00:00": neu du lieu lo mang gio rac ma hien ra thi nguoi doc se tuong
 * do la gio that.
 *
 * @param {string} coGio ten truong 0/1 cho biet gia tri co GIO THAT hay khong
 */
function fmtNgayGioGop(coGio) {
  return (cell) => {
    const s = fmtDateTime(cell.getValue());
    if (!s) return '';
    if (cell.getRow().getData()[coGio]) return s;
    return '<span style="color:var(--text-muted)" title="AMOS chỉ cho biết NGÀY, không có giờ">'
      + `${escapeHtml(s.slice(0, 10))}`
      + ' <span style="font-size:11px">(chỉ có ngày)</span></span>';
  };
}

/**
 * Tu dong bo sung header-filter cho MOI cot chua khai bao (tru cot checkbox
 * "Bo qua" - khong co field). Cot ngay (formatter=fmtDateCell) loc theo chuoi
 * hien thi; cot so TAT (fmtTatCell) loc kieu 'like' (chua); con lai 'input'.
 * Giu nguyen cot da co san headerFilter (vd 'Nguon tra' dung list).
 */
function withHeaderFilters(columns) {
  return columns.map((c) => {
    if (c.headerFilter || !c.field) return c; // da co filter / cot checkbox
    const col = { ...c };
    if (c.formatter === fmtDateCell) {
      col.headerFilter = 'input';
      col.headerFilterFunc = dateFilterFunc;
    } else if (c.formatter === fmtTatCell) {
      col.headerFilter = 'input';
      col.headerFilterFunc = 'like';
    } else {
      col.headerFilter = 'input';
    }
    return col;
  });
}

// --- Checkbox "Bỏ qua" (tính lại TAT): quản lý THỦ CÔNG bằng Set khóa dòng.
//     Chỉ click TRỰC TIẾP vào ô checkbox mới chọn/bỏ chọn — click/double-click
//     chỗ khác trên dòng KHÔNG có tác dụng.
const excludedKeys = new Set();
const rowKey = (r) => `${r.partno}|${r.serialno}|${r.labelno}|${r.voucher_issue}`;

const COL_EXCLUDE = {
  title: 'Bỏ qua',
  headerSort: false,
  hozAlign: 'center',
  headerHozAlign: 'center',
  width: 72,
  formatter: (cell) =>
    `<input type="checkbox" style="cursor:pointer;transform:scale(1.2)" ${
      excludedKeys.has(rowKey(cell.getRow().getData())) ? 'checked' : ''
    }>`,
  cellClick: (e, cell) => {
    if (e.target && e.target.tagName === 'INPUT') {
      const k = rowKey(cell.getRow().getData());
      if (e.target.checked) excludedKeys.add(k);
      else excludedKeys.delete(k);
    }
  },
};

/** Nhãn cột "Nguồn trả" của bảng chi tiết TAT. */
const RETURN_TYPE_LABEL = {
  US: 'Trả unservice',
  SERVICE: 'Trả service',
  INSTALL: 'Chỉ lắp lên',   // lắp vào cụm cao hơn (higher assembly)
};

/** Cột chi tiết TAT theo thiết bị (checkbox "Bỏ qua" đặt ở CỘT CUỐI). */
const COLS_TAT_DEPT = [
  { title: 'Event Perf', field: 'event_perf', headerFilter: 'input' },
  { title: 'Part No', field: 'partno', headerFilter: 'input' },
  { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
  { title: 'Part No (off)', field: 'partno_off', headerFilter: 'input' },
  { title: 'Serial No (off)', field: 'serialno_off', headerFilter: 'input' },
  { title: 'Label', field: 'labelno', headerFilter: 'input'  },
  { title: 'Description', field: 'description' },
  { title: 'Receiver', field: 'receiver', headerFilter: 'input' },
  { title: 'Center', field: 'department', headerFilter: 'input' },
  // 'Nhân viên' = NGƯỜI TRẢ US — cùng nguồn với Trung tâm (real_us1).
  // Dòng "Trả service" / "Chỉ lắp lên" không có người trả US → hiển thị người lập phiếu.
  { title: 'Nhân viên', field: 'staff', headerFilter: 'input', headerTooltip: 'Người trả unservice (real_us1.action_per) — cùng nguồn với Trung tâm. Dòng Trả service / Chỉ lắp lên: người lập phiếu xuất.' },
  { title: 'Người lập phiếu', field: 'issue_staff', headerFilter: 'input', headerTooltip: 'Người lập phiếu xuất (kho_ser1.created_b2) — chỉ để đối chiếu, KHÔNG dùng để xác định Trung tâm' },
  { title: 'Station', field: 'station', headerFilter: 'input' },
  { title: 'Store', field: 'store', headerFilter: 'input' },
  { title: 'Pickslip', field: 'voucher_issue', headerFilter: 'input' },
  { title: 'Phiếu xuất', field: 'picking_li', headerFilter: 'input' },
  { title: 'Ngày Giờ xuất', field: 'issue_time_vn', formatter: fmtDateCell },
  { title: 'Ngày lắp', field: 'installed_time_vn', formatter: fmtDateCell },
  { title: 'TAT install', field: 'tat_install_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
  { title: 'Ngày tháo', field: 'removed_time_vn', formatter: fmtDateCell },
  // Với dòng "Trả service": cột này là GIỜ RECERTIFY (CI) thay cho giờ trả US
  { title: 'Ngày Giờ trả', field: 'return_unservice_time', formatter: fmtDateCell },
  { title: 'TAT US return', field: 'tat_usreturn_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
  { title: 'TAT (tổng)', field: 'tat_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
  // Nguồn đối ứng: US = trả unservice (real_us1); SERVICE = recertify (CI @SHOPLOC);
  // INSTALL = lắp vào CỤM CAO HƠN (higher assembly) — chỉ có chặng lắp lên,
  // chưa tháo xuống nên không có ngày trả và không có TAT tổng.
  {
    title: 'Nguồn trả', field: 'return_type', hozAlign: 'center',
    formatter: (cell) => RETURN_TYPE_LABEL[cell.getValue()] || 'Trả unservice',
    headerFilter: 'list',
    headerFilterParams: {
      values: {
        '': 'Tất cả', US: 'Trả unservice', SERVICE: 'Trả service', INSTALL: 'Chỉ lắp lên',
      },
    },
  },
  COL_EXCLUDE, // checkbox "Bỏ qua" — cột cuối
];

/** So nguyen dang chuoi thuong (khong 8.76e+006, khong dau phan cach nghin). */
const fmtIntCell = (cell) => {
  const n = Number(cell.getValue());
  return isFinite(n) ? String(Math.round(n)) : (cell.getValue() ?? '');
};
/** Chi hien NGAY (dd/mm/yyyy) - cho cot chi co ngay, khong co gio. */
const fmtDateOnlyCell = (cell) => {
  const s = fmtDateTime(cell.getValue());
  return s ? s.slice(0, 10) : '';
};

/**
 * WO_PART_ON_OFF.STATUS — *Booking status of the component change* (tài liệu AMOS):
 * **0 = Not Booked · 1 = Booked**.
 * Hiện chữ chứ không hiện số: “0” và “1” trần trụi thì người đọc phải nhớ nghĩa,
 * và rất dễ lẫn với các cột STATUS khác của AMOS (pickslip dùng 1/11 cho việc khác).
 * Giá trị lạ (không phải 0/1) hiện NGUYÊN VĂN — không âm thầm coi là “chưa booking”.
 */
function fmtBookingCell(cell) {
  const v = cell.getValue();
  const r = cell.getRow().getData();
  if (v === 1) {
    const c = cssVar('--good');
    return `<span class="tat-badge" style="background:${c}22;color:${c}" title="STATUS = 1 — Booked">Đã booking</span>`;
  }
  if (v === 0) {
    const c = cssVar('--warning');
    return `<span class="tat-badge" style="background:${c}22;color:${c}" title="STATUS = 0 — Not Booked">Chưa booking</span>`;
  }
  const tho = String(r.status_tho ?? '').trim();
  if (!tho) return '';
  return `<span style="color:var(--text-muted)" title="Giá trị STATUS không phải 0/1 — hiện nguyên văn">${escapeHtml(tho)}</span>`;
}

const BOOKING_HEADER_FILTER = {
  headerFilter: 'list',
  headerFilterParams: { values: { '': 'Tất cả', 1: 'Đã booking', 0: 'Chưa booking' } },
};

/** Cột tab Tra cứu Part On/Off (WO_PART_ON_OFF). Giờ đã đổi sang VN ở server:
 *  Mutation (ngày AMOS) + Mutation Time (ms) đã GHÉP thành 1 cột giờ VN. */
const COLS_PART_ONOFF = [
  { title: 'Event Perf', field: 'event_perfno_i', formatter: fmtIntCell, hozAlign: 'right', sorter: 'number', headerFilter: 'input' },
  { title: 'Part No', field: 'partno', headerFilter: 'input' },
  { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
  { title: 'Label', field: 'labelno', headerFilter: 'input' },
  { title: 'AC Position', field: 'ac_position', headerFilter: 'input' },
  { title: 'Loc ID', field: 'locid_pk', headerFilter: 'input' },
  { title: 'Part No (off)', field: 'partno_off', headerFilter: 'input' },
  { title: 'Serial No (off)', field: 'serialno_off', headerFilter: 'input' },
  { title: 'Release No', field: 'releaseno', headerFilter: 'input' },
  { title: 'Mutator', field: 'mutator', headerFilter: 'input' },
  {
    title: 'Booking', field: 'booking_status', hozAlign: 'center', width: 140,
    ...BOOKING_HEADER_FILTER,
    headerTooltip: 'WO_PART_ON_OFF.STATUS — Booking status of the component change: '
      + '0 = Not Booked (chưa booking) · 1 = Booked (đã booking).',
    formatter: fmtBookingCell,
  },
  { title: 'Giờ mutation (VN)', field: 'mutation_time_vn', formatter: fmtDateCell },
  { title: 'Created By', field: 'created_by', headerFilter: 'input' },
  { title: 'Created Date (VN)', field: 'created_date_vn', formatter: fmtDateOnlyCell },
];

/** Định nghĩa cột cho từng báo cáo. */
const REPORT_DEFS = {
  'returned-unservice': {
    title: 'Danh mục trả unservice',
    desc: 'Thiết bị đã trả unservice (real_us1) trong kỳ, kèm ngày giao và nhân viên giao.',
    columns: [
      { title: 'event_perf', field: 'event_perf', headerFilter: 'input' },
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno', headerFilter: 'input' },
      { title: 'Description', field: 'description' },
      { title: 'History No', field: 'historyno' },
      { title: 'Aircraft', field: 'ac_registr', headerFilter: 'input'  },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Center', field: 'department', headerFilter: 'input' },
      { title: 'Staff', field: 'staff', headerFilter: 'input' },
      { title: 'Delivery Staff', field: 'del_staff', headerFilter: 'input' },
      { title: 'Delivery Time', field: 'del_time', formatter: fmtDateCell },
      { title: 'Receive Time', field: 'reci_time', formatter: fmtDateCell },
    ],
  },
  'issued-not-installed': {
    title: 'Thiết bị xuất kho nhưng chưa lắp lên tàu',
    desc: 'kho_ser1 vm=T (P-…) chưa lắp (on_off vm=YE) và chưa được return. TAT = hiện tại − giờ xuất kho. Cột "Event (WO)" là số work order của phiếu xuất (kho_ser1.event_perf); "Vị trí hiện tại" lấy từ ROTABLES (nối qua khóa psn) — cho biết thiết bị đang nằm ở đâu. ĐÃ LOẠI những thiết bị lắp vào CỤM CAO HƠN (không lên tàu nên không có on_off YE, nhưng có bản ghi lắp trong WO_PART_ON_OFF) — nhóm đó chuyển sang bảng "Chi tiết TAT" với nhãn "Chỉ lắp lên".',
    columns: [
      {
        title: 'Event (WO)', field: 'event_perf', formatter: fmtIntCell,
        hozAlign: 'right', sorter: 'number', headerFilter: 'input',
        headerTooltip: 'kho_ser1.event_perf — số work order của phiếu xuất',
      },
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno', headerFilter: 'input'  },
      { title: 'Description', field: 'description' },
      { title: 'Center', field: 'department', headerFilter: 'input' },
      { title: 'Staff', field: 'staff', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Store', field: 'store', headerFilter: 'input' },
      { title: 'Aircraft', field: 'ac_registr', headerFilter: 'input' },
      { title: 'Phiếu xuất', field: 'voucher_issue', headerFilter: 'input'  },
      { title: 'Ngày Giờ xuất', field: 'issue_time_vn', formatter: fmtDateCell },
      { title: 'TAT (now)', field: 'tat_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
      // Thong tin tu ROTABLES (noi qua psn): vi tri hien tai cua thiet bi
      { title: 'PSN', field: 'psn', headerFilter: 'input', formatter: fmtIntCell, hozAlign: 'right' },
      {
        title: 'Vị trí hiện tại', field: 'location', headerFilter: 'input', widthGrow: 1.5,
        formatter: (cell) => cell.getValue() || '<span style="color:var(--text-muted)">—</span>',
      },
    ],
  },
  'removed-not-returned': {
    title: 'Thiết bị tháo xuống từ tàu nhưng chưa trả unservice',
    desc: 'on_off vm=YA không có bản ghi real_us1 (liên kết qua historyno_). '
      + 'Store và Location là VỊ TRÍ HIỆN TẠI của thiết bị (ROTABLES nối qua psn, rồi LOCATION theo locationno_i). '
      + 'Báo cáo TỰ CẬP NHẬT theo thực tế: điều kiện "chưa trả US" được xét tại THỜI ĐIỂM XEM, nên thiết bị tháo tháng 7 '
      + 'mà trả US sang tháng 8 sẽ tự biến mất khỏi báo cáo tháng 7. Vì vậy cùng một kỳ xem lại lúc khác có thể ra số khác — đó là đúng ý đồ. '
      + 'Xem /api/admin/diag/rnr để biết từng điều kiện cắt bớt bao nhiêu dòng.',
    columns: [
      { title: 'event_perf', field: 'event_perf', headerFilter: 'input' },
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno', headerFilter: 'input'  },
      { title: 'History No', field: 'historyno' },
      { title: 'Aircraft', field: 'ac_registr', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      // Store + Location = vi tri HIEN TAI, dat canh nhau cho de doc
      {
        title: 'Store', field: 'store_now', headerFilter: 'input',
        headerTooltip: 'Store HIỆN TẠI (LOCATION.store theo locationno_i của ROTABLES); thiếu dữ liệu thì lùi về store lúc tháo',
        formatter: (cell) => cell.getValue() || '<span style="color:var(--text-muted)">—</span>',
      },
      {
        title: 'Location', field: 'location', headerFilter: 'input', widthGrow: 1.5,
        headerTooltip: 'ROTABLES.location — thiết bị hiện đang nằm ở đâu',
        formatter: (cell) => cell.getValue() || '<span style="color:var(--text-muted)">—</span>',
      },
      { title: 'Center', field: 'trung_tam', headerFilter: 'input'  },
      { title: 'Staff', field: 'staff', headerFilter: 'input' },
      { title: 'Ngày Giờ tháo', field: 'removed_time_vn', formatter: fmtDateCell },
      { title: 'station_now', field: 'station_now',  },
      { title: 'store_now', field: 'store_now', headerFilter: 'input' },
      { title: 'PSN', field: 'psn', headerFilter: 'input', formatter: fmtIntCell, hozAlign: 'right' },
    ],
  },
  'not-reconciled': {
    title: 'Thiết bị chưa đối ứng',
    desc: 'Có xuất service (kho_ser1 vm=T) nhưng không có trả unservice, và chưa hoàn kho. TAT tồn = hiện tại − giờ xuất kho.',
    columns: [
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno', headerFilter: 'input'  },
      { title: 'Description', field: 'description' },
      { title: 'Center', field: 'department', headerFilter: 'input' },
      { title: 'Staff', field: 'staff', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Store', field: 'store', headerFilter: 'input' },
      { title: 'Aircraft', field: 'ac_registr', headerFilter: 'input' },
      { title: 'Pickslip', field: 'voucher_issue', headerFilter: 'input' },
      { title: 'Phiếu xuất', field: 'picking_li', headerFilter: 'input' },
      { title: 'Giờ xuất', field: 'issue_time_vn', formatter: fmtDateCell },
      { title: 'TAT (now)', field: 'tat_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
    ],
  },
  'manual-pair': {
    title: 'Đối ứng thủ công — thiết bị tháo/lắp có LABEL LỆCH NHAU',
    desc: 'Trường hợp bất thường: tháo thiết bị này xuống, lắp thiết bị khác lên → label của 2 cái khác nhau nên chương trình không tự đối ứng được. Cột "Cách ghép" cho biết cặp gợi ý tìm bằng nguồn nào, ưu tiên giảm dần: (1) Other (on_ac: NOI/ROB/DIR/CRO — thiết bị đã trả US nhưng chưa có phiếu xuất), chấm điểm theo tiêu chí khớp: event (WO) > part no + số tàu > part no; (2) WO_PART_ON_OFF theo part+serial; (3) WO_PART_ON_OFF theo event; (4) cùng orderno/psn; (5) cùng tàu. Kiểm tra rồi bấm ✔ Xác nhận — thiết bị sẽ hết nằm trong "Chưa đối ứng" và được tính vào KPI.',
    columns: [
      { title: 'PN xuất (lắp lên)', field: 'partno', headerFilter: 'input' },
      { title: 'SN xuất', field: 'serialno', headerFilter: 'input' },
      { title: 'Label xuất', field: 'labelno', headerFilter: 'input' },
      { title: 'Phiếu xuất', field: 'voucher_issue', headerFilter: 'input' },
      { title: 'Event (WO)', field: 'event_perf', headerFilter: 'input' },
      { title: 'Tàu', field: 'ac_registr', headerFilter: 'input' },
      { title: 'Ngày Giờ xuất', field: 'issue_time_vn', formatter: fmtDateCell },
      { title: 'Tồn (ngày)', field: 'tat_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
      // --- Cặp GỢI Ý: thiết bị đã tháo xuống ---
      { title: 'PN tháo (gợi ý)', field: 'sug_partno_off', headerFilter: 'input' },
      { title: 'SN tháo (gợi ý)', field: 'sug_serialno_off', headerFilter: 'input' },
      { title: 'Label trả', field: 'sug_ret_labelno', headerFilter: 'input' },
      { title: 'Giờ trả US', field: 'sug_ret_del_time', formatter: fmtDateCell },
      { title: 'TAT nếu ghép', field: 'sug_tat_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
      { title: 'Ghi chú on_ac', field: 'sug_on_ac', headerFilter: 'input' },
      {
        title: '⚠', field: 'sug_duplicate', hozAlign: 'center', width: 55,
        headerTooltip: 'Cùng một thiết bị tháo được gợi ý cho nhiều phiếu xuất — chỉ tối đa 1 cái đúng',
        formatter: (cell) => {
          const n = Number(cell.getValue()) || 0;
          if (n < 2) return '';
          return `<span title="Serial tháo này còn được gợi ý cho ${n - 1} phiếu khác — kiểm tra kỹ trước khi xác nhận" style="color:${cssVar('--critical')};font-weight:700">⚠${n}</span>`;
        },
      },
      {
        title: 'Cách ghép', field: 'match_method', headerFilter: 'input', widthGrow: 2,
        formatter: (cell) => cell.getValue() || '<span style="color:var(--text-muted)">— không tìm được —</span>',
      },
      {
        title: 'Tin cậy', field: 'confidence', hozAlign: 'center',
        headerFilter: 'list',
        headerFilterParams: { values: { '': 'Tất cả', 'Cao': 'Cao', 'Trung bình': 'Trung bình', 'Thấp': 'Thấp' } },
        formatter: (cell) => {
          const v = cell.getValue();
          if (!v) return '';
          const color = v === 'Cao' ? 'var(--good)' : (v === 'Thấp' ? 'var(--critical)' : 'var(--warning)');
          return `<span style="color:${color};font-weight:700">${v}</span>`;
        },
      },
      { title: 'Center', field: 'department', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      // Nút xác nhận cặp (chỉ hiện khi tìm được gợi ý)
      {
        title: 'Đối ứng', field: '_confirm', headerSort: false, hozAlign: 'center', width: 120,
        formatter: (cell) => {
          const d = cell.getRow().getData();
          if (!d.sug_serialno_off) return '<span style="color:var(--text-muted)">—</span>';
          if (!state.isAdmin) {
            return `<span title="Chỉ máy quản trị mới xác nhận được (IP của bạn: ${state.clientIp})" style="color:var(--text-muted)">🔒 Chỉ xem</span>`;
          }
          return '<button class="btn-accent" style="padding:2px 8px;font-size:11px">✔ Xác nhận</button>';
        },
        cellClick: (e, cell) => { if (state.isAdmin) confirmManualPair(cell.getRow()); },
      },
    ],
  },
  'manual-pair-done': {
    title: 'Cặp đối ứng thủ công ĐÃ xác nhận (chỉ xem)',
    desc: 'Các cặp thiết bị tháo ↔ phiếu xuất đã được quản trị viên xác nhận trong kỳ — đã được tính là ĐÃ đối ứng trong KPI. Mọi máy đều xem/xuất Excel được; chỉ máy quản trị mới thêm/gỡ được (trang Admin).',
    columns: [
      { title: 'Phiếu xuất', field: 'issueVoucher', headerFilter: 'input' },
      { title: 'Label xuất', field: 'issueLabel', headerFilter: 'input' },
      { title: 'PN xuất', field: 'issuePartno', headerFilter: 'input' },
      { title: 'SN xuất', field: 'issueSerialno', headerFilter: 'input' },
      { title: 'Ngày Giờ xuất', field: 'issueTimeVn', formatter: fmtDateCell },
      { title: 'PN tháo', field: 'offPartno', headerFilter: 'input' },
      { title: 'SN tháo', field: 'offSerialno', headerFilter: 'input' },
      { title: 'Label trả', field: 'retLabelno', headerFilter: 'input' },
      { title: 'Giờ trả US', field: 'retDelTime', formatter: fmtDateCell },
      { title: 'TAT (ngày)', field: 'tatDays', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
      { title: 'Cách ghép', field: 'matchMethod', headerFilter: 'input', widthGrow: 2 },
      { title: 'Tin cậy', field: 'confidence', hozAlign: 'center' },
      { title: 'Center', field: 'department', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      {
        title: 'Xác nhận lúc', field: 'confirmedAt',
        formatter: (cell) => String(cell.getValue() || '').slice(0, 16).replace('T', ' '),
      },
      { title: 'Bởi (IP)', field: 'confirmedBy' },
    ],
  },
  'removed-before-installed': {
    title: 'Chỉ một phía trong WO_PART_ON_OFF (chỉ lắp hoặc chỉ tháo)',
    desc: 'Một dòng WO_PART_ON_OFF bình thường là một lần THAY THẾ: thiết bị cũ ra + thiết bị mới vào. Bảng này liệt kê những dòng CHỈ CÓ MỘT PHÍA — "Chỉ lắp (ON)" là gắn thêm mà không gỡ cái nào, "Chỉ tháo (OFF)" là gỡ ra mà chưa gắn cái nào. Đây chính là hai đầu của nghiệp vụ tháo trước–lắp sau, được ghi thành 2 dòng riêng nên không tự ghép với nhau được. Cột "Có on_off" = Không nghĩa là các báo cáo dựa trên on_off (Tháo chưa trả US, Xuất kho chưa lắp) đang BỎ SÓT thiết bị này. Lọc Station/Center chỉ áp dụng khi tra ra được từ phiếu xuất hoặc dòng trả US; dòng không tra ra được vẫn hiển thị.',
    columns: [
      {
        title: 'Phía', field: 'phia', hozAlign: 'center', width: 110,
        formatter: (cell) => (cell.getValue() === 'ON' ? 'Chỉ lắp (ON)' : 'Chỉ tháo (OFF)'),
        headerFilter: 'list',
        headerFilterParams: { values: { '': 'Tất cả', ON: 'Chỉ lắp (ON)', OFF: 'Chỉ tháo (OFF)' } },
      },
      
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno', formatter: fmtIntCell, headerFilter: 'input' },
      { title: 'Event Perf', field: 'event_perf', formatter: fmtIntCell, headerFilter: 'input' },
      { title: 'Vị trí (AC pos)', field: 'ac_position', headerFilter: 'input' },
      { title: 'Thời điểm', field: 'thoi_diem_vn', formatter: fmtDateCell },
      {
        title: 'Booking', field: 'booking_status', hozAlign: 'center', width: 140,
        ...BOOKING_HEADER_FILTER,
        headerTooltip: 'WO_PART_ON_OFF.STATUS — 0 = Not Booked · 1 = Booked. '
          + 'Lần thay thiết bị CHƯA booking là một lý do rất hay gặp khiến on_off không có sự kiện tương ứng.',
        formatter: fmtBookingCell,
      },
      { title: 'Pickslip', field: 'voucher_issue', headerFilter: 'input' },
      { title: 'Ngày xuất kho', field: 'issue_time_vn', formatter: fmtDateCell },
      { title: 'Giờ trả US', field: 'return_unservice_time', formatter: fmtDateCell },
      { title: 'Người tạo', field: 'created_by', headerFilter: 'input' },
      { title: 'Center', field: 'department', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
    ],
  },
  other: {
    title: 'Other (on_ac) — đã trả unservice nhưng CHƯA có phiếu xuất đối ứng',
    desc: 'Thiết bị đã trả US nhưng không tìm được phiếu xuất service tương ứng; ghi chú on_ac cho biết LÝ DO. Mã: NOI = không có phiếu xuất (no issue pickslip) · ROB = robbery, tháo xuống trước · DIR = lắp thẳng lên tàu vật tư trong kho · CRO = tháo vật tư repairable/consumable.',
    columns: [
      {
        title: 'Lý do', field: 'reason_code', hozAlign: 'center', width: 90,
        headerFilter: 'list',
        headerFilterParams: { values: { '': 'Tất cả', NOI: 'NOI', ROB: 'ROB', DIR: 'DIR', CRO: 'CRO' } },
        formatter: (cell) => {
          const v = cell.getValue();
          if (!v) return '<span style="color:var(--text-muted)">—</span>';
          const COLORS = { NOI: '--series-6', ROB: '--series-2', DIR: '--series-1', CRO: '--series-5' };
          return `<span style="font-weight:700;color:${cssVar(COLORS[v] || '--text-secondary')}">${v}</span>`;
        },
      },
      { title: 'Diễn giải', field: 'reason_name', headerFilter: 'input', widthGrow: 2 },
      { title: 'Part No (off)', field: 'partno_off', headerFilter: 'input' },
      { title: 'Serial No (off)', field: 'serialno_off', headerFilter: 'input' },
      { title: 'Batch No (off)', field: 'batchno_off', headerFilter: 'input'  },
      { title: 'Qty', field: 'qty_off', hozAlign: 'right' },
      { title: 'Label', field: 'labelno', headerFilter: 'input' },
      { title: 'Phiếu xuất (voucher_s)', field: 'voucher_issue', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Center', field: 'department', headerFilter: 'input' },
      { title: 'Staff', field: 'staff', headerFilter: 'input' },
      { title: 'Delivery Staff', field: 'del_staff', headerFilter: 'input'  },
      { title: 'Delivery Time', field: 'del_time', formatter: fmtDateCell },
      { title: 'Note (on_ac)', field: 'note', widthGrow: 2 },
    ],
  },
  'return-store-tat': {
    title: 'TAT hoàn kho',
    desc: 'Thiết bị hoàn kho (vm=TC, P-CA-<PS>) đối chiếu phiếu xuất (vm=T, P-<PS>) cùng số PS và labelno.',
    columns: [
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno', headerFilter: 'input'  },
      { title: 'Description', field: 'description' },
      { title: 'Center', field: 'department', headerFilter: 'input' },
      { title: 'Staff', field: 'staff', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Store', field: 'store', headerFilter: 'input' },
      { title: 'Pickslip', field: 'voucher_issue', headerFilter: 'input'  },
      { title: 'Phiếu xuất', field: 'picking_li', headerFilter: 'input' },
      { title: 'Ngày Giờ xuất', field: 'issue_time_vn', formatter: fmtDateCell },
      { title: 'Ngày Giờ hoàn', field: 'return_store_time_vn', formatter: fmtDateCell },
      { title: 'TAT (ngày)', field: 'tat_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
    ],
  },

  // --- REPAIR ADMIN: ton dong tai cac vi tri UNSERVICEABLE (location_type=-4) ---
  'repair-admin': {
    title: 'Repair Admin — tồn đọng tại vị trí Unserviceable',
    desc: 'Thiết bị đang nằm ở vị trí U/S (LOCATION.location_type = -4) có đơn sửa chữa OD_DETAIL với '
      + 'status = 0, backorder = 1 và state = O. Nguồn: LOCATION × ROTABLES × OD_DETAIL (nối psn + labelno), '
      + 'thêm OD_HEADER (nối ORDERNO_I) để lấy cột Hold — đơn sửa chữa có đang bị giữ hay không. '
      + 'Đây là ẢNH CHỤP HIỆN TRẠNG nên KHÔNG phụ thuộc kỳ báo cáo — chỉ lọc theo Station/Store đang chọn. '
      + 'Tuổi tồn đọng tính từ ROTABLES.orderdate. Bảng tổng hợp bên dưới dựng từ chính danh sách này nên luôn khớp; '
      + 'nút ⬇ Excel xuất danh sách chi tiết.',
    // Bang TONG HOP dung tu chinh du lieu bang duoi -> khong the lech nhau.
    summary: (rows) => repairAdminSummary(rows),
    columns: [
      { title: 'Station', field: 'station', headerFilter: 'input', width: 100 },
      { title: 'Store', field: 'store', headerFilter: 'input', width: 110 },
      { title: 'Vị trí (U/S)', field: 'location', headerFilter: 'input', widthGrow: 1.5 },
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno', formatter: fmtIntCell, hozAlign: 'right', headerFilter: 'input' },
      { title: 'PSN', field: 'psn', formatter: fmtIntCell, hozAlign: 'right', headerFilter: 'input' },
      { title: 'Order No', field: 'orderno', headerFilter: 'input' },
      {
        title: 'Hold', field: 'on_hold', hozAlign: 'center', width: 110,
        headerFilter: 'list',
        headerFilterParams: { values: { '': 'Tất cả', true: 'Đang hold', false: 'Không hold' } },
        // So sanh TUONG MINH theo chuoi. Du lieu la BOOLEAN (true/false) con gia
        // tri o loc la CHUOI ('true'/'false'); Tabulator 6 hien tu ep kieu nen
        // van dung, nhung cach ep do la chi tiet BEN TRONG thu vien - viet han
        // ra day thi nang cap Tabulator khong the am tham lam hong o loc nay.
        // (Da do ca hai chieu bang Playwright: 6 dong hold / 48 dong khong hold,
        // khop dung so lieu API.)
        headerFilterFunc: (giaTriLoc, giaTriDong) => String(giaTriDong) === String(giaTriLoc),
        headerTooltip: 'OD_HEADER.on_hold — đơn sửa chữa có đang bị GIỮ (hold) không. '
          + 'Nối OD_DETAIL × OD_HEADER theo ORDERNO_I. Trống = OD_HEADER không có dòng tương ứng.',
        formatter: (cell) => {
          const v = cell.getValue();
          if (v === true) {
            const c = cssVar('--critical');
            return `<span class="tat-badge" style="background:${c}22;color:${c}">Đang hold</span>`;
          }
          if (v === false) return '<span style="color:var(--text-muted)">—</span>';
          // Khong hieu duoc gia tri -> hien NGUYEN VAN, khong doan la "khong hold"
          const tho = String(cell.getRow().getData().on_hold_tho ?? '').trim();
          return tho
            ? `<span style="color:var(--text-muted)" title="Giá trị on_hold không nhận dạng được">${escapeHtml(tho)}</span>`
            : '<span style="color:var(--text-muted)" title="OD_HEADER không có dòng tương ứng">?</span>';
        },
      },
      { title: 'Ngày order', field: 'order_date_vn', formatter: fmtDateOnlyCell },
      {
        title: 'Tuổi (ngày)', field: 'age_days', hozAlign: 'right', sorter: 'number',
        formatter: (cell) => {
          const v = cell.getValue();
          if (v === null || v === undefined) return '<span style="color:var(--text-muted)">—</span>';
          const color = Number(v) >= 30 ? cssVar('--warning') : cssVar('--good');
          return `<span class="tat-badge" style="background:${color}22;color:${color}">${v}</span>`;
        },
      },
    ],
  },
};

// --------------------------------------------------------------------------
// 6. Tai & render Dashboard
// --------------------------------------------------------------------------
let baseKpiInstall = 0; // TAT install goc (khoi phuc khi Dat lai)
let baseKpiUsret = 0;   // TAT US return goc
let baseKpiCuvt = 0;    // TAT CUVT goc (chang 3 - khong co trong bang chi tiet)
let baseKpiTotal = 0;   // TAT tong goc (3 chang cong lai)
let mainTotalRows = 0;  // tong so dong bang chi tiet (cho bo dem X/Y)

let dashLoadSeq = 0; // chong race: doi filter nhanh -> chi render response MOI nhat

async function loadDashboard() {
  const seq = ++dashLoadSeq;
  showError('');
  showLoading(true);
  setBusy('#dashPane', true, 'Đang tải dữ liệu…');
  setTabLoading('.mainTab', 'dashboard', true);
  $('#recalcNote').classList.add('hidden');
  try {
    const dash = await api('/api/dashboard');
    if (seq !== dashLoadSeq) return; // da co request moi hon -> bo response cu
    $('#rangeLabel').textContent = `${dash.range.label}: ${fmtDateTime(dash.range.from)} → ${fmtRangeEnd(dash.range.to)}`;
    baseKpiInstall = dash.kpis.tatInstallAvg;
    baseKpiUsret = dash.kpis.tatUsReturnAvg;
    baseKpiCuvt = dash.kpis.tatCuvtAvg || 0;
    baseKpiTotal = dash.kpis.tatTotalAvg || 0;
    renderKPIs(dash.kpis, dash.prevKpis);
    renderCharts(dash.charts);

    // Bang chi tiet: dung "rows" tra kem trong /api/dashboard (tranh query 2 lan).
    const rows = dash.rows || (await api('/api/tat/departments')).rows;
    excludedKeys.clear(); // du lieu moi -> xoa cac tich chon cu

    // Bo dem so dong (canh bao neu cham gioi han MAX_ROWS phia server)
    mainTotalRows = rows.length;
    $('#mainCount').textContent =
      `${rows.length.toLocaleString('vi')} dòng` +
      (dash.rowsTruncated ? ' ⚠ chạm giới hạn MAX_ROWS — tăng MAX_ROWS trong .env' : '');

    if (!mainTable) {
      mainTable = new Tabulator('#mainTable', {
        data: rows,
        columns: withHeaderFilters(COLS_TAT_DEPT),
        layout: 'fitDataFill',
        pagination: false,     // hien HET cac dong (cuon doc, render ao)
        placeholder: 'Không có dữ liệu',   // duoc thay bang chuBangRong() sau moi lan tai
        height: '600px',
      });
      // Khi tim kiem/loc cot: hien "X/Y dong" de biet so luong cu the
      mainTable.on('dataFiltered', (filters, rowsFiltered) => {
        const n = rowsFiltered.length;
        $('#mainCount').textContent =
          n === mainTotalRows
            ? `${mainTotalRows.toLocaleString('vi')} dòng`
            : `${n.toLocaleString('vi')}/${mainTotalRows.toLocaleString('vi')} dòng`;
      });
    } else {
      mainTable.setColumns(withHeaderFilters(COLS_TAT_DEPT));
      mainTable.replaceData(rows);
    }
  } catch (err) {
    showError(err.message, loadDashboard);
  } finally {
    showLoading(false);
    setTimeout(veChuBangRong, 0);
    if (seq === dashLoadSeq) {
      setBusy('#dashPane', false);
      setTabLoading('.mainTab', 'dashboard', false);
    }
  }
}

/** Trung binh 1 truong, bo qua null/khong hop le. */
function avgField(rows, field) {
  const v = rows.map((r) => Number(r[field])).filter((x) => isFinite(x));
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : 0;
}

/** Cap nhat gia tri 1 card KPI theo thu tu (0-based). */
function setKpiCard(idx, value) {
  const card = document.querySelectorAll('#kpiGrid .kpi .kpi-value')[idx];
  if (card) card.innerHTML = `${value} <span class="kpi-unit">ngày</span>`;
}

/** Tính lại TAT install & US return, bỏ các dòng đã tích checkbox "Bỏ qua".
 *  LƯU Ý 1: loại luôn dòng CUVT khỏi trung bình — giống cách server tính 2 card
 *  KPI (TAT của CUVT đã có card "TAT CUVT" riêng).
 *  LƯU Ý 2: loại luôn dòng "Chỉ lắp lên" (INSTALL — lắp vào cụm cao hơn). Các
 *  card KPI do server tính bằng SQL aggregate CHƯA gồm nhóm này; nếu tính ở đây
 *  thì con số sẽ NHẢY ngay khi người dùng tích ô "Bỏ qua" đầu tiên. Giữ 2 bên
 *  khớp nhau; nhóm này vẫn hiện đầy đủ trong bảng chi tiết. */
function recalcTat() {
  if (!mainTable) return;
  const all = mainTable.getData();
  const kept = all.filter(
    (r) => !excludedKeys.has(rowKey(r))
      && String(r.department || '').trim().toUpperCase() !== 'CUVT'
      && r.return_type !== 'INSTALL'
  );
  const newInstall = avgField(kept, 'tat_install_days');
  const newUsret = avgField(kept, 'tat_usreturn_days');
  // TAT tong = 3 chang; chang CUVT khong nam trong bang chi tiet nen giu nguyen
  const newTotal = Math.round((newInstall + newUsret + baseKpiCuvt) * 10) / 10;

  setKpiCard(0, newTotal);   // card "TAT tổng (3 chặng)"
  setKpiCard(1, newInstall); // card "TAT install"
  setKpiCard(2, newUsret);   // card "TAT US return"
  const note = $('#recalcNote');
  note.classList.remove('hidden');
  note.innerHTML =
    `Đã loại <b>${excludedKeys.size}</b> mục (trên ${kept.length}/${all.length} thiết bị) · ` +
    `TAT install: <b>${newInstall}</b> ngày (gốc ${baseKpiInstall}) · ` +
    `TAT US return: <b>${newUsret}</b> ngày (gốc ${baseKpiUsret}) · ` +
    `TAT tổng: <b>${newTotal}</b> ngày (gốc ${baseKpiTotal}, đã cộng TAT CUVT ${baseKpiCuvt}).`;
}

/** Bỏ tích tất cả checkbox và khôi phục TAT gốc. */
function resetRecalc() {
  excludedKeys.clear();
  if (mainTable) mainTable.redraw(true); // ve lai de checkbox ve trang thai trong
  setKpiCard(0, baseKpiTotal);
  setKpiCard(1, baseKpiInstall);
  setKpiCard(2, baseKpiUsret);
  $('#recalcNote').classList.add('hidden');
}

// --------------------------------------------------------------------------
// 7. Tai & render Bao cao
// --------------------------------------------------------------------------
/**
 * NOI DAT bao cao. Cung mot ham loadReport() phuc vu 2 cho:
 *   'report'    - tab "Cac Bao cao khac" (co thanh tab con .reportTab)
 *   'lgcRepair' - tab con "Repair Admin" trong nhom LGC
 * Nho vay cot / mo ta / bang tong hop chi khai bao MOT lan trong REPORT_DEFS,
 * chuyen cho hien thi khong sinh ra ban sao thu hai de lech nhau.
 */
const REPORT_HOSTS = {
  report: {
    pane: '#reportPane', title: '#reportTitle', desc: '#reportDesc',
    summary: '#reportSummary', table: '#reportTable', count: '#reportCount',
    search: '#reportSearch', tabSel: '.reportTab', tabAttr: 'report',
    remember: true, // ghi nho bao cao dang mo vao state (de doi filter tai lai dung cai do)
  },
  lgcRepair: {
    pane: '#lgcRepairPane', title: '#lgcRepairTitle', desc: '#lgcRepairDesc',
    summary: '#lgcRepairSummary', table: '#lgcRepairTable', count: '#lgcRepairCount',
    search: '#lgcRepairSearch', tabSel: null, tabAttr: null,
    remember: false, // chi co MOT bao cao -> khong ghi de state.currentReport
  },
};
const reportTables = {};    // hostKey -> Tabulator
const reportTotals = {};    // hostKey -> tong so dong (cho bo dem X/Y)
const reportSeqs = {};      // hostKey -> chong race RIENG tung cho

/** Bang TONG HOP cua Repair Admin: dong = Station + Store + Vi tri,
 *  cot = < 30 ngay / >= 30 ngay / Khong ro ngay / Tong, kem dong TỔNG CỘNG.
 *  Dung tu CHINH danh sach dang hien -> khong bao gio lech voi bang duoi. */
/**
 * BANG KPI THEO NHAN VIEN - dung chung cho hai tab LGC:
 *   pickslip  -> thu kho xuat booking (PICKSLIP_HEADER.BOOKING_SIGN)
 *   receiving -> inspector nhap kho   (HISTORY.CREATED_BY)
 *
 * ⚠️ Ty le scan de `null` khi nguoi do KHONG co phieu nao can scan (vi du toan
 * item cancel) - hien "—" chu KHONG hien 0%: 0% doc ra la "chua scan cai nao",
 * oan cho nguoi ta.
 *
 * ⚠️ Ben thu kho CHI do viec XUAT KHO (nghiep vu chot): phieu xuat + item xuat.
 * Cancel/Return/Khac co y KHONG dua vao bang nay - so lieu day du cua chung
 * van nam o the KPI va bieu do cua ca tab.
 */
function veKpiNhanVien(sel, rows, kieu) {
  const box = $(sel);
  if (!box) return;
  const ds = rows || [];
  if (!ds.length) {
    box.innerHTML = '<div class="nv-trong">Không có dữ liệu nhân viên trong kỳ này.</div>';
    return;
  }
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const bar = (v) => {
    if (v === null || v === undefined) return '<span style="color:var(--text-muted)">—</span>';
    const cls = v >= 90 ? '' : (v >= 70 ? 'vua' : 'thap');
    return `${v}%<span class="nv-bar ${cls}"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></span>`;
  };
  const laXuat = kieu === 'pickslip';
  const tong = (k) => ds.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const lam2 = (v) => Math.round(v * 100) / 100;
  // Cot "SL khác" CHI hien khi ky nay THUC SU co vat tu ngoai R/C - khong bay
  // mot cot toan so 0 (giong cach lam cua cot "Đang hold" o Repair Admin).
  // Co no tuc la MAT_CLASS co gia tri la, phai nhin thay chu khong am tham bo.
  const coKhac = !laXuat && tong('sl_khac') > 0;
  const cot = laXuat
    ? ['Mã NV', 'Tên', 'Số phiếu xuất', 'Item xuất', 'Phiếu đã scan', 'Tỷ lệ scan']
    : ['Mã NV', 'Tên', 'Số phiếu receive', 'Item', 'Tổng SL', 'SL nhập R', 'SL nhập C',
      ...(coKhac ? ['SL khác'] : []), 'Phiếu đã scan', 'Tỷ lệ scan'];
  const head = '<tr>' + cot.map((c, i) => `<th${i >= 2 ? ' class="ra-num"' : ''}>${c}</th>`).join('') + '</tr>';
  const num = (v) => `<td class="ra-num">${v}</td>`;
  const body = ds.map((r) => {
    const chung = `<tr><td class="nv-ma">${esc(r.ma_nv)}</td><td class="nv-ten">${esc(r.ten_nv) || '—'}</td>`
      + num(r.so_phieu);
    const duoi = num(`${r.da_scan}/${r.da_scan + r.chua_scan}`) + num(bar(r.ty_le_scan)) + '</tr>';
    return laXuat
      ? chung + num(r.so_xuat) + duoi
      : chung + num(r.so_item) + num(r.tong_sl) + num(r.sl_r ?? 0) + num(r.sl_c ?? 0)
        + (coKhac ? num(r.sl_khac ?? 0) : '') + duoi;
  }).join('');
  const scanTong = tong('da_scan');
  const scanMau = tong('da_scan') + tong('chua_scan');
  const foot = `<tr class="ra-total"><td colspan="2">TỔNG (${ds.length} người)</td>`
    + num(tong('so_phieu'))
    + (laXuat
      ? num(tong('so_xuat'))
      : num(tong('so_item')) + num(lam2(tong('tong_sl')))
        + num(lam2(tong('sl_r'))) + num(lam2(tong('sl_c')))
        + (coKhac ? num(lam2(tong('sl_khac'))) : ''))
    + num(`${scanTong}/${scanMau}`)
    + num(scanMau ? `${Math.round((1000 * scanTong) / scanMau) / 10}%` : '—')
    + '</tr>';
  box.innerHTML = `<table class="ra-table"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
}

function repairAdminSummary(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const key = `${r.station}|${r.store}|${r.location}`;
    let g = map.get(key);
    if (!g) {
      g = { station: r.station || '', store: r.store || '', location: r.location || '',
            less30: 0, over30: 0, unknown: 0, hold: 0, total: 0 };
      map.set(key, g);
    }
    const a = r.age_days;
    if (a === null || a === undefined) g.unknown++;
    else if (Number(a) < 30) g.less30++;
    else g.over30++;
    if (r.on_hold === true) g.hold++;
    g.total++;
  }
  const list = [...map.values()].sort(
    (a, b) => a.station.localeCompare(b.station) || b.total - a.total
  );
  if (!list.length) return '';
  const sum = (k) => list.reduce((s, r) => s + r[k], 0);
  const coUnknown = sum('unknown') > 0;
  const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const num = (v, warn) => {
    if (!v) return '<td class="ra-num ra-zero">0</td>';
    return `<td class="ra-num"${warn ? ` style="color:${cssVar('--warning')};font-weight:600"` : ''}>${v}</td>`;
  };
  // Cot "Dang hold" chi hien khi ky nay THUC SU co thiet bi bi hold - khong
  // bay mot cot toan so 0 (giong cach lam cua cot "Khong ro ngay").
  const coHold = sum('hold') > 0;
  const head = `<tr><th>Station</th><th>Store</th><th>Vị trí (U/S)</th>`
    + `<th class="ra-num">&lt; 30 ngày</th><th class="ra-num">≥ 30 ngày</th>`
    + (coUnknown ? '<th class="ra-num">Không rõ ngày</th>' : '')
    + (coHold ? '<th class="ra-num">Đang hold</th>' : '')
    + `<th class="ra-num">Tổng</th></tr>`;
  const body = list.map((r) =>
    `<tr><td>${esc(r.station)}</td><td>${esc(r.store)}</td><td>${esc(r.location)}</td>`
    + num(r.less30) + num(r.over30, true)
    + (coUnknown ? num(r.unknown) : '')
    + (coHold ? num(r.hold, true) : '')
    + `<td class="ra-num"><b>${r.total}</b></td></tr>`).join('');
  const foot = `<tr class="ra-total"><td colspan="3">TỔNG CỘNG (${list.length} vị trí)</td>`
    + `<td class="ra-num">${sum('less30')}</td><td class="ra-num">${sum('over30')}</td>`
    + (coUnknown ? `<td class="ra-num">${sum('unknown')}</td>` : '')
    + (coHold ? `<td class="ra-num">${sum('hold')}</td>` : '')
    + `<td class="ra-num">${sum('total')}</td></tr>`;
  return `<table class="ra-table"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
}

async function loadReport(name, hostKey = 'report') {
  const H = REPORT_HOSTS[hostKey];
  const seq = (reportSeqs[hostKey] = (reportSeqs[hostKey] || 0) + 1);
  if (H.remember) state.currentReport = name;
  const def = REPORT_DEFS[name];
  $(H.title).textContent = def.title;
  $(H.desc).textContent = def.desc;
  if (H.tabSel) $$(H.tabSel).forEach((b) => b.classList.toggle('active', b.dataset[H.tabAttr] === name));

  // DON SACH du lieu cua bao cao TRUOC ngay lap tuc: neu de nguyen, nguoi dung
  // se doc nham so lieu tab cu tuong la tab moi. Dat cot moi + rong du lieu ->
  // thay dung khung bang cua bao cao sap toi (kieu "skeleton").
  $(H.count).textContent = '';
  $(H.search).value = '';
  const sumBoxEarly = $(H.summary);
  if (sumBoxEarly) { sumBoxEarly.innerHTML = ''; sumBoxEarly.classList.add('hidden'); }
  if (reportTables[hostKey]) {
    reportTables[hostKey].clearFilter(true);
    reportTables[hostKey].setColumns(withHeaderFilters(def.columns));
    reportTables[hostKey].replaceData([]);
  }
  setBusy(H.pane, true, 'Đang tải báo cáo…', 0);
  if (H.tabSel) setTabLoading(H.tabSel, name, true);

  showError('');
  showLoading(true);
  const tt = moTienTrinh(H.pane);
  try {
    // Dung cache theo (bao cao + filter) de doi tab khong load lai du lieu
    const cacheKey = `${name}?${buildQuery()}`;
    let data = reportCache.get(cacheKey);
    if (!data) {
      data = await api(`/api/reports/${name}`, tt.job);
      reportCache.set(cacheKey, data);
    }
    if (seq !== reportSeqs[hostKey]) return; // da co request moi hon -> bo qua
    reportTotals[hostKey] = data.count;
    $(H.count).textContent =
      `${data.count.toLocaleString('vi')} dòng` +
      (data.truncated ? ' ⚠ chạm giới hạn MAX_ROWS' : '');

    // Bao cao "Other": thong ke nhanh theo MA LY DO (NOI/ROB/DIR/CRO)
    if (name === 'other') {
      const cnt = new Map();
      (data.rows || []).forEach((r) => {
        const k = r.reason_code || '—';
        cnt.set(k, (cnt.get(k) || 0) + 1);
      });
      const order = ['NOI', 'ROB', 'DIR', 'CRO', '—'];
      const parts = order.filter((k) => cnt.has(k)).map((k) => `${k}: ${cnt.get(k)}`);
      if (parts.length) $(H.desc).textContent = def.desc + '  ▸ Thống kê kỳ này — ' + parts.join(' · ');
    }
    // Bang TONG HOP (chi bao cao nao khai bao `summary` moi co)
    const sumBox = $(H.summary);
    if (sumBox) {
      const html = typeof def.summary === 'function' ? def.summary(data.rows || []) : '';
      sumBox.innerHTML = html;
      sumBox.classList.toggle('hidden', !html);
    }
    if (!reportTables[hostKey]) {
      reportTables[hostKey] = new Tabulator(H.table, {
        data: data.rows,
        columns: withHeaderFilters(def.columns),
        layout: 'fitDataFill',
        pagination: false,     // hien HET cac dong (cuon doc, render ao)
        placeholder: 'Không có dữ liệu',   // duoc thay bang chuBangRong() sau moi lan tai
        height: '600px',
      });
      // Khi tim kiem/loc cot: hien "X/Y dong"
      reportTables[hostKey].on('dataFiltered', (filters, rowsFiltered) => {
        const n = rowsFiltered.length;
        const tot = reportTotals[hostKey] || 0;
        $(H.count).textContent = n === tot
          ? `${tot.toLocaleString('vi')} dòng`
          : `${n.toLocaleString('vi')}/${tot.toLocaleString('vi')} dòng`;
      });
    } else {
      // Cot da duoc dat o dau ham (luc don sach du lieu cu)
      reportTables[hostKey].replaceData(data.rows);
      reportTables[hostKey].redraw(true); // ve lai day du sau khi tab vua duoc hien thi
    }
  } catch (err) {
    showError(err.message, () => loadReport(name, hostKey));
  } finally {
    tt.dong();
    showLoading(false);
    setTimeout(veChuBangRong, 0);   // the placeholder chi co sau khi Tabulator ve xong
    if (seq === reportSeqs[hostKey]) {
      setBusy(H.pane, false);
      if (H.tabSel) setTabLoading(H.tabSel, name, false);
    }
  }
}

// --------------------------------------------------------------------------
// 8. Bo loc (filters) - nap gia tri dropdown
// --------------------------------------------------------------------------
async function loadFilters() {
  try {
    const f = await fetch('/api/filters').then((r) => r.json());
    // Station: server tra ve DAY DU danh sach, HAN/SGN/DAD da duoc dua len dau
    multiSelects.station?.setList(f.stations || []);
    multiSelects.store?.setList(f.stores || []);
    multiSelects.dept?.setList(f.departments || []);
  } catch (e) {
    // khong chan - loi filter khong lam hong toan bo trang
    console.warn('Khong tai duoc filters:', e.message);
  }
}

// --------------------------------------------------------------------------
// 8b. O CHON NHIEU GIA TRI (Station / Store / Trung tam)
//     Dung nut + menu tich chon thay cho <select multiple>: select multiple
//     bat nguoi dung giu Ctrl de chon them, chiem nhieu cho tren thanh loc va
//     rat de bo chon nham chi bang mot cu click.
//     CHI tai lai du lieu KHI DONG MENU, khong phai moi lan tich - moi truy van
//     deu di qua linked server nen tich 5 kho ma ban 5 luot la rat lang phi.
//
//     Ba o dung CHUNG mot ham dung (taoMultiSelect) de hanh vi giong het nhau:
//     nguoi dung hoc mot lan la dung duoc ca ba, va sua loi mot cho la sua het.
// --------------------------------------------------------------------------

/** Nhan ca chuoi 'A,B' lan mang -> mang khong trung, khong rong. */
function normList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
}

const multiSelects = {};   // id -> dieu khien cua tung o (setList/render)

/**
 * Menu mac dinh neo vao MEP TRAI cua nut. O nao nam gan ria phai man hinh thi
 * menu se tran ra ngoai va bi cat mat. Goi ham nay ngay sau khi mo: do xem co
 * tran khong, tran thi neo sang phai.
 */
function chinhViTriMenu(menu) {
  menu.classList.remove('neo-phai');
  if (menu.getBoundingClientRect().right > window.innerWidth - 8) menu.classList.add('neo-phai');
}

/**
 * Tao mot o chon nhieu gia tri.
 * @param {object} cfg
 *   id       - tien to id trong HTML: 'station' | 'store' | 'dept'
 *   stateKey - khoa trong `state` (mang)
 *   donVi    - danh tu dem tren nut, vd 'kho' -> "3 kho"
 *   moTaAll  - title khi khong chon gi
 *   ghim     - (tuy chon) cac gia tri duoc ghim len dau, ve duong ke phia duoi
 *   biLoai   - (tuy chon) v => true neu gia tri dang bi mot o tich khac loai bo
 *   nhacRong - (tuy chon) () => chuoi canh bao, '' neu khong can nhac
 * @param {Function} apply - ham tai lai du lieu, goi MOT lan khi dong menu
 */
function taoMultiSelect(cfg, apply) {
  const { id, stateKey } = cfg;
  const q = (hau) => $(`#${id}${hau}`);
  if (!q('Btn')) return null;              // trang khac (admin) khong co o nay

  let danhMuc = [];
  let daDoi = false;
  let viTri = -1;      // dong dang "sang" khi di chuyen bang ban phim (-1 = chua chon)

  const chon = () => state[stateKey];
  const locTheoTim = () => {
    const tim = (q('Search').value || '').trim().toLowerCase();
    return danhMuc.filter((v) => !tim || v.toLowerCase().includes(tim));
  };

  /** Chu tren nut: "Tat ca" / liet ke / "N <donVi>". */
  const nhanNut = () => {
    const ds = chon();
    if (!ds.length) return 'Tất cả';
    if (ds.length <= 2) return ds.join(', ');
    return `${ds.length} ${cfg.donVi}`;
  };

  const render = () => {
    const box = q('Options');
    if (!box) return;
    const ds = locTheoTim();
    box.innerHTML = ds.length
      ? ds.map((v, i) => {
        const bo = cfg.biLoai ? cfg.biLoai(v) : false;
        // Duong ke sau nhom ghim (HAN/SGN/DAD) - chi khi dang xem danh sach day du
        const ghim = cfg.ghim ? cfg.ghim.includes(v.trim().toUpperCase()) : false;
        const ghimSau = ghim && ds[i + 1]
          && !cfg.ghim.includes(String(ds[i + 1]).trim().toUpperCase());
        const sang = i === viTri;
        return `<label class="multi-opt${bo ? ' bi-loai' : ''}${ghim ? ' ghim' : ''}${ghimSau ? ' het-ghim' : ''}${sang ? ' sang' : ''}">
            <input type="checkbox" value="${escapeHtml(v)}"${chon().includes(v) ? ' checked' : ''} />
            <span>${escapeHtml(v)}</span>
            ${bo ? '<span class="ghi-chu">đang bỏ qua</span>' : ''}
          </label>`;
      }).join('')
      : '<div class="multi-opt" style="opacity:.6">Không có mục nào khớp</div>';
    q('BtnText').textContent = nhanNut();
    q('Btn').title = chon().length ? chon().join(', ') : cfg.moTaAll;

    const hint = q('Hint');
    const nhac = cfg.nhacRong ? cfg.nhacRong() : '';
    hint.classList.toggle('hidden', !nhac);
    if (nhac) hint.textContent = nhac;

    // Cuon dong dang sang vao tam nhin khi di bang ban phim
    if (viTri >= 0) box.children[viTri]?.scrollIntoView({ block: 'nearest' });
  };

  const dangMo = () => !q('Menu').classList.contains('hidden');

  const mo = (batMo) => {
    if (batMo === dangMo()) return;
    q('Menu').classList.toggle('hidden', !batMo);
    q('Btn').setAttribute('aria-expanded', String(batMo));
    if (batMo) {
      daDoi = false;
      viTri = -1;
      q('Search').value = '';
      render();
      chinhViTriMenu(q('Menu'));
      q('Search').focus();
    } else if (daDoi) {
      daDoi = false;
      apply();   // chi tai lai MOT lan, sau khi da chon xong
    }
  };

  /** Bat/tat mot gia tri (dung chung cho chuot va ban phim). */
  const doiTich = (v) => {
    state[stateKey] = chon().includes(v)
      ? chon().filter((x) => x !== v)
      : [...new Set([...chon(), v])];
    daDoi = true;
    render();
  };

  q('Btn').addEventListener('click', (e) => { e.stopPropagation(); dongTatCaMulti(id); mo(!dangMo()); });
  // Nut cung mo duoc bang ban phim: ↓ / Enter / Space khi dang focus vao nut
  q('Btn').addEventListener('keydown', (e) => {
    if (['ArrowDown', 'Enter', ' '].includes(e.key) && !dangMo()) {
      e.preventDefault();
      dongTatCaMulti(id);
      mo(true);
    }
  });
  q('Menu').addEventListener('click', (e) => e.stopPropagation());
  q('Search').addEventListener('input', () => { viTri = -1; render(); });

  /**
   * BAN PHIM TRONG MENU (nguoi nhap lieu nhieu se nhanh hon han chuot):
   *   ↑ ↓        di chuyen dong sang     Home/End  ve dau / ve cuoi
   *   Space      tich / bo tich dong sang
   *   Enter      tich dong sang; neu chua chon dong nao ma danh sach chi con
   *              DUNG MOT muc (sau khi go tim) thi tich luon muc do
   *   Esc / Tab  dong menu (Esc do trinh xu ly chung o duoi lo)
   * Con trong o TIM thi ↑↓ khong duoc de trinh duyet nhay con tro, nen chan
   * preventDefault o cac phim nay.
   */
  q('Menu').addEventListener('keydown', (e) => {
    const ds = locTheoTim();
    if (!ds.length && e.key !== 'Escape' && e.key !== 'Tab') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const buoc = e.key === 'ArrowDown' ? 1 : -1;
      viTri = viTri < 0
        ? (buoc > 0 ? 0 : ds.length - 1)
        : (viTri + buoc + ds.length) % ds.length;   // chay vong
      render();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      viTri = e.key === 'Home' ? 0 : ds.length - 1;
      render();
    } else if (e.key === ' ' || e.key === 'Enter') {
      // Space trong o tim la khoang trang binh thuong khi CHUA chon dong nao
      if (e.key === ' ' && viTri < 0) return;
      const v = viTri >= 0 ? ds[viTri] : (ds.length === 1 ? ds[0] : null);
      if (!v) return;
      e.preventDefault();
      doiTich(v);
    } else if (e.key === 'Tab') {
      mo(false);   // roi khoi o -> coi nhu chon xong, tai lai du lieu
    }
  });
  q('Options').addEventListener('change', (e) => {
    const el = e.target;
    if (!el.matches('input[type=checkbox]')) return;
    doiTich(el.value);
  });
  // "Chon tat ca" chi ap cho cac muc DANG HIEN (sau khi tim) - dung y nguoi dung
  q('All').addEventListener('click', () => {
    state[stateKey] = [...new Set([...chon(), ...locTheoTim()])];
    daDoi = true;
    render();
  });
  q('None').addEventListener('click', () => {
    state[stateKey] = [];
    daDoi = true;
    render();
  });

  const dk = {
    id,
    render,
    dong: () => mo(false),
    setList: (ds) => { danhMuc = (ds || []).slice(); render(); },
  };
  multiSelects[id] = dk;
  return dk;
}

/** Dong cac menu khac khi mo mot menu (khong de hai menu chong nhau). */
function dongTatCaMulti(tru) {
  Object.values(multiSelects).forEach((m) => { if (m.id !== tru) m.dong(); });
}

/** Ve lai ca ba o (vd sau khi doi o tich "Bo qua cac kho CAB"). */
function renderMultiSelects() {
  Object.values(multiSelects).forEach((m) => m.render());
}

// --------------------------------------------------------------------------
// 8c. BO LOC DA LUU (preset)
//     To hop Station/Store/Trung tam + 2 o tich hay dung -> dat ten, goi lai
//     bang mot cu bam thay vi mo ba menu tich lai tu dau moi sang.
//
//     KY BAO CAO KHONG duoc luu vao preset - co chu y. Neu luu ca 'thang
//     2026-08' thi sang thang bo loc do thanh SAI ma nguoi dung khong biet;
//     ma luu kieu "thang nay" thi lai them mot khai niem nua phai giai thich.
//     Ky bao cao co san 4 nut ngay canh do, chon lai mat mot giay.
//
//     Luu o localStorage (RIENG tung may, tung nguoi) - day la thoi quen ca
//     nhan, khong phai cau hinh chung cua cong ty nen khong dua len server.
// --------------------------------------------------------------------------
const PRESET_KEY = 'tat-presets-v1';
const PRESET_MAX = 20;          // chan danh sach phinh vo han

function loadPresets() {
  try {
    const ds = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]');
    return Array.isArray(ds) ? ds : [];
  } catch { return []; }
}
function savePresets(ds) {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(ds.slice(0, PRESET_MAX))); }
  catch (e) { console.warn('Khong luu duoc bo loc:', e.message); }
}

/** Phan cua `state` duoc luu vao mot preset. */
function presetHienTai() {
  return {
    station: [...state.station],
    store: [...state.store],
    department: [...state.department],
    excludeCC: state.excludeCC,
    excludeCab: state.excludeCab,
  };
}

/** Mo ta ngan gon de nguoi dung nhan ra preset ma khong phai bam thu. */
function moTaPreset(p) {
  const phan = [];
  const them = (nhan, ds) => { if (ds && ds.length) phan.push(`${nhan}: ${ds.join(', ')}`); };
  them('Station', p.station);
  them('Kho', p.store);
  them('TT', p.department);
  if (p.excludeCC) phan.push('bỏ costcenter');
  if (p.excludeCab) phan.push('bỏ kho CAB');
  return phan.length ? phan.join(' · ') : 'Không lọc gì (xem tất cả)';
}

const bang = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
function trungVoiHienTai(p) {
  const h = presetHienTai();
  return bang([...p.station].sort(), [...h.station].sort())
    && bang([...p.store].sort(), [...h.store].sort())
    && bang([...p.department].sort(), [...h.department].sort())
    && !!p.excludeCC === h.excludeCC && !!p.excludeCab === h.excludeCab;
}

function initPresets(apply) {
  const btn = $('#presetBtn');
  if (!btn) return;                        // trang khac khong co o nay
  const menu = $('#presetMenu');
  const dangMo = () => !menu.classList.contains('hidden');

  const baoNhac = (chu) => {
    const h = $('#presetHint');
    h.classList.toggle('hidden', !chu);
    if (chu) h.textContent = chu;
  };

  const render = () => {
    const ds = loadPresets();
    $('#presetList').innerHTML = ds.length
      ? ds.map((p, i) => `
        <div class="preset-row${trungVoiHienTai(p) ? ' dang-dung' : ''}">
          <button type="button" class="preset-ap" data-i="${i}" title="${escapeHtml(moTaPreset(p))}">
            <span class="preset-ten">${escapeHtml(p.ten)}</span>
            <span class="preset-mo-ta">${escapeHtml(moTaPreset(p))}</span>
          </button>
          <button type="button" class="preset-xoa" data-xoa="${i}" title="Xoá bộ lọc này">×</button>
        </div>`).join('')
      : '<div class="multi-opt" style="opacity:.6">Chưa lưu bộ lọc nào</div>';
    // Nut chinh HIEN TEN preset dang dung - nhin mot cai la biet minh dang o
    // bo loc nao, khong phai mo menu ra doi chieu.
    const dang = ds.find(trungVoiHienTai);
    btn.classList.toggle('co-preset', !!dang);
    $('#presetBtnText').textContent = dang ? `⭐ ${dang.ten}` : 'Chọn / Lưu…';
    btn.title = dang ? `Đang dùng bộ lọc "${dang.ten}" — ${moTaPreset(dang)}` : 'Bộ lọc đã lưu';
  };

  const mo = (batMo) => {
    if (batMo === dangMo()) return;
    menu.classList.toggle('hidden', !batMo);
    btn.setAttribute('aria-expanded', String(batMo));
    if (batMo) {
      baoNhac('');
      $('#presetName').value = '';
      render();
      chinhViTriMenu(menu);
      $('#presetName').focus();
    }
  };

  btn.addEventListener('click', (e) => { e.stopPropagation(); dongTatCaMulti(null); mo(!dangMo()); });
  menu.addEventListener('click', (e) => e.stopPropagation());

  $('#presetList').addEventListener('click', (e) => {
    const xoa = e.target.closest('[data-xoa]');
    if (xoa) {
      const ds = loadPresets();
      const ten = ds[+xoa.dataset.xoa]?.ten || '';
      if (!confirm(`Xoá bộ lọc "${ten}"?`)) return;
      ds.splice(+xoa.dataset.xoa, 1);
      savePresets(ds);
      render();
      return;
    }
    const ap = e.target.closest('[data-i]');
    if (!ap) return;
    const p = loadPresets()[+ap.dataset.i];
    if (!p) return;
    // Ap preset: chi dat lai 5 truong cua no, KY BAO CAO giu nguyen
    state.station = [...(p.station || [])];
    state.store = [...(p.store || [])];
    state.department = [...(p.department || [])];
    state.excludeCC = !!p.excludeCC;
    state.excludeCab = !!p.excludeCab;
    $('#ccToggle').checked = state.excludeCC;
    $('#cabToggle').checked = state.excludeCab;
    renderMultiSelects();
    mo(false);
    apply();
  });

  const luu = () => {
    const ten = ($('#presetName').value || '').trim();
    if (!ten) { baoNhac('Đặt tên cho bộ lọc rồi bấm Lưu.'); $('#presetName').focus(); return; }
    const ds = loadPresets();
    const cu = ds.findIndex((p) => p.ten.toLowerCase() === ten.toLowerCase());
    if (cu >= 0 && !confirm(`Đã có bộ lọc tên "${ds[cu].ten}". Ghi đè?`)) return;
    if (cu < 0 && ds.length >= PRESET_MAX) {
      baoNhac(`Chỉ lưu được tối đa ${PRESET_MAX} bộ lọc — xoá bớt một cái rồi lưu lại.`);
      return;
    }
    const moi = { ten, ...presetHienTai() };
    if (cu >= 0) ds[cu] = moi; else ds.push(moi);
    savePresets(ds);
    $('#presetName').value = '';
    baoNhac('');
    render();
  };
  $('#presetSave').addEventListener('click', luu);
  $('#presetName').addEventListener('keydown', (e) => { if (e.key === 'Enter') luu(); });

  document.addEventListener('click', () => mo(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') mo(false); });
  window.__renderPresets = render;   // ve lai khi bo loc doi (danh dau "đang dùng")
  render();
}

function initMultiSelects(apply) {
  taoMultiSelect({
    id: 'station',
    stateKey: 'station',
    donVi: 'station',
    moTaAll: 'Tất cả các station',
    ghim: ['HAN', 'SGN', 'DAD'],   // ba station chinh luon o dau danh sach
  }, apply);

  taoMultiSelect({
    id: 'store',
    stateKey: 'store',
    donVi: 'kho',
    moTaAll: 'Tất cả các kho',
    biLoai: (v) => state.excludeCab && CAB_STORES.includes(v.trim().toUpperCase()),
    nhacRong: () => {
      const conLai = state.store.filter((v) => !CAB_STORES.includes(v.trim().toUpperCase()));
      if (!state.excludeCab || !state.store.length || conLai.length) return '';
      return 'Mọi kho đang chọn đều nằm trong nhóm bị "Bỏ qua các kho CAB" '
        + '→ kết quả sẽ rỗng. Bỏ tích ô đó hoặc chọn thêm kho khác.';
    },
  }, apply);

  taoMultiSelect({
    id: 'dept',
    stateKey: 'department',
    donVi: 'trung tâm',
    moTaAll: 'Tất cả các trung tâm',
  }, apply);

  document.addEventListener('click', () => dongTatCaMulti(null));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dongTatCaMulti(null); });
}

// --------------------------------------------------------------------------
// 9. Che do (mode badge) & health
// --------------------------------------------------------------------------
async function checkHealth() {
  try {
    const h = await fetch('/api/health').then((r) => r.json());
    const badge = $('#modeBadge');
    if (h.mode === 'demo') {
      badge.textContent = 'DEMO';
      badge.style.color = cssVar('--warning');
    } else {
      badge.textContent = 'LIVE';
      badge.style.color = cssVar('--good');
    }
  } catch {
    $('#modeBadge').textContent = 'OFFLINE';
  }
}

// --------------------------------------------------------------------------
// 10. Theme toggle
// --------------------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('tat-theme', theme);
  // ve lai chart de cap nhat mau theo theme
  loadDashboard();
}
function initTheme() {
  const saved = localStorage.getItem('tat-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  $('#themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const isDark = cur === 'dark' || (!cur && matchMedia('(prefers-color-scheme: dark)').matches);
    applyTheme(isDark ? 'light' : 'dark');
  });
}

// --------------------------------------------------------------------------
// 11. Chuyen tab chinh
// --------------------------------------------------------------------------
const MAIN_TABS = ['dashboard', 'reports', 'lgc', 'partlookup'];

/**
 * O LOC NAO CO TAC DUNG o man hinh dang xem.
 * Truoc day thanh loc hien DU MOI O o moi tab, ke ca o KHONG duoc truy van nao
 * dung den (vd "Bo qua xuat costcenter" khong he co trong nhanh pickslip /
 * receiving / repair-admin) -> nguoi dung chinh ma man hinh khong doi gi, tuong
 * la loi. Nay chi hien o nao that su tac dong len so lieu dang xem.
 */
const FILTER_VIEWS = {
  dashboard: { period: 1, station: 1, store: 1, dept: 1, cc: 1, cab: 1 },
  reports: { period: 1, station: 1, store: 1, dept: 1, cc: 1, cab: 1 },
  'lgc:pickslip': { period: 1, station: 1, store: 1, dept: 1, cc: 0 },
  // Phieu NHAP kho thong ke theo Station/Store, KHONG theo Trung tam
  'lgc:receiving': { period: 1, station: 1, store: 1, dept: 0, cc: 0 },
  // Repair Admin la ANH CHUP HIEN TRANG: khong theo ky, chi loc station/store.
  'lgc:repair': { period: 0, station: 1, store: 1, dept: 0, cc: 0 },
  // Tra cuu Part On/Off co o tim rieng, khong dung o loc nao ben tren.
  partlookup: { period: 0, station: 0, store: 0, dept: 0, cc: 0 },
};

/**
 * HANG DIEU KIEN DANG LOC ("chip").
 *
 * Nut loc chi noi DANG CHON MAY thu ("4 station"), khong noi LA NHUNG GI -
 * muon biet phai mo tung menu ra xem; ba o thi phai mo ba lan. Nguoi nhan link
 * minh gui con khong biet dang xem pham vi nao. Hang nay liet ke thang ra, moi
 * dieu kien mot chip co dau × de bo nhanh.
 *
 * CHI HIEN chip cua o loc DANG CO TAC DUNG tren man hinh nay (theo FILTER_VIEWS)
 * - bay chip "Trung tam" o tab Receiving la noi doi, vi tab do khong loc theo
 * trung tam.
 */
function renderChipBar(view) {
  const bar = $('#chipBar');
  if (!bar) return;
  const v = FILTER_VIEWS[view] || FILTER_VIEWS.dashboard;

  const chips = [];
  const themDs = (bat, nhan, khoa) => {
    if (!bat || !state[khoa].length) return;
    chips.push({ nhan, gt: state[khoa].join(', '), khoa });
  };
  themDs(v.station, 'Station', 'station');
  themDs(v.store, 'Kho', 'store');
  themDs(v.dept, 'Trung tâm', 'department');
  if (v.cc && state.excludeCC) chips.push({ nhan: 'Bỏ qua xuất costcenter', gt: '', khoa: 'excludeCC' });
  if (v.cab && state.excludeCab) chips.push({ nhan: 'Bỏ qua các kho CAB', gt: '', khoa: 'excludeCab' });

  bar.classList.toggle('hidden', !chips.length);
  if (!chips.length) return;

  $('#chipList').innerHTML = chips.map((c) => `
    <span class="chip-loc">
      <span class="chip-noi-dung">${escapeHtml(c.nhan)}${c.gt ? ': <b>' + escapeHtml(c.gt) + '</b>' : ''}</span>
      <button type="button" class="chip-x" data-bo="${c.khoa}"
              title="Bỏ điều kiện này" aria-label="Bỏ ${escapeHtml(c.nhan)}">×</button>
    </span>`).join('');
}

function initChipBar(apply) {
  const bar = $('#chipBar');
  if (!bar) return;
  $('#chipList').addEventListener('click', (e) => {
    const nut = e.target.closest('[data-bo]');
    if (!nut) return;
    const khoa = nut.dataset.bo;
    if (khoa === 'excludeCC' || khoa === 'excludeCab') {
      state[khoa] = false;
      $(khoa === 'excludeCC' ? '#ccToggle' : '#cabToggle').checked = false;
    } else {
      state[khoa] = [];
    }
    renderMultiSelects();
    apply();
  });
  $('#chipClear').addEventListener('click', () => {
    state.station = []; state.store = []; state.department = [];
    state.excludeCC = false; state.excludeCab = false;
    $('#ccToggle').checked = false;
    $('#cabToggle').checked = false;
    renderMultiSelects();
    apply();
  });
}

/** Man hinh dang xem la gi (de biet nen hien nhung o loc nao). */
function currentFilterView() {
  if (!$('#tab-lgc').classList.contains('hidden')) return 'lgc:' + state.lgcTab;
  if (!$('#tab-reports').classList.contains('hidden')) return 'reports';
  if (!$('#tab-partlookup').classList.contains('hidden')) return 'partlookup';
  return 'dashboard';
}

function applyFilterVisibility(view) {
  const v = FILTER_VIEWS[view] || FILTER_VIEWS.dashboard;
  const set = (sel, on) => { const el = $(sel); if (el) el.classList.toggle('hidden', !on); };
  set('#periodWrap', v.period);
  ['#monthWrap', '#weekWrap', '#quarterWrap', '#yearWrap'].forEach((sel) => {
    // O nhap cua ky nao dang chon thi moi hien - va chi khi con dung ky bao cao
    set(sel, v.period && sel === `#${state.periodType}Wrap`);
  });
  set('#stationWrap', v.station);
  set('#storeWrap', v.store);
  set('#deptWrap', v.dept);
  set('#ccWrap', v.cc);
  set('#cabWrap', v.cab);
  set('#rangeLabel', v.period); // khong theo ky thi nhan "Thang: ... -> ..." gay hieu nham
  renderChipBar(view);          // hang chip phai theo dung bo o loc dang hien
}

function switchTab(tab) {
  $$('.mainTab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  MAIN_TABS.forEach((t) => $(`#tab-${t}`).classList.toggle('hidden', t !== tab));
  if (tab === 'reports') {
    // LUON tai lai khi mo tab (cache lam viec nay re); tranh cap nhat bang khi
    // tab dang an (Tabulator ve rong neu container display:none).
    applyFilterVisibility('reports');
    loadReport(state.currentReport);
  } else if (tab === 'lgc') {
    switchLgcTab(state.lgcTab);
  } else if (tab === 'partlookup') {
    applyFilterVisibility('partlookup');
    if (partTable) partTable.redraw(true); // ve lai sau khi container hien thi
    $('#poPartno').focus();
  } else {
    applyFilterVisibility('dashboard');
    if (mainTable) mainTable.redraw(true); // ve lai sau khi tab hien thi tro lai
  }
}

/**
 * Bat CHE DO LGC: an cac tab TAT, doi tieu de, va them mot loi thoat sang
 * dashboard day du (khong khoa cung - nguoi LGC van xem duoc phan con lai).
 * KHONG phai phan quyen: day chi la don gian hoa giao dien. Muon CHAN that
 * thi phai chan o server nhu adminGuard.
 */
function applyLgcOnlyMode() {
  document.title = 'VAECO · LGC';
  const h1 = document.querySelector('header h1');
  const sub = document.querySelector('header .brand-sub');
  if (h1) h1.textContent = 'LGC';
  if (sub) sub.textContent = 'VAECO · Logistics Center · Xuất kho · Receiving · Repair Admin';
  $$('.mainTab').forEach((b) => b.classList.toggle('hidden', b.dataset.tab !== 'lgc'));
  const nav = document.querySelector('nav .flex');
  if (nav) {
    const a = document.createElement('a');
    a.href = '/';
    a.className = 'ml-auto self-center text-xs text-muted hover:underline pr-1';
    a.textContent = 'Xem dashboard TAT đầy đủ →';
    nav.appendChild(a);
  }
  chaoNguoiDungLgc();
}

/**
 * Hien "Xin chao <ma nhan vien>" + nut Thoat tren thanh dau trang LGC.
 * Vao duoc trang nay nghia la da qua cong ma nhan vien (server kiem tra), nen
 * day chi la hien thi - KHONG phai cho kiem tra quyen o phia trinh duyet.
 */
async function chaoNguoiDungLgc() {
  let me = null;
  try { me = await fetch('/api/lgc/me').then((r) => r.json()); } catch (_) { return; }
  if (!me || !me.ok || !me.ma) return;          // cong dang tat -> khong hien gi
  const host = document.querySelector('header .ml-auto');
  if (!host) return;
  const box = document.createElement('span');
  box.className = 'lgc-chao';
  // Ten lay tu cot DESCRIPTION cua bang SIGN; khong co ten thi hien ma
  const ten = me.ten || me.ma;
  box.innerHTML = `<span>Xin chào <b>${escapeHtml(ten)}</b></span>`;
  box.title = `Mã nhân viên: ${me.ma}${me.department ? ' · ' + me.department : ''}`;
  const nut = document.createElement('button');
  nut.type = 'button';
  nut.className = 'lgc-thoat';
  nut.textContent = 'Thoát';
  nut.title = 'Quên mã nhân viên trên máy này';
  nut.addEventListener('click', async () => {
    await fetch('/api/lgc/logout', { method: 'POST' }).catch(() => {});
    location.href = '/lgc';
  });
  box.appendChild(nut);
  host.insertBefore(box, host.firstChild);
}

// --- Nhom LGC: KHONG tu chay truy van ------------------------------------
// Cac truy van cua LGC doc AMOS qua linked server nen nang. Mo tab (hoac doi
// bo loc) chi hien man hinh "chua chay"; nguoi dung chon ky/station xong bam
// "Chay kiem tra" thi moi goi API. `lgcRan` nho tab con nao DA chay voi bo loc
// hien tai - doi bo loc thi xoa het de khoi doc nham so lieu cu.
const LGC_TABS = ['pickslip', 'receiving', 'repair'];
const LGC_TAB_NAME = {
  pickslip: 'Quản lý xuất kho', receiving: 'Receiving', repair: 'Repair Admin',
};
const lgcRan = {};

/** Hien noi dung tab con neu DA chay, nguoc lai hien the "chua chay". */
function renderLgcPanes() {
  const sub = state.lgcTab;
  const ran = !!lgcRan[sub];
  $('#lgcIdle').classList.toggle('hidden', ran);
  $('#lgcIdleName').textContent = LGC_TAB_NAME[sub] || sub;
  LGC_TABS.forEach((t) => $(`#lgc-${t}`).classList.toggle('hidden', !(ran && t === sub)));
}

/** Danh dau moi tab con LGC la CHUA CHAY (dung khi doi bo loc). */
function resetLgc() {
  LGC_TABS.forEach((t) => { lgcRan[t] = false; });
  if (!$('#tab-lgc').classList.contains('hidden')) renderLgcPanes();
}

/** Chuyen tab con trong nhom LGC (xuat kho · receiving · repair) - KHONG chay. */
function switchLgcTab(sub) {
  if (!LGC_TABS.includes(sub)) sub = 'pickslip';
  state.lgcTab = sub;
  saveFilters();
  $$('.lgcTab').forEach((b) => b.classList.toggle('active', b.dataset.lgc === sub));
  applyFilterVisibility('lgc:' + sub);
  renderLgcPanes();
}

/** Bam "Chay kiem tra": chay truy van cho tab con dang mo. */
async function runLgc() {
  const sub = state.lgcTab;
  const btn = $('#lgcRun');
  btn.disabled = true;
  btn.textContent = '⏳ Đang chạy…';
  lgcRan[sub] = true;
  renderLgcPanes(); // hien khung TRUOC roi moi tai (Tabulator ve rong neu bi an)
  try {
    if (sub === 'pickslip') await loadPickslip();
    else if (sub === 'receiving') await loadReceiving();
    else await loadReport('repair-admin', 'lgcRepair');
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Chạy kiểm tra';
  }
}

// --------------------------------------------------------------------------
// 11c. Tab Quan ly xuat kho (pickslip) - KPI + 3 bieu do + bang chi tiet
//      Don vi dem: SO DONG. "Huy" = QTY_CANCELED > 0. Ky theo PICKSLIP_DATE.
// --------------------------------------------------------------------------
let pickTable = null;
let pickTotalRows = 0;
let pickLoadSeq = 0;

// THUAT NGU THONG NHAT cho toan bo tab LGC:
//   Phiếu xuất  - item ra khoi kho binh thuong
//   Cancel      - huy truoc khi hang ra khoi kho
//   Return      - hang da ra kho roi quay ve
//   Receive     - nhap kho (tab Receiving)
// THU TU O DAY LA THU TU HIEN TRONG BO LOC cot "Loại" (duoc trai thang bang
// spread) - de NORMAL len dau cho dung thu tu doc.
const PICK_LOAI_LABEL = {
  NORMAL: 'Phiếu xuất', CANCEL: 'Cancel',
  RETURN: 'Return', KHAC: 'Hủy/trả khác',
};

// --- Doi chieu FILE SCAN PDF (dung chung cho tab Xuat kho va tab Receiving) ---
// Gia tri '' = KHONG doc duoc thu muc -> hien '—' chu KHONG bao "chua scan"
// (bao nham se khien nguoi dung di tim file khong ton tai van de).
// Mot nguon duy nhat cho nhan trang thai scan: badge tren bang, bo loc dau cot
// va bang KPI deu doc tu day.
const SCAN_LABEL = { SCANNED: 'Đã scan', CHUA_SCAN: 'Chưa scan', KHONG_CAN: 'không cần' };

/** Cac kho bi loai khi tich "Bo qua cac kho CAB" (giong CAB_STORES o server). */
const CAB_STORES = ['CAB', 'CAB-TD', 'P-THA', 'P-SAF', 'P-PAN'];

/** Chan HTML trong du lieu tu server (duong dan / thong bao loi). */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * O cot "Scan". Rieng trang thai DA SCAN thi bam duoc de MO CHINH FILE PDF
 * tren may chu - xem moFileScan().
 *
 * formatterParams: { loai: 'picking'|'receiving', khoa: '<ten truong khoa>' }
 * Thieu formatterParams thi o van hien binh thuong, chi la khong bam duoc -
 * mot bang quen khai bao KHONG duoc lam hong ca bang.
 */
function fmtScanCell(cell, params) {
  const v = cell.getValue();
  const mau = { SCANNED: '--good', CHUA_SCAN: '--critical' }[v];
  if (mau) {
    const c = cssVar(mau);
    const d = cell.getRow().getData();
    const ma = params && params.khoa ? d[params.khoa] : '';
    if (v === 'SCANNED' && params && params.loai && ma) {
      return `<button type="button" class="tat-badge scan-mo" data-scan-mo`
        + ` data-loai="${escapeHtml(params.loai)}" data-station="${escapeHtml(d.station || '')}"`
        + ` data-ma="${escapeHtml(ma)}" style="background:${c}22;color:${c}"`
        + ` title="Bấm để mở file scan của phiếu ${escapeHtml(ma)}">${SCAN_LABEL[v]} ⤓</button>`;
    }
    return `<span class="tat-badge" style="background:${c}22;color:${c}">${SCAN_LABEL[v]}</span>`;
  }
  // Item cancel: hang khong ra khoi kho nen khong co phieu de ky va luu.
  // Phai noi RO "khong can" thay vi de trong hay hien "Chua scan" - de trong
  // thi nguoi doc tuong thieu du lieu, con "Chua scan" la buoc toan oan.
  if (v === 'KHONG_CAN') {
    return '<span style="color:var(--text-muted)" title="Item cancel — hàng không ra khỏi kho '
      + `nên không có phiếu để ký và lưu">${SCAN_LABEL.KHONG_CAN}</span>`;
  }
  return '<span style="color:var(--text-muted)" title="Không đọc được thư mục scan">—</span>';
}

/**
 * MO FILE SCAN THAT cua mot phieu.
 *
 * Hoi server truoc (/api/scan/tim) roi moi mo, thay vi tro thang the <a> vao
 * /api/scan/file: MOT phieu co the co NHIEU file (phieu scan lam nhieu lan,
 * '649020-1.pdf' + '649020-2.pdf'). Mo dai mot cai roi giau cac cai con lai
 * la kieu sai am tham - nguoi dung tuong da xem het phieu.
 */
async function moFileScan(nut) {
  const { loai, station, ma } = nut.dataset;
  const q = `loai=${encodeURIComponent(loai)}&station=${encodeURIComponent(station)}`
    + `&ma=${encodeURIComponent(ma)}`;
  const cu = nut.textContent;
  nut.textContent = '…';
  try {
    const r = await fetch(`/api/scan/tim?${q}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.message || `Lỗi ${r.status}`);
    if (!j.files.length) throw new Error('Không tìm thấy file scan của phiếu này.');
    if (j.files.length === 1) {
      window.open(`/api/scan/file?${q}&ten=${encodeURIComponent(j.files[0])}`, '_blank', 'noopener');
      return;
    }
    menuFileScan(nut, q, j.files);
  } catch (e) {
    nutBaoLoi(nut, e.message);
  } finally {
    if (nut.textContent === '…') nut.textContent = cu;
  }
}

/** Bao loi ngay tai nut (khong dung alert - dang chen giua bang du lieu). */
function nutBaoLoi(nut, msg) {
  nut.title = msg;
  nut.classList.add('scan-loi');
  setTimeout(() => nut.classList.remove('scan-loi'), 2500);
}

/** Phieu co nhieu file -> menu nho ngay duoi nut de nguoi dung tu chon. */
function menuFileScan(nut, q, files) {
  document.querySelectorAll('.scan-menu').forEach((x) => x.remove());
  const box = document.createElement('div');
  box.className = 'scan-menu';
  box.innerHTML = `<div class="scan-menu-tit">${files.length} file scan</div>`
    + files.map((f) => `<a target="_blank" rel="noopener"
        href="/api/scan/file?${q}&ten=${encodeURIComponent(f)}">${escapeHtml(f)}</a>`).join('');
  const r = nut.getBoundingClientRect();
  box.style.top = `${r.bottom + window.scrollY + 4}px`;
  box.style.left = `${Math.min(r.left + window.scrollX, window.innerWidth - 260)}px`;
  document.body.appendChild(box);
  setTimeout(() => document.addEventListener('click', function dong(ev) {
    if (box.contains(ev.target)) return;
    box.remove();
    document.removeEventListener('click', dong);
  }), 0);
}

// Bat su kien o CAP TAI LIEU: Tabulator ve lai o moi khi cuon/loc nen gan
// listener vao tung nut se mat sau lan ve lai dau tien.
document.addEventListener('click', (e) => {
  const nut = e.target.closest('[data-scan-mo]');
  if (nut) moFileScan(nut);
});

const SCAN_HEADER_FILTER = {
  headerFilter: 'list',
  headerFilterParams: {
    values: { '': 'Tất cả', ...SCAN_LABEL },
  },
};

/**
 * Thanh trang thai thu muc scan. MOI STATION MOT THU MUC (giống công cụ
 * AMOS_GUI), nên server trả về một DANH SÁCH — hiện hết để biết station nào
 * đang đọc được, station nào không.
 */
function renderScanBar(sel, folders) {
  const el = $(sel);
  if (!el) return;
  const ds = Array.isArray(folders) ? folders : (folders ? [folders] : []);
  if (!ds.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const loi = ds.filter((x) => !x.ok);
  el.className = `scanbar ${loi.length ? 'scanbar-warn' : 'scanbar-ok'} mb-3`;
  const dong = ds.map((x) => {
    const dir = `<code>${escapeHtml(x.dir || '(chưa cấu hình)')}</code>`;
    return x.ok
      ? `<div>✔ <b>${escapeHtml(x.station)}</b> ${dir} — <b>${(x.count || 0).toLocaleString('vi')}</b> file PDF`
        + `<span class="text-xs text-muted"> (${x.ms || 0}ms)</span></div>`
      : `<div>⚠ <b>${escapeHtml(x.station)}</b> ${dir} — ${escapeHtml(x.error || 'không đọc được')}</div>`;
  }).join('');
  el.innerHTML = `<div class="font-semibold mb-1">📁 Thư mục scan theo Station</div>${dong}`
    + (loi.length
      ? '<div class="text-xs mt-1">Với station không đọc được, cột “Scan” để trống (—), '
        + 'KHÔNG kết luận là chưa scan. Sửa ở trang <a href="/admin.html" target="_blank">Quản trị</a>.</div>'
      : '<div class="text-xs text-muted mt-1">Làm mới mỗi 60 giây · đối chiếu theo station của từng phiếu.</div>');
}

const COLS_PICKSLIP = [
  {
    title: 'Loại', field: 'loai', hozAlign: 'center', width: 110,
    headerTooltip: 'Mốc là QTY_CANCELED ≠ 0. Rồi dò ĐUÔI của PICKSLIP_TEXT: …cancel / …cancel booking → Cancel; '
      + '…return → Return; không có từ khóa nào → “Hủy/trả khác” (VẪN tính là hủy/trả, chỉ là chưa phân loại được).',
    // Nhan lay TU PICK_LOAI_LABEL - mot nguon duy nhat cho thuat ngu, de doi
    // ten mot cho la ca badge lan bo loc deu doi theo (truoc day chep tay 3 noi).
    formatter: (cell) => {
      const v = cell.getValue();
      const mau = { CANCEL: '--warning', RETURN: '--series-4', KHAC: '--series-5' }[v];
      if (!mau) return `<span style="color:var(--text-muted)">${PICK_LOAI_LABEL.NORMAL}</span>`;
      const c = cssVar(mau);
      const tip = v === 'KHAC'
        ? ' title="QTY_CANCELED ≠ 0 nhưng PICKSLIP_TEXT không có từ khóa cancel/return"' : '';
      return `<span class="tat-badge" style="background:${c}22;color:${c}"${tip}>${PICK_LOAI_LABEL[v]}</span>`;
    },
    headerFilter: 'list',
    headerFilterParams: {
      values: { '': 'Tất cả', ...PICK_LOAI_LABEL },
    },
  },
  // MOT cot thoi gian xuat kho duy nhat: co gio that thi hien ngay + gio, khong
  // co thi lui ve NGAY phieu va ghi ro "chỉ có ngày". Truoc day phai bay ba cot
  // (Ngay phieu / Gio xuat kho / Sua cuoi) vi gio hay trong; nay server tra kem
  // issue_shown + issue_exact nen mot cot la du, khong dong nao mat ngay.
  {
    title: 'Ngày xuất kho', field: 'issue_shown', 
    headerFilter: 'input', headerFilterFunc: dateFilterFunc,
    headerTooltip: 'PICKSLIP_HEADER.PICKSLIP_DATE (ngày AMOS) + PICKSLIP_HEADER.BOOKING_TIME '
      + '(giờ lập phiếu) → giờ VN (+7). Thiếu BOOKING_TIME thì hiện NGÀY phiếu và ghi rõ '
      + '“chỉ có ngày” (không bao giờ trình bày 00:00 như thể đó là giờ thật).',
    formatter: fmtNgayGioGop('issue_exact'),
  },
  { title: 'Pickslip', field: 'pickslipno', headerFilter: 'input' },
  {
    title: 'Event (WO)', field: 'seqno', formatter: fmtIntCell, hozAlign: 'right', 
    headerTooltip: 'PICKSLIPSEQNO_I — số Event/WO của item xuất kho, dùng để khớp với phiếu trả về kho.',
  },
  {
    title: 'Phiếu xuất', field: 'picking_listno', formatter: fmtIntCell, hozAlign: 'right',
    headerFilter: 'input',
    headerTooltip: 'PICKING_LISTNO_I — số phiếu xuất, cũng là tên file scan cần tìm.',
  },
  {
    title: 'Scan', field: 'scan', hozAlign: 'center', width: 105, ...SCAN_HEADER_FILTER,
    headerTooltip: 'Có file <PICKING_LISTNO_I>-….pdf trong thư mục scan hay chưa. '
      + 'Item CANCEL ghi “không cần” — hàng không ra khỏi kho thì không có phiếu để ký và lưu. '
      + '“—” = không đọc được thư mục. Ô “Đã scan” BẤM ĐƯỢC để mở chính file PDF trên máy chủ.',
    formatter: fmtScanCell,
    formatterParams: { loai: 'picking', khoa: 'picking_listno' },
  },
  { title: 'Part No', field: 'partno', headerFilter: 'input' },
  { title: 'Serial / Batch', field: 'serialno', headerFilter: 'input' },
{ title: 'Booked Qty', field: 'qty_booked', hozAlign: 'right', sorter: 'number' },
  {
    title: 'Canceled Qty', field: 'qty_canceled', hozAlign: 'right', sorter: 'number', 
    formatter: (cell) => {
      const v = Number(cell.getValue()) || 0;
      if (!v) return '<span style="color:var(--text-muted)">0</span>';
      const c = cssVar('--warning');
      return `<span class="tat-badge" style="background:${c}22;color:${c}">${v}</span>`;
    },
  },
  // --- Phieu TRA LAI KHO (chi co o dong loai Return) ---
  {
    title: 'Return No', field: 'return_no', headerFilter: 'input',
    headerTooltip: 'HISTORY.HISTORYNO_I + “-R” (VM ∈ EA, TC) khớp theo PICKSLIPSEQNO_I. NOT FOUND = chưa có phiếu nhập lại kho.',
    formatter: (cell) => {
      const v = cell.getValue();
      if (!v) return '';
      if (v === 'NOT FOUND') {
        const c = cssVar('--critical');
        return `<span class="tat-badge" style="background:${c}22;color:${c}">NOT FOUND</span>`;
      }
      return v;
    },
  },
  // MOT cot thoi gian cho CA Cancel lan Return: hai loai ban chat gan giong
  // nhau (hang quay nguoc ve kho) va cot "Loai" da phan biet roi, nen khong
  // bay ba cot rieng (Sua cuoi dong huy / Ngay tra kho / Gio tra kho) nua.
  {
    title: 'Ngày giờ hủy / trả', field: 'huytra_shown', 
    headerFilter: 'input', headerFilterFunc: dateFilterFunc,
    headerTooltip: 'Item return: giờ hàng về kho (HISTORY.MUTATION + MUTATION_TIME → giờ VN +7). '
      + 'Item cancel / hủy-trả khác: AMOS KHÔNG có cột riêng cho giờ hủy — đây là lần SỬA CUỐI '
      + 'của item, mốc gần nhất có thể coi là lúc hủy nhưng KHÔNG chắc chắn, nên ghi rõ “(sửa cuối)”.',
    formatter: (cell) => {
      const r = cell.getRow().getData();
      const s = fmtDateTime(cell.getValue());
      if (!s) return '';
      if (r.huytra_kieu === 'CANCEL') {
        return '<span style="color:var(--text-muted)" title="AMOS không có cột giờ hủy — đây là lần sửa cuối của dòng, KHÔNG chắc là lúc hủy">'
          + `${escapeHtml(s)} <span style="font-size:11px">(sửa cuối)</span></span>`;
      }
      return fmtNgayGioGop('huytra_exact')(cell);
    },
  },
  {
    // MOT cot TAT duy nhat. Truoc day co hai cot ("TAT hoan kho (gio)" tinh
    // theo gio va "TAT return" tinh ngay tron) - hai con so cho cung mot viec,
    // lech nhau, va nguoi doc phai doan tin cot nao. Nay ca hai dau moc deu co
    // du ngay gio nen chi con MOT so: ngay chinh xac.
    title: 'TAT return', field: 'tat_return', hozAlign: 'right', sorter: 'number', 
    headerTooltip: 'Số NGÀY từ NGÀY GIỜ xuất kho (PICKSLIP_DATE + BOOKING_TIME) đến '
      + 'NGÀY GIỜ về kho (HISTORY.MUTATION + MUTATION_TIME). Tính từ mốc thật rồi quy ra '
      + 'ngày nên là số lẻ — 0.17 ngày ≈ 4 giờ.',
    formatter: (cell) => {
      const v = cell.getValue();
      if (v === null || v === undefined || v === '') return '';
      const n = Number(v);
      const c = n > 14 ? cssVar('--critical') : (n > 7 ? cssVar('--warning') : cssVar('--good'));
      const gio = Math.round(n * 24 * 10) / 10;
      return `<span class="tat-badge" style="background:${c}22;color:${c}" title="${gio} giờ">${n} ngày</span>`;
    },
  },
  {
    title: 'Scaned return', field: 'return_scan', hozAlign: 'center',  ...SCAN_HEADER_FILTER,
    headerTooltip: 'Có file <HISTORYNO_I>-….pdf trong thư mục scan hay chưa. '
      + 'Ô “Đã scan” BẤM ĐƯỢC để mở chính file PDF trên máy chủ.',
    formatter: fmtScanCell,
    formatterParams: { loai: 'picking', khoa: 'return_key' },
  },
  { title: 'Station', field: 'station', headerFilter: 'input', },
  { title: 'Store', field: 'store', headerFilter: 'input', },
  { title: 'Vị trí lấy', field: 'location_from', headerFilter: 'input' },
  { title: 'Center', field: 'department', headerFilter: 'input' },
  { title: 'Mech sign', field: 'mech_sign', headerFilter: 'input' },
  { title: 'Booking sign', field: 'booking_sign', headerFilter: 'input' },
  { title: 'Receiver', field: 'receiver', headerFilter: 'input' },
  { title: 'Owner', field: 'owner', headerFilter: 'input' },
  //{ title: 'Người tạo', field: 'created_by', headerFilter: 'input' },
  { title: 'Ghi chú', field: 'remarks', headerFilter: 'input', widthGrow: 2 },
  { title: 'Nội dung phiếu', field: 'pickslip_text', headerFilter: 'input', widthGrow: 2 },
];

/** Bo loc cua bang xuat kho: o tich "Chi dong bi huy" VA o tim kiem.
 *  Gop vao MOT ham vi Tabulator khong cho dat 2 ham loc chong nhau. */
function pickCancelFilter(row) {
  if ($('#pickOnlyCancel').checked && !(Number(row.qty_canceled) > 0)) return false;
  if ($('#pickOnlyNoScan').checked && row.scan !== 'CHUA_SCAN') return false;
  const q = ($('#pickSearch').value || '').trim().toLowerCase();
  if (!q) return true;
  return Object.values(row).some((v) => String(v ?? '').toLowerCase().includes(q));
}

/** Ve mot luoi the KPI tu danh sach { label, value, unit, accent, title }.
 *  Dung dung class `.kpi` + bien `--accent` nhu the KPI o Tong quan (truoc day
 *  cac tab moi ghi nham class `.kpi-card` - khong co trong style.css nen the
 *  hien ra tro tren nen trang, khong co khung va vach mau). */
function renderKpiCards(sel, cards) {
  $(sel).innerHTML = cards.map((c) => `
    <div class="kpi" style="--accent:${cssVar(c.accent)}" title="${escapeHtml(c.title || `${c.label}: ${c.value} ${c.unit}`)}">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value} <span class="kpi-unit">${c.unit}</span></div>
    </div>`).join('');
}

function renderPickKpis(k) {
  const n = (v) => (v === null || v === undefined ? '—' : v);
  renderKpiCards('#pickKpi', [
    { label: 'Tổng item', value: k.soDong, unit: 'item', accent: '--series-1' },
    {
      label: 'Item xuất', value: k.soDongThuc, unit: 'item', accent: '--good',
      title: 'Item thực sự ra khỏi kho (không bị cancel / return).',
    },
    {
      label: 'Item cancel', value: k.soCancel, unit: 'item', accent: '--warning',
      title: 'QTY_CANCELED ≠ 0 và PICKSLIP_TEXT kết thúc bằng “cancel” — hàng KHÔNG ra khỏi kho.',
    },
    {
      label: 'Item return', value: k.soReturn, unit: 'item', accent: '--series-4',
      title: 'QTY_CANCELED ≠ 0 và PICKSLIP_TEXT kết thúc bằng “return” — hàng đã ra kho rồi quay về.',
    },
    {
      label: 'Item hủy/trả khác', value: k.soKhac ?? 0, unit: 'item', accent: '--series-5',
      title: 'QTY_CANCELED ≠ 0 nhưng PICKSLIP_TEXT không có từ khóa cancel/return. '
        + 'VẪN được tính là hủy/trả (trước đây bị xếp nhầm vào “Item xuất”).',
    },
    { label: 'Tỷ lệ hủy/trả', value: k.tyLeHuy, unit: '%', accent: '--critical' },
    { label: 'Phiếu có hủy/trả', value: `${k.soPhieuCoHuy}/${k.soPhieu}`, unit: `(${k.tyLePhieuCoHuy}%)`, accent: '--series-3' },
    {
      label: 'Đã scan', value: `${n(k.daScan)}/${n(k.tongPhieuScan)}`, unit: `phiếu (${k.tyLeScan ?? 0}%)`,
      accent: (k.chuaScan === 0 && k.tongPhieuScan > 0) ? '--good' : '--warning',
      title: 'Số PHIẾU XUẤT đã có file PDF trong thư mục scan, tính trên TOÀN KỲ '
        + '(không phụ thuộc bảng chi tiết bên dưới — bảng đó bị cắt ở MAX_ROWS). '
        + 'Phiếu chỉ toàn item cancel KHÔNG tính vào đây (hàng không ra khỏi kho thì không có gì để scan). '
        + 'Yêu cầu nghiệp vụ: phải đạt 100%.',
    },
    {
      label: 'Chưa scan', value: n(k.chuaScan), unit: 'phiếu', accent: k.chuaScan ? '--critical' : '--good',
      title: 'Số PHIẾU XUẤT chưa tìm thấy file PDF. Đếm theo PHIẾU (một phiếu nhiều item '
        + 'chỉ cần một file), tính trên toàn kỳ. Đây là số file thực sự còn phải scan.',
    },
    {
      label: 'TAT return TB', value: n(k.tatReturnAvg), unit: 'ngày', accent: '--series-2',
      title: 'Trung bình số NGÀY từ lúc xuất kho đến lúc hàng về kho — tính trên TOÀN KỲ, '
        + 'chỉ gồm item return đã tra được phiếu trả. '
        + 'Cả hai mốc đều có đủ ngày giờ (xuất kho = PICKSLIP_DATE + BOOKING_TIME; '
        + 'về kho = MUTATION + MUTATION_TIME) nên số ngày là số LẺ chính xác, không làm tròn.',
    },
    {
      label: 'TAT return lâu nhất', value: n(k.tatReturnMax), unit: 'ngày', accent: '--warning',
      title: 'Item return có thời gian nằm ngoài kho lâu nhất trong kỳ.',
    },
    {
      label: 'Phiếu trả chưa scan', value: n(k.returnChuaScan), unit: 'phiếu',
      accent: k.returnChuaScan ? '--critical' : '--good',
      title: 'Số phiếu nhập lại kho (HISTORYNO_I) chưa có file PDF trong thư mục scan. '
        + 'Đếm theo phiếu, toàn kỳ.',
    },
  ]);
}

function renderPickCharts(c) {
  const d = chartDefaults();

  destroyChart('pickDept');
  charts.pickDept = new Chart($('#chartPickDept'), {
    type: 'bar',
    data: {
      labels: c.byDept.labels,
      datasets: [
        { label: 'Phiếu xuất', data: c.byDept.thuc, backgroundColor: cssVar('--good') },
        { label: 'Cancel', data: c.byDept.cancel, backgroundColor: cssVar('--warning') },
        { label: 'Return', data: c.byDept.ret, backgroundColor: cssVar('--series-4') },
        { label: 'Hủy/trả khác', data: c.byDept.khac || [], backgroundColor: cssVar('--series-5'), borderRadius: 4 },
      ],
    },
    options: {
      ...d.common,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ...d.common.scales.x, stacked: true },
        y: { ...d.common.scales.y, stacked: true, grace: '8%' },
      },
      plugins: {
        ...d.common.plugins,
        tooltip: {
          mode: 'index', intersect: false,
          callbacks: {
            footer: (items) => {
              const i = items[0].dataIndex;
              const t = items.reduce((s, it) => s + (Number(it.parsed.y) || 0), 0);
              return `Tổng: ${t} dòng · Tỷ lệ hủy/trả: ${c.byDept.tyLe[i]}%`;
            },
          },
        },
      },
      onClick: chartDrill(c.byDept.labels, 'department'),
    },
    plugins: [segmentValueLabel, stackTotalLabel],
  });

  destroyChart('pickDay');
  charts.pickDay = new Chart($('#chartPickDay'), {
    type: 'bar',
    data: {
      labels: c.byDay.labels,
      datasets: [
        { type: 'bar', label: 'Số item', data: c.byDay.soDong, backgroundColor: cssVar('--series-1'), borderRadius: 3, yAxisID: 'y' },
        {
          type: 'line', label: '% hủy/trả', data: c.byDay.tyLe, yAxisID: 'y1',
          borderColor: cssVar('--warning'), backgroundColor: cssVar('--warning'),
          borderWidth: 2, tension: .25, pointRadius: 2,
        },
      ],
    },
    options: {
      ...d.common,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: d.common.scales.x,
        y: { ...d.common.scales.y, title: { display: true, text: 'Số item', color: cssVar('--text-secondary') } },
        y1: {
          position: 'right', beginAtZero: true, grid: { drawOnChartArea: false },
          ticks: { color: cssVar('--text-secondary'), callback: (v) => v + '%' },
          title: { display: true, text: '% hủy', color: cssVar('--text-secondary') },
        },
      },
    },
  });

  destroyChart('pickPart');
  charts.pickPart = new Chart($('#chartPickPart'), {
    type: 'bar',
    data: {
      labels: c.topPart.labels,
      datasets: [{ label: 'Số item bị hủy/trả', data: c.topPart.values, backgroundColor: cssVar('--warning'), borderRadius: 4 }],
    },
    options: {
      ...d.common,
      indexAxis: 'y',
      plugins: { ...d.common.plugins, legend: { display: false } },
      scales: { x: { ...d.common.scales.y, beginAtZero: true }, y: d.common.scales.x },
    },
  });

  // Phan bo TAT return: cang lech ve phai = thiet bi nam ngoai kho cang lau
  destroyChart('pickTat');
  const tat = c.tatReturn || { labels: [], values: [] };
  const tatTong = tat.values.reduce((a, b) => a + b, 0);
  charts.pickTat = new Chart($('#chartPickTat'), {
    type: 'bar',
    data: {
      labels: tat.labels,
      datasets: [{
        label: 'Số item return',
        data: tat.values,
        backgroundColor: tat.labels.map((_, i) => cssVar(i >= 4 ? '--critical' : (i >= 2 ? '--warning' : '--good'))),
        borderRadius: 4,
      }],
    },
    options: {
      ...d.common,
      plugins: {
        ...d.common.plugins,
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (it) => {
              const v = Number(it.parsed.y) || 0;
              const p = tatTong ? Math.round((v / tatTong) * 1000) / 10 : 0;
              return `${v} dòng (${p}%)`;
            },
          },
        },
      },
      scales: { x: d.common.scales.x, y: { ...d.common.scales.y, beginAtZero: true, grace: '10%' } },
    },
    plugins: [stackTotalLabel],
  });

  // TAT return theo Trung tam - don vi NGAY (tinh tu ngay-gio that o ca hai dau)
  destroyChart('pickTatTt');
  const tt = c.tatTheoTt || { labels: [], ngayTb: [], ngayMax: [], soItem: [] };
  charts.pickTatTt = new Chart($('#chartPickTatTt'), {
    type: 'bar',
    data: {
      labels: tt.labels,
      datasets: [
        { label: 'TAT trung bình (ngày)', data: tt.ngayTb, backgroundColor: cssVar('--series-1'), borderRadius: 4 },
        { label: 'Lâu nhất (ngày)', data: tt.ngayMax, backgroundColor: cssVar('--warning'), borderRadius: 4 },
      ],
    },
    options: {
      ...d.common,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        ...d.common.plugins,
        tooltip: {
          mode: 'index', intersect: false,
          callbacks: {
            label: (it) => {
              const ngay = Number(it.parsed.y) || 0;
              const gio = Math.round(ngay * 24 * 10) / 10;
              return `${it.dataset.label}: ${ngay} ngày (~${gio} giờ)`;
            },
            footer: (items) => `Số item return: ${tt.soItem[items[0].dataIndex] ?? 0}`,
          },
        },
      },
      scales: {
        x: d.common.scales.x,
        y: {
          ...d.common.scales.y, beginAtZero: true, grace: '8%',
          title: { display: true, text: 'Ngày', color: cssVar('--text-secondary') },
        },
      },
      onClick: chartDrill(tt.labels, 'department'),
    },
  });
}

/**
 * Bu cac truong `*_shown` / `*_exact` NGAY TAI TRINH DUYET neu server chua tra ve.
 *
 * VI SAO: hai cot gop ("Gio xuat kho", "Gio tra kho") doc `issue_shown` /
 * `return_shown` do SERVER tinh. Neu chi cap nhat public/ ma QUEN cap nhat +
 * khoi dong lai server.js thi cac truong do khong ton tai va cot TRONG TRON -
 * loi im lang, khong bao gi ca. Da xay ra that voi cot "Gio xuat kho".
 *
 * Frontend co san cac truong goc (`issue_time_vn` + `pickslip_date`,
 * `return_time_vn` + `return_date`) ma server cu VAN tra du, nen tu tinh lay
 * duoc. Nho vay trang chay dung voi CA server cu lan moi, va thu tu cap nhat
 * file khong con quan trong.
 */
function buSoLieuNgayGio(rows) {
  (rows || []).forEach((r) => {
    if (r.issue_shown == null) {
      r.issue_shown = r.issue_time_vn || r.pickslip_date || null;
      r.issue_exact = r.issue_time_vn ? 1 : 0;
    }
    if (r.return_shown == null) {
      r.return_shown = r.return_time_vn || r.return_date || null;
      r.return_exact = r.return_time_vn ? 1 : 0;
    }
    if (r.huytra_shown == null) {
      const laTra = r.loai === 'RETURN';
      r.huytra_shown = laTra ? r.return_shown : (r.cancel_time_vn || null);
      r.huytra_kieu = r.huytra_shown ? (laTra ? 'RETURN' : 'CANCEL') : '';
      r.huytra_exact = laTra ? r.return_exact : 0;
    }
  });
}

async function loadPickslip() {
  const seq = ++pickLoadSeq;
  showError('');
  showLoading(true);
  // delay 0: hien lop phu NGAY de nhat ky co cho ma ve (truy van nay von lau)
  setBusy('#pickPane', true, 'Đang lấy dữ liệu xuất kho…', 0);
  setTabLoading('.mainTab', 'pickslip', true);
  const tt = moTienTrinh('#pickPane');
  try {
    const data = await api('/api/pickslip', tt.job);
    if (seq !== pickLoadSeq) return;
    buSoLieuNgayGio(data.rows);
    $('#rangeLabel').textContent = `${data.range.label}: ${fmtDateTime(data.range.from)} → ${fmtRangeEnd(data.range.to)}`;
    renderPickKpis(data.kpis);
    renderPickCharts(data.charts);
    veKpiNhanVien('#pickKpiNv', data.kpiThuKho, 'pickslip');
    renderScanBar('#pickScanBar', data.scanFolder);
    $('#pickDesc').textContent =
      'PICKSLIP_BOOKED × PICKSLIP_HEADER. Kỳ theo PICKSLIP_DATE (ngày AMOS); đơn vị đếm là ITEM. '
      + 'Phiếu xuất / Cancel / Return phân biệt bằng ĐUÔI của PICKSLIP_TEXT (…cancel · …cancel booking · …return) kèm QTY_CANCELED ≠ 0. '
      + 'Đã áp bộ lọc nghiệp vụ: QTY_BOOKED ≠ 0, STATUS ∉ {1, 11}, LOCATION_FROM không chứa “U/S”. '
      + 'Ngày giờ xuất kho = PICKSLIP_DATE + BOOKING_TIME; ngày giờ về kho = HISTORY.MUTATION + MUTATION_TIME — '
      + 'cả hai đều đủ ngày giờ nên TAT return là số NGÀY chính xác (số lẻ), không làm tròn ngày. '
      + 'Item CANCEL không cần file scan (hàng không ra khỏi kho). '
      + '⚠ Thẻ KPI “Đã scan / Chưa scan” đếm theo PHIẾU (một phiếu xuất nhiều item chỉ cần một file) và tính trên TOÀN KỲ; '
      + 'bảng chi tiết bên dưới đếm theo ITEM và bị cắt ở MAX_ROWS, nên hai con số không nhất thiết bằng nhau.';
    pickTotalRows = data.count;
    $('#pickCount').textContent =
      `${data.count.toLocaleString('vi')} item` + (data.truncated ? ' ⚠ chạm giới hạn MAX_ROWS' : '');
    if (!pickTable) {
      pickTable = new Tabulator('#pickTable', {
        data: data.rows,
        columns: withHeaderFilters(COLS_PICKSLIP),
        layout: 'fitDataFill',
        pagination: false,
        placeholder: 'Không có dữ liệu',   // duoc thay bang chuBangRong() sau moi lan tai
        height: '600px',
      });
      pickTable.on('dataFiltered', (filters, rowsFiltered) => {
        const n = rowsFiltered.length;
        $('#pickCount').textContent = n === pickTotalRows
          ? `${pickTotalRows.toLocaleString('vi')} item`
          : `${n.toLocaleString('vi')}/${pickTotalRows.toLocaleString('vi')} item`;
      });
    } else {
      pickTable.replaceData(data.rows);
      pickTable.redraw(true);
    }
    pickTable.setFilter(pickCancelFilter);
  } catch (err) {
    showError(err.message, loadPickslip);
  } finally {
    tt.dong();
    showLoading(false);
    setTimeout(veChuBangRong, 0);   // the placeholder chi co sau khi Tabulator ve xong
    if (seq === pickLoadSeq) {
      setBusy('#pickPane', false);
      setTabLoading('.mainTab', 'pickslip', false);
    }
  }
}

function initPickslip() {
  // Tabulator khong ghep duoc nhieu ham loc -> gop TAT CA dieu kien vao mot ham
  ['#pickOnlyCancel', '#pickOnlyNoScan'].forEach((sel) => {
    $(sel).addEventListener('change', () => {
      if (pickTable) pickTable.setFilter(pickCancelFilter);
    });
  });
  $('#pickSearch').addEventListener('input', () => {
    if (pickTable) pickTable.setFilter(pickCancelFilter);
  });
  $('#pickExport').addEventListener('click', () => {
    if (pickTable) pickTable.download('xlsx', `XuatKho_${Date.now()}.xlsx`, { sheetName: 'XuatKho' });
  });
}

// --------------------------------------------------------------------------
// 11d. Tab RECEIVING (nhap kho) - HISTORY VM='B1', da loai phieu huy nhap (CR)
//      Doi chieu file scan PDF theo VOUCHERNO (bo tien to "R-").
// --------------------------------------------------------------------------
let recvTable = null;
let recvTotalRows = 0;
let recvLoadSeq = 0;

const COLS_RECEIVING = [
  {
    title: 'Scan', field: 'scan', hozAlign: 'center', width: 105, ...SCAN_HEADER_FILTER,
    headerTooltip: 'Có file PDF trùng VOUCHERNO trong thư mục scan hay chưa. Chấp nhận CẢ HAI cách đặt tên: '
      + 'giữ nguyên “R-259454.pdf” (SGN) hoặc bỏ tiền tố “259454.pdf” (HAN). “—” = không đọc được thư mục. '
      + 'Ô “Đã scan” BẤM ĐƯỢC để mở chính file PDF trên máy chủ.',
    formatter: fmtScanCell,
    formatterParams: { loai: 'receiving', khoa: 'voucherno' },
  },
  {
    title: 'Ngày giờ', field: 'receive_time_vn', 
    headerFilter: 'input', headerFilterFunc: dateFilterFunc,
    headerTooltip: 'HISTORY.MUTATION (ngày AMOS) + HISTORY.MUTATION_TIME (số ms từ 0h) → giờ VN (+7). '
      + 'DEL_DATE chỉ có NGÀY nên vẫn dùng làm mốc kỳ báo cáo, còn cột này là mốc thật để đối chiếu.',
    formatter: (cell) => escapeHtml(fmtDateTime(cell.getValue())),
  },
  { title: 'Receiving No', field: 'voucherno', headerFilter: 'input'},
  { title: 'Part No', field: 'partno', headerFilter: 'input' },
  { title: 'Serial / Batch', field: 'serialno', headerFilter: 'input' },
  { title: 'Qty', field: 'qty', hozAlign: 'right', sorter: 'number' },
  { title: 'Cond', field: 'tinh_trang', headerFilter: 'input'},
  { title: 'Station', field: 'station', headerFilter: 'input', width: 80 },
  { title: 'Store', field: 'store', headerFilter: 'input', width: 80 },
  { title: 'Location', field: 'location', headerFilter: 'input' },
//  { title: 'PSN', field: 'psn', headerFilter: 'input' },
  { title: 'Label', field: 'labelno', headerFilter: 'input' },
  { title: 'MC', field: 'mat_class', headerFilter: 'input' },
  { title: 'Order No', field: 'orderno', headerFilter: 'input' },
  { title: 'Order date', field: 'orderdate', formatter: fmtDateCell },
  { title: 'Owner', field: 'owner', headerFilter: 'input' },
  { title: 'Inspector', field: 'created_by', headerFilter: 'input' },
  //{ title: 'History No', field: 'historyno', formatter: fmtIntCell, hozAlign: 'right' },
  { title: 'Rec detail', field: 'recdetailno', formatter: fmtIntCell, hozAlign: 'right' },
];

/** O tich "Chi phieu chua scan" + o tim kiem, gop vao MOT ham loc. */
function recvFilter(row) {
  if ($('#recvOnlyNoScan').checked && row.scan !== 'CHUA_SCAN') return false;
  const q = ($('#recvSearch').value || '').trim().toLowerCase();
  if (!q) return true;
  return Object.values(row).some((v) => String(v ?? '').toLowerCase().includes(q));
}

function renderRecvKpis(k) {
  renderKpiCards('#recvKpi', [
    { label: 'Item receive', value: k.soDong, unit: 'item', accent: '--series-1' },
    { label: 'Số phiếu receive', value: k.soPhieu, unit: 'phiếu', accent: '--series-3' },
    {
      label: 'Đã scan', value: `${k.daScan}/${k.tongPhieuScan}`, unit: `phiếu (${k.tyLeScan ?? 0}%)`,
      accent: (k.chuaScan === 0 && k.tongPhieuScan > 0) ? '--good' : '--warning',
      title: 'Số VOUCHER đã có file PDF trong thư mục scan, tính trên TOÀN KỲ '
        + '(không phụ thuộc bảng chi tiết bên dưới — bảng đó bị cắt ở MAX_ROWS). '
        + 'Yêu cầu nghiệp vụ: phải đạt 100%.',
    },
    {
      label: 'Chưa scan', value: k.chuaScan, unit: 'phiếu', accent: k.chuaScan ? '--critical' : '--good',
      title: 'Số VOUCHER chưa tìm thấy file PDF. Đếm theo PHIẾU (một voucher nhiều item '
        + 'chỉ cần một file), tính trên toàn kỳ. Đây là số file thực sự còn phải scan.',
    },
    {
      label: 'Item bị hủy receive', value: k.b1BiHuy, unit: 'item', accent: '--warning',
      title: 'Item B1 có RECDETAILNO_I trùng với một dòng CR → đã bị hủy nhập, KHÔNG tính vào báo cáo.',
    },
    {
      label: 'B1 thô trong kỳ', value: k.b1Tho, unit: 'item', accent: '--text-muted',
      title: 'Số item VM = B1 lấy về trước khi lọc (station / condition / store / location).',
    },
  ]);
}

function renderRecvCharts(c) {
  const d = chartDefaults();

  // Phieu NHAP kho thong ke theo STATION va STORE (khong theo Trung tam)
  const veScan = (ten, canvas, nguon, khoaLoc) => {
    destroyChart(ten);
    charts[ten] = new Chart($(canvas), {
      type: 'bar',
      data: {
        labels: nguon.labels,
        datasets: [
          { label: 'Đã scan', data: nguon.daScan, backgroundColor: cssVar('--good') },
          { label: 'Chưa scan', data: nguon.chuaScan, backgroundColor: cssVar('--critical'), borderRadius: 4 },
        ],
      },
      options: {
        ...d.common,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ...d.common.scales.x, stacked: true },
          y: { ...d.common.scales.y, stacked: true, grace: '8%' },
        },
        onClick: khoaLoc ? chartDrill(nguon.labels, khoaLoc) : undefined,
      },
      plugins: [segmentValueLabel, stackTotalLabel],
    });
  };
  veScan('recvStation', '#chartRecvStation', c.byStation, 'station');
  veScan('recvStore', '#chartRecvStore', c.byStore, 'store');

  destroyChart('recvDay');
  charts.recvDay = new Chart($('#chartRecvDay'), {
    type: 'bar',
    data: {
      labels: c.byDay.labels,
      datasets: [{ label: 'Số item receive', data: c.byDay.values, backgroundColor: cssVar('--series-2'), borderRadius: 3 }],
    },
    options: {
      ...d.common,
      plugins: { ...d.common.plugins, legend: { display: false } },
      scales: { x: d.common.scales.x, y: { ...d.common.scales.y, beginAtZero: true } },
    },
  });
}

async function loadReceiving() {
  const seq = ++recvLoadSeq;
  showError('');
  showLoading(true);
  setBusy('#recvPane', true, 'Đang lấy dữ liệu nhập kho…', 0);
  setTabLoading('.mainTab', 'receiving', true);
  const tt = moTienTrinh('#recvPane');
  try {
    const data = await api('/api/receiving', tt.job);
    if (seq !== recvLoadSeq) return;
    $('#rangeLabel').textContent = `${data.range.label}: ${fmtDateTime(data.range.from)} → ${fmtRangeEnd(data.range.to)}`;
    renderRecvKpis(data.kpis);
    renderRecvCharts(data.charts);
    veKpiNhanVien('#recvKpiNv', data.kpiInspector, 'receiving');
    renderScanBar('#recvScanBar', data.scanFolder);
    $('#recvDesc').textContent =
      'HISTORY với VM = B1 (phiếu receive), kỳ theo DEL_DATE (ngày AMOS); đơn vị đếm là ITEM. '
      + 'Đã LOẠI các item B1 có RECDETAILNO_I trùng với dòng VM = CR (phiếu receive đã bị hủy). '
      + 'Bộ lọc: STATION chứa station đang chọn, CONDITION không chứa “us”. '
      + 'Thống kê theo STATION và STORE (receive không quy về Trung tâm). '
      + 'Ngày giờ receive = MUTATION + MUTATION_TIME → giờ VN (+7); DEL_DATE chỉ có ngày nên chỉ dùng làm mốc kỳ. '
      + 'Cột Scan đối chiếu file PDF trùng VOUCHERNO — chấp nhận cả “R-259454.pdf” (SGN) lẫn “259454.pdf” (HAN). '
      + '⚠ Thẻ KPI và biểu đồ “Đã scan / Chưa scan” đếm theo PHIẾU (voucher) và tính trên TOÀN KỲ; '
      + 'bảng chi tiết bên dưới đếm theo ITEM và bị cắt ở MAX_ROWS.';
    recvTotalRows = data.count;
    $('#recvCount').textContent =
      `${data.count.toLocaleString('vi')} item` + (data.truncated ? ' ⚠ chạm giới hạn MAX_ROWS' : '');
    if (!recvTable) {
      recvTable = new Tabulator('#recvTable', {
        data: data.rows,
        columns: withHeaderFilters(COLS_RECEIVING),
        layout: 'fitDataFill',
        pagination: false,
        placeholder: 'Không có dữ liệu',   // duoc thay bang chuBangRong() sau moi lan tai
        height: '600px',
      });
      recvTable.on('dataFiltered', (filters, rowsFiltered) => {
        const n = rowsFiltered.length;
        $('#recvCount').textContent = n === recvTotalRows
          ? `${recvTotalRows.toLocaleString('vi')} item`
          : `${n.toLocaleString('vi')}/${recvTotalRows.toLocaleString('vi')} item`;
      });
    } else {
      recvTable.replaceData(data.rows);
      recvTable.redraw(true);
    }
    recvTable.setFilter(recvFilter);
  } catch (err) {
    showError(err.message, loadReceiving);
  } finally {
    tt.dong();
    showLoading(false);
    setTimeout(veChuBangRong, 0);   // the placeholder chi co sau khi Tabulator ve xong
    if (seq === recvLoadSeq) {
      setBusy('#recvPane', false);
      setTabLoading('.mainTab', 'receiving', false);
    }
  }
}

function initReceiving() {
  $('#recvOnlyNoScan').addEventListener('change', () => {
    if (recvTable) recvTable.setFilter(recvFilter);
  });
  $('#recvSearch').addEventListener('input', () => {
    if (recvTable) recvTable.setFilter(recvFilter);
  });
  $('#recvExport').addEventListener('click', () => {
    if (recvTable) recvTable.download('xlsx', `Receiving_${Date.now()}.xlsx`, { sheetName: 'Receiving' });
  });
}

// --------------------------------------------------------------------------
// 11b. Tab Tra cuu Part On/Off (WO_PART_ON_OFF) - tra theo tu khoa chinh xac
// --------------------------------------------------------------------------
let partTable = null;       // Tabulator cua tab tra cuu
let partTotalRows = 0;      // tong so dong ket qua (cho bo dem X/Y)

/** 6 o tim rieng: id o nhap -> ten tham so API. */
const PART_FIELDS = {
  poEvent: 'event', poPartno: 'partno', poSerialno: 'serialno',
  poLabelno: 'labelno', poPartnoOff: 'partnoOff', poSerialnoOff: 'serialnoOff',
};

async function loadPartLookup() {
  const qs = new URLSearchParams();
  for (const [id, param] of Object.entries(PART_FIELDS)) {
    // AMOS chi luu CHU HOA -> upper truoc khi gui (go thuong van khop)
    const v = $('#' + id).value.trim().toUpperCase();
    if (v) qs.set(param, v);
  }
  if (![...qs.keys()].length) { $('#partCount').textContent = 'Điền ít nhất 1 ô để tra cứu'; return; }
  showError('');
  showLoading(true);
  setBusy('#partTable', true, 'Đang tra cứu…');
  if (partTable) partTable.replaceData([]);   // don ket qua lan tra truoc
  try {
    const res = await fetch(`/api/part-onoff?${qs.toString()}`);
    const data = await res.json();
    if (data.error) throw new Error(data.message || 'Lỗi tra cứu');
    partTotalRows = data.count;
    $('#partCount').textContent =
      `${data.count.toLocaleString('vi')} dòng` +
      (data.truncated ? ' ⚠ chạm giới hạn MAX_ROWS' : '');
    if (!partTable) {
      partTable = new Tabulator('#partTable', {
        data: data.rows,
        columns: withHeaderFilters(COLS_PART_ONOFF),
        layout: 'fitDataFill',
        pagination: false,     // hien HET cac dong (cuon doc, render ao)
        placeholder: 'Không có dữ liệu — kiểm tra giá trị nhập (khớp chính xác)',
        height: '600px',
      });
      partTable.on('dataFiltered', (filters, rowsFiltered) => {
        const n = rowsFiltered.length;
        $('#partCount').textContent =
          n === partTotalRows
            ? `${partTotalRows.toLocaleString('vi')} dòng`
            : `${n.toLocaleString('vi')}/${partTotalRows.toLocaleString('vi')} dòng`;
      });
    } else {
      partTable.clearFilter(true);
      $('#partFilter').value = '';
      partTable.replaceData(data.rows);
      partTable.redraw(true);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    showLoading(false);
    setBusy('#partTable', false);
  }
}

function initPartLookup() {
  $('#partSearchBtn').addEventListener('click', loadPartLookup);
  // Enter o bat ky o tim nao -> tra cuu luon; hien CHU HOA ngay khi go (chuan AMOS)
  for (const id of Object.keys(PART_FIELDS)) {
    const el = $('#' + id);
    el.style.textTransform = 'uppercase';
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadPartLookup(); });
  }
  $('#partClearBtn').addEventListener('click', () => {
    for (const id of Object.keys(PART_FIELDS)) $('#' + id).value = '';
    $('#poEvent').focus();
  });
  $('#partFilter').addEventListener('input', (e) => {
    if (partTable) partTable.setFilter(matchAny, { value: e.target.value });
  });
  $('#partExport').addEventListener('click', () => {
    if (partTable) partTable.download('xlsx', `PartOnOff_${Date.now()}.xlsx`, { sheetName: 'PartOnOff' });
  });
}

// --------------------------------------------------------------------------
// 12. Gan su kien & khoi tao
// --------------------------------------------------------------------------
async function init() {
  // Mac dinh: thang/quy/nam hien tai
  const now = new Date();
  state.month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  state.quarter = `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
  state.year = String(now.getFullYear());

  // Nap options QUY (4 nam gan nhat x Q1-4, moi nhat truoc) va NAM (6 nam)
  const qSel = $('#quarterInput');
  for (let y = now.getFullYear(); y >= now.getFullYear() - 3; y--) {
    for (let q = 4; q >= 1; q--) {
      const o = document.createElement('option');
      o.value = `${y}-Q${q}`;
      o.textContent = `Quý ${q}/${y}`;
      qSel.appendChild(o);
    }
  }
  const ySel = $('#yearInput');
  for (let y = now.getFullYear(); y >= now.getFullYear() - 5; y--) {
    const o = document.createElement('option');
    o.value = String(y);
    o.textContent = String(y);
    ySel.appendChild(o);
  }

  // Khoi phuc cau hinh filter da luu (neu co)
  const saved = loadSavedFilters();
  if (saved) {
    if (saved.periodType) state.periodType = saved.periodType;
    if (saved.month) state.month = saved.month;
    if (saved.week) state.week = saved.week;
    if (saved.quarter) state.quarter = saved.quarter;
    if (saved.year) state.year = saved.year;
    state.station = normList(saved.station);
    state.store = normList(saved.store);
    state.department = normList(saved.department);
    state.excludeCC = !!saved.excludeCC;
    state.excludeCab = !!saved.excludeCab;
    if (LGC_TABS.includes(saved.lgcTab)) state.lgcTab = saved.lgcTab;
  }
  // URL co tham so (link duoc chia se) -> UU TIEN hon cau hinh da luu
  const urlQ = new URLSearchParams(location.search);
  if ([...urlQ.keys()].length) {
    if (urlQ.get('periodType')) state.periodType = urlQ.get('periodType');
    if (urlQ.get('month')) state.month = urlQ.get('month');
    if (urlQ.get('week')) state.week = urlQ.get('week');
    if (urlQ.get('quarter')) state.quarter = urlQ.get('quarter');
    if (urlQ.get('year')) state.year = urlQ.get('year');
    if (urlQ.has('station')) state.station = normList(urlQ.get('station'));
    if (urlQ.has('store')) state.store = normList(urlQ.get('store'));
    if (urlQ.has('department')) state.department = normList(urlQ.get('department'));
    state.excludeCC = urlQ.get('excludeCC') === '1';
    state.excludeCab = urlQ.get('excludeCab') === '1';
  }
  // TRANG LGC: vao la LAY HET Station / Store / Trung tam.
  // Trang LGC dung CHUNG localStorage voi dashboard, nen bo loc chon ben
  // dashboard (vd station=HAN) van con khi sang LGC - nhan vien kho mo len
  // thay so lieu thieu ma khong hieu vi sao. Nay mo /lgc la ba o ve "Tat ca".
  // NGOAI TRU khi link co san tham so loc: do la y muon ro rang cua nguoi gui.
  if (LGC_ONLY && !['station', 'store', 'department'].some((k) => urlQ.has(k))) {
    state.station = [];
    state.store = [];
    state.department = [];
  }
  $('#ccToggle').checked = state.excludeCC;
  $('#cabToggle').checked = state.excludeCab;
  $('#monthInput').value = state.month;
  $('#weekInput').value = state.week || now.toISOString().slice(0, 10);
  if ([...qSel.options].some((o) => o.value === state.quarter)) qSel.value = state.quarter;
  if ([...ySel.options].some((o) => o.value === state.year)) ySel.value = state.year;

  // Period buttons: doi ky bao cao -> tu dong tai lai
  // Hien o nhap cua ky dang chon - nhung van an het neu man hinh dang xem
  // khong dung ky bao cao (vd Repair Admin, Tra cuu Part On/Off).
  const showPeriodInputs = () => applyFilterVisibility(currentFilterView());
  $$('.periodBtn').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.periodType = btn.dataset.period;
      $$('.periodBtn').forEach((b) => b.classList.toggle('active', b === btn));
      showPeriodInputs();
      applyFilters(); // khai bao ben duoi; chi chay khi nguoi dung click (sau init)
    })
  );
  const activePeriodBtn = document.querySelector(`.periodBtn[data-period="${state.periodType}"]`);
  (activePeriodBtn || document.querySelector('.periodBtn[data-period="month"]')).classList.add('active');
  if (!activePeriodBtn) state.periodType = 'month'; // gia tri luu cu khong hop le
  showPeriodInputs();

  // TU DONG tai du lieu moi khi doi filter (khong con nut "Ap dung"):
  // luu cau hinh + xoa cache bao cao + tai lai tab dang mo.
  // KHONG cap nhat bang bao cao khi tab dang an (Tabulator se ve rong);
  // khi mo lai tab, switchTab() se tu load voi filter moi.
  const applyFilters = () => {
    saveFilters();
    if (typeof window.__renderPresets === 'function') window.__renderPresets();
    renderChipBar(currentFilterView());
    // Dua filter len URL -> copy link gui dong nghiep la ho thay dung man hinh nay
    history.replaceState(null, '', `${location.pathname}?${buildQuery()}`);
    reportCache.clear();
    if (!LGC_ONLY) loadDashboard();
    if (!$('#tab-reports').classList.contains('hidden')) loadReport(state.currentReport);
    resetLgc(); // LGC khong tu chay lai - nguoi dung bam "Chay kiem tra"
    resetSoSanhThang(); // so sanh thang cung vay: doi bo loc thi so cu sai
  };
  window.__applyFilters = applyFilters; // cho drill-down tu bieu do (chartDrill)

  // Inputs: doi xong la load ngay
  $('#monthInput').addEventListener('change', (e) => { state.month = e.target.value; applyFilters(); });
  $('#weekInput').addEventListener('change', (e) => { state.week = e.target.value; applyFilters(); });
  $('#quarterInput').addEventListener('change', (e) => { state.quarter = e.target.value; applyFilters(); });
  $('#yearInput').addEventListener('change', (e) => { state.year = e.target.value; applyFilters(); });
  // Nut "Tai lai": bo qua bo nho dem cua may chu, hoi lai SQL Server MOT luot
  $('#dataReload').addEventListener('click', () => {
    boQuaCacheLanToi = true;
    try { applyFilters(); } finally { setTimeout(() => { boQuaCacheLanToi = false; }, 3000); }
  });

  initMultiSelects(applyFilters);   // Station + Store + Trung tam (chon nhieu)
  initPresets(applyFilters);        // Bo loc da luu
  initChipBar(applyFilters);        // Hang dieu kien dang loc
  $('#trendRun').addEventListener('click', chaySoSanhThang);
  $('#trendMonths').addEventListener('change', resetSoSanhThang);
  // Checkbox "Bo qua xuat costcenter": loai receiver la so roi tinh lai KPI/bieu do tu server
  $('#ccToggle').addEventListener('change', (e) => { state.excludeCC = e.target.checked; applyFilters(); });
  // Checkbox "Bo qua cac kho CAB": loai han cac kho CAB/CAB-TD/P-THA/P-SAF/P-PAN
  $('#cabToggle').addEventListener('change', (e) => {
    state.excludeCab = e.target.checked;
    renderMultiSelects(); // ve lai de nhan "dang bo qua" trong menu kho cho dung
    applyFilters();
  });

  // Tim kiem bang chinh
  $('#mainSearch').addEventListener('input', (e) => {
    if (mainTable) mainTable.setFilter(matchAny, { value: e.target.value });
  });
  $('#reportSearch').addEventListener('input', (e) => {
    if (reportTables.report) reportTables.report.setFilter(matchAny, { value: e.target.value });
  });
  $('#lgcRepairSearch').addEventListener('input', (e) => {
    if (reportTables.lgcRepair) reportTables.lgcRepair.setFilter(matchAny, { value: e.target.value });
  });

  // Tinh lai TAT (bo item da chon)
  $('#recalcBtn').addEventListener('click', recalcTat);
  $('#resetCalcBtn').addEventListener('click', resetRecalc);

  // Export Excel
  $('#mainExport').addEventListener('click', () => {
    if (mainTable) mainTable.download('xlsx', `TAT_TrungTam_${Date.now()}.xlsx`, { sheetName: 'TAT' });
  });
  $('#reportExport').addEventListener('click', () => {
    const t = reportTables.report;
    if (t) t.download('xlsx', `${state.currentReport}_${Date.now()}.xlsx`, { sheetName: 'BaoCao' });
  });
  $('#lgcRepairExport').addEventListener('click', () => {
    const t = reportTables.lgcRepair;
    if (t) t.download('xlsx', `RepairAdmin_${Date.now()}.xlsx`, { sheetName: 'RepairAdmin' });
  });

  // Tab chinh
  $$('.mainTab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $$('.lgcTab').forEach((b) => b.addEventListener('click', () => switchLgcTab(b.dataset.lgc)));
  $('#lgcRun').addEventListener('click', runLgc);
  if (LGC_ONLY) applyLgcOnlyMode();
  switchTab(LGC_ONLY ? 'lgc' : 'dashboard');

  // Report sub-tabs
  $$('.reportTab').forEach((b) => b.addEventListener('click', () => loadReport(b.dataset.report)));

  // Hoi server: may nay co quyen SUA khong (an/hien nut xac nhan doi ung)
  try {
    const who = await fetch('/api/whoami').then((r) => r.json());
    state.isAdmin = !!who.isAdmin;
    state.clientIp = who.ip || '';
  } catch (_) { state.isAdmin = false; }

  // Khoi tao
  initTheme();
  initChat();
  initPartLookup();
  initPickslip();
  initReceiving();
  checkHealth();
  await loadFilters(); // nap danh muc roi ve lai nut theo gia tri da khoi phuc
  if (!LGC_ONLY) loadDashboard();
}

// --------------------------------------------------------------------------
// 12b. SO SANH CAC THANG (chuyen tu trang beta sang dashboard)
//      Thang DA DONG duoc may chu luu ra JSON nen tai rat nhanh; thang hien
//      tai van tinh lai vi con dang phat sinh. KHONG tu chay khi mo trang -
//      6 thang van la 1 thang phai hoi SQL Server that.
// --------------------------------------------------------------------------
let trendChart = null;

/** Cot cua bang so sanh: [khoa, nhan, so chu so thap phan, don vi]. */
const TREND_COLS = [
  ['tatTotal', 'TAT tổng', 1, 'ngày'],
  ['tatInstall', 'TAT install', 1, 'ngày'],
  ['tatUsReturn', 'TAT US return', 1, 'ngày'],
  ['tatReturnStore', 'TAT hoàn kho', 1, 'ngày'],
  ['issued', 'Thiết bị xuất', 0, ''],
  ['notReconciled', 'Chưa đối ứng', 0, ''],
  ['reconcileRate', 'Tỷ lệ đối ứng', 1, '%'],
];

function veBangThang(series) {
  const so = (v, n) => (v === null || v === undefined || v === '' ? '—' : Number(v).toFixed(n));
  const head = '<thead><tr><th>Chỉ số</th>'
    + series.map((x) => `<th class="${x.tuSnapshot ? 'tu-luu' : ''}"`
      + ` title="${x.tuSnapshot ? 'Lấy từ bản lưu JSON trên máy chủ' : 'Vừa hỏi SQL Server'}">`
      + `${escapeHtml(x.month)}</th>`).join('')
    + '</tr></thead>';
  const body = '<tbody>' + TREND_COLS.map(([k, nhan, n, dv]) =>
    `<tr><td>${nhan}${dv ? ` <span class="text-muted">(${dv})</span>` : ''}</td>`
    + series.map((x) => `<td>${so(x[k], n)}</td>`).join('') + '</tr>').join('') + '</tbody>';
  $('#trendTable').innerHTML = head + body;
}

function veBieuDoThang(series) {
  const d = chartDefaults();
  if (trendChart) trendChart.destroy();
  trendChart = new Chart($('#chartTrend'), {
    data: {
      labels: series.map((x) => x.month),
      datasets: [
        { type: 'bar', label: 'Chưa đối ứng', data: series.map((x) => x.notReconciled),
          yAxisID: 'y1', backgroundColor: cssVar('--series-6') + '99', order: 3, borderRadius: 4 },
        { type: 'line', label: 'TAT tổng (3 chặng)', data: series.map((x) => x.tatTotal),
          yAxisID: 'y', borderColor: cssVar('--series-4'), backgroundColor: cssVar('--series-4'),
          borderWidth: 3, tension: .3, order: 0 },
        { type: 'line', label: 'TAT install', data: series.map((x) => x.tatInstall),
          yAxisID: 'y', borderColor: cssVar('--series-1'), backgroundColor: cssVar('--series-1'), tension: .3, order: 1 },
        { type: 'line', label: 'TAT US return', data: series.map((x) => x.tatUsReturn),
          yAxisID: 'y', borderColor: cssVar('--series-8'), backgroundColor: cssVar('--series-8'), tension: .3, order: 2 },
      ],
    },
    options: {
      ...d.common,
      scales: {
        x: d.common.scales.x,
        y: { ...d.common.scales.y, position: 'left', beginAtZero: true,
             title: { display: true, text: 'TAT (ngày)', color: cssVar('--text-muted') } },
        y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false },
              ticks: { color: cssVar('--text-muted') },
              title: { display: true, text: 'SL chưa đối ứng', color: cssVar('--text-muted') } },
      },
    },
  });
}

async function chaySoSanhThang() {
  const nut = $('#trendRun');
  nut.disabled = true;
  nut.textContent = '⏳ Đang chạy…';
  setBusy('#trendCard', true, 'Đang lấy số liệu các tháng…', 0);
  const tt = moTienTrinh('#trendCard');
  showError('');
  try {
    const months = $('#trendMonths').value;
    const data = await api(`/api/trend?months=${encodeURIComponent(months)}`, tt.job);
    const series = data.series || [];
    $('#trendIdle').classList.add('hidden');
    $('#trendBody').classList.remove('hidden');
    veBieuDoThang(series);
    veBangThang(series);
    const luu = series.filter((x) => x.tuSnapshot).length;
    $('#trendDesc').textContent =
      `${series.length} tháng · ${luu} tháng lấy từ bản lưu 💾 trên máy chủ, `
      + `${series.length - luu} tháng vừa hỏi SQL Server. `
      + 'Tháng đã đóng không đổi số nữa nên được lưu lại; tháng hiện tại luôn tính lại.';
  } catch (err) {
    showError(err.message, chaySoSanhThang);
  } finally {
    tt.dong();
    setBusy('#trendCard', false);
    nut.disabled = false;
    nut.textContent = '▶ Xem';
  }
}

/** Doi bo loc -> so lieu cu khong con dung nua; quay ve trang thai chua chay. */
function resetSoSanhThang() {
  if (!$('#trendBody')) return;
  $('#trendBody').classList.add('hidden');
  $('#trendIdle').classList.remove('hidden');
  $('#trendDesc').textContent = '';
}

// --------------------------------------------------------------------------
// 13. Chatbox (tro ly noi bo) - goi /api/chat, xu ly cuc bo o server
// --------------------------------------------------------------------------
function chatAppend(text, who) {
  const b = document.createElement('div');
  b.className = `chat-msg ${who}`;
  b.textContent = text;
  $('#chatBody').appendChild(b);
  $('#chatBody').scrollTop = $('#chatBody').scrollHeight;
  return b;
}

/** Gan hang "👍 / 👎 Báo sai" duoi 1 cau tra loi cua bot.
 *  Bam "Báo sai" -> goi /api/chat/flag (nho LLM tra loi lai neu duoc bat). */
function chatAddFeedback(question) {
  const row = document.createElement('div');
  row.className = 'chat-fb';
  const flag = document.createElement('button');
  flag.type = 'button';
  flag.className = 'chat-fb-btn';
  flag.textContent = '👎 Báo sai';
  flag.title = 'Câu trả lời chưa đúng — gửi để cải thiện';
  flag.addEventListener('click', async () => {
    flag.disabled = true;
    row.remove();
    const typing = chatAppend('Đang xem lại…', 'bot typing');
    try {
      const res = await fetch('/api/chat/flag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question }),
      });
      const data = await res.json();
      typing.remove();
      chatAppend(data.reply || 'Đã ghi nhận phản hồi.', 'bot');
    } catch (err) {
      typing.remove();
      chatAppend('Lỗi kết nối: ' + err.message, 'bot');
    }
  });
  row.appendChild(flag);
  $('#chatBody').appendChild(row);
  $('#chatBody').scrollTop = $('#chatBody').scrollHeight;
}

async function chatSend(msg) {
  const text = (msg || '').trim();
  if (!text) return;
  chatAppend(text, 'user');
  $('#chatText').value = '';
  const typing = chatAppend('Đang trả lời…', 'bot typing');
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Gui kem filter hien tai de cau hoi khong ghi ro ky/trung tam se dung dung ngu canh
      body: JSON.stringify({
        message: text,
        periodType: state.periodType, month: state.month, week: state.week,
        quarter: state.quarter, year: state.year,
        station: state.station, store: state.store,
        department: state.department, excludeCC: state.excludeCC,
      }),
    });
    const data = await res.json();
    typing.remove();
    chatAppend(data.reply || 'Xin lỗi, đã có lỗi.', 'bot');
    // Cho phep bao sai voi cac cau tra loi nghiep vu (khong phai tra cuu du lieu cung)
    chatAddFeedback(text);
  } catch (err) {
    typing.remove();
    chatAppend('Lỗi kết nối: ' + err.message, 'bot');
  }
}

function initChat() {
  const panel = $('#chatPanel');
  const open = () => {
    panel.classList.remove('hidden');
    if (!$('#chatBody').children.length) {
      chatAppend(
        'Xin chào! Tôi là trợ lý TAT nội bộ. Hỏi tôi về số liệu, tra cứu thiết bị, định nghĩa nghiệp vụ hoặc cách dùng dashboard.',
        'bot'
      );
    }
    $('#chatText').focus();
  };
  $('#chatToggle').addEventListener('click', () =>
    panel.classList.contains('hidden') ? open() : panel.classList.add('hidden')
  );
  $('#chatClose').addEventListener('click', () => panel.classList.add('hidden'));
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    chatSend($('#chatText').value);
  });
  $$('#chatQuick button').forEach((b) =>
    b.addEventListener('click', () => { open(); chatSend(b.dataset.q); })
  );
}

/** Xac nhan 1 cap doi ung THU CONG (label lech) -> luu o server, bo dong khoi
 *  bang va tai lai dashboard de KPI cap nhat ngay. */
async function confirmManualPair(row) {
  const d = row.getData();
  if (!d.sug_serialno_off) return;
  const msg =
    `Xác nhận đối ứng?\n\n` +
    `Thiết bị XUẤT: ${d.partno || ''} / ${d.serialno || ''} (label ${d.labelno || ''}, phiếu ${d.voucher_issue || ''})\n` +
    `Thiết bị THÁO: ${d.sug_partno_off || ''} / ${d.sug_serialno_off || ''}` +
    (d.sug_ret_labelno ? ` (label trả ${d.sug_ret_labelno})` : ' (chưa thấy bản ghi trả US)') + `\n` +
    `Cách ghép: ${d.match_method || '—'} · Độ tin cậy: ${d.confidence || '—'}\n` +
    (Number(d.sug_duplicate) > 1
      ? `\n⚠ CẢNH BÁO: serial tháo này còn được gợi ý cho ${Number(d.sug_duplicate) - 1} phiếu xuất khác.\n` +
        `Chỉ tối đa MỘT cặp là đúng — hãy kiểm tra kỹ.\n`
      : '') +
    `\nSau khi xác nhận, thiết bị này hết nằm trong "Chưa đối ứng" và được tính vào KPI.`;
  if (!confirm(msg)) return;
  try {
    const res = await fetch('/api/admin/manual-pair/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        issueLabel: d.labelno, issueVoucher: d.voucher_issue,
        issuePartno: d.partno, issueSerialno: d.serialno,
        issueTimeVn: d.issue_time_vn,
        department: d.department, station: d.station, store: d.store,
        offPartno: d.sug_partno_off, offSerialno: d.sug_serialno_off,
        retLabelno: d.sug_ret_labelno, retVoucher: d.sug_ret_voucher,
        retDelTime: d.sug_ret_del_time, tatDays: d.sug_tat_days,
        matchMethod: d.match_method, confidence: d.confidence,
      }),
    });
    const out = await res.json();
    if (res.status === 409) { showError(out.message); return; }  // trung serial tháo
    if (!res.ok || out.error) throw new Error(out.message || `Lỗi ${res.status}`);
    row.delete();                 // bo dong da xu ly khoi bang
    reportCache.clear();          // so lieu bao cao da doi
    loadDashboard();              // KPI "Chua doi ung" / "Ty le doi ung" cap nhat
  } catch (err) {
    showError('Không lưu được cặp đối ứng: ' + err.message +
      ' (chức năng này chỉ dùng được từ máy quản trị)');
  }
}

/** Filter "tim kiem tren moi cot" cho Tabulator. */
function matchAny(data, params) {
  const kw = (params.value || '').toLowerCase();
  if (!kw) return true;
  return Object.values(data).some((v) => String(v ?? '').toLowerCase().includes(kw));
}

document.addEventListener('DOMContentLoaded', init);
