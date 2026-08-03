/**
 * ============================================================================
 *  demo-data.js  -  Du lieu MAU cho DEMO_MODE
 *  Cho phep chay thu toan bo giao dien khi CHUA co ket noi SQL Server.
 *  (Khi DEMO_MODE=false, file nay khong duoc su dung.)
 * ============================================================================
 */
'use strict';

const STATIONS = ['SGN', 'HAN', 'DAD', 'CXR', 'VII']; // CXR/VII = station phu -> gom vao "Khac"
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
    staff: 'VAE' + rndInt(10000, 99999),
  };
}

/** Receiver mau: lan lon so tau (co chu cai) va costcenter (so thuan / 2 chu so). */
const RECEIVERS = ['VN-A321', 'VN-A868', 'VN-B787', '15', '25', '1234', '12.5'];

/** Receiver la "xuat costcenter"? = co chu so va CHI gom chu so + dau . , */
function isCostcenterReceiver(rcv) {
  const s = String(rcv || '').trim();
  return /[0-9]/.test(s) && /^[0-9.,]+$/.test(s);
}

/** Loc theo filter chung. station='OTHER' = ngoai HAN/SGN/DAD. */
function applyFilter(rows, f) {
  const MAIN = ['HAN', 'SGN', 'DAD'];
  return rows.filter((r) => {
    if (f.station) {
      if (f.station.toUpperCase() === 'OTHER') {
        if (MAIN.includes((r.station || '').toUpperCase())) return false;
      } else if (r.station !== f.station) return false;
    }
    if (f.store && r.store !== f.store) return false;
    if (f.department && r.department !== f.department) return false;
    // Checkbox "Bo qua xuat costcenter" (chi tac dong dong co truong receiver)
    if (f.excludeCC && 'receiver' in r && isCostcenterReceiver(r.receiver)) return false;
    return true;
  });
}

// --- Cac bo sinh du lieu theo tung API ---

function tatDepartments(range, f) {
  const rows = [];
  for (let i = 0; i < 120; i++) {
    const d = baseDevice(i);
    const issue = rndDate(range.from, range.to);
    const tat = +(Math.random() * 5 + 0.1).toFixed(1); // ngay (tong xuat->tra US)
    const ret = new Date(issue.getTime() + tat * 86400000);
    // Cac moc trung gian: lap (sau xuat), thao (truoc tra US). ~15% dong thieu su kien.
    const hasInstall = Math.random() > 0.15;
    const hasRemoval = Math.random() > 0.15;
    const install = hasInstall ? new Date(issue.getTime() + Math.random() * tat * 0.4 * 86400000) : null;
    const removal = hasRemoval ? new Date(ret.getTime() - Math.random() * tat * 0.4 * 86400000) : null;
    rows.push({
      ...d,
      event_perf: 'E' + rndInt(100000, 999999),
      receiver: rnd(RECEIVERS),
      partno_off: 'PN-' + pad(rndInt(100, 999)),
      serialno_off: 'SN' + rndInt(10000, 99999),
      voucher_issue: 'P-' + rndInt(10000, 99999),
      picking_li: 'PL-' + rndInt(10000, 99999),
      department: rnd(DEPARTMENTS),
      issue_time_vn: issue.toISOString(),
      installed_time_vn: install ? install.toISOString() : null,
      removed_time_vn: removal ? removal.toISOString() : null,
      return_unservice_time: ret.toISOString(),
      tat_days: tat,
      tat_install_days: install ? +((install - issue) / 86400000).toFixed(1) : null,
      tat_usreturn_days: removal ? +((ret - removal) / 86400000).toFixed(1) : null,
      // ~20% dong doi ung kieu TRA SERVICE (recertify CI @SHOPLOC thay vi tra US)
      return_type: Math.random() > 0.8 ? 'SERVICE' : 'US',
    });
  }
  return applyFilter(rows, f);
}

function tatCuvt(range, f) {
  const rows = [];
  for (let i = 0; i < 80; i++) {
    const d = baseDevice(i);
    const del = rndDate(range.from, range.to);
    const tat = +(Math.random() * 2 + 0.05).toFixed(1); // ngay
    const rec = new Date(del.getTime() + tat * 86400000);
    rows.push({
      ...d,
      department: 'CUVT',
      return_unservice_time: del.toISOString(),
      receive_unservice_time: rec.toISOString(),
      tat_days: tat,
    });
  }
  return applyFilter(rows, f);
}

function returnStoreTat(range, f) {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const d = baseDevice(i);
    const issue = rndDate(range.from, range.to);
    const tat = +(Math.random() * 10 + 0.5).toFixed(1); // ngay
    const ret = new Date(issue.getTime() + tat * 86400000);
    rows.push({
      ...d,
      voucher_issue: 'P-' + rndInt(10000, 99999),
      picking_li: 'PL-' + rndInt(10000, 99999),
      department: rnd(DEPARTMENTS),
      issue_time_vn: issue.toISOString(),
      return_store_time_vn: ret.toISOString(),
      tat_days: tat,
    });
  }
  return applyFilter(rows, f);
}

function issuedNotInstalled(range, f) {
  const rows = [];
  for (let i = 0; i < 45; i++) {
    const d = baseDevice(i);
    const issue = rndDate(range.from, range.to);
    rows.push({
      ...d,
      voucher_issue: 'P-' + rndInt(10000, 99999),
      department: rnd(DEPARTMENTS),
      issue_time_vn: issue.toISOString(),
      tat_days: +((Date.now() - issue.getTime()) / 86400000).toFixed(1),
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
      staff: d.staff,
      station: d.station,
      store: d.store,
      ac_registr: d.ac_registr,
      removed_time_vn: rndDate(range.from, range.to).toISOString(),
    });
  }
  return applyFilter(rows, f);
}

function returnedUnservice(range, f) {
  const rows = [];
  for (let i = 0; i < 50; i++) {
    const d = baseDevice(i);
    const del = rndDate(range.from, range.to);
    rows.push({
      partno: d.partno,
      serialno: d.serialno,
      labelno: d.labelno,
      description: d.description,
      historyno: 'H' + rndInt(100000, 999999),
      staff: d.staff,
      ac_registr: d.ac_registr,
      station: d.station,
      store: d.store,
      department: rnd(DEPARTMENTS),
      del_staff: 'NV' + rndInt(100, 999),
      del_time: del.toISOString(),
      reci_time: Math.random() > 0.3 ? new Date(del.getTime() + rndInt(1, 48) * 3600000).toISOString() : null,
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
      picking_li: 'PL-' + rndInt(10000, 99999),
      department: rnd(DEPARTMENTS),
      issue_time_vn: rndDate(range.from, range.to).toISOString(),
      tat_days: +(Math.random() * 20 + 1).toFixed(1),
    });
  }
  return applyFilter(rows, f);
}

function removedBeforeInstalled(range, f) {
  const rows = [];
  for (let i = 0; i < 25; i++) {
    const d = baseDevice(i);
    // Logic "thao truoc lap sau": THAO -> LAP -> XUAT KHO (phieu lam sau)
    const removal = rndDate(range.from, range.to);
    const install = new Date(removal.getTime() + rndInt(0, 2) * 86400000 + 3600000);
    const issue = new Date(install.getTime() + rndInt(1, 10) * 86400000);
    const ret = new Date(removal.getTime() + rndInt(1, 3) * 86400000);
    rows.push({
      labelno: d.labelno,
      partno: d.partno,
      serialno: d.serialno,
      description: d.description,
      staff: d.staff,
      partno_removed: 'PN-' + pad(rndInt(100, 999)),
      serialno_removed: 'SN' + rndInt(10000, 99999),
      ac_registr: d.ac_registr,
      department: rnd(DEPARTMENTS),
      station: d.station,
      issue_time_vn: issue.toISOString(),
      installed_time_vn: install.toISOString(),
      removed_time_vn: removal.toISOString(),
      return_unservice_time: ret.toISOString(),
      tat_issue_install_days: +((issue - install) / 86400000).toFixed(1),
      tat_removal_return_days: +((ret - removal) / 86400000).toFixed(1),
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
      staff: d.staff,
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
  return { stations: ['HAN', 'SGN', 'DAD', 'OTHER'], stores: STORES, departments: DEPARTMENTS };
}

/** Tra cuu lich su booking mau cho 1 thiet bi (dung cho chatbot o DEMO_MODE). */
function deviceLookup(term) {
  const vms = ['YE', 'YA', 'T', 'TC', 'CI', 'B1'];
  const now = Date.now();
  const rows = [];
  const n = 6 + rndInt(0, 8);
  for (let i = 0; i < n; i++) {
    rows.push({
      vm: rnd(vms),
      voucherno: 'P-' + rndInt(100000, 999999),
      labelno: /^[0-9]+$/.test(String(term)) ? term : 'L' + rndInt(1000, 9999),
      partno: /[a-z]/i.test(String(term)) ? term : 'PN-' + pad(rndInt(100, 999)),
      serialno: 'SN' + rndInt(10000, 99999),
      time: new Date(now - i * 86400000 * rndInt(1, 20)).toISOString(),
      ac_registr: rnd(AC),
      station: rnd(STATIONS),
    });
  }
  return rows;
}

/** Dashboard mau (dung lai logic tong hop don gian). */
function dashboard(range, f) {
  const dept = tatDepartments(range, f);
  const cuvt = tatCuvt(range, f);
  const ret = returnStoreTat(range, f);
  const ni = issuedNotInstalled(range, f);
  const nr = notReconciled(range, f);
  const retUS = returnedUnservice(range, f);

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
  // Trung binh tach 2 thanh phan theo Trung tam, bo qua dong thieu (null)
  const grp2 = (arr) => {
    const m = new Map();
    arr.forEach((r) => {
      const key = r.department || '(trong)';
      if (!m.has(key)) m.set(key, { si: 0, ci: 0, su: 0, cu: 0, c: 0 });
      const g = m.get(key);
      g.c += 1;
      if (isFinite(r.tat_install_days) && r.tat_install_days != null) { g.si += r.tat_install_days; g.ci += 1; }
      if (isFinite(r.tat_usreturn_days) && r.tat_usreturn_days != null) { g.su += r.tat_usreturn_days; g.cu += 1; }
    });
    return [...m.entries()].map(([key, g]) => ({
      key, count: g.c,
      avgI: g.ci ? g.si / g.ci : 0, cntI: g.ci,
      avgU: g.cu ? g.su / g.cu : 0, cntU: g.cu,
    }));
  };
  // KPI/bieu do TAT install & US return: KHONG gom CUVT (giong server that)
  const byDept2 = grp2(dept.filter((r) => r.department !== 'CUVT')).sort((a, b) => b.avgI - a.avgI);
  const wavg = (arr, aF, cF) => {
    const c = arr.reduce((s, x) => s + x[cF], 0);
    return c ? arr.reduce((s, x) => s + x[aF] * x[cF], 0) / c : 0;
  };
  const byRet = groupAvg(ret, 'department', 'tat_days').sort((a, b) => b.avg - a.avg);
  const MAIN = ['HAN', 'SGN', 'DAD'];
  const stMap = new Map([...MAIN, 'OTHER'].map((s) => [s, 0]));
  dept.forEach((r) => {
    const k = MAIN.includes((r.station || '').toUpperCase()) ? r.station.toUpperCase() : 'OTHER';
    stMap.set(k, (stMap.get(k) || 0) + 1);
  });
  const pieOrder = [...MAIN, 'OTHER'];
  // So luong xuat kho & tra unservice theo trung tam
  const issuedCnt = new Map();
  [...dept, ...nr].forEach((r) => issuedCnt.set(r.department, (issuedCnt.get(r.department) || 0) + 1));
  const returnedCnt = new Map();
  retUS.forEach((r) => returnedCnt.set(r.department, (returnedCnt.get(r.department) || 0) + 1));
  const volLabels = [...new Set([...issuedCnt.keys(), ...returnedCnt.keys()])].sort(
    (a, b) => (issuedCnt.get(b) || 0) - (issuedCnt.get(a) || 0)
  );

  // TAT CUVT theo tung trung tam (chang 3) - de xep chong vao bieu do cot
  const cuvtByDept = new Map();
  {
    const m = new Map();
    cuvt.forEach((d) => {
      const g = m.get(d.department) || { s: 0, c: 0 };
      if (isFinite(d.tat_days)) { g.s += d.tat_days; g.c++; }
      m.set(d.department, g);
    });
    for (const [k, g] of m) cuvtByDept.set(k, g.c ? r1(g.s / g.c) : 0);
  }
  const stackTotal = (x) => (x.avgI || 0) + (x.avgU || 0) + (cuvtByDept.get(x.key) || 0);
  const byDeptStack = [...byDept2].sort((a, b) => stackTotal(b) - stackTotal(a));

  const kInstall = r1(wavg(byDept2, 'avgI', 'cntI'));
  const kUsret = r1(wavg(byDept2, 'avgU', 'cntU'));
  const kCuvt = r1(avg(cuvt, (d) => d.tat_days));

  return {
    range: { from: range.from, to: range.to, label: range.label },
    kpis: {
      tatInstallAvg: kInstall,
      tatUsReturnAvg: kUsret,
      tatCuvtAvg: kCuvt,
      tatTotalAvg: r1(kInstall + kUsret + kCuvt),
      tatReturnStoreAvg: r1(avg(ret, (d) => d.tat_days)),
      countIssued: dept.length + nr.length,
      countNotReconciled: nr.length,
      cntReci: cuvt.length,
      cntDel: retUS.length,
      countIssuedNotInstalled: ni.length,
      reconcileRate: dept.length + nr.length ? r1((dept.length / (dept.length + nr.length)) * 100) : 0,
    },
    charts: {
      barDept: {
        labels: byDeptStack.map((x) => x.key),
        install: byDeptStack.map((x) => r1(x.avgI)),
        usret: byDeptStack.map((x) => r1(x.avgU)),
        cuvt: byDeptStack.map((x) => cuvtByDept.get(x.key) || 0),
        total: byDeptStack.map((x) => r1(stackTotal(x))),
        counts: byDeptStack.map((x) => x.count),
      },
      pieStation: { labels: pieOrder.map((s) => (s === 'OTHER' ? 'Khác' : s)), values: pieOrder.map((s) => stMap.get(s) || 0) },
      deptVolume: {
        labels: volLabels,
        issued: volLabels.map((k) => issuedCnt.get(k) || 0),
        returned: volLabels.map((k) => returnedCnt.get(k) || 0),
      },
      retStoreDept: { labels: byRet.map((x) => x.key), values: byRet.map((x) => r1(x.avg)), counts: byRet.map((x) => x.count) },
    },
  };
}

/** Trang thai doi ung mau cho 1 thiet bi (dung cho chatbot o DEMO_MODE). */
function reconcileStatus(term) {
  const now = Date.now();
  const n = 2 + rndInt(0, 3);
  const rows = [];
  for (let i = 0; i < n; i++) {
    // Ngau nhien 1 trong cac trang thai (dong dau uu tien "chua doi ung" de de thay)
    const roll = i === 0 ? rndInt(0, 4) : rndInt(1, 4);
    const issue = new Date(now - i * 86400000 * rndInt(10, 60));
    rows.push({
      labelno: /^[0-9]+$/.test(String(term)) ? term : 'L' + rndInt(1000, 9999),
      partno: /[a-z]/i.test(String(term)) ? term : 'PN-' + pad(rndInt(100, 999)),
      serialno: 'SN' + rndInt(10000, 99999),
      voucherno: 'P-' + rndInt(100000, 999999),
      issue_time_vn: issue.toISOString(),
      // Chi tiet: tra unservice (SN + gio) / tra service (gio recertify)
      us_part: roll === 1 ? 'PN-' + pad(rndInt(100, 999)) : null,
      us_serial: roll === 1 ? 'SN' + rndInt(10000, 99999) : null,
      us_del_time: roll === 1 ? new Date(issue.getTime() + rndInt(1, 40) * 86400000).toISOString() : null,
      svc_serial: roll === 2 ? 'SN' + rndInt(10000, 99999) : null,
      svc_recert_time: roll === 2 ? new Date(issue.getTime() + rndInt(1, 40) * 86400000).toISOString() : null,
      has_return: roll === 3 ? 1 : 0,
      cancelled: roll === 4 ? 1 : 0,
    });
  }
  return rows;
}

/** Doi ung NGUOC mau: hoi ve 1 SN unservice -> phieu xuat doi ung. */
function reconcileReverse(term) {
  const now = Date.now();
  const n = 1 + rndInt(0, 2);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const del = new Date(now - i * 86400000 * rndInt(5, 40));
    const hasIssue = Math.random() > 0.2;
    rows.push({
      labelno: /^[0-9]+$/.test(String(term)) ? term : 'L' + rndInt(1000, 9999),
      returned_part: 'PN-' + pad(rndInt(100, 999)),
      returned_serial: /[a-z]/i.test(String(term)) ? term : 'SN' + rndInt(10000, 99999),
      voucher_s: 'P-' + rndInt(100000, 999999),
      del_time: del.toISOString(),
      issued_part: hasIssue ? 'PN-' + pad(rndInt(100, 999)) : null,
      issued_serial: hasIssue ? 'SN' + rndInt(10000, 99999) : null,
      issue_voucher: hasIssue ? 'P-' + rndInt(100000, 999999) : null,
      issue_time_vn: hasIssue ? new Date(del.getTime() - rndInt(1, 30) * 86400000).toISOString() : null,
    });
  }
  return rows;
}

/** Tra cuu Part On/Off mau (WO_PART_ON_OFF) - phuc vu xem giao dien che do DEMO.
 *  crit = { event, partno, serialno, labelno, partnoOff, serialnoOff } (o trong = bo qua). */
function partOnOff(crit) {
  const now = Date.now();
  const rows = [];
  const n = 3 + rndInt(0, 6);
  for (let i = 0; i < n; i++) {
    const t = new Date(now - i * 86400000 * rndInt(1, 30));
    rows.push({
      event_perfno_i: Number(crit.event) || rndInt(7000000, 9000000),
      partno: crit.partno || 'PN-' + pad(rndInt(100, 999)),
      serialno: crit.serialno || 'SN' + rndInt(10000, 99999),
      labelno: crit.labelno || String(rndInt(100000, 999999)),
      ac_position: rnd(['1L', '2R', '11A', '21C', 'DOOR2']),
      locid_pk: rnd(STATIONS) + '-STORE',
      partno_off: crit.partnoOff || 'PN-' + pad(rndInt(100, 999)),
      serialno_off: crit.serialnoOff || 'SN' + rndInt(10000, 99999),
      releaseno: 'REL' + rndInt(1000, 9999),
      mutator: 'USER' + rndInt(10, 99),
      status: rnd(['ON', 'OFF', 'RELEASED']),
      // Gia lap gio VN (server that ghep MUTATION+MUTATION_TIME): tra chuoi ISO-Z
      mutation_time_vn: t.toISOString(),
      created_by: 'USER' + rndInt(10, 99),
      // Chi co NGAY (nhu CREATED_DATE that - so ngay AMOS khong kem gio)
      created_date_vn: t.toISOString().slice(0, 10) + 'T00:00:00.000Z',
    });
  }
  return rows;
}

module.exports = {
  filters,
  deviceLookup,
  partOnOff,
  reconcileStatus,
  reconcileReverse,
  dashboard,
  tatDepartments,
  tatCuvt,
  returnStoreTat,
  issuedNotInstalled,
  removedNotReturned,
  returnedUnservice,
  notReconciled,
  removedBeforeInstalled,
  other,
};
