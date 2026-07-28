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
function renderKPIs(kpis) {
  const cards = [
    { label: 'TAT install', value: kpis.tatInstallAvg, unit: 'ngày', accent: '--series-1' },
    { label: 'TAT US return', value: kpis.tatUsReturnAvg, unit: 'ngày', accent: '--series-8' },
    { label: 'TAT CUVT', value: kpis.tatCuvtAvg, unit: 'ngày', accent: '--series-2' },
    { label: 'TAT hoàn kho', value: kpis.tatReturnStoreAvg, unit: 'ngày', accent: '--series-5' },
    { label: 'Thiết bị xuất kho', value: kpis.countIssued, unit: 'thiết bị', accent: '--series-3' },
    { label: 'Chưa đối ứng', value: kpis.countNotReconciled, unit: 'thiết bị', accent: '--series-6' },
    { label: 'Tỷ lệ đối ứng', value: kpis.reconcileRate, unit: '%', accent: '--series-4' },
    // SL da NHAN (reci) / SL da GIAO (del) cua CUVT trong ky
    { label: 'SL nhận / SL giao (CUVT)', value: `${kpis.cntReci ?? 0}/${kpis.cntDel ?? 0}`, unit: '', accent: '--series-7' },
  ];
  $('#kpiGrid').innerHTML = cards
    .map(
      (c) => `
      <div class="kpi" style="--accent:${cssVar(c.accent)}" title="${c.label}: ${c.value ?? 0} ${c.unit}">
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

  // 4.1 Bieu do cot theo Trung tam - 2 series: TAT install / TAT US return
  destroyChart('bar');
  charts.bar = new Chart($('#chartBarDept'), {
    type: 'bar',
    data: {
      labels: c.barDept.labels,
      datasets: [
        { label: 'TAT install', data: c.barDept.install, backgroundColor: cssVar('--series-1'), borderRadius: 4 },
        { label: 'TAT US return', data: c.barDept.usret, backgroundColor: cssVar('--series-8'), borderRadius: 4 },
      ],
    },
    options: d.common,
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
    title: 'Other',
    desc: 'Lấy ghi chú on_ac cho các thiết bị tháo.',
    columns: [
      { title: 'Part No (off)', field: 'partno_off', headerFilter: 'input' },
      { title: 'Serial No (off)', field: 'serialno_off', headerFilter: 'input' },
      { title: 'Batch No (off)', field: 'batchno_off', headerFilter: 'input'  },
      { title: 'Qty', field: 'qty_off', hozAlign: 'right' },
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
let mainTotalRows = 0;  // tong so dong bang chi tiet (cho bo dem X/Y)
let reportTotalRows = 0; // tong so dong bang bao cao (cho bo dem X/Y)

async function loadDashboard() {
  showError('');
  showLoading(true);
  $('#recalcNote').classList.add('hidden');
  try {
    const dash = await api('/api/dashboard');
    $('#rangeLabel').textContent = `${dash.range.label}: ${fmtDateTime(dash.range.from)} → ${fmtRangeEnd(dash.range.to)}`;
    baseKpiInstall = dash.kpis.tatInstallAvg;
    baseKpiUsret = dash.kpis.tatUsReturnAvg;
    renderKPIs(dash.kpis);
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

  setKpiCard(0, newInstall); // card "TAT install"
  setKpiCard(1, newUsret);   // card "TAT US return"
  const note = $('#recalcNote');
  note.classList.remove('hidden');
  note.innerHTML =
    `Đã loại <b>${excludedKeys.size}</b> mục (trên ${kept.length}/${all.length} thiết bị) · ` +
    `TAT install: <b>${newInstall}</b> ngày (gốc ${baseKpiInstall}) · ` +
    `TAT US return: <b>${newUsret}</b> ngày (gốc ${baseKpiUsret}).`;
}

/** Bỏ tích tất cả checkbox và khôi phục TAT gốc. */
function resetRecalc() {
  excludedKeys.clear();
  if (mainTable) mainTable.redraw(true); // ve lai de checkbox ve trang thai trong
  setKpiCard(0, baseKpiInstall);
  setKpiCard(1, baseKpiUsret);
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
    reportTotalRows = data.count;
    $('#reportCount').textContent =
      `${data.count.toLocaleString('vi')} dòng` +
      (data.truncated ? ' ⚠ chạm giới hạn MAX_ROWS' : '');
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
    reportCache.clear();
    loadDashboard();
    if (!$('#tab-reports').classList.contains('hidden')) loadReport(state.currentReport);
  };

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

/** Filter "tim kiem tren moi cot" cho Tabulator. */
function matchAny(data, params) {
  const kw = (params.value || '').toLowerCase();
  if (!kw) return true;
  return Object.values(data).some((v) => String(v ?? '').toLowerCase().includes(kw));
}

document.addEventListener('DOMContentLoaded', init);
