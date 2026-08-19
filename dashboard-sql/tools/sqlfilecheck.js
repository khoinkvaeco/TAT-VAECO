#!/usr/bin/env node
/**
 * SQLFILECHECK - soi cac tep .sql trong docs/ ma NGHIEP VU se dan vao SSMS.
 * ---------------------------------------------------------------------------
 * VI SAO CAN: docs/INDEXES.sql duoc NGUOI THAT chay tay tren may chu that.
 * Header cua no HUA "tat ca deu co IF NOT EXISTS -> chay lai nhieu lan khong
 * sao", nhung ba lenh cuoi file KHONG he co guard - chay lan hai la SSMS bao
 * loi "There is already an index named ...". Nguoi chay khong biet la loi vo
 * hai hay minh vua lam hong CSDL.
 *
 * Bai nay soi CHINH TEP, khong can SQL Server:
 *   1. Moi CREATE INDEX phai co IF NOT EXISTS ngay truoc  (chay lai duoc)
 *   2. Moi DROP INDEX phai co IF EXISTS ngay truoc        (nt)
 *   3. Khong duoc trung ten index
 *   4. Khong duoc co HAI index cung BANG + cung COT KHOA (thua, ton dia va
 *      lam cham moi lenh ghi) - loi da co that trong ban cu.
 *   5. CHI duoc dong den cac bang doc/cache da biet, TUYET DOI khong DROP
 *      TABLE / DELETE / UPDATE trong tep huong dan.
 *
 * CHAY:  node tools/sqlfilecheck.js   (da nam trong `npm run smoke`)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TEP = [path.join(__dirname, '..', 'docs', 'INDEXES.sql')];

const ket = [];
function kiemTra(ten, dat, chiTiet) {
  ket.push({ ten, dat });
  console.log(`  ${dat ? '✔' : '✘'} ${ten}${chiTiet ? '  — ' + chiTiet : ''}`);
}

/** Bo chu thich /* *\/ va -- de khong bat nham vi du nam trong loi giai thich. */
function boChuThich(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

function soiTep(tep) {
  const ten = path.basename(tep);
  if (!fs.existsSync(tep)) { kiemTra(`${ten}: tồn tại`, false, 'không tìm thấy tệp'); return; }
  const goc = fs.readFileSync(tep, 'utf8');
  const s = boChuThich(goc);
  const dong = s.split('\n');

  // 1 + 2. Lenh nao cung phai chay lai duoc
  const thieuGuard = [];
  dong.forEach((d, i) => {
    const m = d.match(/^\s*(CREATE\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?INDEX|DROP\s+INDEX)\b/i);
    if (!m) return;
    const la = /^DROP/i.test(m[1].trim()) ? 'IF EXISTS' : 'IF NOT EXISTS';
    const truoc = dong.slice(Math.max(0, i - 6), i).join('\n').toUpperCase();
    // "IF NOT EXISTS" chua "IF EXISTS" nen phai xet rieng cho DROP
    const co = la === 'IF NOT EXISTS'
      ? truoc.includes('IF NOT EXISTS')
      : /IF\s+EXISTS/.test(truoc) && !truoc.includes('IF NOT EXISTS');
    if (!co) thieuGuard.push(`dòng ${i + 1}: ${d.trim().slice(0, 60)}`);
  });
  kiemTra(`${ten}: mọi CREATE/DROP INDEX đều chạy lại được (có guard)`,
    !thieuGuard.length, thieuGuard.join(' · '));

  // 3. Trung ten index
  const tenIdx = [...s.matchAll(/CREATE\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\s+\[?(\w+)\]?/gi)]
    .map((m) => m[1]);
  const dem = new Map();
  tenIdx.forEach((t) => dem.set(t, (dem.get(t) || 0) + 1));
  const trung = [...dem.entries()].filter(([, v]) => v > 1).map(([k]) => k);
  kiemTra(`${ten}: không trùng tên index`, !trung.length, trung.join(', '));

  // 4. Hai index cung bang + cung COT KHOA -> thua
  //    ⚠️ Loi nay DA CO THAT: IX_real_us1_del_time va IX_real_us1_onac_deltime
  //    deu khoa theo [del_time] cua real_us1.
  const khoa = [...s.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\s+\[?(\w+)\]?\s+ON\s+([^(]+)\(([^)]*)\)/gi)]
    .map((m) => ({
      idx: m[1],
      bang: m[2].replace(/[[\]\s]/g, '').split('.').pop().toLowerCase(),
      cot: m[3].replace(/[[\]\s]/g, '').toLowerCase(),
    }));
  const theoKhoa = new Map();
  for (const k of khoa) {
    const kk = `${k.bang}(${k.cot})`;
    if (!theoKhoa.has(kk)) theoKhoa.set(kk, []);
    theoKhoa.get(kk).push(k.idx);
  }
  const thua = [...theoKhoa.entries()].filter(([, v]) => v.length > 1)
    .map(([kk, v]) => `${kk} ← ${v.join(' + ')}`);
  kiemTra(`${ten}: không có hai index trùng cột khoá trên cùng bảng`,
    !thua.length, thua.join(' · '));

  // 5. Tep HUONG DAN khong duoc chua lenh pha du lieu
  const nguyHiem = s.match(/\b(DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM|UPDATE\s+\[?\w)/i);
  kiemTra(`${ten}: không có lệnh phá dữ liệu (DROP TABLE / DELETE / UPDATE)`,
    !nguyHiem, nguyHiem ? nguyHiem[0] : '');

  // 6. Header hua gi thi phai lam dung - đây chính là chỗ bản cũ nói sai
  kiemTra(`${ten}: header nhắc "IF NOT EXISTS" và đúng như vậy`,
    /IF NOT EXISTS/i.test(goc) && !thieuGuard.length);
}

TEP.forEach(soiTep);

const truot = ket.filter((x) => !x.dat);
if (truot.length) {
  console.error(`\n✖ TRUOT: ${truot.length}/${ket.length} muc cua tep .sql huong dan.`);
  process.exit(1);
}
console.log(`\n✔ DAT: tep .sql huong dan chay lai duoc, khong index thua (${ket.length} muc).`);
