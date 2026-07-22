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

// ---------------------------------------------------------------------------
// 1. KIEN THUC (KB): dinh nghia nghiep vu + huong dan dung dashboard
//    Moi muc: { keys: [tu khoa da BO DAU], answer: 'noi dung' }
// ---------------------------------------------------------------------------
const DEFINITIONS = [
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
    keys: ['loc', 'filter', 'tim kiem', 'tim'],
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
      'Cấu trúc: tab "Tổng quan" (KPI + biểu đồ + bảng Chi tiết TAT); tab "Các Báo cáo khác" gồm Trả unservice, Xuất kho chưa lắp, Tháo chưa trả US, Chưa đối ứng, Tháo trước lắp sau, Other (on_ac), TAT hoàn kho — mỗi báo cáo lọc/tìm/xuất Excel độc lập.',
  },
  {
    keys: ['ky bao cao', 'thang', 'tuan', 'chon ky'],
    answer:
      'Kỳ báo cáo: chọn "Tháng" (chọn tháng) hoặc "Tuần (từ T2)" (chọn ngày tham chiếu, tuần tính từ Thứ 2). Dữ liệu tự tải lại theo kỳ đã chọn.',
  },
];

// ---------------------------------------------------------------------------
// 2. NHAN DIEN CHI SO (metric) cho cau hoi so lieu
// ---------------------------------------------------------------------------
const METRICS = [
  { keys: ['tat install', 'tat lap'], field: 'tatInstallAvg', label: 'TAT install', unit: 'ngày' },
  { keys: ['us return', 'tat us', 'tra us'], field: 'tatUsReturnAvg', label: 'TAT US return', unit: 'ngày' },
  { keys: ['tat cuvt', 'cuvt'], field: 'tatCuvtAvg', label: 'TAT CUVT', unit: 'ngày' },
  { keys: ['hoan kho'], field: 'tatReturnStoreAvg', label: 'TAT hoàn kho', unit: 'ngày' },
  { keys: ['chua doi ung'], field: 'countNotReconciled', label: 'Số thiết bị chưa đối ứng', unit: 'thiết bị' },
  { keys: ['ty le doi ung', 'ty le'], field: 'reconcileRate', label: 'Tỷ lệ đối ứng', unit: '%' },
  { keys: ['xuat kho', 'so luong xuat', 'thiet bi xuat'], field: 'countIssued', label: 'Thiết bị xuất kho', unit: 'thiết bị' },
  { keys: ['chua lap', 'xuat chua lap'], field: 'countIssuedNotInstalled', label: 'Xuất kho chưa lắp', unit: 'thiết bị' },
];

// ---------------------------------------------------------------------------
// 3. HAM CHINH: interpret(message, ctx) -> { intent, ... }
//    ctx.departments: danh sach ten trung tam de nhan dien trong cau hoi
// ---------------------------------------------------------------------------
function matchKB(list, n) {
  for (const item of list) {
    if (item.keys.some((k) => n.includes(k))) return item.answer;
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

/** Nhan dien ky bao cao tu cau hoi. Tra { periodType, month?, week? } hoac null. */
function findPeriod(n) {
  // "thang 7" hoac "thang 7/2026" hoac "thang 7 2026"
  const m = n.match(/thang\s*(\d{1,2})(?:\s*[/\-]?\s*(\d{4}))?/);
  if (m) {
    const mm = String(Math.min(12, Math.max(1, parseInt(m[1], 10)))).padStart(2, '0');
    const yyyy = m[2] || String(new Date().getFullYear());
    return { periodType: 'month', month: `${yyyy}-${mm}` };
  }
  if (/tuan/.test(n)) return { periodType: 'week' };
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

function interpret(message, ctx = {}) {
  const raw = String(message || '');
  const n = norm(raw);
  if (!n) return { intent: 'help' };

  const department = findDepartment(n, ctx.departments);
  const period = findPeriod(n);

  const isQuestionWord = /(bao nhieu|may|so luong|trung binh|cao nhat|thap nhat|top|ty le|list|liet ke|thong ke)/.test(n);
  const isDefine = /(la gi|nghia la|dinh nghia|giai thich|khac nhau|the nao)/.test(n);
  const wantsDevice = /(tra cuu|tra thiet bi|lich su|thiet bi|part\s*no|serial|label|linh kien)/.test(n);
  const deviceCode = findDeviceCode(raw);

  // --- (1) Tra cuu thiet bi: co tu khoa tra cuu + ma, hoac chi 1 ma don doc ---
  if ((wantsDevice && deviceCode) || (deviceCode && n.replace(deviceCode.toLowerCase(), '').trim().length <= 3)) {
    return { intent: 'device', term: deviceCode };
  }

  // --- (2) Chao / tro giup ---
  if (/^(chao|hi|hello|xin chao|helo|alo)\b/.test(n) || /(ban lam duoc gi|giup gi|huong dan|help|menu)/.test(n)) {
    return { intent: 'help' };
  }

  // --- (3) Dinh nghia (uu tien khi hoi "la gi") ---
  if (isDefine) {
    const ans = matchKB(DEFINITIONS, n);
    if (ans) return { intent: 'kb', answer: ans };
  }

  // --- (4) Truy van so lieu: co chi so / xep hang / tu de hoi / co ky / trung tam ---
  //     UU TIEN truoc huong dan (tranh tu 'thang'/'tuan' khop nham muc huong dan).
  const metrics = METRICS.filter((mt) => mt.keys.some((k) => n.includes(k)));
  const rankTop = /(cao nhat|top|xep hang|nhieu nhat)/.test(n);
  const rankLow = /(thap nhat|it nhat)/.test(n);
  const wantsSummary = /(tong quan|tong hop|tom tat|summary|ky nay|tinh hinh|so lieu)/.test(n);
  if (metrics.length || rankTop || rankLow || isQuestionWord || period || department || wantsSummary) {
    return {
      intent: 'kpi',
      metrics: metrics.map((m) => m.field),
      rank: rankTop ? 'top' : rankLow ? 'low' : null,
      department,
      period,
    };
  }

  // --- (5) Huong dan dung dashboard ---
  const usage = matchKB(USAGE, n);
  if (usage) return { intent: 'kb', answer: usage };

  // --- (6) Con lai: thu KB dinh nghia lan cuoi, khong thi tra ve unknown ---
  const anyDef = matchKB(DEFINITIONS, n);
  if (anyDef) return { intent: 'kb', answer: anyDef };
  return { intent: 'unknown' };
}

/** Van ban tro giup (liet ke nang luc). */
function helpText() {
  return [
    'Tôi có thể giúp anh/chị:',
    '• Số liệu: "TAT install tháng 7 của CNBDNT", "có bao nhiêu thiết bị chưa đối ứng", "trung tâm nào TAT cao nhất".',
    '• Tra cứu thiết bị: "tra cứu serial 43842" hoặc gõ số label/part.',
    '• Định nghĩa: "TAT US return là gì", "trả service là gì", "costcenter là gì".',
    '• Hướng dẫn: "cách xuất Excel", "cách lọc", "tính lại TAT là gì".',
  ].join('\n');
}

module.exports = { interpret, helpText, norm, DEFINITIONS, USAGE, METRICS };
