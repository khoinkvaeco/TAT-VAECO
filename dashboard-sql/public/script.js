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
 *  Phai doc bang getUTC* de KHONG bi trinh duyet cong them mui gio lan nua. */
function fmtDateTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return v;
  // Record trong / gia tri sentinel (1900-01-01, hoac nam <= 1901) -> de trong.
  if (d.getUTCFullYear() <= 1901) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
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
  const { periodType, month, week, station, store, department } = state;
  localStorage.setItem(FILTER_STORE_KEY, JSON.stringify({ periodType, month, week, station, store, department }));
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
    { label: 'TAT TB Trung tâm', value: kpis.tatDeptAvg, unit: 'ngày', accent: '--series-1' },
    { label: 'TAT CUVT', value: kpis.tatCuvtAvg, unit: 'ngày', accent: '--series-2' },
    { label: 'TAT hoàn kho', value: kpis.tatReturnStoreAvg, unit: 'ngày', accent: '--series-5' },
    { label: 'Thiết bị xuất kho', value: kpis.countIssued, unit: 'thiết bị', accent: '--series-3' },
    { label: 'Chưa đối ứng', value: kpis.countNotReconciled, unit: 'thiết bị', accent: '--series-6' },
    { label: 'Tỷ lệ đối ứng', value: kpis.reconcileRate, unit: '%', accent: '--series-4' },
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
      datasets: [{ label: 'TAT (ngày)', data: c.barDept.values, backgroundColor: cssVar('--series-1'), borderRadius: 4 }],
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
    options: d.common,
  });

  // 4.4 TAT hoan kho trung binh theo Trung tam (1 series -> series-5)
  destroyChart('top');
  charts.top = new Chart($('#chartTop10'), {
    type: 'bar',
    data: {
      labels: c.retStoreDept.labels,
      datasets: [{ label: 'TAT hoàn kho (ngày)', data: c.retStoreDept.values, backgroundColor: cssVar('--series-5'), borderRadius: 4 }],
    },
    options: { ...d.common, plugins: { ...d.common.plugins, legend: { display: false } } },
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

/** Cột chi tiết TAT theo thiết bị (có checkbox "Bỏ qua" để tính lại TAT). */
const COLS_TAT_DEPT = [
  { title: 'Bỏ qua', formatter: 'rowSelection', titleFormatter: 'rowSelection', hozAlign: 'center',
    headerSort: false, width: 70, headerHozAlign: 'center' },
  { title: 'Event Perf', field: 'event_perf', headerFilter: 'input' },
  { title: 'Part No', field: 'partno', headerFilter: 'input' },
  { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
  { title: 'Label', field: 'labelno' },
  { title: 'Mô tả', field: 'description' },
  { title: 'Receiver', field: 'receiver', headerFilter: 'input' },
  { title: 'Trung tâm', field: 'department', headerFilter: 'input' },
      { title: 'Nhân viên', field: 'staff', headerFilter: 'input' },
  { title: 'Station', field: 'station', headerFilter: 'input' },
  { title: 'Store', field: 'store', headerFilter: 'input' },
  { title: 'Pickslip', field: 'voucher_issue' },
  { title: 'Phiếu xuất', field: 'picking_li' },
  { title: 'Giờ xuất (VN)', field: 'issue_time_vn', formatter: fmtDateCell },
  { title: 'Giờ trả US', field: 'return_unservice_time', formatter: fmtDateCell },
  { title: 'TAT (ngày)', field: 'tat_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
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
      { title: 'Mô tả', field: 'description' },
      { title: 'History No', field: 'historyno' },
      { title: 'Số hiệu tàu', field: 'ac_registr' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Trung tâm', field: 'department', headerFilter: 'input' },
      { title: 'Nhân viên', field: 'staff', headerFilter: 'input' },
      { title: 'NV giao', field: 'del_staff', headerFilter: 'input' },
      { title: 'Giờ giao (del_time)', field: 'del_time', formatter: fmtDateCell },
      { title: 'Giờ nhận (reci_time)', field: 'reci_time', formatter: fmtDateCell },
    ],
  },
  'issued-not-installed': {
    title: 'Thiết bị xuất kho nhưng chưa lắp lên tàu',
    desc: 'kho_ser1 vm=T (P-…) chưa lắp (on_off vm=YE) và chưa được return. TAT = hiện tại − giờ xuất kho.',
    columns: [
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno' },
      { title: 'Mô tả', field: 'description' },
      { title: 'Trung tâm', field: 'department', headerFilter: 'input' },
      { title: 'Nhân viên', field: 'staff', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Store', field: 'store', headerFilter: 'input' },
      { title: 'Phiếu xuất', field: 'voucher_issue' },
      { title: 'Giờ xuất (VN)', field: 'issue_time_vn', formatter: fmtDateCell },
      { title: 'TAT tồn (ngày)', field: 'tat_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
    ],
  },
  'removed-not-returned': {
    title: 'Thiết bị tháo xuống từ tàu nhưng chưa trả unservice',
    desc: 'on_off vm=YA không có bản ghi real_us1 (liên kết qua historyno_).',
    columns: [
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno' },
      { title: 'History No', field: 'historyno' },
      { title: 'Số hiệu tàu', field: 'ac_registr' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Store', field: 'store' },
      { title: 'Nhân viên', field: 'staff', headerFilter: 'input' },
      { title: 'Giờ tháo (VN)', field: 'removed_time_vn', formatter: fmtDateCell },
    ],
  },
  'not-reconciled': {
    title: 'Thiết bị chưa đối ứng',
    desc: 'Có xuất service (kho_ser1 vm=T) nhưng không có trả unservice, và chưa hoàn kho.',
    columns: [
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno' },
      { title: 'Mô tả', field: 'description' },
      { title: 'Trung tâm', field: 'department', headerFilter: 'input' },
      { title: 'Nhân viên', field: 'staff', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Store', field: 'store', headerFilter: 'input' },
      { title: 'Pickslip', field: 'voucher_issue' },
      { title: 'Phiếu xuất', field: 'picking_li' },
      { title: 'Giờ xuất (VN)', field: 'issue_time_vn', formatter: fmtDateCell },
    ],
  },
  'removed-before-installed': {
    title: 'Tháo trước, lắp sau (ngày xuất kho SAU ngày lắp)',
    desc: 'Liên kết theo labelno. Thiết bị THÁO (tháo trước) và thiết bị XUẤT KHO (phiếu xuất làm sau ngày lắp) được hiển thị riêng để dễ đối chiếu.',
    columns: [
      { title: 'Label', field: 'labelno', headerFilter: 'input' },
      { title: 'PN tháo (tháo trước)', field: 'partno_removed', headerFilter: 'input' },
      { title: 'SN tháo', field: 'serialno_removed' },
      { title: 'Ngày tháo', field: 'removed_time_vn', formatter: fmtDateCell },
      { title: 'Ngày lắp', field: 'installed_time_vn', formatter: fmtDateCell },
      { title: 'PN xuất (xuất sau)', field: 'partno', headerFilter: 'input' },
      { title: 'SN xuất', field: 'serialno' },
      { title: 'Ngày xuất kho', field: 'issue_time_vn', formatter: fmtDateCell },
      { title: 'Xuất sau lắp (ngày)', field: 'tat_issue_install_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
      { title: 'Giờ trả US', field: 'return_unservice_time', formatter: fmtDateCell },
      { title: 'TAT tháo→trả US (ngày)', field: 'tat_removal_return_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
      { title: 'Số hiệu tàu', field: 'ac_registr' },
      { title: 'Trung tâm', field: 'department', headerFilter: 'input' },
      { title: 'Nhân viên', field: 'staff', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
    ],
  },
  other: {
    title: 'Other — ghi chú trong cột on_ac (real_us1)',
    desc: 'Lấy ghi chú on_ac cho các thiết bị tháo.',
    columns: [
      { title: 'Part No (off)', field: 'partno_off', headerFilter: 'input' },
      { title: 'Serial No (off)', field: 'serialno_off', headerFilter: 'input' },
      { title: 'Batch No (off)', field: 'batchno_off' },
      { title: 'SL', field: 'qty_off', hozAlign: 'right' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Trung tâm', field: 'department', headerFilter: 'input' },
      { title: 'Nhân viên', field: 'staff', headerFilter: 'input' },
      { title: 'NV giao', field: 'del_staff' },
      { title: 'Giờ giao (VN)', field: 'del_time', formatter: fmtDateCell },
      { title: 'Ghi chú (on_ac)', field: 'note', widthGrow: 2 },
    ],
  },
  'return-store-tat': {
    title: 'TAT hoàn kho',
    desc: 'Thiết bị hoàn kho (vm=TC, P-CA-<PS>) đối chiếu phiếu xuất (vm=T, P-<PS>) cùng số PS và labelno.',
    columns: [
      { title: 'Part No', field: 'partno', headerFilter: 'input' },
      { title: 'Serial No', field: 'serialno', headerFilter: 'input' },
      { title: 'Label', field: 'labelno' },
      { title: 'Mô tả', field: 'description' },
      { title: 'Trung tâm', field: 'department', headerFilter: 'input' },
      { title: 'Nhân viên', field: 'staff', headerFilter: 'input' },
      { title: 'Station', field: 'station', headerFilter: 'input' },
      { title: 'Store', field: 'store', headerFilter: 'input' },
      { title: 'Pickslip', field: 'voucher_issue' },
      { title: 'Phiếu xuất', field: 'picking_li' },
      { title: 'Giờ xuất (VN)', field: 'issue_time_vn', formatter: fmtDateCell },
      { title: 'Giờ hoàn (VN)', field: 'return_store_time_vn', formatter: fmtDateCell },
      { title: 'TAT (ngày)', field: 'tat_days', formatter: fmtTatCell, hozAlign: 'right', sorter: 'number' },
    ],
  },
};

// --------------------------------------------------------------------------
// 6. Tai & render Dashboard
// --------------------------------------------------------------------------
let baseKpiDeptAvg = 0; // TAT TB Trung tam goc (de khoi phuc khi Dat lai)

async function loadDashboard() {
  showError('');
  showLoading(true);
  $('#recalcNote').classList.add('hidden');
  try {
    const dash = await api('/api/dashboard');
    $('#rangeLabel').textContent = `${dash.range.label}: ${fmtDateTime(dash.range.from)} → ${fmtDateTime(dash.range.to)}`;
    baseKpiDeptAvg = dash.kpis.tatDeptAvg;
    renderKPIs(dash.kpis);
    renderCharts(dash.charts);

    // Bang chi tiet: dung "rows" tra kem trong /api/dashboard (tranh query 2 lan).
    const rows = dash.rows || (await api('/api/tat/departments')).rows;
    if (!mainTable) {
      mainTable = new Tabulator('#mainTable', {
        data: rows,
        columns: COLS_TAT_DEPT,
        layout: 'fitDataFill',
        pagination: true,
        paginationSize: 15,
        paginationSizeSelector: [10, 15, 25, 50, 100],
        selectableRows: true, // cho phep tich chon dong de "bo qua"
        placeholder: 'Không có dữ liệu',
        height: '540px',
      });
    } else {
      mainTable.setColumns(COLS_TAT_DEPT);
      mainTable.replaceData(rows);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    showLoading(false);
  }
}

/** Tính lại TAT TB Trung tâm, bỏ các dòng đã tích chọn (item đặc biệt). */
function recalcTat() {
  if (!mainTable) return;
  const excluded = mainTable.getSelectedData();
  const exSet = new Set(excluded.map((r) => `${r.partno}|${r.serialno}|${r.labelno}|${r.voucher_issue}`));
  const all = mainTable.getData();
  const kept = all.filter((r) => !exSet.has(`${r.partno}|${r.serialno}|${r.labelno}|${r.voucher_issue}`));
  const vals = kept.map((r) => Number(r.tat_days)).filter((v) => isFinite(v));
  const newAvg = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0;

  // Cap nhat card TAT TB Trung tam (card dau tien)
  const card = $('#kpiGrid .kpi:first-child .kpi-value');
  if (card) card.innerHTML = `${newAvg} <span class="kpi-unit">ngày</span>`;
  const note = $('#recalcNote');
  note.classList.remove('hidden');
  note.innerHTML = `Đã loại <b>${excluded.length}</b> mục · TAT TB Trung tâm tính lại: <b>${newAvg} ngày</b> (gốc ${baseKpiDeptAvg} ngày, trên ${kept.length}/${all.length} thiết bị).`;
}

/** Bỏ chọn tất cả và khôi phục TAT gốc. */
function resetRecalc() {
  if (mainTable) mainTable.deselectRow();
  const card = $('#kpiGrid .kpi:first-child .kpi-value');
  if (card) card.innerHTML = `${baseKpiDeptAvg} <span class="kpi-unit">ngày</span>`;
  $('#recalcNote').classList.add('hidden');
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
    // Dung cache theo (bao cao + filter) de doi tab khong load lai du lieu
    const cacheKey = `${name}?${buildQuery()}`;
    let data = reportCache.get(cacheKey);
    if (!data) {
      data = await api(`/api/reports/${name}`);
      reportCache.set(cacheKey, data);
    }
    $('#reportCount').textContent = `${data.count} dòng`;
    if (!reportTable) {
      reportTable = new Tabulator('#reportTable', {
        data: data.rows,
        columns: def.columns,
        layout: 'fitDataFill',
        pagination: true,
        paginationSize: 15,
        paginationSizeSelector: [10, 15, 25, 50, 100],
        placeholder: 'Không có dữ liệu',
        height: '540px',
      });
    } else {
      // Xoa filter tim kiem cu (cua bao cao truoc) de khong loc nham het du lieu
      reportTable.clearFilter(true);
      $('#reportSearch').value = '';
      reportTable.setColumns(def.columns);
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
  if (tab === 'reports') {
    // LUON tai lai khi mo tab (cache lam viec nay re); tranh cap nhat bang khi
    // tab dang an (Tabulator ve rong neu container display:none).
    loadReport(state.currentReport);
  } else if (mainTable) {
    mainTable.redraw(true); // ve lai sau khi tab hien thi tro lai
  }
}

// --------------------------------------------------------------------------
// 12. Gan su kien & khoi tao
// --------------------------------------------------------------------------
async function init() {
  // Mac dinh: thang hien tai
  const now = new Date();
  state.month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Khoi phuc cau hinh filter da luu (neu co)
  const saved = loadSavedFilters();
  if (saved) {
    if (saved.periodType) state.periodType = saved.periodType;
    if (saved.month) state.month = saved.month;
    if (saved.week) state.week = saved.week;
    state.station = saved.station || '';
    state.store = saved.store || '';
    state.department = saved.department || '';
  }
  $('#monthInput').value = state.month;
  $('#weekInput').value = state.week || now.toISOString().slice(0, 10);

  // Period buttons
  $$('.periodBtn').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.periodType = btn.dataset.period;
      $$('.periodBtn').forEach((b) => b.classList.toggle('active', b === btn));
      $('#monthWrap').classList.toggle('hidden', state.periodType !== 'month');
      $('#weekWrap').classList.toggle('hidden', state.periodType !== 'week');
    })
  );
  document.querySelector(`.periodBtn[data-period="${state.periodType}"]`).classList.add('active');
  $('#monthWrap').classList.toggle('hidden', state.periodType !== 'month');
  $('#weekWrap').classList.toggle('hidden', state.periodType !== 'week');

  // Inputs
  $('#monthInput').addEventListener('change', (e) => (state.month = e.target.value));
  $('#weekInput').addEventListener('change', (e) => (state.week = e.target.value));
  $('#stationSelect').addEventListener('change', (e) => (state.station = e.target.value));
  $('#storeSelect').addEventListener('change', (e) => (state.store = e.target.value));
  $('#deptSelect').addEventListener('change', (e) => (state.department = e.target.value));

  // Ap dung filter -> luu cau hinh + xoa cache bao cao + tai lai tab dang mo.
  // KHONG cap nhat bang bao cao khi tab dang an (Tabulator se ve rong);
  // khi mo lai tab, switchTab() se tu load voi filter moi.
  $('#applyBtn').addEventListener('click', () => {
    saveFilters();
    reportCache.clear();
    loadDashboard();
    if (!$('#tab-reports').classList.contains('hidden')) loadReport(state.currentReport);
  });

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
  checkHealth();
  await loadFilters(); // doi nap xong option roi moi khoi phuc gia tri da luu
  $('#stationSelect').value = state.station;
  $('#storeSelect').value = state.store;
  $('#deptSelect').value = state.department;
  loadDashboard();
}

/** Filter "tim kiem tren moi cot" cho Tabulator. */
function matchAny(data, params) {
  const kw = (params.value || '').toLowerCase();
  if (!kw) return true;
  return Object.values(data).some((v) => String(v ?? '').toLowerCase().includes(kw));
}

document.addEventListener('DOMContentLoaded', init);
