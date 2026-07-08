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

/** Dinh dang ngay gio (VN). */
function fmtDateTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return v;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
  station: '',
  store: '',
  department: '',
  currentReport: 'issued-not-installed',
};

let mainTable = null;   // Tabulator bang chinh
let reportTable = null; // Tabulator bang bao cao
const charts = {};      // luu instance Chart.js

// --------------------------------------------------------------------------
// 2. Goi API
// --------------------------------------------------------------------------
/** Ghep query string tu state. */
function buildQuery() {
  const p = new URLSearchParams();
  p.set('periodType', state.periodType);
  if (state.periodType === 'month' && state.month) p.set('month', state.month);
  if (state.periodType === 'week' && state.week) p.set('week', state.week);
  if (state.station) p.set('station', state.station);
  if (state.store) p.set('store', state.store);
  if (state.department) p.set('department', state.department);
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
function renderKPIs(kpis) {
  const cards = [
    { label: 'TAT TB don vi', value: kpis.tatDeptAvg, unit: 'gio', accent: '--series-1' },
    { label: 'TAT CUVT', value: kpis.tatCuvtAvg, unit: 'gio', accent: '--series-2' },
    { label: 'TAT hoan kho', value: kpis.tatReturnStoreAvg, unit: 'gio', accent: '--series-5' },
    { label: 'Thiet bi xuat kho', value: kpis.countIssued, unit: 'thiet bi', accent: '--series-3' },
    { label: 'Chua doi ung', value: kpis.countNotReconciled, unit: 'thiet bi', accent: '--series-6' },
    { label: 'Ty le doi ung', value: kpis.reconcileRate, unit: '%', accent: '--series-4' },
  ];
  $('#kpiGrid').innerHTML = cards
    .map(
      (c) => `
      <div class="kpi" style="--accent:${cssVar(c.accent)}">
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${c.value ?? 0} <span class="kpi-unit">${c.unit}</span></div>
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

function destroyChart(key) {
  if (charts[key]) {
    charts[key].destroy();
    charts[key] = null;
  }
}

function renderCharts(c) {
  const d = chartDefaults();
  const colors = seriesColors();

  // 4.1 Bieu do cot - TAT TB theo don vi (1 series -> mau series-1, khong can legend)
  destroyChart('bar');
  charts.bar = new Chart($('#chartBarDept'), {
    type: 'bar',
    data: {
      labels: c.barDept.labels,
      datasets: [{ label: 'TAT (gio)', data: c.barDept.values, backgroundColor: cssVar('--series-1'), borderRadius: 4 }],
    },
    options: { ...d.common, plugins: { ...d.common.plugins, legend: { display: false } } },
  });

  // 4.2 Bieu do tron - phan bo theo station (categorical theo thu tu)
  destroyChart('pie');
  charts.pie = new Chart($('#chartPieStation'), {
    type: 'doughnut',
    data: {
      labels: c.pieStation.labels,
      datasets: [{ data: c.pieStation.values, backgroundColor: colors, borderColor: cssVar('--surface-1'), borderWidth: 2 }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: cssVar('--text-secondary') } } } },
  });

  // 4.3 Bieu do duong - TAT TB theo ngay
  destroyChart('line');
  charts.line = new Chart($('#chartLineDay'), {
    type: 'line',
    data: {
      labels: c.lineDay.labels,
      datasets: [{
        label: 'TAT (gio)', data: c.lineDay.values,
        borderColor: cssVar('--series-1'), backgroundColor: 'transparent',
        borderWidth: 2, tension: 0.25, pointRadius: 3, pointBackgroundColor: cssVar('--series-1'),
      }],
    },
    options: { ...d.common, plugins: { ...d.common.plugins, legend: { display: false } } },
  });

  // 4.4 Top 10 don vi theo so luong (1 series -> series-2)
  destroyChart('top');
  charts.top = new Chart($('#chartTop10'), {
    type: 'bar',
    data: {
      labels: c.top10.labels,
      datasets: [{ label: 'So luong', data: c.top10.values, backgroundColor: cssVar('--series-2'), borderRadius: 4 }],
    },
    options: {
      ...d.common,
      indexAxis: 'y',
      plugins: { ...d.common.plugins, legend: { display: false } },
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
  if (v > 48) color = cssVar('--critical');
  else if (v > 24) color = cssVar('--warning');
  return `<span class="tat-badge" style="background:${color}22;color:${color}">${v.toFixed(1)}</span>`;
};

/** Cot chung cho bang chi tiet TAT theo don vi. */
const COLS_TAT_DEPT = [
  { title: 'Event Perf', field: 'event_perf', headerFilter: 'input' },
  { title: 'Part No', field: 'partno', headerFilter: 'input' },
  { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
  { title: 'Label', field: 'labelno' },
  { title: 'Mo ta', field: 'description' },
  { title: 'Receiver', field: 'receiver', headerFilter: 'input' },
  { title: 'Don vi', field: 'department', headerFilter: 'input' },
  { title: 'Station', field: 'station', headerFilter: 'input' },
  { title: 'Store', field: 'store' },
  { title: 'Phieu xuat', field: 'voucher_issue' },
  { title: 'Gio xuat (VN)', field: 'issue_time_vn', formatter: fmtDateCell },
  { title: 'Gio tra US', field: 'return_unservice_time', formatter: fmtDateCell },
  { title: 'TAT (gio)', field: 'tat_hours', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
];

/** Dinh nghia cot cho tung bao cao. */
const REPORT_DEFS = {
  'issued-not-installed': {
    title: 'Thiet bi xuat kho nhung chua lap len tau',
    desc: 'kho_ser1 vm=T (P-...) khong co ban ghi on_off vm=YE.',
    columns: [
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno' },
      { title: 'Mo ta', field: 'description' },
      { title: 'Don vi', field: 'department', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Store', field: 'store' },
      { title: 'Phieu xuat', field: 'voucher_issue' },
      { title: 'Gio xuat (VN)', field: 'issue_time_vn', formatter: fmtDateCell },
    ],
  },
  'removed-not-returned': {
    title: 'Thiet bi thao xuong tu tau nhung chua tra unservice',
    desc: 'on_off vm=YA khong co ban ghi real_us1 (link qua historyno_).',
    columns: [
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno' },
      { title: 'History No', field: 'historyno' },
      { title: 'AC', field: 'ac_registr' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Store', field: 'store' },
      { title: 'Gio thao (VN)', field: 'removed_time_vn', formatter: fmtDateCell },
    ],
  },
  'not-reconciled': {
    title: 'Thiet bi chua doi ung',
    desc: 'Co xuat service (kho_ser1 vm=T) nhung khong co tra unservice (real_us1).',
    columns: [
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno' },
      { title: 'Mo ta', field: 'description' },
      { title: 'Don vi', field: 'department', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Store', field: 'store' },
      { title: 'Phieu xuat', field: 'voucher_issue' },
      { title: 'Gio xuat (VN)', field: 'issue_time_vn', formatter: fmtDateCell },
    ],
  },
  'removed-before-installed': {
    title: 'Thiet bi thao truoc, lap sau',
    desc: 'Thiet bi thao xuong (nhan unservice) chua tim duoc khoi xuat ra doi ung theo labelno.',
    columns: [
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno', headerFilter: 'input' },
      { title: 'Mo ta', field: 'description' },
      { title: 'AC', field: 'ac_registr' },
      { title: 'Don vi', field: 'department', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'NV giao', field: 'del_staff' },
      { title: 'Gio thao (VN)', field: 'removed_time_vn', formatter: fmtDateCell },
    ],
  },
  other: {
    title: 'Other - note trong cot on_ac (real_us1)',
    desc: 'Lay note on_ac cho cac thiet bi thao.',
    columns: [
      { title: 'Part No (off)', field: 'partno_off', headerFilter: 'input' },
      { title: 'Serial No (off)', field: 'serialno_off', headerFilter: 'input' },
      { title: 'Batch No (off)', field: 'batchno_off' },
      { title: 'SL', field: 'qty_off', hozAlign: 'right' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Don vi', field: 'department', headerFilter: 'input' },
      { title: 'NV giao', field: 'del_staff' },
      { title: 'Gio giao (VN)', field: 'del_time', formatter: fmtDateCell },
      { title: 'Note (on_ac)', field: 'note', widthGrow: 2 },
    ],
  },
  'return-store-tat': {
    title: 'TAT hoan kho',
    desc: 'Thiet bi hoan kho (vm=TC, P-CA-...) doi chieu phieu xuat (vm=T, P-...).',
    columns: [
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno' },
      { title: 'Mo ta', field: 'description' },
      { title: 'Don vi', field: 'department', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Phieu xuat', field: 'voucher_issue' },
      { title: 'Phieu hoan', field: 'voucher_return' },
      { title: 'Gio xuat (VN)', field: 'issue_time_vn', formatter: fmtDateCell },
      { title: 'Gio hoan (VN)', field: 'return_store_time_vn', formatter: fmtDateCell },
      { title: 'TAT (gio)', field: 'tat_hours', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
    ],
  },
};

// --------------------------------------------------------------------------
// 6. Tai & render Dashboard
// --------------------------------------------------------------------------
async function loadDashboard() {
  showError('');
  showLoading(true);
  try {
    const dash = await api('/api/dashboard');
    $('#rangeLabel').textContent = `${dash.range.label}: ${fmtDateTime(dash.range.from)} → ${fmtDateTime(dash.range.to)}`;
    renderKPIs(dash.kpis);
    renderCharts(dash.charts);

    // Bang chi tiet
    const tat = await api('/api/tat/departments');
    if (!mainTable) {
      mainTable = new Tabulator('#mainTable', {
        data: tat.rows,
        columns: COLS_TAT_DEPT,
        layout: 'fitDataFill',
        pagination: true,
        paginationSize: 15,
        paginationSizeSelector: [10, 15, 25, 50, 100],
        placeholder: 'Khong co du lieu',
        height: '520px',
      });
    } else {
      mainTable.setColumns(COLS_TAT_DEPT);
      mainTable.replaceData(tat.rows);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    showLoading(false);
  }
}

// --------------------------------------------------------------------------
// 7. Tai & render Bao cao
// --------------------------------------------------------------------------
async function loadReport(name) {
  state.currentReport = name;
  const def = REPORT_DEFS[name];
  $('#reportTitle').textContent = def.title;
  $('#reportDesc').textContent = def.desc;
  $$('.reportTab').forEach((b) => b.classList.toggle('active', b.dataset.report === name));

  showError('');
  showLoading(true);
  try {
    const data = await api(`/api/reports/${name}`);
    $('#reportCount').textContent = `${data.count} dong`;
    if (!reportTable) {
      reportTable = new Tabulator('#reportTable', {
        data: data.rows,
        columns: def.columns,
        layout: 'fitDataFill',
        pagination: true,
        paginationSize: 15,
        paginationSizeSelector: [10, 15, 25, 50, 100],
        placeholder: 'Khong co du lieu',
        height: '520px',
      });
    } else {
      reportTable.setColumns(def.columns);
      reportTable.replaceData(data.rows);
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
    const fill = (sel, arr) => {
      const el = $(sel);
      arr.forEach((v) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        el.appendChild(o);
      });
    };
    fill('#stationSelect', f.stations || []);
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
  if (tab === 'reports' && !reportTable) loadReport(state.currentReport);
}

// --------------------------------------------------------------------------
// 12. Gan su kien & khoi tao
// --------------------------------------------------------------------------
function init() {
  // Mac dinh: thang hien tai
  const now = new Date();
  state.month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  $('#monthInput').value = state.month;
  $('#weekInput').value = now.toISOString().slice(0, 10);

  // Period buttons
  $$('.periodBtn').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.periodType = btn.dataset.period;
      $$('.periodBtn').forEach((b) => b.classList.toggle('active', b === btn));
      $('#monthWrap').classList.toggle('hidden', state.periodType !== 'month');
      $('#weekWrap').classList.toggle('hidden', state.periodType !== 'week');
    })
  );
  document.querySelector('.periodBtn[data-period="month"]').classList.add('active');

  // Inputs
  $('#monthInput').addEventListener('change', (e) => (state.month = e.target.value));
  $('#weekInput').addEventListener('change', (e) => (state.week = e.target.value));
  $('#stationSelect').addEventListener('change', (e) => (state.station = e.target.value));
  $('#storeSelect').addEventListener('change', (e) => (state.store = e.target.value));
  $('#deptSelect').addEventListener('change', (e) => (state.department = e.target.value));

  // Ap dung filter -> tai lai ca 2 tab
  $('#applyBtn').addEventListener('click', () => {
    loadDashboard();
    if (!$('#tab-reports').classList.contains('hidden') || reportTable) loadReport(state.currentReport);
  });

  // Tim kiem bang chinh
  $('#mainSearch').addEventListener('input', (e) => {
    if (mainTable) mainTable.setFilter(matchAny, { value: e.target.value });
  });
  $('#reportSearch').addEventListener('input', (e) => {
    if (reportTable) reportTable.setFilter(matchAny, { value: e.target.value });
  });

  // Export Excel
  $('#mainExport').addEventListener('click', () => {
    if (mainTable) mainTable.download('xlsx', `TAT_don_vi_${Date.now()}.xlsx`, { sheetName: 'TAT' });
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
  checkHealth();
  loadFilters();
  loadDashboard();
}

/** Filter "tim kiem tren moi cot" cho Tabulator. */
function matchAny(data, params) {
  const kw = (params.value || '').toLowerCase();
  if (!kw) return true;
  return Object.values(data).some((v) => String(v ?? '').toLowerCase().includes(kw));
}

document.addEventListener('DOMContentLoaded', init);
