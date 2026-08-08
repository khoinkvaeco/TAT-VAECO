#!/usr/bin/env node
/**
 * CHATCHECK - do xem chatbot tra loi duoc bao nhieu phan cau hoi THUC TE.
 * ---------------------------------------------------------------------------
 * Yeu cau nghiep vu: "de moi nguoi hoi thoai mai ma trang nay tra loi duoc"
 * (trong pham vi chuong trinh nay). Vay thi phai DO chu khong the doan.
 *
 * Danh sach duoi day viet theo kieu nguoi dung THAT se go: khong dau, viet tat,
 * hoi vong vo, dung tu cua ho chu khong phai tu khoa cua he thong.
 *
 * Moi cau ky vong mot INTENT. Quan trong:
 *   - 'kb' / 'kb-gan' : tra loi duoc tu kho kien thuc
 *   - 'kpi'           : cau hoi so lieu -> di truy van
 *   - 'unknown'       : KHONG hieu (cang it cang tot, nhung KHONG duoc = 0:
 *                       cau ngoai pham vi PHAI roi vao day, tra loi bua con
 *                       te hon khong tra loi)
 *
 * CHAY:  node tools/chatcheck.js   (da nam trong `npm run smoke`)
 */
'use strict';

const chatbot = require('../chatbot');

// [cau hoi, nhom intent chap nhan duoc]
const CAU_HOI = [
  // --- Dinh nghia nghiep vu ---
  ['tat install la gi', ['kb', 'kb-gan']],
  ['doi ung nghia la sao', ['kb', 'kb-gan']],
  ['tat tong tinh the nao', ['kb', 'kb-gan']],
  ['tra service khac gi tra unservice', ['kb', 'kb-gan']],

  // --- Dang nhap / mat khau (tinh nang moi) ---
  ['lam sao de dang nhap trang lgc', ['kb', 'kb-gan']],
  ['mat khau lan dau la gi', ['kb', 'kb-gan']],
  ['toi quen mat khau thi lam sao', ['kb', 'kb-gan']],
  ['doi mat khau o dau', ['kb', 'kb-gan']],
  ['ai duoc xem trang lgc', ['kb', 'kb-gan']],

  // --- Van hanh / su co ---
  ['sao trang cham the', ['kb', 'kb-gan']],
  ['bang khong co du lieu gi ca', ['kb', 'kb-gan']],
  ['bao loi do thi lam gi', ['kb', 'kb-gan']],
  ['so lieu nay cu roi phai khong', ['kb', 'kb-gan']],
  ['lam sao lay so lieu moi nhat', ['kb', 'kb-gan']],

  // --- Tinh nang giao dien ---
  ['chon nhieu kho duoc khong', ['kb', 'kb-gan']],
  ['luu bo loc lai duoc khong', ['kb', 'kb-gan']],
  ['xem so sanh cac thang o dau', ['kb', 'kb-gan']],
  ['dang loc nhung gi', ['kb', 'kb-gan']],
  ['xuat excel kieu gi', ['kb', 'kb-gan']],

  // --- Nghiep vu kho ---
  ['cot scan nghia la gi', ['kb', 'kb-gan']],
  ['phieu chua scan xem o dau', ['kb', 'kb-gan']],
  ['huy tra khac la sao', ['kb', 'kb-gan']],
  ['sao gio xuat kho chi co ngay', ['kb', 'kb-gan']],
  ['phieu nhap thong ke theo gi', ['kb', 'kb-gan']],

  // --- Cau hoi SO LIEU -> phai di truy van ---
  ['tat trung binh thang nay bao nhieu', ['kpi']],
  ['trung tam nao tat cao nhat', ['kpi']],
  ['co bao nhieu thiet bi chua doi ung', ['kpi']],

  // --- Chao hoi ---
  ['chao ban', ['help']],
  ['ban lam duoc gi', ['help']],

  // --- Loat 2: viet SAU khi da chinh xong, de do TRUNG THUC ---
  //     (luc dau chi 60% dung - da bo sung cac chu de con thieu)
  ['tai sao co phieu chua doi ung', ['kb', 'kb-gan', 'kpi']],
  ['toi muon in bao cao ra giay', ['kb', 'kb-gan']],
  ['bang chi tiet co bao nhieu dong', ['kb', 'kb-gan', 'kpi']],
  ['sao station khong co dad', ['kb', 'kb-gan', 'kpi']],
  ['picking list la gi', ['kb', 'kb-gan']],
  ['toi bi khoa tai khoan roi', ['kb', 'kb-gan']],
  ['nhan vien nao lap phieu nay', ['kb', 'kb-gan']],
  ['cach xem tat cua thang truoc', ['kb', 'kb-gan', 'kpi']],
  ['bo qua kho cab de lam gi', ['kb', 'kb-gan']],
  ['costcenter la gi', ['kb', 'kb-gan']],
  ['tai sao so lieu lgc khac dashboard', ['kb', 'kb-gan', 'kpi']],
  ['repair admin dung de lam gi', ['kb', 'kb-gan']],
  ['toi khong thay tab lgc', ['kb', 'kb-gan']],
  ['maxrows la gi', ['kb', 'kb-gan']],
  ['lam sao biet phieu da tra chua', ['kb', 'kb-gan']],
  ['tat thang truoc bao nhieu', ['kpi']],
  ['so lieu thang 7 the nao', ['kpi', 'kb', 'kb-gan']],

  // --- NGOAI pham vi: PHAI la unknown, khong duoc tra loi bua ---
  //     Moi cau duoi day tung LOT COng mot lan trong luc lam - giu lai het.
  ['thoi tiet ha noi hom nay the nao', ['unknown']],   // 'noi' trong 'ha noi'
  ['gia vang hom nay bao nhieu', ['unknown']],
  ['cong thuc nau pho bo', ['unknown']],
  ['ket qua bong da toi qua', ['unknown']],            // 'bo qua' khop 'BOng da toi QUA'
  ['may bay bay cao bao nhieu', ['unknown']],          // 'bao cao' khop dao nguoc
  ['luong thang nay bao nhieu', ['unknown']],          // 'thang' la tu thoi gian, khong phai tu nghiep vu
  ['ty gia usd hom nay', ['unknown']],
  ['ai la giam doc cong ty', ['unknown']],
  ['nghi le mung 2 9 may ngay', ['unknown']],
];

function main() {
  const ds = [];
  for (const [cau, mong] of CAU_HOI) {
    const kq = chatbot.interpret(cau, { departments: ['PA', 'CUVT', 'DIEN'] });
    ds.push({ cau, mong, thuc: kq.intent, dat: mong.includes(kq.intent) });
  }
  const truot = ds.filter((x) => !x.dat);
  const trongPhamVi = ds.filter((x) => !x.mong.includes('unknown'));
  const hieu = trongPhamVi.filter((x) => x.dat).length;

  ds.filter((x) => !x.dat).forEach((x) =>
    console.log(`  ✘ "${x.cau}"  -> ${x.thuc}  (mong: ${x.mong.join('/')})`));

  console.log(`\n  Trong pham vi chuong trinh: hieu ${hieu}/${trongPhamVi.length} cau`
    + ` (${Math.round((hieu / trongPhamVi.length) * 100)}%)`);
  const ngoai = ds.filter((x) => x.mong.includes('unknown'));
  console.log(`  Ngoai pham vi: ${ngoai.filter((x) => x.dat).length}/${ngoai.length} cau bi tu choi dung`);

  if (truot.length) {
    console.error(`\n✘ TRUOT: ${truot.length}/${ds.length} cau hoi khong dat.`);
    process.exit(1);
  }
  console.log(`\n✔ DAT: chatbot xu ly dung ca ${ds.length} cau hoi mau.`);
}

main();
