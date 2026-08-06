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
      // staff (tu baseDevice) = nguoi TRA US; issue_staff = nguoi LAP PHIEU XUAT
      issue_staff: 'VAE' + rndInt(10000, 99999),
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
      event_perf: rndInt(8600000, 8800000),   // so work order cua phieu xuat
      voucher_issue: 'P-' + rndInt(10000, 99999),
      department: rnd(DEPARTMENTS),
      issue_time_vn: issue.toISOString(),
      tat_days: +((Date.now() - issue.getTime()) / 86400000).toFixed(1),
      // ROTABLES (noi qua psn): vi tri hien tai (higher_pn/sn giu de dung noi bo)
      psn: rndInt(1000000, 1999999),
      location: rnd(['SHOPLOC', 'HANSTORE', 'SGNSTORE', 'AOG-DAD', 'WORKSHOP-01', '']),
      higher_pn: rnd(['', 'HPN-' + pad(rndInt(100, 999)), 'C20500100', '183304-0A07E']),
      higher_sn: rnd(['', 'HSN' + rndInt(1000, 9999), 'K1635728']),
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
      trung_tam: rnd(DEPARTMENTS),
      removed_time_vn: rndDate(range.from, range.to).toISOString(),
      // Vi tri HIEN TAI: store (LOCATION) + location (ROTABLES), noi qua psn
      psn: rndInt(1000000, 1999999),
      store_now: rnd(STORES),
      location: rnd(['SHOPLOC', 'HANSTORE', 'SGNSTORE', 'AOG-DAD', 'WORKSHOP-01', '']),
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

/** Thiet bi CHI CO MOT PHIA trong WO_PART_ON_OFF (chi ON hoac chi OFF). */
function removedBeforeInstalled(range, f) {
  const rows = [];
  for (let i = 0; i < 25; i++) {
    const d = baseDevice(i);
    const phia = i % 2 === 0 ? 'OFF' : 'ON';
    const t = rndDate(range.from, range.to);
    const coOnOff = rndInt(0, 3) > 0; // phan lon co su kien on_off
    const coPhieuXuat = phia === 'ON' && rndInt(0, 2) > 0;
    const daTraUS = phia === 'OFF' && rndInt(0, 3) === 0;
    rows.push({
      phia,
      partno: d.partno,
      serialno: d.serialno,
      labelno: d.labelno,
      event_perf: rndInt(8600000, 8800000),
      ac_position: rnd(['AP25', 'AP44', '28WR', '3DN', null]),
      thoi_diem_vn: t.toISOString(),
      created_by: d.staff,
      co_su_kien_on_off: coOnOff ? 'Có' : 'Không',
      voucher_issue: coPhieuXuat ? 'P-' + rndInt(300000, 399999) : null,
      issue_time_vn: coPhieuXuat ? new Date(t.getTime() - rndInt(1, 10) * 86400000).toISOString() : null,
      return_unservice_time: daTraUS ? new Date(t.getTime() + rndInt(1, 5) * 86400000).toISOString() : null,
      department: rnd(DEPARTMENTS),
      station: d.station,
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
      labelno: String(rndInt(100000, 999999)),
      voucher_issue: '',
      note: rnd(['NOI', 'ROB', 'DIR', 'CRO', 'SWP', 'Ghi chu khac']),
    });
  }
  // Giai ma ma ly do giong server that (NOI/ROB/DIR/CRO)
  const NAMES = { NOI: 'Không có phiếu xuất', SWP: 'Swap (hoán đổi thiết bị)',
    ROB: 'Robbery (tháo xuống trước)', DIR: 'Lắp thẳng từ kho', CRO: 'Repairable / consumable' };
  return applyFilter(rows, f).map((r) => {
    const m = /(^|[^A-Z])(NOI|SWP|ROB|DIR|CRO)([^A-Z]|$)/.exec(String(r.note).toUpperCase());
    const code = m ? m[2] : '';
    return { ...r, reason_code: code, reason_name: code ? NAMES[code] : 'Khác / chưa phân loại' };
  });
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
  // Dem TAT CA thiet bi xuat kho (da doi ung + chua doi ung) de khop bieu do cot
  [...dept, ...nr].forEach((r) => {
    const k = MAIN.includes((r.station || '').toUpperCase()) ? r.station.toUpperCase() : 'OTHER';
    stMap.set(k, (stMap.get(k) || 0) + 1);
  });
  const pieOrder = [...MAIN, 'OTHER'];
  // So luong xuat kho & tra unservice theo trung tam
  // Cot xep chong: da tra (dept) + chua tra (nr) = tong xuat kho
  const daTraCnt = new Map();
  dept.forEach((r) => daTraCnt.set(r.department, (daTraCnt.get(r.department) || 0) + 1));
  const chuaTraCnt = new Map();
  nr.forEach((r) => chuaTraCnt.set(r.department, (chuaTraCnt.get(r.department) || 0) + 1));
  const returnedCnt = new Map();
  retUS.forEach((r) => returnedCnt.set(r.department, (returnedCnt.get(r.department) || 0) + 1));
  const tongVol = (k) => (daTraCnt.get(k) || 0) + (chuaTraCnt.get(k) || 0);
  const volLabels = [...new Set([...daTraCnt.keys(), ...chuaTraCnt.keys()])].sort(
    (a, b) => tongVol(b) - tongVol(a)
  );
  // Bieu do tron theo trung tam: TAT CA thiet bi xuat kho (khop bieu do cot)
  const pieDeptLabels = volLabels.filter((k) => tongVol(k)).sort((a, b) => tongVol(b) - tongVol(a));

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
      // Chua chon station -> chia theo STATION; da chon 1 station -> chia theo
      // TRUNG TAM (chia theo station luc do chi con 1 mieng, khong co y nghia).
      pieStation: (f && f.station)
        ? { groupBy: 'department', labels: pieDeptLabels, values: pieDeptLabels.map(tongVol) }
        : { groupBy: 'station', labels: pieOrder.map((s) => (s === 'OTHER' ? 'Khác' : s)), values: pieOrder.map((s) => stMap.get(s) || 0) },
      deptVolume: {
        labels: volLabels,
        daTra: volLabels.map((k) => daTraCnt.get(k) || 0),
        chuaTra: volLabels.map((k) => chuaTraCnt.get(k) || 0),
        issued: volLabels.map(tongVol),
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

/** Ung vien doi ung THU CONG mau (label lech) cho DEMO_MODE. */
function manualPairCandidates(range, f) {
  const rows = notReconciled(range, f).slice(0, 12);
  const METHODS = [
    ['WO_PART_ON_OFF', 'Cao', ''],
    ['Cùng orderno/psn', 'Trung bình', ''],
    ['Cùng tàu, gần thời gian', 'Thấp', ''],
    ['Other — ROB (Robbery (tháo xuống trước)) · Khớp event (WO)', 'Cao', 'ROB'],
    ['Other — SWP (Swap (hoán đổi thiết bị)) · Khớp event (WO)', 'Cao', 'SWP'],
    ['WO_PART_ON_OFF (theo event)', 'Cao', ''],
    ['Other — SWP (Swap (hoán đổi thiết bị)) · Khớp part no + số tàu', 'Trung bình', 'SWP'],
    ['Cùng orderno/psn', 'Trung bình', ''],
    ['Other — NOI (Không có phiếu xuất) · Khớp part no', 'Thấp', 'NOI'],
  ];
  return rows.map((r, i) => {
    const [method, conf, onac] = METHODS[i % METHODS.length];
    const del = new Date(Date.now() - rndInt(1, 20) * 86400000);
    return {
      ...r,
      sug_partno_off: 'PN-' + pad(rndInt(100, 999)),
      sug_serialno_off: 'SN' + rndInt(10000, 99999),
      match_method: method,
      confidence: conf,
      sug_on_ac: onac,
      sug_duplicate: i % 5 === 0 ? 2 : 0,   // mo phong ca trung de xem canh bao
      sug_ret_labelno: String(rndInt(100000, 999999)), // label KHAC voi phieu xuat
      sug_ret_voucher: 'P-' + rndInt(100000, 999999),
      sug_ret_del_time: del.toISOString(),
      sug_tat_days: Math.round(rndInt(5, 300) / 10) / 10 + 1,
    };
  });
}

// --- REPAIR ADMIN: ton dong tai vi tri UNSERVICEABLE (location_type = -4) ---
const REPAIR_LOCS = {
  HAN: ['HAN VNA U/S', 'HAN 3RD U/S', 'HAN CAB U/S', 'HAN LINE U/S', 'HAN MAIN U/S'],
  SGN: ['SGN VNA U/S', 'SGN 3RD U/S', 'SGN CAB U/S', 'SGN LINE U/S', 'SGN BASE U/S', 'SGN MAIN U/S'],
  DAD: ['DAD VNA U/S', 'DAD LINE U/S', 'DAD CAB U/S'],
};

// Nho ket qua theo bo loc: 2 bao cao (tong hop + chi tiet) phai thay CUNG MOT
// tap du lieu, neu khong thi so lieu 2 tab lech nhau va khong doi chieu duoc.
const _repairDemoCache = new Map();

/** Danh sach item dang nam o vi tri U/S (dung chung cho 2 bao cao). */
function repairAdminItems(f) {
  const ck = JSON.stringify([f && f.station, f && f.store]);
  if (_repairDemoCache.has(ck)) return _repairDemoCache.get(ck);
  const items = [];
  const stations = f && f.station ? [f.station] : Object.keys(REPAIR_LOCS);
  for (const st of stations) {
    for (const loc of REPAIR_LOCS[st] || []) {
      for (let i = 0; i < rndInt(2, 18); i++) {
        const age = rndInt(1, 200);
        // ~75% dong dat backorder=1 & state='O' -> duoc tinh vao bao cao
        const bo = rndInt(0, 3) > 0 ? 1 : 0;
        const st2 = bo === 1 && rndInt(0, 9) > 0 ? 'O' : rnd(['C', 'P', 'O']);
        items.push({
          station: st, store: rnd(STORES), location: loc,
          partno: 'PN-' + pad(rndInt(100, 999)), serialno: 'SN' + rndInt(10000, 99999),
          labelno: rndInt(100000, 299999), psn: rndInt(1000000, 1999999),
          orderno: 'O-' + rndInt(100000, 999999),
          order_date_vn: new Date(Date.now() - age * 86400000).toISOString(),
          od_status: 0, od_state: st2, od_backorder: bo,
          od_ext_state: rnd(['', 'AOG', 'RTN']),
          age_days: age, nhom: age < 30 ? 'less30' : 'over30',
          tinh_tong_hop: bo === 1 && st2 === 'O',
        });
      }
    }
  }
  _repairDemoCache.set(ck, items);
  return items;
}

function repairAdmin(range, f) {
  return repairAdminItems(f)
    .filter((it) => it.tinh_tong_hop)
    .map(({ od_status, od_state, od_backorder, od_ext_state, tinh_tong_hop, ...rest }) => rest)
    .sort((a, b) => a.station.localeCompare(b.station)
      || a.location.localeCompare(b.location)
      || (b.age_days ?? -1) - (a.age_days ?? -1));
}

// --- QUAN LY XUAT KHO (pickslip) ---------------------------------------------
function pickslip(range, f) {
  const rows = [];
  const n = 260;
  // Thuc te MOT picking list gom NHIEU dong -> tao san mot ro phieu de nhieu
  // dong dung chung. Trang thai scan gan THEO PHIEU (mot phieu = mot file PDF).
  const plPool = [];
  for (let i = 0; i < 70; i++) {
    plPool.push({ no: rndInt(100000, 999999), scan: rndInt(0, 9) < 7 ? 'SCANNED' : 'CHUA_SCAN' });
  }
  for (let i = 0; i < n; i++) {
    const d = baseDevice(i);
    const r = rndInt(0, 9);
    const loai = r < 2 ? 'CANCEL' : (r < 3 ? 'RETURN' : 'NORMAL');
    const huy = loai !== 'NORMAL';
    const qtyB = rndInt(1, 8);
    rows.push({
      station: d.station,
      store: d.store,
      location_from: rnd(['A01', 'B12', 'SHOPLOC', 'HANSTORE', 'SGNSTORE']),
      picking_listno: 0, // gan o vong duoi (theo ro phieu plPool)
      pickslipno: 'P-' + rndInt(300000, 399999),
      seqno: rndInt(1, 20),
      partno: d.partno,
      serialno: d.serialno,
      qty_booked: qtyB,
      qty_canceled: huy ? rndInt(1, qtyB) : 0,
      loai,
      is_cancel: huy ? 1 : 0,
      owner: rnd(['VNA', 'VAECO', '']),
      created_by: d.staff,
      pickslip_date: rndDate(range.from, range.to).toISOString(),
      mech_sign: d.staff,
      booking_sign: 'VAE' + rndInt(10000, 99999),
      department: rnd(DEPARTMENTS),
      receiver: rnd(RECEIVERS),
      remarks: huy ? rnd(['Sai part', 'Khong du hang', 'Doi phuong an', '']) : '',
      pickslip_text: loai === 'CANCEL' ? rnd(['PS cancel', 'Booking cancel booking'])
        : (loai === 'RETURN' ? 'PS return' : rnd(['', 'AOG', 'Routine'])),
    });
  }
  // Doi chieu file scan + phieu tra + TAT return (demo: sinh ngau nhien)
  rows.forEach((r) => {
    const pl = rnd(plPool);
    r.picking_listno = pl.no;
    r.scan = pl.scan; // moi dong cung phieu PHAI cung trang thai scan

    r.return_no = '';
    r.return_date = null;
    r.tat_return = null;
    r.return_scan = '';
    if (r.loai !== 'RETURN') return;
    if (rndInt(0, 9) === 0) { r.return_no = 'NOT FOUND'; return; }
    const tat = rndInt(0, 40);
    r.return_no = rndInt(3000000, 3999999) + '-R';
    r.return_date = new Date(Date.parse(r.pickslip_date) + tat * 86400000).toISOString();
    r.tat_return = tat;
    r.return_scan = rndInt(0, 9) < 6 ? 'SCANNED' : 'CHUA_SCAN';
  });
  const kept = applyFilter(rows, f);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const soDongHuy = kept.filter((r) => r.is_cancel).length;
  const soCancel = kept.filter((r) => r.loai === 'CANCEL').length;
  const soReturn = kept.filter((r) => r.loai === 'RETURN').length;
  const phieu = new Set(kept.map((r) => r.pickslipno));
  const phieuHuy = new Set(kept.filter((r) => r.is_cancel).map((r) => r.pickslipno));

  const g = new Map();
  kept.forEach((r) => {
    const k = r.department || 'PA';
    const x = g.get(k) || { department: k, so_dong: 0, so_cancel: 0, so_return: 0 };
    x.so_dong++;
    if (r.loai === 'CANCEL') x.so_cancel++; else if (r.loai === 'RETURN') x.so_return++;
    g.set(k, x);
  });
  const byDept = [...g.values()].sort((a, b) => b.so_dong - a.so_dong);

  const dm = new Map();
  kept.forEach((r) => {
    const k = r.pickslip_date.slice(0, 10);
    const x = dm.get(k) || { ngay: k, so_dong: 0, so_dong_huy: 0 };
    x.so_dong++; if (r.is_cancel) x.so_dong_huy++;
    dm.set(k, x);
  });
  const byDay = [...dm.values()].sort((a, b) => a.ngay.localeCompare(b.ngay));

  const pm = new Map();
  kept.filter((r) => r.is_cancel).forEach((r) => pm.set(r.partno, (pm.get(r.partno) || 0) + 1));
  const topPart = [...pm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Dem scan theo PHIEU (distinct picking list) - giong server that
  const plScan = new Map();
  kept.forEach((r) => plScan.set(String(r.picking_listno), r.scan));
  const daScan = [...plScan.values()].filter((v) => v === 'SCANNED').length;
  const chuaScan = [...plScan.values()].filter((v) => v === 'CHUA_SCAN').length;
  const daScanDong = kept.filter((r) => r.scan === 'SCANNED').length;
  const chuaScanDong = kept.filter((r) => r.scan === 'CHUA_SCAN').length;
  const retScan = new Map();
  kept.filter((r) => r.return_no && r.return_no !== 'NOT FOUND')
    .forEach((r) => retScan.set(r.return_no, r.return_scan));
  const retOk = kept.filter((r) => r.loai === 'RETURN' && r.tat_return !== null);
  const tats = retOk.map((r) => r.tat_return);
  const TB = [
    { label: 'Trong ngay', min: -Infinity, max: 0 },
    { label: '1-3 ngay', min: 1, max: 3 },
    { label: '4-7 ngay', min: 4, max: 7 },
    { label: '8-14 ngay', min: 8, max: 14 },
    { label: '15-30 ngay', min: 15, max: 30 },
    { label: '> 30 ngay', min: 31, max: Infinity },
  ];
  const buckets = TB.map((b) => tats.filter((d) => d >= b.min && d <= b.max).length);

  return {
    range: { from: range.from, to: range.to, label: range.label },
    kpis: {
      soDong: kept.length,
      soCancel,
      soReturn,
      soDongHuy,
      soDongThuc: kept.length - soDongHuy,
      tyLeHuy: pct(soDongHuy, kept.length),
      soPhieu: phieu.size,
      soPhieuCoHuy: phieuHuy.size,
      tyLePhieuCoHuy: pct(phieuHuy.size, phieu.size),
      daScan, chuaScan,
      tongPhieuScan: daScan + chuaScan,
      tyLeScan: pct(daScan, daScan + chuaScan),
      daScanDong, chuaScanDong,
      returnCoPhieu: kept.filter((r) => r.loai === 'RETURN' && r.return_no && r.return_no !== 'NOT FOUND').length,
      returnKhongPhieu: kept.filter((r) => r.return_no === 'NOT FOUND').length,
      tatReturnAvg: tats.length ? Math.round((tats.reduce((a, b) => a + b, 0) / tats.length) * 10) / 10 : null,
      tatReturnMax: tats.length ? Math.max(...tats) : null,
      returnDaScan: [...retScan.values()].filter((v) => v === 'SCANNED').length,
      returnChuaScan: [...retScan.values()].filter((v) => v === 'CHUA_SCAN').length,
    },
    scanFolder: { dir: '(DEMO) \\\\10.99.7.7\\picking list\\2026', ok: true, count: 1234, error: '', ms: 5 },
    charts: {
      tatReturn: { labels: TB.map((b) => b.label), values: buckets },
      byDept: {
        labels: byDept.map((r) => r.department),
        thuc: byDept.map((r) => r.so_dong - r.so_cancel - r.so_return),
        cancel: byDept.map((r) => r.so_cancel),
        ret: byDept.map((r) => r.so_return),
        tyLe: byDept.map((r) => pct(r.so_cancel + r.so_return, r.so_dong)),
      },
      byDay: {
        labels: byDay.map((r) => r.ngay),
        soDong: byDay.map((r) => r.so_dong),
        tyLe: byDay.map((r) => pct(r.so_dong_huy, r.so_dong)),
      },
      topPart: { labels: topPart.map((x) => x[0]), values: topPart.map((x) => x[1]) },
    },
    rows: kept,
    count: kept.length,
  };
}

/** DEMO tab RECEIVING (nhap kho) - cau truc giong qReceiving() o server.js. */
function receiving(range, f) {
  const rows = [];
  const n = 320;
  // Mot VOUCHER gom nhieu dong; trang thai scan gan THEO VOUCHER.
  const vcPool = [];
  for (let i = 0; i < 90; i++) {
    vcPool.push({ no: 'R-' + rndInt(200000, 299999), scan: rndInt(0, 9) < 7 ? 'SCANNED' : 'CHUA_SCAN' });
  }
  for (let i = 0; i < n; i++) {
    const d = baseDevice(i);
    const del = rndDate(range.from, range.to);
    rows.push({
      station: d.station,
      store: d.store,
      location: rnd(['A01', 'B12', 'LG3', 'RACK-7', 'QUAR']),
      voucherno: '', // gan o vong duoi (theo ro voucher vcPool)
      partno: d.partno,
      serialno: d.serialno,
      batchno: '',
      psn: 'P' + rndInt(100000, 999999),
      labelno: d.labelno,
      qty: rndInt(1, 6),
      tinh_trang: rnd(['SV', 'NEW', 'OH', 'RP']),
      mat_class: rnd(['ROT', 'CON', 'EXP']),
      orderno: 'PO' + rndInt(10000, 99999),
      orderdate: new Date(del.getTime() - rndInt(5, 60) * 86400000).toISOString(),
      del_date: del.toISOString(),
      mutation_date: del.toISOString(),
      owner: rnd(['VNA', 'VAECO', '']),
      created_by: d.staff,
      department: rnd(DEPARTMENTS),
      historyno: rndInt(4000000, 4999999),
      recdetailno: rndInt(500000, 599999),
    });
  }
  rows.forEach((r) => {
    const v = rnd(vcPool);
    r.voucherno = v.no;
    r.voucher_scan = v.no.replace(/^R-/i, '');
    r.scan = v.scan; // moi dong cung voucher PHAI cung trang thai scan
  });
  const kept = applyFilter(rows, f);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  // Dem scan theo PHIEU (distinct voucher) - giong server that
  const vc = new Map();
  kept.forEach((r) => vc.set(r.voucherno, r));
  const daScan = [...vc.values()].filter((r) => r.scan === 'SCANNED').length;
  const chuaScan = vc.size - daScan;
  const daScanDong = kept.filter((r) => r.scan === 'SCANNED').length;
  const chuaScanDong = kept.length - daScanDong;

  const g = new Map();
  [...vc.values()].forEach((r) => {
    const k = r.department || 'PA';
    const x = g.get(k) || { k, daScan: 0, chuaScan: 0, tong: 0 };
    x.tong++; if (r.scan === 'SCANNED') x.daScan++; else x.chuaScan++;
    g.set(k, x);
  });
  const byDept = [...g.values()].sort((a, b) => b.tong - a.tong);

  const dm = new Map();
  kept.forEach((r) => {
    const k = r.del_date.slice(0, 10);
    dm.set(k, (dm.get(k) || 0) + 1);
  });
  const byDay = [...dm.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return {
    range: { from: range.from, to: range.to, label: range.label },
    kpis: {
      soDong: kept.length,
      soPhieu: new Set(kept.map((r) => r.voucherno)).size,
      b1Tho: kept.length + 24,
      crHuy: 24,
      b1BiHuy: 24,
      daScan, chuaScan,
      tongPhieuScan: vc.size,
      tyLeScan: pct(daScan, vc.size),
      daScanDong, chuaScanDong,
    },
    scanFolder: { dir: '(DEMO) \\\\10.99.7.7\\certificates\\2026', ok: true, count: 987, error: '', ms: 4 },
    charts: {
      byDept: {
        labels: byDept.map((r) => r.k),
        daScan: byDept.map((r) => r.daScan),
        chuaScan: byDept.map((r) => r.chuaScan),
      },
      byDay: { labels: byDay.map((x) => x[0]), values: byDay.map((x) => x[1]) },
    },
    rows: kept,
    count: kept.length,
  };
}

module.exports = {
  filters,
  manualPairCandidates,
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
  repairAdmin,
  pickslip,
  receiving,
};
