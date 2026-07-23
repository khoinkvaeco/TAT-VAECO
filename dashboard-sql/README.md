# Dashboard Báo cáo TAT (Turn-Around-Time) — VAECO

Web Dashboard đọc dữ liệu từ **SQL Server** (các bảng `NQT.dbo.*` và `DWH_DB..STG_AMOS.SIGN` của hệ AMOS), tính toán **TAT** cho từng đơn vị / station / CUVT / hoàn kho, hiển thị **KPI cards, biểu đồ, bảng dữ liệu** và các **báo cáo có export Excel**.

- **Frontend:** HTML5 + Tailwind CSS (CDN) + Chart.js + Tabulator.js
- **Backend:** Node.js + Express + `mssql`
- **Bảo mật:** không hardcode mật khẩu — dùng biến môi trường (`.env`)

---

## 1. Cấu trúc project

```
dashboard-sql/
├── server.js          # Backend Node.js + Express + mssql (API + tính toán TAT)
├── demo-data.js       # Dữ liệu mẫu cho DEMO_MODE (chạy thử không cần SQL Server)
├── package.json
├── .env.example       # Mẫu cấu hình — copy thành .env
├── .gitignore
└── public/
    ├── index.html     # Giao diện (KPI, charts, tables, tabs báo cáo)
    ├── style.css      # Bảng màu + theme sáng/tối
    └── script.js      # Gọi API, vẽ chart/table, filter, export Excel
```

## 2. Cài đặt

Yêu cầu: **Node.js >= 18**.

```bash
cd dashboard-sql
npm install
```

## 3. Cấu hình kết nối SQL Server

Copy file mẫu rồi điền thông tin:

```bash
cp .env.example .env
```

Mở `.env` và sửa:

| Biến | Ý nghĩa |
|------|---------|
| `DB_USER` / `DB_PASSWORD` | Tài khoản SQL Server (cần quyền đọc **cả 2** database `NQT` và `DWH_DB`) |
| `DB_SERVER` | Host/IP SQL Server |
| `DB_DATABASE` | Database mặc định khi kết nối (mặc định `NQT`) |
| `DB_PORT` | Cổng (mặc định `1433`) |
| `DB_INSTANCE` | Tên named instance (vd `SQLEXPRESS`) — để trống nếu không dùng |
| `DB_ENCRYPT` | `true` nếu SQL Server yêu cầu mã hóa (Azure SQL bắt buộc `true`) |
| `DB_TRUST_SERVER_CERTIFICATE` | `true` khi dùng self-signed cert trong LAN |
| `PORT` | Cổng web (mặc định `3000`) |
| `MAX_ROWS` | Số dòng tối đa mỗi query (tối ưu performance, mặc định `5000`) |
| `AMOS_TZ_OFFSET_HOURS` | Chênh lệch giờ AMOS→VN (AMOS lưu UTC → `7`) |
| `DEMO_MODE` | `true` để chạy thử với dữ liệu mẫu (không cần SQL Server) |

> ⚠️ **Không commit file `.env` thật** — nó đã được thêm vào `.gitignore`.

## 4. Chạy

```bash
# Chạy production
npm start

# Chạy dev (tự reload khi sửa server.js/chatbot.js/llm.js — Node >= 18)
npm run dev
```

Mở trình duyệt: **http://localhost:3000**

### Chạy nền như Windows Service

Để dashboard tự chạy khi bật máy (không phải mở CMD thủ công), cài thành Windows
Service — xem hướng dẫn đầy đủ ở **[`docs/DEPLOY-SERVICE.md`](docs/DEPLOY-SERVICE.md)**. Tóm tắt (CMD/PowerShell **Run as Administrator**):

```cmd
npm run service:install      :: cài + khởi động service "DashboardTAT"
npm run service:uninstall    :: gỡ service
```
Sau khi sửa code: `git pull` (hoặc copy) rồi `sc stop DashboardTAT & sc start DashboardTAT` để nạp bản mới.

### Chạy thử không cần SQL Server (DEMO)

Đặt `DEMO_MODE=true` trong `.env` rồi `npm start` — toàn bộ giao diện chạy với dữ liệu mẫu để bạn xem trước.

## 5. Các định nghĩa TAT (nghiệp vụ)

| Chỉ số | Định nghĩa |
|--------|-----------|
| **TAT Trung tâm (department)** | Từ lúc **xuất kho** (`kho_ser1` `vm='T'`, voucher `P-...`) đến lúc **trả unservice** (`real_us1.del_time`). Tính theo **ngày**. Link `kho_ser1(partno,serialno,voucherno)`=`real_us1(partno,serialno,voucher_s)`. **Trung tâm** = `real_us1.department`; nếu trống/`UNKNOWN` → nếu `mutator` bắt đầu bằng `PA` thì `PA`, ngược lại tra `mutator` vào `SIGN`; cuối cùng mặc định `PA`. (Bảng không có `department` như kho_ser1/on_off thì dùng `mutator`.) |
| **TAT CUVT** | `reci_time − del_time` trong `real_us1` (đều là datetime giờ VN). |
| **TAT hoàn kho** | Thiết bị hoàn kho (`vm='TC'`, voucher `P-CA-...`) đối chiếu phiếu xuất (`vm='T'`, `P-...`) cùng `partno/serialno/labelno`. TAT = thời điểm hoàn − thời điểm xuất (đơn vị: ngày). |
| **Xuất kho chưa lắp** | `kho_ser1 vm='T'` không có `on_off vm='YE'` (link `partno,serialno,labelno`). |
| **Tháo chưa trả US** | `on_off vm='YA'` không có `real_us1` (link `historyno_`). |
| **Chưa đối ứng** | Có xuất service nhưng không có trả unservice. |
| **Tháo trước lắp sau** | Sự kiện `YA` trước `YE` cùng thiết bị → TAT riêng. |
| **Other** | Note trong `on_ac` của `real_us1`. |

### Quy đổi giờ AMOS → VN

`mutation` (ngày AMOS, dạng `yyyymmdd`) + `mutation_t` (giờ AMOS = **số millisecond kể từ 00:00**) là **UTC**, được cộng `AMOS_TZ_OFFSET_HOURS` (mặc định +7) để ra giờ VN. Ví dụ `mutation_t = 71820341` → `19:57:00`. Biểu thức quy đổi nằm **duy nhất** trong hàm `amosToVN()` ở `server.js` — nếu định dạng khác, chỉ cần sửa ở đó. `del_time`, `reci_time` đã là datetime giờ VN nên dùng trực tiếp.

## 6. Tính năng

- **Dashboard:** 6 KPI cards, 4 biểu đồ (cột / tròn / đường / top 10), bảng chi tiết có phân trang + tìm kiếm + filter theo cột.
- **Báo cáo đơn vị:** 6 tab (xuất kho chưa lắp, tháo chưa trả US, chưa đối ứng, tháo trước lắp sau, other, TAT hoàn kho) — mỗi tab **export Excel**.
- **Bộ lọc:** Station, Store, Department, kỳ **tháng** hoặc **tuần** (Thứ 5 tuần này → Thứ 5 tuần trước).
- **Khác:** loading indicator, thông báo lỗi kết nối, theme sáng/tối, responsive.
- **Trợ lý TAT (chatbox nội bộ):** nút 💬 góc dưới-phải. Xử lý **cục bộ** theo luật/ý định (rule/intent) — **không gọi dịch vụ ngoài, không gửi dữ liệu ra ngoài**. Trả lời 5 nhóm: (1) **số liệu** ("TAT install tháng 7 của CNBDNT", "bao nhiêu thiết bị chưa đối ứng", "trung tâm nào TAT cao nhất"); (2) **tìm đối ứng** của 1 thiết bị ("đối ứng của serial 43842") → từng phiếu xuất gần nhất: trả unservice (kèm **SN được trả + giờ trả**) / trả service (kèm **giờ recertify**) / hoàn kho / bị hủy / CHƯA đối ứng. **Chiều ngược** ("unservice 43842", "SN 43842 trả về từ phiếu nào") → tìm ngược phiếu xuất đối ứng của 1 SN đã trả về kho; (3) **tra cứu 1 thiết bị** theo part/serial/label → lịch sử booking (on_off); (4) **định nghĩa nghiệp vụ** (TAT install/US return/hoàn kho, đối ứng, trả service, costcenter…); (5) **hướng dẫn dùng dashboard**. Câu hỏi không nêu kỳ/trung tâm sẽ dùng bộ lọc đang chọn trên trang. Logic NLU ở `chatbot.js` (hàm thuần, test được không cần DB).
  - **NLU nội bộ (mặc định, không cần hạ tầng):** hiểu nhiều cách hỏi (đồng nghĩa, thiếu dấu, so khớp theo cụm từ), kỳ tương đối ("tháng này/tháng trước/tuần này"), và gợi ý chủ đề gần nhất khi chưa hiểu. **Mọi câu hỏi** gửi tới chatbot được ghi vào `logs/chat-YYYY-MM-DD.log` (TSV: giờ · IP · intent · nội dung — mở bằng Excel) để review câu hỏi thực tế; riêng câu **chưa hiểu** còn ghi vào `logs/chat-unknown-YYYY-MM-DD.log`; xem/review tập trung tại **trang Admin** (`/admin` — link ở footer dashboard, chỉ IP quản trị).
  - **Vòng học nội bộ (không internet):** trang Admin có 3 tab — *Câu hỏi chưa hiểu*, *Tất cả câu hỏi* (gom theo nội dung + thống kê theo intent), *Gợi ý học (KB)*. Ở tab Gợi ý: mỗi câu chưa hiểu kèm chủ đề KB gần nhất; admin sửa/nhập câu trả lời rồi **Duyệt** → lưu `data/kb-learned.json` và **chatbot trả lời được ngay** (intent `learned`), không sửa code, không gửi dữ liệu ra ngoài. Mở rộng sâu vẫn có thể sửa `DEFINITIONS`/`USAGE`/`METRICS`/`SYNONYMS` trong `chatbot.js`.
  - **Mô hình AI nội bộ (tùy chọn, để thông minh hơn):** đặt `LLM_URL` trong `.env` trỏ tới một **local LLM trong LAN** (ví dụ Ollama). Khi bật, câu hỏi tự do (bot chưa hiểu) sẽ được LLM trả lời, **grounding bằng kho tri thức** (chỉ dùng kiến thức được cung cấp, không bịa số liệu). **Khóa an toàn bắt buộc:** server **từ chối** gọi nếu `LLM_URL` trỏ ra ngoài mạng nội bộ (không phải 10.x/192.168.x/172.16–31.x/tên máy LAN) → **không bao giờ gửi dữ liệu ra ngoài phạm vi công ty**. Mặc định TẮT (không cấu hình → chạy thuần rule/intent). Số liệu/tra cứu/đối ứng **luôn tính bằng SQL nội bộ**, LLM chỉ diễn giải — nên con số luôn chính xác. Adapter ở `llm.js`, hỗ trợ Ollama (`/api/chat`) và endpoint OpenAI-compatible.
- **Ghi log truy cập:** mọi request được ghi vào `logs/access-YYYY-MM-DD.log` (1 file/ngày, định dạng TSV — mở trực tiếp bằng Excel) gồm: thời gian, IP, tên máy, method, đường dẫn, mã trạng thái, thời gian xử lý. Thư mục `logs/` không commit lên git (`.gitignore`).
  - **Tra tên máy** theo 2 bước, cache 10 phút/IP: (1) reverse-DNS (PTR record) — chỉ có nếu DNS nội bộ khai báo; (2) nếu thất bại và server chạy trên **Windows**, thử `nbtstat -A <ip>` (NetBIOS qua UDP 137) — không phụ thuộc DNS, thường lấy được tên máy Windows trong cùng LAN. Nếu cả hai đều thất bại (mạng khác VLAN chặn UDP 137, máy tắt NetBIOS, hoặc server chạy Linux/macOS), cột tên máy ghi `N/A` — vẫn còn cột IP để tra thủ công.

## 7. Bảo mật & performance

- Mật khẩu chỉ nằm trong `.env` (không hardcode, không commit).
- Mọi query dùng **tham số hóa** (`@param`) — tránh SQL injection.
- Giới hạn `TOP (@MAX_ROWS)` mỗi query để không tải quá nhiều dữ liệu một lúc.
- Bật `compression` (gzip) cho response.
- **Cache bộ nhớ (TTL)**: dashboard/báo cáo 60 giây, danh mục filter 10 phút — đổi tab hoặc nhiều người cùng xem không query lại DB.
- **Lọc thô sargable**: điều kiện `mutation BETWEEN @fromDay AND @toDay` cho phép SQL dùng index trên cột `mutation` trước, rồi mới tính biểu thức đổi giờ chính xác trên số ít dòng còn lại.
- `/api/dashboard` trả kèm `rows` chi tiết — frontend không phải gọi thêm `/api/tat/departments` (tránh chạy query nặng 2 lần).

### Tăng tốc phía SQL Server (khuyến nghị — chạy 1 lần)

Hiệu quả lớn nhất đến từ **index trong DB**. Chạy script sau (bỏ qua index đã có):

```sql
-- kho_ser1: loc theo vm + voucher + thoi gian, join theo part/serial/label
CREATE INDEX IX_kho_ser1_vm_mutation ON [NQT].[dbo].[kho_ser1] ([vm], [mutation])
  INCLUDE ([voucherno], [partno], [serialno], [labelno], [station], [store], [receiver], [costcenter], [action_per], [mutation_t]);
CREATE INDEX IX_kho_ser1_keys ON [NQT].[dbo].[kho_ser1] ([partno], [serialno], [voucherno]);
CREATE INDEX IX_kho_ser1_label ON [NQT].[dbo].[kho_ser1] ([labelno]) INCLUDE ([vm], [voucherno]);

-- real_us1: loc theo del_time, join theo voucher_s / historyno_
CREATE INDEX IX_real_us1_del_time ON [NQT].[dbo].[real_us1] ([del_time])
  INCLUDE ([reci_time], [partno], [serialno], [labelno], [department], [action_per], [del_staff], [station], [store]);
CREATE INDEX IX_real_us1_voucher ON [NQT].[dbo].[real_us1] ([partno], [serialno], [voucher_s]);
CREATE INDEX IX_real_us1_history ON [NQT].[dbo].[real_us1] ([historyno_]);
CREATE INDEX IX_real_us1_label ON [NQT].[dbo].[real_us1] ([labelno]);

-- on_off: loc theo vm + thoi gian, join theo label / historyno_
CREATE INDEX IX_on_off_vm_mutation ON [NQT].[dbo].[on_off] ([vm], [mutation])
  INCLUDE ([partno], [serialno], [labelno], [historyno_], [station], [store], [ac_registr], [mutation_t]);
CREATE INDEX IX_on_off_history ON [NQT].[dbo].[on_off] ([historyno_]);

-- SIGN: tra cuu nhan vien -> don vi
CREATE INDEX IX_SIGN_user ON [DWH_DB].[STG_AMOS].[SIGN] ([USER_SIGN]) INCLUDE ([DEPARTMENT]);
```

> Lưu ý: tên schema `STG_AMOS` — nếu là database khác schema, chỉnh lại cho đúng. Nếu bảng do hệ thống khác đồng bộ (không được phép tạo index), có thể tạo **indexed view** hoặc bảng trung gian refresh định kỳ.

## 8. API

| Endpoint | Mô tả |
|----------|-------|
| `GET /api/health` | Kiểm tra kết nối DB / chế độ (live/demo) |
| `GET /api/filters` | Danh sách station/store/department cho dropdown |
| `GET /api/dashboard` | KPI + dữ liệu biểu đồ |
| `GET /api/tat/departments` | Bảng chi tiết TAT theo đơn vị |
| `GET /api/tat/cuvt` | Chi tiết TAT CUVT |
| `GET /api/reports/:name` | Báo cáo (`issued-not-installed`, `removed-not-returned`, `not-reconciled`, `removed-before-installed`, `other`, `return-store-tat`) |
| `POST /api/chat` | Trợ lý TAT nội bộ. Body JSON `{ message, ...filter }` → `{ reply, intent }`. Xử lý cục bộ, không gọi dịch vụ ngoài. |
| `GET /api/admin/chat-unknown` | Gộp log câu hỏi chatbot chưa hiểu (gom theo nội dung, đếm số lần). Query `days` (0 = tất cả). Trang xem: `/admin` hoặc `/admin.html`. **Chỉ IP quản trị.** |

**Bảo mật trang Admin:** `/admin`, `/admin.html` và `/api/admin/*` chỉ cho phép truy cập từ **localhost** và các IP trong `ADMIN_IPS` (mặc định `10.99.89.120`). IP khác bị **từ chối (403)** kèm cảnh báo, và mọi lần truy cập (ALLOW/DENY) được ghi vào `logs/admin-access-YYYY-MM-DD.log` + cảnh báo ra console. Kiểm tra dựa trên **IP socket thật** (không tin `x-forwarded-for` → chống giả mạo). Nếu chạy sau reverse proxy, thêm IP proxy vào `ADMIN_IPS`.

Tham số query chung: `periodType=month|week`, `month=YYYY-MM`, `week=YYYY-MM-DD`, `station`, `store`, `department`, `excludeCC=1`.
