/**
 * ============================================================================
 *  demo-data.js  -  Du lieu MAU cho DEMO_MODE
 *  Cho phep chay thu toan bo giao dien khi CHUA co ket noi SQL Server.
 *  (Khi DEMO_MODE=false, file nay khong duoc su dung.)
 * ============================================================================
 */
'use strict';

const STATIONS = ['SGN', 'HAN', 'DAD'];
const STORES = ['S01', 'S02', 'S03'];
const DEPARTMENTS = ['PA', 'CUVT', 'DIEN', 'AVIONICS', 'CANOPY', 'HYDRAULIC'];
const AC = ['VN-A321', 'VN-A350', 'VN-B787', 'VN-A320'];

function rnd(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function rndInt(a, b) {
  return Math.floor(a + Math.random() * (b - a + 1));
}
/** Ngay ngau nhien trong khoang [from, to). Chap nhan Date hoac chuoi. */
function rndDate(from, to) {
  const f = new Date(from).getTime();
  const t2 = new Date(to).getTime();
  const t = f + Math.random() * (t2 - f);
  return new Date(t);
}
function pad(n) {
  return String(n).padStart(3, '0');
}

/** Sinh 1 dong thiet bi co san cac truong chung. */
function baseDevice(i) {
  return {
    partno: 'PN-' + pad(rndInt(100, 999)),
    serialno: 'SN' + rndInt(10000, 99999),
    labelno: 'L' + rndInt(1000, 9999),
    description: rnd(['VALVE', 'PUMP', 'SENSOR', 'ACTUATOR', 'LIGHT UNIT', 'CONTROLLER']),
    station: rnd(STATIONS),
    store: rnd(STORES),
    ac_registr: rnd(AC),
  };
}

/** Loc theo filter chung. */
function applyFilter(rows, f) {
  return rows.filter((r) => {
    if (f.station && r.station !== f.station) return false;
    if (f.store && r.store !== f.store) return false;
    if (f.department && r.department !== f.department) return false;
    return true;
  });
}

// --- Cac bo sinh du lieu theo tung API ---

function tatDepartments(range, f) {
  const rows = [];
  for (let i = 0; i < 120; i++) {
    const d = baseDevice(i);
    const issue = rndDate(range.from, range.to);
    const tat = +(Math.random() * 72 + 1).toFixed(1);
    const ret = new Date(issue.getTime() + tat * 3600 * 1000);
    rows.push({
      ...d,
      voucher_issue: 'P-' + rndInt(10000, 99999),
      department: rnd(DEPARTMENTS),
      issue_time_vn: issue.toISOString(),
      return_unservice_time: ret.toISOString(),
      tat_hours: tat,
    });
  }
  return applyFilter(rows, f);
}

function tatCuvt(range, f) {
  const rows = [];
  for (let i = 0; i < 80; i++) {
    const d = baseDevice(i);
    const del = rndDate(range.from, range.to);
    const tat = +(Math.random() * 48 + 0.5).toFixed(1);
    const rec = new Date(del.getTime() + tat * 3600 * 1000);
    rows.push({
      ...d,
      department: 'CUVT',
      return_unservice_time: del.toISOString(),
      receive_unservice_time: rec.toISOString(),
      tat_hours: tat,
    });
  }
  return applyFilter(rows, f);
}

function returnStoreTat(range, f) {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const d = baseDevice(i);
    const issue = rndDate(range.from, range.to);
    const tat = +(Math.random() * 200 + 5).toFixed(1);
    const ret = new Date(issue.getTime() + tat * 3600 * 1000);
    rows.push({
      ...d,
      voucher_issue: 'P-' + rndInt(10000, 99999),
      voucher_return: 'P-CA-' + rndInt(10000, 99999),
      department: rnd(DEPARTMENTS),
      issue_time_vn: issue.toISOString(),
      return_store_time_vn: ret.toISOString(),
      tat_hours: tat,
    });
  }
  return applyFilter(rows, f);
}

function issuedNotInstalled(range, f) {
  const rows = [];
  for (let i = 0; i < 45; i++) {
    const d = baseDevice(i);
    rows.push({
      ...d,
      voucher_issue: 'P-' + rndInt(10000, 99999),
      department: rnd(DEPARTMENTS),
      issue_time_vn: rndDate(range.from, range.to).toISOString(),
    });
  }
  return applyFilter(rows, f);
}

function removedNotReturned(range, f) {
  const rows = [];
  for (let i = 0; i < 35; i++) {
    const d = baseDevice(i);
    rows.push({
      partno: d.partno,
      serialno: d.serialno,
      labelno: d.labelno,
      historyno: 'H' + rndInt(100000, 999999),
      station: d.station,
      store: d.store,
      ac_registr: d.ac_registr,
      removed_time_vn: rndDate(range.from, range.to).toISOString(),
    });
  }
  return applyFilter(rows, f);
}

function notReconciled(range, f) {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const d = baseDevice(i);
    rows.push({
      ...d,
      voucher_issue: 'P-' + rndInt(10000, 99999),
      department: rnd(DEPARTMENTS),
      issue_time_vn: rndDate(range.from, range.to).toISOString(),
    });
  }
  return applyFilter(rows, f);
}

function removedBeforeInstalled(range, f) {
  const rows = [];
  for (let i = 0; i < 25; i++) {
    const d = baseDevice(i);
    const removed = rndDate(range.from, range.to);
    const tat = +(Math.random() * 24 + 0.5).toFixed(1);
    const installed = new Date(removed.getTime() + tat * 3600 * 1000);
    rows.push({
      partno: d.partno,
      serialno: d.serialno,
      labelno: d.labelno,
      station: d.station,
      store: d.store,
      ac_registr: d.ac_registr,
      removed_time_vn: removed.toISOString(),
      installed_time_vn: installed.toISOString(),
      tat_hours: tat,
    });
  }
  return applyFilter(rows, f);
}

function other(range, f) {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const d = baseDevice(i);
    rows.push({
      partno_off: d.partno,
      serialno_off: d.serialno,
      batchno_off: 'B' + rndInt(1000, 9999),
      qty_off: rndInt(1, 5),
      station: d.station,
      department: rnd(DEPARTMENTS),
      del_staff: 'NV' + rndInt(100, 999),
      del_time: rndDate(range.from, range.to).toISOString(),
      note: rnd(['Kiem tra lai', 'Cho vat tu', 'Hong nang', 'Chuyen xuong', 'Ghi chu khac']),
    });
  }
  return applyFilter(rows, f);
}

function filters() {
  return { stations: STATIONS, stores: STORES, departments: DEPARTMENTS };
}

/** Dashboard mau (dung lai logic tong hop don gian). */
function dashboard(range, f) {
  const dept = tatDepartments(range, f);
  const cuvt = tatCuvt(range, f);
  const ret = returnStoreTat(range, f);
  const ni = issuedNotInstalled(range, f);
  const nr = notReconciled(range, f);

  const avg = (a, s) => {
    const v = a.map(s).filter((x) => isFinite(x));
    return v.length ? v.reduce((p, c) => p + c, 0) / v.length : 0;
  };
  const r1 = (n) => Math.round(n * 10) / 10;

  const groupAvg = (arr, k, v) => {
    const m = new Map();
    arr.forEach((r) => {
      const key = r[k] || '(trong)';
      if (!m.has(key)) m.set(key, { s: 0, c: 0 });
      m.get(key).s += r[v];
      m.get(key).c += 1;
    });
    return [...m.entries()].map(([key, g]) => ({ key, avg: g.s / g.c, count: g.c }));
  };
  const byDept = groupAvg(dept, 'department', 'tat_hours').sort((a, b) => b.avg - a.avg);
  const byStationMap = new Map();
  dept.forEach((r) => byStationMap.set(r.station, (byStationMap.get(r.station) || 0) + 1));
  const byDayMap = new Map();
  dept.forEach((r) => {
    const day = r.return_unservice_time.slice(0, 10);
    if (!byDayMap.has(day)) byDayMap.set(day, { s: 0, c: 0 });
    byDayMap.get(day).s += r.tat_hours;
    byDayMap.get(day).c += 1;
  });
  const days = [...byDayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const top = [...byDept].sort((a, b) => b.count - a.count).slice(0, 10);

  return {
    range: { from: range.from, to: range.to, label: range.label },
    kpis: {
      tatDeptAvg: r1(avg(dept, (d) => d.tat_hours)),
      tatCuvtAvg: r1(avg(cuvt, (d) => d.tat_hours)),
      tatReturnStoreAvg: r1(avg(ret, (d) => d.tat_hours)),
      countIssued: dept.length + nr.length,
      countNotReconciled: nr.length,
      countIssuedNotInstalled: ni.length,
      reconcileRate: dept.length + nr.length ? r1((dept.length / (dept.length + nr.length)) * 100) : 0,
    },
    charts: {
      barDept: { labels: byDept.map((x) => x.key), values: byDept.map((x) => r1(x.avg)), counts: byDept.map((x) => x.count) },
      pieStation: { labels: [...byStationMap.keys()], values: [...byStationMap.values()] },
      lineDay: { labels: days.map((d) => d[0]), values: days.map((d) => r1(d[1].s / d[1].c)) },
      top10: { labels: top.map((x) => x.key), values: top.map((x) => x.count), tat: top.map((x) => r1(x.avg)) },
    },
  };
}

module.exports = {
  filters,
  dashboard,
  tatDepartments,
  tatCuvt,
  returnStoreTat,
  issuedNotInstalled,
  removedNotReturned,
  notReconciled,
  removedBeforeInstalled,
  other,
};
