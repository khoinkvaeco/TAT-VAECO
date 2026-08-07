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
  store: [],        // CHON NHIEU KHO - mang rong = tat ca
  department: '',
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
  if (state.station) p.set('station', state.station);
  if (state.store.length) p.set('store', state.store.join(','));
  if (state.department) p.set('department', state.department);
  if (state.excludeCC) p.set('excludeCC', '1');
  if (state.excludeCab) p.set('excludeCab', '1');
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
  }
}

/** Cham nhay tren nut tab dang tai (bao cao / tab chinh). */
function setTabLoading(selector, name, on) {
  $$(selector).forEach((b) => {
    const mine = b.dataset.report === name || b.dataset.tab === name;
    b.classList.toggle('loading', on && mine);
  });
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

  // 4.2 Bieu do tron - phan bo thiet bi.
  //     CHUA chon Station -> chia theo STATION.
  //     DA chon 1 Station  -> chia theo TRUNG TAM (chia theo station luc do chi
  //     con dung 1 mieng, khong noi len dieu gi). Server bao qua truong groupBy;
  //     drill-down cung phai doi khoa loc theo do.
  const pieBy = c.pieStation.groupBy === 'department' ? 'department' : 'station';
  const pieTitle = $('#pieStationTitle');
  if (pieTitle) {
    pieTitle.innerHTML = pieBy === 'department'
      ? `Phân bổ thiết bị theo Trung tâm <span class="unit">(station ${state.station})</span>`
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
/** O DEM cua bang pivot: 0 hien nhat de mat tap trung vao o co so lieu.
 *  Dong TONG CONG (isTotal) luon in dam. */
const fmtCountCell = (cell) => {
  const v = Number(cell.getValue()) || 0;
  const bold = cell.getRow().getData().isTotal ? 'font-weight:700;' : '';
  if (!v) return `<span style="color:var(--text-muted);${bold}">0</span>`;
  return `<span style="${bold}">${v}</span>`;
};
/** Nhu fmtCountCell nhung to mau canh bao (cot "tu 30 ngay tro len"). */
const fmtCountWarnCell = (cell) => {
  const v = Number(cell.getValue()) || 0;
  const bold = cell.getRow().getData().isTotal ? 'font-weight:700;' : '';
  if (!v) return `<span style="color:var(--text-muted);${bold}">0</span>`;
  const c = cssVar('--warning');
  return `<span class="tat-badge" style="background:${c}22;color:${c};${bold}">${v}</span>`;
};
/** Cot TONG - luon in dam. */
const fmtCountBoldCell = (cell) => `<b>${Number(cell.getValue()) || 0}</b>`;

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
        title: 'Có on_off', field: 'co_su_kien_on_off', hozAlign: 'center', width: 100,
        headerFilter: 'list',
        headerFilterParams: { values: { '': 'Tất cả', 'Có': 'Có', 'Không': 'Không' } },
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
      + 'status = 0, backorder = 1 và state = O. Nguồn: LOCATION × ROTABLES × OD_DETAIL (nối psn + labelno). '
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
function repairAdminSummary(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const key = `${r.station}|${r.store}|${r.location}`;
    let g = map.get(key);
    if (!g) {
      g = { station: r.station || '', store: r.store || '', location: r.location || '',
            less30: 0, over30: 0, unknown: 0, total: 0 };
      map.set(key, g);
    }
    const a = r.age_days;
    if (a === null || a === undefined) g.unknown++;
    else if (Number(a) < 30) g.less30++;
    else g.over30++;
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
  const head = `<tr><th>Station</th><th>Store</th><th>Vị trí (U/S)</th>`
    + `<th class="ra-num">&lt; 30 ngày</th><th class="ra-num">≥ 30 ngày</th>`
    + (coUnknown ? '<th class="ra-num">Không rõ ngày</th>' : '')
    + `<th class="ra-num">Tổng</th></tr>`;
  const body = list.map((r) =>
    `<tr><td>${esc(r.station)}</td><td>${esc(r.store)}</td><td>${esc(r.location)}</td>`
    + num(r.less30) + num(r.over30, true)
    + (coUnknown ? num(r.unknown) : '')
    + `<td class="ra-num"><b>${r.total}</b></td></tr>`).join('');
  const foot = `<tr class="ra-total"><td colspan="3">TỔNG CỘNG (${list.length} vị trí)</td>`
    + `<td class="ra-num">${sum('less30')}</td><td class="ra-num">${sum('over30')}</td>`
    + (coUnknown ? `<td class="ra-num">${sum('unknown')}</td>` : '')
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
  setBusy(H.pane, true);
  if (H.tabSel) setTabLoading(H.tabSel, name, true);

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
        placeholder: 'Không có dữ liệu',
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
    showError(err.message);
  } finally {
    showLoading(false);
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
    STORE_LIST = (f.stores || []).slice();
    renderStoreMenu();
    fill('#deptSelect', f.departments || []);
  } catch (e) {
    // khong chan - loi filter khong lam hong toan bo trang
    console.warn('Khong tai duoc filters:', e.message);
  }
}

// --------------------------------------------------------------------------
// 8b. O CHON NHIEU KHO (Store)
//     Dung nut + menu tich chon thay cho <select multiple>: select multiple
//     bat nguoi dung giu Ctrl de chon them, chiem nhieu cho tren thanh loc va
//     rat de bo chon nham chi bang mot cu click.
//     CHI tai lai du lieu KHI DONG MENU, khong phai moi lan tich - moi truy van
//     deu di qua linked server nen tich 5 kho ma ban 5 luot la rat lang phi.
// --------------------------------------------------------------------------
let STORE_LIST = [];          // danh muc kho lay tu /api/filters
let storeDaDoi = false;       // co thay doi ke tu luc mo menu khong
let storeApply = () => {};    // ham tai lai du lieu (truyen tu init)

/** Nhan ca chuoi 'A,B' lan mang -> mang khong trung, khong rong. */
function normStores(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
}

/** Chu tren nut: "Tat ca" / ten kho / "N kho". */
function storeBtnLabel() {
  const n = state.store.length;
  if (!n) return 'Tất cả';
  if (n <= 2) return state.store.join(', ');
  return `${n} kho`;
}

function renderStoreMenu() {
  const box = $('#storeOptions');
  if (!box) return;
  const tim = ($('#storeSearch').value || '').trim().toLowerCase();
  const ds = STORE_LIST.filter((v) => !tim || v.toLowerCase().includes(tim));
  box.innerHTML = ds.length
    ? ds.map((v) => {
      const biLoai = state.excludeCab && CAB_STORES.includes(v.trim().toUpperCase());
      return `<label class="multi-opt${biLoai ? ' bi-loai' : ''}">
          <input type="checkbox" value="${escapeHtml(v)}"${state.store.includes(v) ? ' checked' : ''} />
          <span>${escapeHtml(v)}</span>
          ${biLoai ? '<span class="ghi-chu">đang bỏ qua</span>' : ''}
        </label>`;
    }).join('')
    : '<div class="multi-opt" style="opacity:.6">Không có kho nào khớp</div>';
  $('#storeBtnText').textContent = storeBtnLabel();
  $('#storeBtn').title = state.store.length ? state.store.join(', ') : 'Tất cả các kho';

  // Nhac khi lua chon hien tai bi o "Bo qua cac kho CAB" triet tieu
  const conLai = state.store.filter((v) => !CAB_STORES.includes(v.trim().toUpperCase()));
  const hint = $('#storeHint');
  const canNhac = state.excludeCab && state.store.length && !conLai.length;
  hint.classList.toggle('hidden', !canNhac);
  if (canNhac) {
    hint.textContent = 'Mọi kho đang chọn đều nằm trong nhóm bị "Bỏ qua các kho CAB" '
      + '→ kết quả sẽ rỗng. Bỏ tích ô đó hoặc chọn thêm kho khác.';
  }
}

function storeMenuMo() { return !$('#storeMenu').classList.contains('hidden'); }

function moStoreMenu(mo) {
  const menu = $('#storeMenu');
  if (mo === storeMenuMo()) return;
  menu.classList.toggle('hidden', !mo);
  $('#storeBtn').setAttribute('aria-expanded', String(mo));
  if (mo) {
    storeDaDoi = false;
    $('#storeSearch').value = '';
    renderStoreMenu();
    $('#storeSearch').focus();
  } else if (storeDaDoi) {
    storeDaDoi = false;
    storeApply();   // chi tai lai MOT lan, sau khi da chon xong
  }
}

function initStoreMulti(apply) {
  storeApply = apply;
  $('#storeBtn').addEventListener('click', (e) => { e.stopPropagation(); moStoreMenu(!storeMenuMo()); });
  $('#storeMenu').addEventListener('click', (e) => e.stopPropagation());
  $('#storeSearch').addEventListener('input', renderStoreMenu);

  $('#storeOptions').addEventListener('change', (e) => {
    const el = e.target;
    if (!el.matches('input[type=checkbox]')) return;
    const v = el.value;
    state.store = el.checked
      ? [...new Set([...state.store, v])]
      : state.store.filter((x) => x !== v);
    storeDaDoi = true;
    renderStoreMenu();
  });
  // "Chon tat ca" chi ap cho cac kho DANG HIEN (sau khi tim) - dung y nguoi dung
  $('#storeAll').addEventListener('click', () => {
    const tim = ($('#storeSearch').value || '').trim().toLowerCase();
    const ds = STORE_LIST.filter((v) => !tim || v.toLowerCase().includes(tim));
    state.store = [...new Set([...state.store, ...ds])];
    storeDaDoi = true;
    renderStoreMenu();
  });
  $('#storeNone').addEventListener('click', () => {
    state.store = [];
    storeDaDoi = true;
    renderStoreMenu();
  });

  document.addEventListener('click', () => moStoreMenu(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') moStoreMenu(false); });
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

const PICK_LOAI_LABEL = {
  CANCEL: 'Cancel', RETURN: 'Return',
  KHAC: 'Hủy/trả khác', NORMAL: 'Bình thường',
};

// --- Doi chieu FILE SCAN PDF (dung chung cho tab Xuat kho va tab Receiving) ---
// Gia tri '' = KHONG doc duoc thu muc -> hien '—' chu KHONG bao "chua scan"
// (bao nham se khien nguoi dung di tim file khong ton tai van de).
const SCAN_LABEL = { SCANNED: 'Đã scan', CHUA_SCAN: 'Chưa scan' };

/** Cac kho bi loai khi tich "Bo qua cac kho CAB" (giong CAB_STORES o server). */
const CAB_STORES = ['CAB', 'CAB-TD', 'P-THA', 'P-SAF', 'P-PAN'];

/** Chan HTML trong du lieu tu server (duong dan / thong bao loi). */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtScanCell(cell) {
  const v = cell.getValue();
  if (v === 'SCANNED') {
    const c = cssVar('--good');
    return `<span class="tat-badge" style="background:${c}22;color:${c}">Đã scan</span>`;
  }
  if (v === 'CHUA_SCAN') {
    const c = cssVar('--critical');
    return `<span class="tat-badge" style="background:${c}22;color:${c}">Chưa scan</span>`;
  }
  return '<span style="color:var(--text-muted)" title="Không đọc được thư mục scan">—</span>';
}

const SCAN_HEADER_FILTER = {
  headerFilter: 'list',
  headerFilterParams: { values: { '': 'Tất cả', SCANNED: 'Đã scan', CHUA_SCAN: 'Chưa scan' } },
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
    formatter: (cell) => {
      const v = cell.getValue();
      if (v === 'CANCEL') return `<span class="tat-badge" style="background:${cssVar('--warning')}22;color:${cssVar('--warning')}">Cancel</span>`;
      if (v === 'RETURN') return `<span class="tat-badge" style="background:${cssVar('--series-4')}22;color:${cssVar('--series-4')}">Return</span>`;
      if (v === 'KHAC') return `<span class="tat-badge" style="background:${cssVar('--series-5')}22;color:${cssVar('--series-5')}" title="QTY_CANCELED ≠ 0 nhưng PICKSLIP_TEXT không có từ khóa cancel/return">Hủy/trả khác</span>`;
      return '<span style="color:var(--text-muted)">Bình thường</span>';
    },
    headerFilter: 'list',
    headerFilterParams: {
      values: {
        '': 'Tất cả', NORMAL: 'Bình thường', CANCEL: 'Cancel',
        RETURN: 'Return', KHAC: 'Hủy/trả khác',
      },
    },
  },
  { title: 'Ngày phiếu', field: 'pickslip_date', formatter: fmtDateCell },
  {
    title: 'Giờ xuất kho', field: 'issue_time_vn', formatter: fmtDateCell, width: 145,
    headerTooltip: 'Chỉ điền khi MUTATION của phiếu RƠI ĐÚNG vào ngày phiếu (PICKSLIP_DATE) — '
      + 'khi đó MUTATION_TIME mới đúng là giờ lập phiếu. Trống = AMOS chỉ cho biết NGÀY.',
  },
  {
    title: 'Sửa cuối (dòng)', field: 'booked_time_vn', formatter: fmtDateCell, width: 145,
    headerTooltip: 'PICKSLIP_BOOKED.MUTATION + MUTATION_TIME = lần sửa CUỐI của dòng, '
      + 'KHÔNG phải giờ xuất kho (đã đo được có dòng lệch tới 8 tháng). Chỉ để đối chiếu.',
  },
  { title: 'Pickslip', field: 'pickslipno', headerFilter: 'input' },
  { title: 'Seq', field: 'seqno', formatter: fmtIntCell, hozAlign: 'right', width: 70 },
  { title: 'Picking list', field: 'picking_listno', formatter: fmtIntCell, hozAlign: 'right', headerFilter: 'input' },
  {
    title: 'Scan', field: 'scan', hozAlign: 'center', width: 105, ...SCAN_HEADER_FILTER,
    headerTooltip: 'Có file <PICKING_LISTNO_I>-….pdf trong thư mục scan hay chưa. “—” = không đọc được thư mục.',
    formatter: fmtScanCell,
  },
  { title: 'Part No', field: 'partno', headerFilter: 'input' },
  { title: 'Serial / Batch', field: 'serialno', headerFilter: 'input' },
  { title: 'SL đặt', field: 'qty_booked', hozAlign: 'right', sorter: 'number', width: 85 },
  {
    title: 'SL hủy', field: 'qty_canceled', hozAlign: 'right', sorter: 'number', width: 85,
    formatter: (cell) => {
      const v = Number(cell.getValue()) || 0;
      if (!v) return '<span style="color:var(--text-muted)">0</span>';
      const c = cssVar('--warning');
      return `<span class="tat-badge" style="background:${c}22;color:${c}">${v}</span>`;
    },
  },
  // --- Phieu TRA LAI KHO (chi co o dong loai Return) ---
  {
    title: 'Phiếu trả', field: 'return_no', headerFilter: 'input', width: 120,
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
  {
    title: 'Sửa cuối (dòng hủy)', field: 'cancel_time_vn', formatter: fmtDateCell, width: 155,
    headerTooltip: 'Lần sửa cuối của dòng Cancel — mốc gần nhất có thể coi là lúc hủy, '
      + 'nhưng AMOS không có cột riêng cho giờ hủy nên KHÔNG chắc chắn.',
  },
  { title: 'Ngày trả kho', field: 'return_date', formatter: fmtDateCell, width: 115 },
  {
    title: 'Giờ trả kho', field: 'return_time_vn', formatter: fmtDateCell, width: 145,
    headerTooltip: 'HISTORY.MUTATION + MUTATION_TIME → giờ VN (+7).',
  },
  {
    title: 'TAT hoàn kho (giờ)', field: 'tat_gio', hozAlign: 'right', sorter: 'number', width: 150,
    headerTooltip: 'Số GIỜ từ lúc xuất kho đến lúc hàng về kho — chính xác đến giờ, '
      + 'khác với cột “TAT return” chỉ tính ngày tròn.',
    formatter: (cell) => {
      const v = cell.getValue();
      if (v === null || v === undefined || v === '') return '';
      const n = Number(v);
      const c = n > 24 * 14 ? cssVar('--critical') : (n > 24 * 7 ? cssVar('--warning') : cssVar('--good'));
      const nhan = n < 24 ? `${n} giờ` : `${Math.round((n / 24) * 10) / 10} ngày`;
      return `<span class="tat-badge" style="background:${c}22;color:${c}" title="${n} giờ">${nhan}</span>`;
    },
  },
  {
    title: 'TAT return', field: 'tat_return', hozAlign: 'right', sorter: 'number', width: 105,
    headerTooltip: 'Số NGÀY từ ngày xuất kho (PICKSLIP_DATE) đến ngày trả về kho (HISTORY.MUTATION).',
    formatter: (cell) => {
      const v = cell.getValue();
      if (v === null || v === undefined || v === '') return '';
      const n = Number(v);
      const c = n > 14 ? cssVar('--critical') : (n > 7 ? cssVar('--warning') : cssVar('--good'));
      return `<span class="tat-badge" style="background:${c}22;color:${c}">${n} ngày</span>`;
    },
  },
  {
    title: 'Scan phiếu trả', field: 'return_scan', hozAlign: 'center', width: 125, ...SCAN_HEADER_FILTER,
    headerTooltip: 'Có file <HISTORYNO_I>-….pdf trong thư mục scan hay chưa.',
    formatter: fmtScanCell,
  },
  { title: 'Station', field: 'station', headerFilter: 'input', width: 90 },
  { title: 'Store', field: 'store', headerFilter: 'input', width: 100 },
  { title: 'Vị trí lấy', field: 'location_from', headerFilter: 'input' },
  { title: 'Center', field: 'department', headerFilter: 'input' },
  { title: 'Mech sign', field: 'mech_sign', headerFilter: 'input' },
  { title: 'Booking sign', field: 'booking_sign', headerFilter: 'input' },
  { title: 'Receiver', field: 'receiver', headerFilter: 'input' },
  { title: 'Owner', field: 'owner', headerFilter: 'input' },
  { title: 'Người tạo', field: 'created_by', headerFilter: 'input' },
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
    { label: 'Số dòng xuất', value: k.soDong, unit: 'dòng', accent: '--series-1' },
    { label: 'Thực xuất', value: k.soDongThuc, unit: 'dòng', accent: '--good' },
    { label: 'Cancel', value: k.soCancel, unit: 'dòng', accent: '--warning' },
    { label: 'Return', value: k.soReturn, unit: 'dòng', accent: '--series-4' },
    {
      label: 'Hủy/trả khác', value: k.soKhac ?? 0, unit: 'dòng', accent: '--series-5',
      title: 'QTY_CANCELED ≠ 0 nhưng PICKSLIP_TEXT không có từ khóa cancel/return. '
        + 'VẪN được tính là hủy/trả (trước đây bị xếp nhầm vào “Thực xuất”).',
    },
    { label: 'Tỷ lệ hủy/trả', value: k.tyLeHuy, unit: '%', accent: '--critical' },
    { label: 'Phiếu có hủy/trả', value: `${k.soPhieuCoHuy}/${k.soPhieu}`, unit: `(${k.tyLePhieuCoHuy}%)`, accent: '--series-3' },
    {
      label: 'Đã scan', value: `${n(k.daScan)}/${n(k.tongPhieuScan)}`, unit: `phiếu (${k.tyLeScan ?? 0}%)`,
      accent: (k.chuaScan === 0 && k.tongPhieuScan > 0) ? '--good' : '--warning',
      title: 'Số PICKING LIST đã có file PDF trong thư mục scan, tính trên TOÀN KỲ '
        + '(không phụ thuộc bảng chi tiết bên dưới — bảng đó bị cắt ở MAX_ROWS). '
        + 'Yêu cầu nghiệp vụ: phải đạt 100%.',
    },
    {
      label: 'Chưa scan', value: n(k.chuaScan), unit: 'phiếu', accent: k.chuaScan ? '--critical' : '--good',
      title: 'Số PICKING LIST chưa tìm thấy file PDF. Đếm theo PHIẾU (một phiếu nhiều dòng '
        + 'chỉ cần một file), tính trên toàn kỳ. Đây là số file thực sự còn phải scan.',
    },
    {
      label: 'TAT hoàn kho TB', value: n(k.tatGioAvg), unit: 'giờ', accent: '--series-2',
      title: 'Trung bình số GIỜ từ lúc xuất kho đến lúc hàng về kho. '
        + 'Thiếu giờ thật ở đầu nào thì lùi về NGÀY ở đầu đó (sai số tối đa 1 ngày). '
        + 'Xem KPI “Chính xác đến giờ” bên cạnh để biết bao nhiêu dòng có giờ thật cả hai đầu.',
    },
    {
      label: 'Chính xác đến giờ',
      value: `${k.soChinhXacGio ?? 0}/${k.soCoTat ?? 0}`,
      unit: `dòng (${k.soCoTat ? Math.round(((k.soChinhXacGio || 0) / k.soCoTat) * 100) : 0}%)`,
      accent: '--series-3',
      title: 'Số dòng có GIỜ thật ở CẢ HAI đầu (xuất kho và về kho). '
        + 'Các dòng còn lại lùi về ngày nên TAT có thể lệch trong phạm vi 1 ngày.',
    },
    {
      label: 'TAT return TB', value: n(k.tatReturnAvg), unit: 'ngày', accent: '--series-2',
      title: 'Trung bình số ngày từ khi xuất kho đến khi trả về kho — tính trên TOÀN KỲ, '
        + 'chỉ gồm dòng Return đã tra được phiếu nhập lại.',
    },
    {
      label: 'TAT return lâu nhất', value: n(k.tatReturnMax), unit: 'ngày', accent: '--warning',
      title: 'Dòng Return có thời gian nằm ngoài kho lâu nhất trong kỳ.',
    },
    {
      label: 'Return có phiếu trả', value: `${n(k.returnCoPhieu)}/${(k.returnCoPhieu || 0) + (k.returnKhongPhieu || 0)}`,
      unit: 'dòng', accent: '--series-4',
      title: 'Số dòng Return tra được số phiếu nhập lại kho trong HISTORY (VM ∈ EA, TC), toàn kỳ. '
        + 'Không tra được thì cột "Phiếu trả" ghi NOT FOUND — khi đó không kiểm được scan của phiếu trả.',
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
        { label: 'Thực xuất', data: c.byDept.thuc, backgroundColor: cssVar('--good') },
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
        { type: 'bar', label: 'Số dòng', data: c.byDay.soDong, backgroundColor: cssVar('--series-1'), borderRadius: 3, yAxisID: 'y' },
        {
          type: 'line', label: '% hủy', data: c.byDay.tyLe, yAxisID: 'y1',
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
        y: { ...d.common.scales.y, title: { display: true, text: 'Số dòng', color: cssVar('--text-secondary') } },
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
      datasets: [{ label: 'Số dòng bị hủy', data: c.topPart.values, backgroundColor: cssVar('--warning'), borderRadius: 4 }],
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
        label: 'Số dòng Return',
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

  // TAT hoan kho theo Trung tam - don vi GIO (chinh xac nho MUTATION_TIME)
  destroyChart('pickTatTt');
  const tt = c.tatTheoTt || { labels: [], gioTb: [], gioMax: [], soDong: [] };
  charts.pickTatTt = new Chart($('#chartPickTatTt'), {
    type: 'bar',
    data: {
      labels: tt.labels,
      datasets: [
        { label: 'TAT trung bình (giờ)', data: tt.gioTb, backgroundColor: cssVar('--series-1'), borderRadius: 4 },
        { label: 'Lâu nhất (giờ)', data: tt.gioMax, backgroundColor: cssVar('--warning'), borderRadius: 4 },
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
              const g = Number(it.parsed.y) || 0;
              const ngay = Math.round((g / 24) * 10) / 10;
              return `${it.dataset.label}: ${g} giờ (~${ngay} ngày)`;
            },
            footer: (items) => `Số dòng Return: ${tt.soDong[items[0].dataIndex] ?? 0}`,
          },
        },
      },
      scales: {
        x: d.common.scales.x,
        y: {
          ...d.common.scales.y, beginAtZero: true, grace: '8%',
          title: { display: true, text: 'Giờ', color: cssVar('--text-secondary') },
        },
      },
      onClick: chartDrill(tt.labels, 'department'),
    },
  });
}

async function loadPickslip() {
  const seq = ++pickLoadSeq;
  showError('');
  showLoading(true);
  setBusy('#pickPane', true);
  setTabLoading('.mainTab', 'pickslip', true);
  try {
    const data = await api('/api/pickslip');
    if (seq !== pickLoadSeq) return;
    $('#rangeLabel').textContent = `${data.range.label}: ${fmtDateTime(data.range.from)} → ${fmtRangeEnd(data.range.to)}`;
    renderPickKpis(data.kpis);
    renderPickCharts(data.charts);
    renderScanBar('#pickScanBar', data.scanFolder);
    $('#pickDesc').textContent =
      'PICKSLIP_BOOKED × PICKSLIP_HEADER. Kỳ theo PICKSLIP_DATE (ngày AMOS); đơn vị đếm là SỐ DÒNG. '
      + 'Cancel / Return phân biệt bằng ĐUÔI của PICKSLIP_TEXT (…cancel · …cancel booking · …return) kèm QTY_CANCELED ≠ 0. '
      + 'Đã áp bộ lọc nghiệp vụ: QTY_BOOKED ≠ 0, STATUS ∉ {1, 11}, LOCATION_FROM không chứa “U/S”, STORE thuộc MAIN/VNA. '
      + 'Cột Scan đối chiếu file PDF trong thư mục scan; TAT return = số ngày từ ngày xuất kho đến ngày trả về kho (HISTORY, VM ∈ EA/TC). '
      + '⚠ Thẻ KPI “Đã scan / Chưa scan” đếm theo PHIẾU (một picking list nhiều dòng chỉ cần một file) và tính trên TOÀN KỲ; '
      + 'bảng chi tiết bên dưới đếm theo DÒNG và bị cắt ở MAX_ROWS, nên hai con số không nhất thiết bằng nhau.';
    pickTotalRows = data.count;
    $('#pickCount').textContent =
      `${data.count.toLocaleString('vi')} dòng` + (data.truncated ? ' ⚠ chạm giới hạn MAX_ROWS' : '');
    if (!pickTable) {
      pickTable = new Tabulator('#pickTable', {
        data: data.rows,
        columns: withHeaderFilters(COLS_PICKSLIP),
        layout: 'fitDataFill',
        pagination: false,
        placeholder: 'Không có dữ liệu',
        height: '600px',
      });
      pickTable.on('dataFiltered', (filters, rowsFiltered) => {
        const n = rowsFiltered.length;
        $('#pickCount').textContent = n === pickTotalRows
          ? `${pickTotalRows.toLocaleString('vi')} dòng`
          : `${n.toLocaleString('vi')}/${pickTotalRows.toLocaleString('vi')} dòng`;
      });
    } else {
      pickTable.replaceData(data.rows);
      pickTable.redraw(true);
    }
    pickTable.setFilter(pickCancelFilter);
  } catch (err) {
    showError(err.message);
  } finally {
    showLoading(false);
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
      + 'giữ nguyên “R-259454.pdf” (SGN) hoặc bỏ tiền tố “259454.pdf” (HAN). “—” = không đọc được thư mục.',
    formatter: fmtScanCell,
  },
  { title: 'Ngày nhập', field: 'del_date', formatter: fmtDateCell, width: 110 },
  { title: 'Voucher', field: 'voucherno', headerFilter: 'input', width: 120 },
  {
    title: 'Tên file scan', field: 'voucher_scan', headerFilter: 'input', width: 190,
    headerTooltip: 'Đã tìm thấy → tên file thật trong thư mục. Chưa thấy → liệt kê CẢ HAI dạng '
      + 'chấp nhận được (mỗi station đặt tên một kiểu: HAN bỏ tiền tố “R-”, SGN giữ nguyên).',
  },
  { title: 'Part No', field: 'partno', headerFilter: 'input' },
  { title: 'Serial', field: 'serialno', headerFilter: 'input' },
  { title: 'Batch', field: 'batchno', headerFilter: 'input', width: 100 },
  { title: 'SL', field: 'qty', hozAlign: 'right', sorter: 'number', width: 70 },
  { title: 'Tình trạng', field: 'tinh_trang', headerFilter: 'input', width: 100 },
  { title: 'Station', field: 'station', headerFilter: 'input', width: 90 },
  { title: 'Store', field: 'store', headerFilter: 'input', width: 100 },
  { title: 'Location', field: 'location', headerFilter: 'input', width: 110 },
  { title: 'PSN', field: 'psn', headerFilter: 'input' },
  { title: 'Label', field: 'labelno', headerFilter: 'input' },
  { title: 'Mat class', field: 'mat_class', headerFilter: 'input', width: 100 },
  { title: 'Order No', field: 'orderno', headerFilter: 'input' },
  { title: 'Ngày order', field: 'orderdate', formatter: fmtDateCell, width: 110 },
  { title: 'Owner', field: 'owner', headerFilter: 'input', width: 90 },
  { title: 'Người tạo', field: 'created_by', headerFilter: 'input' },
  { title: 'History No', field: 'historyno', formatter: fmtIntCell, hozAlign: 'right' },
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
    { label: 'Dòng nhập kho', value: k.soDong, unit: 'dòng', accent: '--series-1' },
    { label: 'Số voucher', value: k.soPhieu, unit: 'phiếu', accent: '--series-3' },
    {
      label: 'Đã scan', value: `${k.daScan}/${k.tongPhieuScan}`, unit: `phiếu (${k.tyLeScan ?? 0}%)`,
      accent: (k.chuaScan === 0 && k.tongPhieuScan > 0) ? '--good' : '--warning',
      title: 'Số VOUCHER đã có file PDF trong thư mục scan, tính trên TOÀN KỲ '
        + '(không phụ thuộc bảng chi tiết bên dưới — bảng đó bị cắt ở MAX_ROWS). '
        + 'Yêu cầu nghiệp vụ: phải đạt 100%.',
    },
    {
      label: 'Chưa scan', value: k.chuaScan, unit: 'phiếu', accent: k.chuaScan ? '--critical' : '--good',
      title: 'Số VOUCHER chưa tìm thấy file PDF. Đếm theo PHIẾU (một voucher nhiều dòng '
        + 'chỉ cần một file), tính trên toàn kỳ. Đây là số file thực sự còn phải scan.',
    },
    {
      label: 'Phiếu bị hủy nhập', value: k.b1BiHuy, unit: 'dòng', accent: '--warning',
      title: 'Dòng B1 có RECDETAILNO_I trùng với một dòng CR → đã bị hủy nhập, KHÔNG tính vào báo cáo.',
    },
    {
      label: 'B1 thô trong kỳ', value: k.b1Tho, unit: 'dòng', accent: '--text-muted',
      title: 'Số dòng VM = B1 lấy về trước khi lọc (station / condition / store / location).',
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
      datasets: [{ label: 'Số dòng nhập', data: c.byDay.values, backgroundColor: cssVar('--series-2'), borderRadius: 3 }],
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
  setBusy('#recvPane', true);
  setTabLoading('.mainTab', 'receiving', true);
  try {
    const data = await api('/api/receiving');
    if (seq !== recvLoadSeq) return;
    $('#rangeLabel').textContent = `${data.range.label}: ${fmtDateTime(data.range.from)} → ${fmtRangeEnd(data.range.to)}`;
    renderRecvKpis(data.kpis);
    renderRecvCharts(data.charts);
    renderScanBar('#recvScanBar', data.scanFolder);
    $('#recvDesc').textContent =
      'HISTORY với VM = B1 (phiếu nhập kho), kỳ theo DEL_DATE (ngày AMOS). '
      + 'Đã LOẠI các dòng B1 có RECDETAILNO_I trùng với dòng VM = CR (phiếu nhập đã bị hủy). '
      + 'Bộ lọc: STATION chứa station đang chọn, CONDITION không chứa “us”, STORE thuộc MAIN/VNA, '
      + 'loại riêng STORE = MAIN có LOCATION là SHOPLOC hoặc LG5. '
      + 'Thống kê theo STATION và STORE (nhập kho không quy về Trung tâm). '
      + 'Cột Scan đối chiếu file PDF trùng VOUCHERNO — chấp nhận cả “R-259454.pdf” (SGN) lẫn “259454.pdf” (HAN). '
      + '⚠ Thẻ KPI và biểu đồ “Đã scan / Chưa scan” đếm theo PHIẾU (voucher) và tính trên TOÀN KỲ; '
      + 'bảng chi tiết bên dưới đếm theo DÒNG và bị cắt ở MAX_ROWS.';
    recvTotalRows = data.count;
    $('#recvCount').textContent =
      `${data.count.toLocaleString('vi')} dòng` + (data.truncated ? ' ⚠ chạm giới hạn MAX_ROWS' : '');
    if (!recvTable) {
      recvTable = new Tabulator('#recvTable', {
        data: data.rows,
        columns: withHeaderFilters(COLS_RECEIVING),
        layout: 'fitDataFill',
        pagination: false,
        placeholder: 'Không có dữ liệu',
        height: '600px',
      });
      recvTable.on('dataFiltered', (filters, rowsFiltered) => {
        const n = rowsFiltered.length;
        $('#recvCount').textContent = n === recvTotalRows
          ? `${recvTotalRows.toLocaleString('vi')} dòng`
          : `${n.toLocaleString('vi')}/${recvTotalRows.toLocaleString('vi')} dòng`;
      });
    } else {
      recvTable.replaceData(data.rows);
      recvTable.redraw(true);
    }
    recvTable.setFilter(recvFilter);
  } catch (err) {
    showError(err.message);
  } finally {
    showLoading(false);
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
    state.station = saved.station || '';
    state.store = normStores(saved.store);
    state.department = saved.department || '';
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
    if (urlQ.has('station')) state.station = urlQ.get('station');
    if (urlQ.has('store')) state.store = normStores(urlQ.get('store'));
    if (urlQ.has('department')) state.department = urlQ.get('department');
    state.excludeCC = urlQ.get('excludeCC') === '1';
    state.excludeCab = urlQ.get('excludeCab') === '1';
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
    // Dua filter len URL -> copy link gui dong nghiep la ho thay dung man hinh nay
    history.replaceState(null, '', `${location.pathname}?${buildQuery()}`);
    reportCache.clear();
    if (!LGC_ONLY) loadDashboard();
    if (!$('#tab-reports').classList.contains('hidden')) loadReport(state.currentReport);
    resetLgc(); // LGC khong tu chay lai - nguoi dung bam "Chay kiem tra"
  };
  window.__applyFilters = applyFilters; // cho drill-down tu bieu do (chartDrill)

  // Inputs: doi xong la load ngay
  $('#monthInput').addEventListener('change', (e) => { state.month = e.target.value; applyFilters(); });
  $('#weekInput').addEventListener('change', (e) => { state.week = e.target.value; applyFilters(); });
  $('#quarterInput').addEventListener('change', (e) => { state.quarter = e.target.value; applyFilters(); });
  $('#yearInput').addEventListener('change', (e) => { state.year = e.target.value; applyFilters(); });
  $('#stationSelect').addEventListener('change', (e) => { state.station = e.target.value; applyFilters(); });
  initStoreMulti(applyFilters);
  $('#deptSelect').addEventListener('change', (e) => { state.department = e.target.value; applyFilters(); });
  // Checkbox "Bo qua xuat costcenter": loai receiver la so roi tinh lai KPI/bieu do tu server
  $('#ccToggle').addEventListener('change', (e) => { state.excludeCC = e.target.checked; applyFilters(); });
  // Checkbox "Bo qua cac kho CAB": loai han cac kho CAB/CAB-TD/P-THA/P-SAF/P-PAN
  $('#cabToggle').addEventListener('change', (e) => {
    state.excludeCab = e.target.checked;
    renderStoreMenu(); // ve lai de nhan "dang bo qua" trong menu kho cho dung
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
  await loadFilters(); // doi nap xong option roi moi khoi phuc gia tri da luu
  $('#stationSelect').value = state.station;
  $('#deptSelect').value = state.department;
  if (!LGC_ONLY) loadDashboard();
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
