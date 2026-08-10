/**
 * WPCHECK - chot cac phep DOI DON VI cua trang "Ra soat ho so bao duong" (/wp).
 * ---------------------------------------------------------------------------
 * VI SAO CAN RIENG MOT BAI: du lieu AMOS o trang nay dung BA don vi khac nhau
 * va deu la so tran - sai mot phep doi thi khong co gi bao loi, chi la con so
 * hien ra sai. Nguy hiem nhat la phep +7h:
 *
 *   Mot hanh dong luc 20:15 ngay 30/06 gio AMOS -> 03:15 ngay 01/07 gio VN.
 *   Neu chi cong 7h vao RIENG cot gio (khong cho ngay chay theo) thi ra
 *   "03:15 ngay 30/06" - dung gio nhung SAI MOT NGAY. Module Handover so ngay
 *   cua dong ban giao voi ngay buoc cuoi, nen lech mot ngay la cham sai het
 *   ma van "tram" nhu binh thuong.
 *
 * Bai nay chay THUAN o Node, khong can SQL Server, khong can trinh duyet.
 *
 * CHAY:  npm run wpcheck   (da nam trong `npm run smoke`)
 */
const { tienIch } = require('../wp-validator');

const { ngayGioVN, doiNgay, doiGio, doiCong, ngaySangAmos, WP_STATUS, STATUS_HIEU_LUC } = tienIch;

let dat = 0;
const truot = [];
function ok(ten, thuc, mong) {
  const a = JSON.stringify(thuc);
  const b = JSON.stringify(mong);
  if (a === b) { dat += 1; console.log(`  ✔ ${ten}`); return; }
  truot.push({ ten, thuc: a, mong: b });
  console.log(`  ✖ ${ten}\n      duoc : ${a}\n      mong : ${b}`);
}

// --- 1. Moc ngay AMOS ---------------------------------------------------
console.log('\n1. Moc ngay AMOS (so ngay ke tu 31/12/1971)');
ok('19725 = 01/01/2026', doiNgay(19725), '01/01/2026');
ok('19945 = 09/08/2026', doiNgay(19945), '09/08/2026');
ok('0 (chua co ngay) -> rong', doiNgay(0), '');
ok('rong -> rong', doiNgay(''), '');
ok('2026-01-01 -> 19725', ngaySangAmos('2026-01-01'), 19725);
ok('doi di roi doi lai khong lech', doiNgay(ngaySangAmos('2026-08-09')), '09/08/2026');
ok('ngay sai dinh dang -> null', ngaySangAmos('09/08/2026'), null);

// --- 2. ACTION_TIME tinh bang PHUT (khong phai mili giay) ---------------
console.log('\n2. ACTION_TIME = so PHUT ke tu 0h');
ok('0 -> 00:00', doiGio(0), '00:00:00');
ok('495 -> 08:15', doiGio(8 * 60 + 15), '08:15:00');
ok('1439 -> 23:59', doiGio(1439), '23:59:00');

// --- 3. PHEP +7h PHAI KEO CA NGAY (cai bay chinh) -----------------------
console.log('\n3. AMOS -> gio VN: ngay va gio doi CUNG NHAU (+7h)');
const D = 19945;   // 09/08/2026
ok('08:15 -> cung ngay 15:15',
  ngayGioVN(D, 8 * 60 + 15, 7), { dat: '09/08/2026', tim: '15:15:00', datGoc: '09/08/2026', timGoc: '08:15:00' });
ok('16:59 -> van trong ngay 23:59',
  ngayGioVN(D, 16 * 60 + 59, 7).dat + ' ' + ngayGioVN(D, 16 * 60 + 59, 7).tim, '09/08/2026 23:59:00');
ok('17:00 -> QUA NGAY, 00:00 hom sau',
  ngayGioVN(D, 17 * 60, 7).dat + ' ' + ngayGioVN(D, 17 * 60, 7).tim, '10/08/2026 00:00:00');
ok('20:15 -> QUA NGAY, 03:15 hom sau',
  ngayGioVN(D, 20 * 60 + 15, 7).dat + ' ' + ngayGioVN(D, 20 * 60 + 15, 7).tim, '10/08/2026 03:15:00');
ok('23:59 -> QUA NGAY, 06:59 hom sau',
  ngayGioVN(D, 23 * 60 + 59, 7).dat + ' ' + ngayGioVN(D, 23 * 60 + 59, 7).tim, '10/08/2026 06:59:00');
ok('cuoi thang: 31/08 20:00 -> 01/09',
  ngayGioVN(ngaySangAmos('2026-08-31'), 20 * 60, 7).dat, '01/09/2026');
ok('cuoi nam: 31/12 20:00 -> 01/01 nam sau',
  ngayGioVN(ngaySangAmos('2026-12-31'), 20 * 60, 7).dat, '01/01/2027');
ok('giu lai gio THO cua AMOS de doi chieu',
  { d: ngayGioVN(D, 20 * 60 + 15, 7).datGoc, t: ngayGioVN(D, 20 * 60 + 15, 7).timGoc },
  { d: '09/08/2026', t: '20:15:00' });
ok('lech = 0 thi giu nguyen gio AMOS',
  ngayGioVN(D, 20 * 60 + 15, 0).dat + ' ' + ngayGioVN(D, 20 * 60 + 15, 0).tim, '09/08/2026 20:15:00');
ok('khong co gio -> chi co ngay, khong bia gio',
  ngayGioVN(D, '', 7), { dat: '09/08/2026', tim: '', datGoc: '09/08/2026', timGoc: '' });
ok('khong co ngay -> rong het', ngayGioVN(0, 600, 7), { dat: '', tim: '', datGoc: '', timGoc: '' });

// --- 4. DURATION / EST_MH tinh bang PHUT --------------------------------
console.log('\n4. DURATION / EST_MH = so PHUT -> doi ra gio');
ok('60 phut = 1.0 gio', doiCong(60), 1);
ok('90 phut = 1.5 gio', doiCong(90), 1.5);
ok('34 phut = 0.567 gio', doiCong(34), 0.567);
ok('0 / rong = 0', [doiCong(0), doiCong(''), doiCong(null)], [0, 0, 0]);

// --- 5. Bang ma WP_STATUS ------------------------------------------------
console.log('\n5. WP_HEADER.WP_STATUS (nghiep vu chot)');
ok('IN PROGRESS = 11', WP_STATUS.INPROGRESS, 11);
ok('PRELOAD = 112', WP_STATUS.PRELOAD, 112);
ok('CLOSED = -2', WP_STATUS.CLOSED, -2);
ok('ba ma khong trung nhau', new Set(Object.values(WP_STATUS)).size, 3);
ok('WP_HEADER.STATUS luon = 0', STATUS_HIEU_LUC, 0);

// --- Ket luan ------------------------------------------------------------
if (truot.length) {
  console.error(`\n✖ TRUOT: ${truot.length}/${dat + truot.length} truong hop.`);
  process.exit(1);
}
console.log(`\n✔ DAT: cac phep doi don vi cua trang /wp dung ca ${dat} truong hop.`);
