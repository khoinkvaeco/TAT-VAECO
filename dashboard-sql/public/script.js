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

/** Dinh dang so gio TAT. */
function fmtHours(v) {
  const n = Number(v);
  if (!isFinite(n)) return '';
  return n.toFixed(1);
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
  station: '',
  store: '',
  department: '',
  excludeCC: false, // checkbox "Bo qua xuat costcenter" (receiver la so, khong phai so tau)
  currentReport: 'returned-unservice',
};

let mainTable = null;   // Tabulator bang chinh
let reportTable = null; // Tabulator bang bao cao
const charts = {};      // luu instance Chart.js

// Cache du lieu bao cao PHIA TRINH DUYET theo (ten bao cao + filter):
// doi qua lai giua cac tab khong goi lai API/DB. Xoa khi bam "Ap dung".
const reportCache = new Map();

// --- Luu / khoi phuc cau hinh filter (localStorage) de lan sau mo lai dung ngay ---
const FILTER_STORE_KEY = 'tat-filters-v1';
function saveFilters() {
  const { periodType, month, week, quarter, year, station, store, department, excludeCC } = state;
  localStorage.setItem(FILTER_STORE_KEY, JSON.stringify({ periodType, month, week, quarter, year, station, store, department, excludeCC }));
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
  if (state.station) p.set('station', state.station);
  if (state.store) p.set('store', state.store);
  if (state.department) p.set('department', state.department);
  if (state.excludeCC) p.set('excludeCC', '1');
  return p.toString();
}

async function api(path) {
  const url = path.includes('?') ? `${path}&${buildQuery()}` : `${path}?${buildQuery()}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.message || `Loi ${res.status}`);
  }
  return data;
}

function showLoading(on) {
  $('#loading').classList.toggle('hidden', !on);
  $('#loading').classList.toggle('flex', on);
}
function showError(msg) {
  if (!msg) {
    $('#errorBox').classList.add('hidden');
    return;
  }
  $('#errorMsg').textContent = msg;
  $('#errorBox').classList.remove('hidden');
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
    const sel = filterKey === 'station' ? '#stationSelect' : '#deptSelect';
    const next = state[filterKey] === label ? '' : label; // toggle
    state[filterKey] = next;
    const el = $(sel);
    if ([...el.options].some((o) => o.value === next)) el.value = next;
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

  // 4.2 Bieu do tron - phan bo theo station (categorical theo thu tu)
  destroyChart('pie');
  charts.pie = new Chart($('#chartPieStation'), {
    type: 'doughnut',
    data: {
      labels: c.pieStation.labels,
      datasets: [{ data: c.pieStation.values, backgroundColor: colors, borderColor: cssVar('--surface-1'), borderWidth: 2 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { color: cssVar('--text-secondary') } } },
      onClick: chartDrill(c.pieStation.labels, 'station'),
    },
  });

  // 4.3 Bieu do cot nhom - So luong xuat kho & tra unservice theo Trung tam
  //     (2 series -> co legend; mau theo thu tu co dinh series-1/series-2)
  destroyChart('line');
  charts.line = new Chart($('#chartLineDay'), {
    type: 'bar',
    data: {
      labels: c.deptVolume.labels,
      datasets: [
        { label: 'Xuất kho', data: c.deptVolume.issued, backgroundColor: cssVar('--series-1'), borderRadius: 4 },
        { label: 'Trả unservice', data: c.deptVolume.returned, backgroundColor: cssVar('--series-2'), borderRadius: 4 },
      ],
    },
    options: { ...d.common, onClick: chartDrill(c.deptVolume.labels, 'department') },
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
  { title: 'Nhân viên', field: 'staff', headerFilter: 'input' },
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
  // Nguồn đối ứng: US = trả unservice (real_us1); SERVICE = recertify (CI @SHOPLOC)
  {
    title: 'Nguồn trả', field: 'return_type', hozAlign: 'center',
    formatter: (cell) => (cell.getValue() === 'SERVICE' ? 'Trả service' : 'Trả unservice'),
    headerFilter: 'list',
    headerFilterParams: { values: { '': 'Tất cả', US: 'Trả unservice', SERVICE: 'Trả service' } },
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
  { title: 'Status', field: 'status', headerFilter: 'input' },
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
    desc: 'kho_ser1 vm=T (P-…) chưa lắp (on_off vm=YE) và chưa được return. TAT = hiện tại − giờ xuất kho.',
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
      { title: 'Phiếu xuất', field: 'voucher_issue', headerFilter: 'input'  },
      { title: 'Ngày Giờ xuất', field: 'issue_time_vn', formatter: fmtDateCell },
      { title: 'TAT (now)', field: 'tat_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
    ],
  },
  'removed-not-returned': {
    title: 'Thiết bị tháo xuống từ tàu nhưng chưa trả unservice',
    desc: 'on_off vm=YA không có bản ghi real_us1 (liên kết qua historyno_).',
    columns: [
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno', headerFilter: 'input'  },
      { title: 'History No', field: 'historyno' },
      { title: 'Aircraft', field: 'ac_registr', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Store', field: 'store', headerFilter: 'input'  },
      { title: 'Center', field: 'trung_tam', headerFilter: 'input'  },
      { title: 'Staff', field: 'staff', headerFilter: 'input' },
      { title: 'Ngày Giờ tháo', field: 'removed_time_vn', formatter: fmtDateCell },
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
          return '<button class="btn-accent" style="padding:2px 8px;font-size:11px">✔ Xác nhận</button>';
        },
        cellClick: (e, cell) => confirmManualPair(cell.getRow()),
      },
    ],
  },
  'removed-before-installed': {
    title: 'Tháo trước, lắp sau (ngày xuất kho SAU ngày lắp)',
    desc: 'Liên kết theo labelno. Thiết bị THÁO (tháo trước) và thiết bị XUẤT KHO (phiếu xuất làm sau ngày lắp) được hiển thị riêng để dễ đối chiếu.',
    columns: [
      { title: 'Label', field: 'labelno', headerFilter: 'input' },
      { title: 'PN tháo (tháo trước)', field: 'partno_removed', headerFilter: 'input' },
      { title: 'SN tháo', field: 'serialno_removed' , headerFilter: 'input' },
      { title: 'Ngày tháo', field: 'removed_time_vn', formatter: fmtDateCell },
      { title: 'Ngày lắp', field: 'installed_time_vn', formatter: fmtDateCell },
      { title: 'PN xuất (xuất sau)', field: 'partno', headerFilter: 'input' },
      { title: 'SN xuất', field: 'serialno', headerFilter: 'input' },
      { title: 'Ngày xuất kho', field: 'issue_time_vn', formatter: fmtDateCell },
      { title: 'Xuất sau lắp (ngày)', field: 'tat_issue_install_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
      { title: 'Giờ trả US', field: 'return_unservice_time', formatter: fmtDateCell },
      { title: 'TAT tháo→trả US (ngày)', field: 'tat_removal_return_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
      { title: 'Aircraft', field: 'ac_registr', headerFilter: 'input' },
      { title: 'Center', field: 'department', headerFilter: 'input' },
      { title: 'Staff', field: 'staff', headerFilter: 'input' },
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
};

// --------------------------------------------------------------------------
// 6. Tai & render Dashboard
// --------------------------------------------------------------------------
let baseKpiInstall = 0; // TAT install goc (khoi phuc khi Dat lai)
let baseKpiUsret = 0;   // TAT US return goc
let baseKpiCuvt = 0;    // TAT CUVT goc (chang 3 - khong co trong bang chi tiet)
let baseKpiTotal = 0;   // TAT tong goc (3 chang cong lai)
let mainTotalRows = 0;  // tong so dong bang chi tiet (cho bo dem X/Y)
let reportTotalRows = 0; // tong so dong bang bao cao (cho bo dem X/Y)

let dashLoadSeq = 0; // chong race: doi filter nhanh -> chi render response MOI nhat

async function loadDashboard() {
  const seq = ++dashLoadSeq;
  showError('');
  showLoading(true);
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
        placeholder: 'Không có dữ liệu',
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
    showError(err.message);
  } finally {
    showLoading(false);
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
 *  LƯU Ý: loại luôn dòng CUVT khỏi trung bình — giống cách server tính 2 card
 *  KPI (TAT của CUVT đã có card "TAT CUVT" riêng). */
function recalcTat() {
  if (!mainTable) return;
  const all = mainTable.getData();
  const kept = all.filter(
    (r) => !excludedKeys.has(rowKey(r)) && String(r.department || '').trim().toUpperCase() !== 'CUVT'
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
let reportLoadSeq = 0; // chong race: doi bao cao/filter nhanh -> chi render cai moi nhat

async function loadReport(name) {
  const seq = ++reportLoadSeq;
  state.currentReport = name;
  const def = REPORT_DEFS[name];
  $('#reportTitle').textContent = def.title;
  $('#reportDesc').textContent = def.desc;
  $$('.reportTab').forEach((b) => b.classList.toggle('active', b.dataset.report === name));

  showError('');
  showLoading(true);
  try {
    // Dung cache theo (bao cao + filter) de doi tab khong load lai du lieu
    const cacheKey = `${name}?${buildQuery()}`;
    let data = reportCache.get(cacheKey);
    if (!data) {
      data = await api(`/api/reports/${name}`);
      reportCache.set(cacheKey, data);
    }
    if (seq !== reportLoadSeq) return; // da co request moi hon -> bo qua
    reportTotalRows = data.count;
    $('#reportCount').textContent =
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
      if (parts.length) $('#reportDesc').textContent = def.desc + '  ▸ Thống kê kỳ này — ' + parts.join(' · ');
    }
    if (!reportTable) {
      reportTable = new Tabulator('#reportTable', {
        data: data.rows,
        columns: withHeaderFilters(def.columns),
        layout: 'fitDataFill',
        pagination: false,     // hien HET cac dong (cuon doc, render ao)
        placeholder: 'Không có dữ liệu',
        height: '600px',
      });
      // Khi tim kiem/loc cot: hien "X/Y dong"
      reportTable.on('dataFiltered', (filters, rowsFiltered) => {
        const n = rowsFiltered.length;
        $('#reportCount').textContent =
          n === reportTotalRows
            ? `${reportTotalRows.toLocaleString('vi')} dòng`
            : `${n.toLocaleString('vi')}/${reportTotalRows.toLocaleString('vi')} dòng`;
      });
    } else {
      // Xoa filter tim kiem cu (cua bao cao truoc) de khong loc nham het du lieu
      reportTable.clearFilter(true);
      $('#reportSearch').value = '';
      reportTable.setColumns(withHeaderFilters(def.columns));
      reportTable.replaceData(data.rows);
      reportTable.redraw(true); // dam bao ve lai day du sau khi tab vua duoc hien thi
    }
  } catch (err) {
    showError(err.message);
  } finally {
    showLoading(false);
  }
}

// --------------------------------------------------------------------------
// 8. Bo loc (filters) - nap gia tri dropdown
// --------------------------------------------------------------------------
async function loadFilters() {
  try {
    const f = await fetch('/api/filters').then((r) => r.json());
    const fill = (sel, arr, labelFn) => {
      const el = $(sel);
      arr.forEach((v) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = labelFn ? labelFn(v) : v;
        el.appendChild(o);
      });
    };
    // Station: OTHER hien thi "Khac (station con lai)"
    fill('#stationSelect', f.stations || [], (v) => (v === 'OTHER' ? 'Khác (station còn lại)' : v));
    fill('#storeSelect', f.stores || []);
    fill('#deptSelect', f.departments || []);
  } catch (e) {
    // khong chan - loi filter khong lam hong toan bo trang
    console.warn('Khong tai duoc filters:', e.message);
  }
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
function switchTab(tab) {
  $$('.mainTab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#tab-dashboard').classList.toggle('hidden', tab !== 'dashboard');
  $('#tab-reports').classList.toggle('hidden', tab !== 'reports');
  $('#tab-partlookup').classList.toggle('hidden', tab !== 'partlookup');
  if (tab === 'reports') {
    // LUON tai lai khi mo tab (cache lam viec nay re); tranh cap nhat bang khi
    // tab dang an (Tabulator ve rong neu container display:none).
    loadReport(state.currentReport);
  } else if (tab === 'partlookup') {
    if (partTable) partTable.redraw(true); // ve lai sau khi container hien thi
    $('#poPartno').focus();
  } else if (mainTable) {
    mainTable.redraw(true); // ve lai sau khi tab hien thi tro lai
  }
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
    state.station = saved.station || '';
    state.store = saved.store || '';
    state.department = saved.department || '';
    state.excludeCC = !!saved.excludeCC;
  }
  // URL co tham so (link duoc chia se) -> UU TIEN hon cau hinh da luu
  const urlQ = new URLSearchParams(location.search);
  if ([...urlQ.keys()].length) {
    if (urlQ.get('periodType')) state.periodType = urlQ.get('periodType');
    if (urlQ.get('month')) state.month = urlQ.get('month');
    if (urlQ.get('week')) state.week = urlQ.get('week');
    if (urlQ.get('quarter')) state.quarter = urlQ.get('quarter');
    if (urlQ.get('year')) state.year = urlQ.get('year');
    if (urlQ.has('station')) state.station = urlQ.get('station');
    if (urlQ.has('store')) state.store = urlQ.get('store');
    if (urlQ.has('department')) state.department = urlQ.get('department');
    state.excludeCC = urlQ.get('excludeCC') === '1';
  }
  $('#ccToggle').checked = state.excludeCC;
  $('#monthInput').value = state.month;
  $('#weekInput').value = state.week || now.toISOString().slice(0, 10);
  if ([...qSel.options].some((o) => o.value === state.quarter)) qSel.value = state.quarter;
  if ([...ySel.options].some((o) => o.value === state.year)) ySel.value = state.year;

  // Period buttons: doi ky bao cao -> tu dong tai lai
  const showPeriodInputs = () => {
    $('#monthWrap').classList.toggle('hidden', state.periodType !== 'month');
    $('#weekWrap').classList.toggle('hidden', state.periodType !== 'week');
    $('#quarterWrap').classList.toggle('hidden', state.periodType !== 'quarter');
    $('#yearWrap').classList.toggle('hidden', state.periodType !== 'year');
  };
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
    // Dua filter len URL -> copy link gui dong nghiep la ho thay dung man hinh nay
    history.replaceState(null, '', `${location.pathname}?${buildQuery()}`);
    reportCache.clear();
    loadDashboard();
    if (!$('#tab-reports').classList.contains('hidden')) loadReport(state.currentReport);
  };
  window.__applyFilters = applyFilters; // cho drill-down tu bieu do (chartDrill)

  // Inputs: doi xong la load ngay
  $('#monthInput').addEventListener('change', (e) => { state.month = e.target.value; applyFilters(); });
  $('#weekInput').addEventListener('change', (e) => { state.week = e.target.value; applyFilters(); });
  $('#quarterInput').addEventListener('change', (e) => { state.quarter = e.target.value; applyFilters(); });
  $('#yearInput').addEventListener('change', (e) => { state.year = e.target.value; applyFilters(); });
  $('#stationSelect').addEventListener('change', (e) => { state.station = e.target.value; applyFilters(); });
  $('#storeSelect').addEventListener('change', (e) => { state.store = e.target.value; applyFilters(); });
  $('#deptSelect').addEventListener('change', (e) => { state.department = e.target.value; applyFilters(); });
  // Checkbox "Bo qua xuat costcenter": loai receiver la so roi tinh lai KPI/bieu do tu server
  $('#ccToggle').addEventListener('change', (e) => { state.excludeCC = e.target.checked; applyFilters(); });

  // Tim kiem bang chinh
  $('#mainSearch').addEventListener('input', (e) => {
    if (mainTable) mainTable.setFilter(matchAny, { value: e.target.value });
  });
  $('#reportSearch').addEventListener('input', (e) => {
    if (reportTable) reportTable.setFilter(matchAny, { value: e.target.value });
  });

  // Tinh lai TAT (bo item da chon)
  $('#recalcBtn').addEventListener('click', recalcTat);
  $('#resetCalcBtn').addEventListener('click', resetRecalc);

  // Export Excel
  $('#mainExport').addEventListener('click', () => {
    if (mainTable) mainTable.download('xlsx', `TAT_TrungTam_${Date.now()}.xlsx`, { sheetName: 'TAT' });
  });
  $('#reportExport').addEventListener('click', () => {
    if (reportTable) reportTable.download('xlsx', `${state.currentReport}_${Date.now()}.xlsx`, { sheetName: 'BaoCao' });
  });

  // Tab chinh
  $$('.mainTab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  switchTab('dashboard');

  // Report sub-tabs
  $$('.reportTab').forEach((b) => b.addEventListener('click', () => loadReport(b.dataset.report)));

  // Khoi tao
  initTheme();
  initChat();
  initPartLookup();
  checkHealth();
  await loadFilters(); // doi nap xong option roi moi khoi phuc gia tri da luu
  $('#stationSelect').value = state.station;
  $('#storeSelect').value = state.store;
  $('#deptSelect').value = state.department;
  loadDashboard();
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
