/**
 * ============================================================================
 *  chatbot.js  -  Bo NLU (hieu y dinh) NOI BO cho Dashboard TAT
 *  - KHONG goi dich vu ngoai (khong LLM), khong gui du lieu ra ngoai.
 *  - Phan tich cau hoi tieng Viet -> tra ve { intent, params } de server.js
 *    quyet dinh: tra loi tu KB (dinh nghia / huong dan) hay truy van du lieu.
 *  - Ham interpret() la HAM THUAN (khong DB) -> de kiem thu doc lap.
 * ============================================================================
 */
'use strict';

/** Bo dau tieng Viet + lowercase -> so khop tu khoa khong phu thuoc dau. */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // bo dau ket hop
    .replace(/đ/g, 'd') // đ -> d
    .replace(/\s+/g, ' ')
    .trim();
}

// Dong nghia -> tu khoa chuan (ap dung SAU khi norm) de hieu nhieu cach hoi.
const SYNONYMS = [
  [/\b(ton dong|ton kho lau|chua xu ly|chua hoan tat|chua khop|chua tra ve kho)\b/g, 'chua doi ung'],
  [/\b(mat may ngay|mat bao lau|bao lau|thoi gian quay vong|quay vong)\b/g, 'tat'],
  [/\b(binh quan|trung binh|tb)\b/g, 'trung binh'],
  [/\b(so luong|sl|dem|tong so)\b/g, 'so luong'],
  [/\b(don vi|bo phan)\b/g, 'trung tam'],
  [/\b(may bay|tau bay|tau|phi co)\b/g, 'tau'],
  [/\b(xuat file|tai ve|download|export)\b/g, 'xuat excel'],
  [/\b(hoan tra|tra lai kho|nhap lai kho)\b/g, 'hoan kho'],
  [/\b(kiem dinh|recert|recertify|chung nhan lai)\b/g, 'tra service'],
  // --- Bo sung: cac tinh nang moi + cach hoi thuong gap ---
  [/\b(dang nhap|login|sign in|vao trang lgc)\b/g, 'dang nhap'],
  [/\b(mat khau|password|pass|matkhau)\b/g, 'mat khau'],
  [/\b(quen mat khau|mat mat khau|khong vao duoc)\b/g, 'quen mat khau'],
  [/\b(scan|quet|file pdf|ban scan)\b/g, 'scan'],
  [/\b(phieu xuat|picking list|pickinglist)\b/g, 'phieu xuat'],
  [/\b(phieu nhap|receiving|nhap kho)\b/g, 'phieu nhap'],
  [/\b(huy phieu|cancel|huy)\b/g, 'huy'],
  [/\b(so sanh thang|xu huong thang|nhieu thang|theo thang)\b/g, 'so sanh thang'],
  [/\b(luu bo loc|bo loc da luu|preset)\b/g, 'bo loc da luu'],
  [/\b(cham|lau|doi lau|treo|khong chay)\b/g, 'cham'],
  [/\b(so lieu cu|du lieu cu|khong moi|cache|bo nho dem)\b/g, 'so lieu cu'],
  [/\b(trong|rong|khong co du lieu|khong ra gi)\b/g, 'bang rong'],
  [/\b(loi|error|bao do|hong)\b/g, 'loi'],
  [/\b(ai xem duoc|quyen|phan quyen|access)\b/g, 'quyen'],
];
function expandSyn(n) {
  let s = ' ' + n + ' ';
  for (const [re, rep] of SYNONYMS) s = s.replace(re, rep);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * So khop 1 tu khoa: chua nguyen cum, HOAC moi tu trong cum deu xuat hien
 * NHU MOT TU RIENG.
 *
 * ⚠️ Phai so theo TU, khong duoc so chuoi con. Truoc day dung n.includes(t) nen
 * khoa 'bo qua' khop cau "ket qua BOng da toi QUA" ('bo' nam trong 'bong') va
 * chatbot tra loi huong dan "Tinh lai TAT" cho mot cau hoi bong da. Loi kieu
 * nay khong lam gi hong - no chi lam nguoi dung mat long tin.
 */
function hasKey(n, key) {
  if (n.includes(key)) return true;
  const toks = key.split(' ').filter(Boolean);
  if (toks.length <= 1) return false;
  // Moi tu phai la MOT TU RIENG va xuat hien DUNG THU TU cua khoa (cho phep
  // chen tu o giua: 'lam moi' van khop "LAM sao lay so lieu MOI nhat").
  // Bat buoc dung thu tu vi neu khong, khoa 'bao cao' se khop cau
  // "may bay bay CAO BAO nhieu" - dao nguoc va lac de hoan toan.
  const tu = n.split(/[^a-z0-9_]+/).filter(Boolean);
  let i = 0;
  for (const t of toks) {
    const j = tu.indexOf(t, i);
    if (j < 0) return false;
    i = j + 1;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 1. KIEN THUC (KB): dinh nghia nghiep vu + huong dan dung dashboard
//    Moi muc: { keys: [tu khoa da BO DAU], answer: 'noi dung' }
// ---------------------------------------------------------------------------
const DEFINITIONS = [
  {
    keys: ['tat tong', 'tong tat', 'tat toan chuoi', 'tat 3 chang', 'tat cong lai'],
    answer:
      'TAT tổng = TAT install + TAT US return + TAT CUVT. Đây là 3 chặng LIÊN TIẾP của cùng một vòng đời khí tài nên cộng lại được: (1) xuất kho → lắp lên tàu; (2) tháo khỏi tàu → trả unservice; (3) trả unservice → CUVT nhận. Trên biểu đồ "TAT tổng theo Trung tâm", 3 chặng được XẾP CHỒNG nên chiều cao cả cột chính là TAT tổng của trung tâm đó. Đơn vị: ngày.',
  },
  {
    keys: ['other', 'on_ac', 'onac', 'noi', 'rob', 'dir', 'cro', 'ma ly do', 'khong co phieu xuat', 'robbery'],
    answer:
      'Báo cáo "Other (on_ac)" ghi nhận thiết bị ĐÃ TRẢ UNSERVICE nhưng CHƯA tìm được phiếu xuất service đối ứng; ghi chú on_ac cho biết lý do:\n' +
      '• NOI = no issue pickslip — không có phiếu xuất kho tương ứng.\n' +
      '• ROB = robbery — tháo thiết bị xuống trước (lấy từ tàu/thiết bị khác) nên không phát sinh phiếu xuất.\n' +
      '• DIR = lắp thẳng lên tàu vật tư đang có trong kho, không qua phiếu xuất service.\n' +
      '• CRO = tháo vật tư loại repairable / consumable.\n' +
      'Tab Other có cột "Lý do" lọc được theo từng mã và dòng thống kê số lượng mỗi mã trong kỳ.',
  },
  {
    keys: ['tat install', 'tat lap', 'thoi gian lap'],
    answer:
      'TAT install = thời điểm LẮP lên tàu (on_off vm=YE, lần đầu tiên cùng labelno SAU giờ xuất kho) − thời điểm XUẤT KHO (kho_ser1). Đơn vị: ngày. Dòng thiếu sự kiện lắp thì để trống, không tính vào trung bình.',
  },
  {
    keys: ['tat us return', 'us return', 'tra unservice', 'tat tra us'],
    answer:
      'TAT US return = thời điểm TRẢ UNSERVICE (real_us1.del_time) − thời điểm THÁO khỏi tàu (on_off vm=YA khớp historyno_). Với thiết bị đối ứng kiểu "trả service" thì thay del_time bằng giờ recertify (CI @SHOPLOC). Đơn vị: ngày.',
  },
  {
    keys: ['tat cuvt', 'cuvt'],
    answer:
      'TAT CUVT = thời điểm NHẬN unservice (real_us1.reci_time) − thời điểm TRẢ unservice (del_time). Đây là TAT nội bộ của CUVT, đo riêng và KHÔNG gộp vào TAT install / TAT US return.',
  },
  {
    keys: ['tat hoan kho', 'hoan kho'],
    answer:
      'TAT hoàn kho = thời điểm HOÀN KHO (kho_ser1 vm=TC, voucher P-CA-<PS>) − thời điểm XUẤT KHO tương ứng (vm=T, P-<PS>) cùng số PS và labelno. Không tính cho CUVT. Đơn vị: ngày.',
  },
  {
    keys: ['doi ung', 'chua doi ung', 'la doi ung'],
    answer:
      'Đối ứng = phiếu xuất kho (kho_ser1 vm=T) tìm được đường "đóng vòng": hoặc có TRẢ UNSERVICE (real_us1, khớp labelno+voucherno), hoặc có TRẢ SERVICE (tháo YA → recertify CI @SHOPLOC), hoặc đã HOÀN KHO (TC). "Chưa đối ứng" = phiếu xuất trong kỳ chưa có đường nào ở trên và chưa bị hủy.',
  },
  {
    keys: ['tim doi ung', 'tra cuu doi ung', 'kiem tra doi ung', 'trang thai doi ung', 'cach tim doi ung', 'tim kiem doi ung'],
    answer:
      'Tìm đối ứng của 1 thiết bị: gõ "đối ứng của <part / serial / label>" (ví dụ: "đối ứng serial 43842"). Tôi kiểm tra các phiếu xuất gần nhất của thiết bị đã "đóng vòng" chưa — Trả unservice / Trả service (recertify) / Hoàn kho — hay vẫn CHƯA đối ứng, kèm số phiếu và thời điểm.',
  },
  {
    keys: ['tra service', 'recertify', 'recert'],
    answer:
      'Trả service (recertify) = thiết bị tháo khỏi tàu (on_off YA) được kiểm định lại tại shop (on_off CI, location=SHOPLOC, cùng psn+orderno với YA) và chuyển thành serviceable. Đây cũng là 1 dạng đối ứng; giờ recertify (CI) đóng vai trò như giờ trả unservice khi tính TAT US return.',
  },
  {
    keys: ['costcenter', 'bo qua xuat costcenter', 'xuat costcenter'],
    answer:
      'Checkbox "Bỏ qua xuất costcenter": loại các phiếu xuất có Receiver LÀ SỐ (đúng 2 chữ số hoặc số thuần như 15, 1234, 12.5) — đây là xuất cho costcenter, không phải xuất cho tàu (số tàu có chữ cái, ví dụ VN-A868). Khi bật, KPI và biểu đồ được tính lại bỏ các phiếu này.',
  },
  {
    keys: ['ty le doi ung', 'ty le'],
    answer:
      'Tỷ lệ đối ứng = số thiết bị ĐÃ đối ứng / (đã đối ứng + chưa đối ứng) × 100%, tính trên toàn bộ dữ liệu trong kỳ.',
  },
  {
    keys: ['sl nhan', 'sl giao', 'reci', 'del'],
    answer:
      'SL nhận / SL giao (CUVT): SL nhận = số thiết bị CUVT đã nhận unservice hợp lệ trong kỳ (reci_time ≥ del_time); SL giao = tổng số thiết bị đã trả unservice trong kỳ.',
  },
  {
    keys: ['tat la gi', 'turn around', 'turnaround', 'dinh nghia tat'],
    answer:
      'TAT (Turn-Around-Time) = thời gian quay vòng của khí tài trong quy trình xuất kho → lắp → tháo → trả/đối ứng. Dashboard tách 2 thành phần chính: TAT install và TAT US return, cùng TAT CUVT và TAT hoàn kho.',
  },
];

const USAGE = [
  {
    keys: ['xuat excel', 'export', 'tai excel', 'xuat file'],
    answer:
      'Xuất Excel: mỗi bảng có nút "⬇ Excel" ở góc phải. Bảng đang lọc/tìm kiếm sẽ xuất đúng phần đang hiển thị. Bảng Chi tiết TAT dùng nút Excel ở khu vực "Chi tiết TAT theo thiết bị".',
  },
  {
    keys: ['cach loc', 'bo loc', 'filter', 'tim kiem', 'loc theo cot', 'loc cot'],
    answer:
      'Lọc: dùng thanh trên cùng (Kỳ báo cáo, Station, Store, Trung tâm) — dữ liệu tự tải lại khi đổi. Trong mỗi bảng, gõ vào ô dưới tiêu đề cột để lọc theo cột đó; số "X/Y dòng" hiện số dòng khớp trên tổng. Cột ngày gõ dạng dd/mm/yyyy.',
  },
  {
    keys: ['tinh lai tat', 'tinh lai', 'bo qua'],
    answer:
      'Tính lại TAT: ở bảng Chi tiết TAT, tích cột "Bỏ qua" các dòng đặc biệt rồi bấm "↻ Tính lại TAT" để loại chúng khỏi trung bình TAT install / US return. Bấm "Đặt lại" để khôi phục. (Dòng CUVT luôn được loại khỏi 2 chỉ số này.)',
  },
  {
    keys: ['tab', 'bao cao', 'man hinh', 'trang'],
    answer:
      'Cấu trúc: tab "Tổng quan" (KPI + biểu đồ + bảng Chi tiết TAT); tab "Các Báo cáo khác" gồm Trả unservice, Xuất kho chưa lắp, Tháo chưa trả US, Chưa đối ứng, Chỉ lắp / Chỉ tháo, Other (on_ac), TAT hoàn kho — mỗi báo cáo lọc/tìm/xuất Excel độc lập.',
  },
  {
    keys: ['ky bao cao', 'thang', 'tuan', 'chon ky'],
    answer:
      'Kỳ báo cáo: chọn "Tháng", "Tuần (từ T2)", "Quý" hoặc "Năm". Dữ liệu tự tải lại theo kỳ đã chọn.',
  },
  // --- Cac tinh nang bo sung gan day ---
  {
    keys: ['chon nhieu', 'multi select', 'nhieu station', 'nhieu kho', 'nhieu trung tam', 'chon nhieu kho'],
    answer:
      'Station / Store / Trung tâm đều CHỌN ĐƯỢC NHIỀU: bấm vào ô để mở menu tích chọn (có ô tìm, nút "Chọn tất cả" / "Bỏ chọn"). Không chọn gì = tất cả. Dữ liệu chỉ tải lại KHI ĐÓNG menu nên tích nhiều mục không bị chậm. Dùng được cả bàn phím: ↑↓ di chuyển, Space tích, Enter chọn, Esc đóng. HAN/SGN/DAD được ghim lên đầu danh sách station.',
  },
  {
    keys: ['bo loc da luu', 'luu bo loc'],
    answer:
      'Bộ lọc đã lưu (nút ⭐): đặt tên cho tổ hợp Station/Store/Trung tâm + 2 ô tích hay dùng rồi gọi lại bằng một cú bấm. Nút hiện TÊN bộ lọc đang dùng nếu màn hình trùng khớp. LƯU Ý: kỳ báo cáo KHÔNG nằm trong bộ lọc đã lưu (nếu lưu cả "tháng 8" thì sang tháng sau sẽ sai) — chọn kỳ riêng mỗi lần. Bộ lọc lưu trên máy bạn, không dùng chung với người khác.',
  },
  {
    keys: ['dang loc gi', 'dieu kien dang loc', 'chip', 'xoa bo loc', 'bo loc dang ap dung'],
    answer:
      'Hàng "ĐANG LỌC" ngay dưới thanh lọc liệt kê mọi điều kiện đang áp dụng, mỗi cái một chip có dấu × để bỏ nhanh; nút "Xoá tất cả bộ lọc" dọn sạch. Hàng này tự ẩn khi không lọc gì, và chỉ hiện điều kiện CÓ tác dụng trên màn hình bạn đang xem.',
  },
  {
    keys: ['so lieu cu', 'so lieu luc may gio', 'tai lai', 'lam moi'],
    answer:
      'Nhãn "Số liệu lúc HH:MM" trên thanh lọc cho biết số liệu được TÍNH lúc nào (không phải lúc bạn mở trang) — máy chủ giữ kết quả vài phút để nhiều người xem cùng lúc không phải hỏi lại SQL Server. Quá 90 giây nhãn đổi màu. Muốn số mới nhất thì bấm "↻ Tải lại" — nó bỏ qua bộ nhớ đệm và hỏi lại thật.',
  },
  {
    keys: ['so sanh thang'],
    answer:
      'Bảng "So sánh các tháng" nằm cuối tab Tổng quan: chọn 3 / 6 / 12 tháng rồi bấm "▶ Xem". Có biểu đồ (cột Chưa đối ứng + đường TAT) và bảng số. Tháng đã đóng được máy chủ lưu lại nên hiện rất nhanh (đánh dấu 💾); tháng hiện tại luôn tính lại vì còn đang phát sinh. Đổi bộ lọc thì phải bấm Xem lại.',
  },
  {
    keys: ['cham', 'sao lau', 'mat bao lau moi xong'],
    answer:
      'Các truy vấn đọc dữ liệu AMOS đi qua linked server nên có câu mất hàng chục giây — nhất là tab LGC và các báo cáo. Trong lúc chờ, khung "đang tải" hiện NHẬT KÝ TIẾN TRÌNH theo thời gian thực: đang làm bước gì, mỗi bước mất bao lâu, hoặc bạn đang đứng thứ mấy trong hàng đợi. Nếu nhiều người cùng hỏi một truy vấn giống hệt nhau, hệ thống gộp lại chỉ chạy MỘT lần và mọi người dùng chung kết quả.',
  },
  {
    keys: ['bang rong', 'khong thay du lieu'],
    answer:
      'Bảng trống thì đọc dòng chữ giữa bảng — nó nói rõ là kỳ này thật sự không có dữ liệu, hay bộ lọc hiện tại không khớp dòng nào (kèm liệt kê điều kiện đang lọc). Cách nhanh nhất: bấm × trên các chip ở hàng "ĐANG LỌC", hoặc "Xoá tất cả bộ lọc". Cũng nên kiểm tra lại Kỳ báo cáo.',
  },
  {
    keys: ['loi', 'thu lai', 'bao loi do'],
    answer:
      'Gặp hộp báo lỗi đỏ: bấm nút "↻ Thử lại" ngay trong hộp đó — lỗi hay gặp nhất chỉ là linked server nghẽn nhất thời. Không cần tải lại cả trang. Nếu lặp lại nhiều lần thì báo quản trị (chi tiết lỗi đã ghi ở log máy chủ).',
  },
  {
    keys: ['lgc', 'trang lgc', 'quan ly xuat kho'],
    answer:
      'Trang LGC (địa chỉ /lgc) gồm 3 việc nội bộ của kho: Quản lý xuất kho, Receiving (phiếu nhập), Repair Admin. CHỈ nhân viên CUVT đăng nhập được. Trang này KHÔNG tự chạy truy vấn khi mở — chọn kỳ và bộ lọc xong rồi bấm "▶ Chạy kiểm tra", vì các truy vấn ở đây khá lâu.',
  },
  {
    keys: ['dang nhap', 'mat khau', 'doi mat khau'],
    answer:
      'Đăng nhập trang LGC: nhập MÃ NHÂN VIÊN và MẬT KHẨU. Lần đầu, mật khẩu chính là mã nhân viên VIẾT HOA; hệ thống sẽ bắt bạn đổi mật khẩu ngay (từ 6 ký tự và không được trùng mã nhân viên). Sai mật khẩu 5 lần liên tiếp thì tài khoản bị khoá 15 phút. Chỉ nhân viên CUVT mới lập được tài khoản.',
  },
  {
    keys: ['quen mat khau'],
    answer:
      'Quên mật khẩu: hiện chưa có chức năng tự đặt lại. Liên hệ quản trị viên để xoá tài khoản của bạn trong bảng TAT_USER — sau đó bạn đăng nhập lại bằng mã nhân viên viết hoa như lần đầu và đặt mật khẩu mới.',
  },
  {
    keys: ['quyen', 'ai xem duoc', 'nguoi ngoai'],
    answer:
      'Dashboard TAT (trang chủ) mở cho cả công ty xem. Riêng trang LGC chỉ nhân viên CUVT đăng nhập được — cả trang lẫn dữ liệu đều bị chặn ở máy chủ, không phải chỉ ẩn nút. Trang Quản trị chỉ mở cho máy quản trị theo địa chỉ IP.',
  },
  {
    keys: ['scan', 'chua scan', 'da scan', 'thu muc scan'],
    answer:
      'Cột "Scan" đối chiếu xem phiếu đã có file PDF trong thư mục scan chưa. Mỗi station một thư mục riêng (cấu hình ở trang Quản trị). Thẻ KPI "Đã scan / Chưa scan" đếm theo PHIẾU và tính trên TOÀN KỲ (một phiếu nhiều dòng chỉ cần một file) — nên số này có thể khác bảng chi tiết vốn đếm theo dòng. Dấu "—" nghĩa là KHÔNG ĐỌC ĐƯỢC thư mục, không phải chưa scan.',
  },
  {
    keys: ['huy', 'return', 'huy tra khac', 'phan loai huy'],
    answer:
      'Ở bảng xuất kho, cột "Loại" phân biệt: Bình thường · Cancel · Return · Hủy/trả khác. Mốc để biết CÓ hủy/trả hay không là QTY_CANCELED ≠ 0; sau đó xem đuôi nội dung phiếu để phân loại. Dòng có QTY_CANCELED ≠ 0 nhưng không có từ khoá nào thì xếp vào "Hủy/trả khác" — VẪN được tính là hủy/trả.',
  },
  {
    keys: ['gio xuat kho', 'gio huy', 'gio tra', 'chi co ngay'],
    answer:
      'Cột "Giờ xuất kho" và "Giờ hủy / trả" gộp cả ngày lẫn giờ. AMOS không phải lúc nào cũng có GIỜ: khi thiếu, ô hiện NGÀY kèm ghi chú "(chỉ có ngày)" bằng chữ mờ — cố ý không hiện 00:00 để bạn không tưởng đó là giờ thật. Dòng Cancel hiện "(sửa cuối)" vì AMOS không có cột riêng cho giờ hủy, đó chỉ là lần sửa cuối của dòng.',
  },
  {
    keys: ['khoa tai khoan', 'bi khoa', 'khoa 15 phut'],
    answer:
      'Tài khoản bị khoá là do sai mật khẩu 5 lần liên tiếp — hệ thống khoá 15 phút rồi tự mở lại, bạn chỉ cần chờ. Nếu không nhớ mật khẩu, liên hệ quản trị viên để đặt lại (xoá tài khoản trong bảng TAT_USER, sau đó bạn đăng nhập bằng mã nhân viên viết hoa như lần đầu).',
  },
  {
    keys: ['nhan vien nao', 'ai lap phieu', 'nguoi lap phieu', 'mech sign', 'booking sign', 'nguoi tao'],
    answer:
      'Ai lập phiếu: bảng chi tiết có các cột "Mech sign" (người nhận hàng — cũng là căn cứ xác định Trung tâm), "Booking sign" (người đặt) và "Người tạo". Gõ mã nhân viên vào ô lọc dưới tiêu đề cột để tìm nhanh. Ở bảng Chi tiết TAT còn có "Nhân viên" (người trả unservice) và "Người lập phiếu".',
  },
  {
    keys: ['costcenter', 'cost center', 'xuat costcenter'],
    answer:
      'Xuất costcenter là phiếu xuất mà ô Receiver ghi một CON SỐ (ví dụ 15, 1234, 12.5) chứ không phải số tàu — tức xuất cho bộ phận/đơn vị chứ không lắp lên máy bay. Ô tích "Bỏ qua xuất costcenter" trên thanh lọc sẽ loại các phiếu này rồi tính lại KPI và biểu đồ.',
  },
  {
    keys: ['repair admin'],
    answer:
      'Repair Admin (trong nhóm LGC) là ẢNH CHỤP HIỆN TRẠNG các thiết bị đang nằm ở vị trí sửa chữa và có đơn hàng chưa về — nên KHÔNG theo kỳ báo cáo, chỉ lọc theo Station/Store. Có phân nhóm theo tuổi đơn hàng (dưới 30 ngày / trên 30 ngày) để biết cái nào tồn lâu.',
  },
  {
    keys: ['maxrows', 'max rows', 'gioi han dong', 'cat bot dong', 'bao nhieu dong'],
    answer:
      'MAX_ROWS là giới hạn số dòng một bảng chi tiết trả về (mặc định 5.000) để trang không bị nặng. Khi chạm giới hạn, chỗ đếm số dòng hiện cảnh báo "⚠ chạm giới hạn MAX_ROWS" — lúc đó nên thu hẹp kỳ báo cáo hoặc bộ lọc. Lưu ý các thẻ KPI vẫn tính trên TOÀN KỲ, không bị cắt, nên KPI và bảng có thể lệch nhau.',
  },
  {
    keys: ['da tra chua', 'tra chua', 'kiem tra da tra', 'phieu tra', 'da hoan kho chua'],
    answer:
      'Xem một phiếu đã trả về kho chưa: ở bảng Quản lý xuất kho (nhóm LGC), dòng loại Return có cột "Phiếu trả" (số phiếu nhập lại kho), "Giờ hủy / trả" và "TAT return" (số ngày từ lúc xuất đến lúc về kho). "NOT FOUND" nghĩa là chưa tìm thấy phiếu nhập lại. Ở tab Tổng quan thì dùng báo cáo "Chưa đối ứng" để xem thiết bị xuất đi mà chưa quay về.',
  },
  {
    keys: ['phieu nhap'],
    answer:
      'Tab Receiving (trong nhóm LGC) thống kê phiếu NHẬP kho theo Station và Store — không theo Trung tâm, vì nhập kho là việc của kho. Kỳ tính theo ngày nhập. Có đối chiếu file scan phiếu nhập; tên file có thể ở dạng "R-259454" hoặc "259454" tuỳ station, hệ thống thử cả hai.',
  },
];

// ---------------------------------------------------------------------------
// 2. NHAN DIEN CHI SO (metric) cho cau hoi so lieu
// ---------------------------------------------------------------------------
const METRICS = [
  { keys: ['tat tong', 'tong tat', 'tat toan chuoi', 'tat 3 chang'], field: 'tatTotalAvg', label: 'TAT tổng (3 chặng)', unit: 'ngày' },
  { keys: ['tat install', 'tat lap'], field: 'tatInstallAvg', label: 'TAT install', unit: 'ngày' },
  { keys: ['us return', 'tat us', 'tra us'], field: 'tatUsReturnAvg', label: 'TAT US return', unit: 'ngày' },
  { keys: ['tat cuvt', 'cuvt'], field: 'tatCuvtAvg', label: 'TAT CUVT', unit: 'ngày' },
  { keys: ['hoan kho'], field: 'tatReturnStoreAvg', label: 'TAT hoàn kho', unit: 'ngày' },
  { keys: ['chua doi ung'], field: 'countNotReconciled', label: 'Số thiết bị chưa đối ứng', unit: 'thiết bị' },
  { keys: ['ty le doi ung', 'ty le'], field: 'reconcileRate', label: 'Tỷ lệ đối ứng', unit: '%' },
  { keys: ['xuat kho', 'so luong xuat', 'thiet bi xuat'], field: 'countIssued', label: 'Thiết bị xuất kho', unit: 'thiết bị' },
  { keys: ['chua lap', 'xuat chua lap'], field: 'countIssuedNotInstalled', label: 'Xuất kho chưa lắp', unit: 'thiết bị' },
];

// KHO TRI THUC "DA HOC": cac muc admin duyet bo sung (luu o data/kb-learned.json,
// server nap va goi setLearned). Moi muc: { keys:[da bo dau], answer:'...' }.
let LEARNED = [];
function setLearned(arr) {
  LEARNED = Array.isArray(arr) ? arr.filter((x) => x && Array.isArray(x.keys) && x.answer) : [];
}
function getLearned() { return LEARNED; }

/** Tim chu de KB co san TRUNG NHIEU TU NHAT voi cau hoi (de goi y bo sung). */
function bestMatch(message) {
  const n = expandSyn(norm(message));
  let best = { score: 0, answer: '', topic: '' };
  for (const item of [...DEFINITIONS, ...USAGE]) {
    for (const k of item.keys) {
      const toks = k.split(' ').filter(Boolean);
      const sc = toks.reduce((s, t) => s + (n.includes(t) ? 1 : 0), 0);
      if (sc > best.score) best = { score: sc, answer: item.answer, topic: item.keys[0] };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 3. HAM CHINH: interpret(message, ctx) -> { intent, ... }
//    ctx.departments: danh sach ten trung tam de nhan dien trong cau hoi
// ---------------------------------------------------------------------------
function matchKB(list, n) {
  for (const item of list) {
    if (item.keys.some((k) => hasKey(n, k))) return item.answer;
  }
  return null;
}

/** Tim ten trung tam xuat hien trong cau hoi (so khop khong dau). */
function findDepartment(n, departments) {
  if (!Array.isArray(departments)) return '';
  // Uu tien ten dai truoc (tranh 'PA' khop nham trong 'PART')
  const sorted = [...departments].sort((a, b) => b.length - a.length);
  for (const d of sorted) {
    const nd = norm(d);
    if (!nd) continue;
    const re = new RegExp(`(^|[^a-z0-9])${nd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
    if (re.test(n)) return d;
  }
  return '';
}

/** Nhan dien ky bao cao tu cau hoi.
 *  Tra { periodType, month? | week? | quarter? | year? } hoac null. */
function findPeriod(n) {
  const now = new Date();
  const curQ = Math.floor(now.getMonth() / 3) + 1;
  // --- QUY: "quy nay/truoc", "quy 3", "quy 3/2026", "quy 3 nam 2026" ---
  if (/quy truoc/.test(n)) {
    const y = curQ === 1 ? now.getFullYear() - 1 : now.getFullYear();
    const q = curQ === 1 ? 4 : curQ - 1;
    return { periodType: 'quarter', quarter: `${y}-Q${q}` };
  }
  if (/quy nay/.test(n)) {
    return { periodType: 'quarter', quarter: `${now.getFullYear()}-Q${curQ}` };
  }
  const mq = n.match(/quy\s*([1-4])(?:\s*(?:[/\-]|nam)?\s*(\d{4}))?/);
  if (mq) {
    return { periodType: 'quarter', quarter: `${mq[2] || now.getFullYear()}-Q${mq[1]}` };
  }
  // --- NAM: "nam nay", "nam truoc/ngoai", "nam 2025" ---
  if (/nam (truoc|ngoai)/.test(n)) {
    return { periodType: 'year', year: String(now.getFullYear() - 1) };
  }
  if (/nam nay|ca nam/.test(n)) {
    return { periodType: 'year', year: String(now.getFullYear()) };
  }
  const my = n.match(/nam\s*(\d{4})/);
  if (my) return { periodType: 'year', year: my[1] };
  // --- THANG ---
  if (/thang truoc/.test(n)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { periodType: 'month', month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` };
  }
  if (/thang nay/.test(n)) {
    return { periodType: 'month', month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` };
  }
  // "thang 7" hoac "thang 7/2026" hoac "thang 7 2026"
  const m = n.match(/thang\s*(\d{1,2})(?:\s*[/\-]?\s*(\d{4}))?/);
  if (m) {
    const mm = String(Math.min(12, Math.max(1, parseInt(m[1], 10)))).padStart(2, '0');
    const yyyy = m[2] || String(now.getFullYear());
    return { periodType: 'month', month: `${yyyy}-${mm}` };
  }
  if (/tuan (nay|truoc)|tuan/.test(n)) return { periodType: 'week' };
  return null;
}

/** Token trong giong ma thiet bi (part/serial/label): >=4 ky tu, co chu so. */
function findDeviceCode(raw) {
  const tokens = String(raw || '').split(/[\s,]+/);
  for (const t of tokens) {
    const c = t.replace(/[^0-9A-Za-z-]/g, '');
    if (c.length >= 4 && /[0-9]/.test(c) && /^[0-9A-Za-z-]+$/.test(c)) return c;
  }
  return '';
}

/**
 * TU THUOC PHAM VI CHUONG TRINH.
 * Cau hoi khong chua tu nao trong day thi KHONG tra loi - tra "chua hieu".
 * Vi sao can: truoc day "thoi tiet ha noi hom nay the nao" duoc tra loi (tu
 * 'noi' trong 'ha noi' khop khoa ma ly do NOI), va "gia vang hom nay bao nhieu"
 * bi doc thanh cau hoi so lieu vi co 'bao nhieu' + 'hom nay'. Tra loi bua con
 * te hon khong tra loi: nguoi dung se tin theo.
 */
const TU_CHUYEN_NGANH = [
  'tat', 'doi ung', 'xuat kho', 'nhap kho', 'hoan kho', 'kho', 'phieu', 'thiet bi',
  'trung tam', 'station', 'store', 'scan', 'huy', 'return', 'unservice', 'service',
  'install', 'lap', 'thao', 'cuvt', 'lgc', 'dashboard', 'bao cao', 'bo loc', 'loc',
  'excel', 'mat khau', 'dang nhap', 'quyen', 'so lieu', 'du lieu', 'bang', 'cot',
  // CO Y khong dua 'thang'/'tuan'/'quy'/'nam' vao day: chung la tu CHI THOI GIAN,
  // khong phai tu nghiep vu. De vao thi "luong thang nay bao nhieu" cung lot
  // cong va bi doc thanh cau hoi so lieu. Cau hoi ve ky bao cao that su luon
  // kem mot tu nghiep vu khac ('tat thang truoc', 'so lieu thang 7'...).
  'bieu do', 'ky bao cao', 'part', 'serial', 'label',
  'amos', 'repair', 'receiving', 'picking', 'cancel', 'kpi', 'chi so', 'tra cuu',
  'cham', 'loi', 'tai lai', 'lam moi', 'trang', 'tab', 'so sanh',
];
/**
 * Cau hoi co dinh den nghiep vu/chuong trinh khong?
 *
 * HAI duong vao:
 *   (a) chua mot tu trong TU_CHUYEN_NGANH (so khop theo TU, khong phai chuoi
 *       con - de 'noi' trong 'ha noi' khong bi tinh la tu nghiep vu), HOAC
 *   (b) khop DU CU THE mot khoa nao do trong kho kien thuc.
 *
 * (b) quan trong: neu chi dua vao danh sach (a) thi moi lan them muc KB moi lai
 * phai nho them tu vao danh sach - hai noi phai dong bo bang tay. Da sap bay
 * that: them muc 'costcenter', 'maxrows', 'khoa tai khoan' xong van bi cong
 * chan vi quen cap nhat danh sach. Nay them muc KB la tu dong mo pham vi.
 *
 * "Du cu the" = khoa >= 2 tu, hoac khoa 1 tu nhung dai >= 6 ky tu. Nguong nay
 * de khoa ngan nhu 'noi' / 'rob' khong keo cau hoi ngoai le vao.
 */
function trongPhamVi(n) {
  // Dung chung hasKey() de cung theo TU va DUNG THU TU. Truoc day cho nay tu
  // kiem tra bang Set (khong ke thu tu) nen 'bao cao' khop "bay CAO BAO nhieu"
  // va cau hoi ngoai le lot cong - dung y het loi da sua trong hasKey().
  if (TU_CHUYEN_NGANH.some((k) => hasKey(n, k))) return true;
  for (const item of [...DEFINITIONS, ...USAGE, ...LEARNED]) {
    for (const k of item.keys) {
      const toks = k.split(' ').filter(Boolean);
      const duCuThe = toks.length >= 2 || (toks.length === 1 && toks[0].length >= 6);
      if (duCuThe && hasKey(n, k)) return true;
    }
  }
  return false;
}

/** So tu (bo tu mo) cua khoa khop dai nhat trong mot danh sach KB. */
function doCuThe(list, n) {
  let best = 0; let ans = null;
  for (const item of list) {
    for (const k of item.keys) {
      if (!hasKey(n, k)) continue;
      const d = k.split(' ').filter(Boolean).length;
      if (d > best) { best = d; ans = item.answer; }
    }
  }
  return { do: best, answer: ans };
}

function interpret(message, ctx = {}) {
  const raw = String(message || '');
  const n = expandSyn(norm(raw)); // bo dau + ap dong nghia
  if (!n) return { intent: 'help' };

  const department = findDepartment(n, ctx.departments);
  const period = findPeriod(n);

  const isQuestionWord = /(bao nhieu|may|so luong|trung binh|cao nhat|thap nhat|top|ty le|list|liet ke|thong ke)/.test(n);
  const isDefine = /(la gi|nghia la|dinh nghia|giai thich|khac nhau|the nao)/.test(n);
  const wantsDevice = /(tra cuu|tra thiet bi|lich su|thiet bi|part\s*no|serial|label|linh kien)/.test(n);
  const wantsReconcile = /(doi ung|dong vong|khop phieu|da tra|da hoan)/.test(n);
  const deviceCode = findDeviceCode(raw);

  // --- (0) Tim doi ung cua 1 thiet bi: co "doi ung" + ma thiet bi (KHONG hoi "la gi") ---
  //     Chieu NGUOC: hoi ve 1 SN unservice -> tim phieu xuat doi ung.
  const reverseRecon =
    /(^|\s)unservice\s+[0-9a-z-]*\d/.test(n) ||
    /(phieu nao|xuat nao|tu phieu|tra ve tu|doi ung nguoc|nguoc lai)/.test(n);
  if (wantsReconcile && deviceCode && !isDefine) {
    return { intent: 'reconcile', term: deviceCode, direction: reverseRecon ? 'reverse' : 'forward' };
  }
  // "unservice <ma>" (khong co tu 'doi ung') cung la chieu nguoc
  if (reverseRecon && deviceCode && !isDefine) {
    return { intent: 'reconcile', term: deviceCode, direction: 'reverse' };
  }

  // --- (1) Tra cuu thiet bi: co tu khoa tra cuu + ma, hoac chi 1 ma don doc ---
  if ((wantsDevice && deviceCode) || (deviceCode && n.replace(deviceCode.toLowerCase(), '').trim().length <= 3)) {
    return { intent: 'device', term: deviceCode };
  }

  // --- (2) Chao / tro giup ---
  if (/^(chao|hi|hello|xin chao|helo|alo)\b/.test(n) || /(ban lam duoc gi|giup gi|huong dan|help|menu)/.test(n)) {
    return { intent: 'help' };
  }

  // --- (2b) CONG PHAM VI: cau khong dinh gi den chuong trinh -> khong tra loi ---
  if (!trongPhamVi(n)) return { intent: 'unknown', suggestions: suggestTopics(n) };

  // --- (3) Dinh nghia (uu tien khi hoi "la gi") ---
  if (isDefine) {
    const ans = matchKB(DEFINITIONS, n);
    if (ans) return { intent: 'kb', answer: ans };
  }

  // --- (4) Truy van so lieu: co chi so / xep hang / tu de hoi / co ky / trung tam ---
  //     UU TIEN truoc huong dan (tranh tu 'thang'/'tuan' khop nham muc huong dan).
  const metrics = METRICS.filter((mt) => mt.keys.some((k) => hasKey(n, k)));
  const rankTop = /(cao nhat|top|xep hang|nhieu nhat)/.test(n);
  const rankLow = /(thap nhat|it nhat)/.test(n);
  const wantsSummary = /(tong quan|tong hop|tom tat|summary|ky nay|tinh hinh|so lieu)/.test(n);

  // --- (3b) HUONG DAN THANG khi no CU THE HON cau hoi so lieu ---
  //     "sao gio xuat kho chi co ngay" co tu 'xuat kho' (mot chi so) nhung y
  //     nguoi hoi ro rang la HUONG DAN, vi khoa 'chi co ngay' (3 tu) cu the hon
  //     'xuat kho' (2 tu). Khong co chi so nao thi khoa phai >= 2 tu moi duoc
  //     uu tien - neu khong 'thang' se nuot moi cau hoi so lieu theo thang.
  if (!rankTop && !rankLow) {
    const kb = doCuThe([...USAGE, ...DEFINITIONS, ...LEARNED], n);
    const mDo = metrics.length
      ? Math.max(...metrics.map((mt) => Math.max(...mt.keys.filter((k) => hasKey(n, k))
        .map((k) => k.split(' ').filter(Boolean).length))))
      : 0;
    if (kb.answer && kb.do >= 2 && kb.do > mDo) return { intent: 'kb', answer: kb.answer };
  }

  if (metrics.length || rankTop || rankLow || isQuestionWord || period || department || wantsSummary) {
    return {
      intent: 'kpi',
      metrics: metrics.map((m) => m.field),
      rank: rankTop ? 'top' : rankLow ? 'low' : null,
      department,
      period,
    };
  }

  // --- (4b) KB DA HOC (admin duyet) - uu tien truoc huong dan/unknown ---
  const learned = matchKB(LEARNED, n);
  if (learned) return { intent: 'learned', answer: learned };

  // --- (5) Huong dan dung dashboard ---
  const usage = matchKB(USAGE, n);
  if (usage) return { intent: 'kb', answer: usage };

  // --- (6) Thu KB dinh nghia lan cuoi ---
  const anyDef = matchKB(DEFINITIONS, n);
  if (anyDef) return { intent: 'kb', answer: anyDef };

  // --- (7) KHOP GAN DUNG: nguoi dung hoi theo cach cua ho, khong the doi ho
  //     go trung tu khoa. matchKB() doi PHAI CO DU moi tu trong khoa nen rat
  //     de truot. O day cham diem theo TY LE tu khop; du diem thi van tra loi,
  //     nhung noi ro la doan de nguoi doc con biet ma hoi lai.
  const gan = timGanDung(n);
  if (gan) return { intent: 'kb-gan', answer: gan.answer, chuDe: gan.chuDe };

  return { intent: 'unknown', suggestions: suggestTopics(n) };
}

/**
 * Tim muc KB GAN DUNG nhat voi cau hoi.
 * Cham diem = ty le tu trong khoa xuat hien trong cau hoi. Yeu cau:
 *   - khop it nhat 1 tu "co nghia" (bo cac tu qua ngan / qua pho bien), VA
 *   - ty le >= 0.6 (khoa 2 tu phai trung ca 2; khoa 3 tu duoc phep truot 1)
 * Nguong nay cot de KHONG tra loi bua: tha bao "chua hieu" con hon tra loi
 * lac de - nguoi dung se tin nham.
 */
const TU_MO = new Set(['la', 'gi', 'the', 'nao', 'cua', 'cho', 'khi', 'co', 'thi', 'va', 'o', 'tren', 'trong']);
function timGanDung(n) {
  let best = null;
  for (const item of [...DEFINITIONS, ...USAGE, ...LEARNED]) {
    for (const k of item.keys) {
      const toks = k.split(' ').filter((t) => t && !TU_MO.has(t));
      if (!toks.length) continue;
      const trung = toks.filter((t) => n.includes(t));
      if (!trung.length) continue;
      const diem = trung.length / toks.length;
      if (diem < 0.6) continue;
      // Khoa MOT tu thi tu do phai du dai, tranh khop lung tung ('tab', 'loi'...)
      if (toks.length === 1 && toks[0].length < 5) continue;
      if (!best || diem > best.diem || (diem === best.diem && trung.length > best.soTu)) {
        best = { diem, soTu: trung.length, answer: item.answer, chuDe: item.keys[0] };
      }
    }
  }
  return best;
}

/** Goi y chu de gan nhat dua tren so tu khoa trung (khi chua hieu cau hoi). */
function suggestTopics(n) {
  const pool = [
    { label: 'TAT install là gì', keys: ['tat', 'install', 'lap'] },
    { label: 'TAT US return là gì', keys: ['us', 'return', 'tra', 'unservice'] },
    { label: 'Đối ứng là gì', keys: ['doi ung', 'khop', 'dong vong'] },
    { label: 'Trả service là gì', keys: ['tra service', 'recert', 'kiem dinh'] },
    { label: 'Có bao nhiêu thiết bị chưa đối ứng', keys: ['chua doi ung', 'ton'] },
    { label: 'Đối ứng của serial …', keys: ['doi ung', 'thiet bi', 'serial', 'part', 'label'] },
    { label: 'Cách xuất Excel', keys: ['excel', 'xuat', 'file'] },
    { label: 'Cách lọc', keys: ['loc', 'filter', 'tim'] },
  ];
  const scored = pool
    .map((p) => ({ label: p.label, score: p.keys.reduce((s, k) => s + (n.includes(k) ? 1 : 0), 0) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((p) => p.label);
  return scored;
}

/** Van ban tro giup (liet ke nang luc). */
function helpText() {
  return [
    'Tôi có thể giúp anh/chị:',
    '• Số liệu: "TAT install tháng 7 của CNBDNT", "có bao nhiêu thiết bị chưa đối ứng", "trung tâm nào TAT cao nhất".',
    '• Tìm đối ứng: "đối ứng của serial 43842" — thiết bị đã trả unservice (SN nào, khi nào) / trả service (giờ recertify) / hoàn kho hay chưa.',
    '• Chiều ngược: "unservice 43842" hoặc "SN 43842 trả về từ phiếu nào" — tìm phiếu xuất đối ứng của 1 SN đã trả về kho.',
    '• Tra cứu thiết bị: "tra cứu serial 43842" hoặc gõ số label/part.',
    '• Định nghĩa: "TAT US return là gì", "trả service là gì", "costcenter là gì".',
    '• Hướng dẫn: "cách xuất Excel", "cách lọc", "tính lại TAT là gì".',
  ].join('\n');
}

module.exports = {
  interpret, helpText, norm, bestMatch,
  setLearned, getLearned,
  DEFINITIONS, USAGE, METRICS,
};
