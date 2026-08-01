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
Triển khai báo cáo lên **SharePoint Online / Teams** (thẻ KPI + file CSV định kỳ, cho người chưa dùng SharePoint bao giờ) — xem **[`docs/DEPLOY-SHAREPOINT-TEAMS.md`](docs/DEPLOY-SHAREPOINT-TEAMS.md)**.

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

- **Dashboard:** 8 KPI cards (kèm chip **▲▼ % so với kỳ liền trước** — TAT giảm hiện xanh, tăng hiện đỏ), 4 biểu đồ, bảng chi tiết + tìm kiếm + filter theo cột.
- **Drill-down:** click 1 cột/miếng trên biểu đồ → lọc toàn dashboard theo Trung tâm/Station đó; click lại lần nữa để bỏ lọc.
- **Chia sẻ link:** bộ lọc hiện hành nằm trên URL (`?periodType=…&month=…&department=…`) — copy link gửi đồng nghiệp là họ mở ra đúng màn hình đang xem.
- **Báo cáo định kỳ → Teams/SharePoint (tùy chọn, mặc định TẮT):** theo lịch (`REPORT_SCHEDULE`, vd `T2 06:30`), server tự tính KPI **kỳ vừa kết thúc** (tuần/tháng, kèm so sánh kỳ trước) rồi: (1) đăng **thẻ Adaptive Card** vào kênh Teams qua **Workflows webhook** (`TEAMS_WEBHOOK_URL` — Incoming Webhook kiểu cũ đã bị Microsoft khai tử); (2) xuất **CSV** (KPI + chi tiết TAT, có BOM cho Excel) vào thư mục SharePoint/OneDrive **sync** trên server (`REPORT_EXPORT_DIR`) → tự lên thư viện SharePoint, xem được từ mọi nơi. Trang Admin có nút **📨 Gửi báo cáo ngay** để test. ⚠️ Bật tính năng này = số liệu **tổng hợp** rời mạng nội bộ lên cloud M365; mỗi lần gửi đều ghi audit `logs/report-YYYY-MM-DD.log`.
- **Báo cáo đơn vị:** 6 tab (xuất kho chưa lắp, tháo chưa trả US, chưa đối ứng, tháo trước lắp sau, other, TAT hoàn kho) — mỗi tab **export Excel**.
- **Tra cứu Part On/Off:** tab riêng đọc `WO_PART_ON_OFF` (DWH_DB, Oracle). **6 ô tìm riêng** (Event Perf, Part No, Serial No, Label, Part No off, Serial No off) — khớp **chính xác**, các ô kết hợp AND, ô trống bỏ qua; EVENT_PERFNO_I/LABELNO so sánh kiểu **số**, còn lại kiểu chữ. Giờ VN ghép từ `MUTATION` (ngày AMOS) + `MUTATION_TIME` (ms); lọc trong kết quả + export Excel. Không phụ thuộc kỳ báo cáo (tra toàn bộ lịch sử, giới hạn MAX_ROWS).
- **Bộ lọc:** Station, Store, Department, kỳ **tháng** / **tuần** (từ Thứ 2) / **quý** (Q1–Q4) / **năm** — mọi KPI, biểu đồ, bảng chi tiết và báo cáo đều tính theo kỳ đã chọn.
- **Khác:** loading indicator, thông báo lỗi kết nối, theme sáng/tối, responsive.
- **Trợ lý TAT (chatbox nội bộ):** nút 💬 góc dưới-phải. Xử lý **cục bộ** theo luật/ý định (rule/intent) — **không gọi dịch vụ ngoài, không gửi dữ liệu ra ngoài**. Trả lời 5 nhóm: (1) **số liệu** ("TAT install tháng 7 của CNBDNT", "bao nhiêu thiết bị chưa đối ứng", "trung tâm nào TAT cao nhất"); (2) **tìm đối ứng** của 1 thiết bị ("đối ứng của serial 43842") → từng phiếu xuất gần nhất: trả unservice (kèm **SN được trả + giờ trả**) / trả service (kèm **giờ recertify**) / hoàn kho / bị hủy / CHƯA đối ứng. **Chiều ngược** ("unservice 43842", "SN 43842 trả về từ phiếu nào") → tìm ngược phiếu xuất đối ứng của 1 SN đã trả về kho; (3) **tra cứu 1 thiết bị** theo part/serial/label → lịch sử booking (on_off); (4) **định nghĩa nghiệp vụ** (TAT install/US return/hoàn kho, đối ứng, trả service, costcenter…); (5) **hướng dẫn dùng dashboard**. Câu hỏi không nêu kỳ/trung tâm sẽ dùng bộ lọc đang chọn trên trang. Logic NLU ở `chatbot.js` (hàm thuần, test được không cần DB).
  - **NLU nội bộ (mặc định, không cần hạ tầng):** hiểu nhiều cách hỏi (đồng nghĩa, thiếu dấu, so khớp theo cụm từ), kỳ tương đối ("tháng này/tháng trước/tuần này"), và gợi ý chủ đề gần nhất khi chưa hiểu. **Mọi câu hỏi** gửi tới chatbot được ghi vào `logs/chat-YYYY-MM-DD.log` (TSV: giờ · IP · intent · nội dung — mở bằng Excel) để review câu hỏi thực tế; riêng câu **chưa hiểu** còn ghi vào `logs/chat-unknown-YYYY-MM-DD.log`; xem/review tập trung tại **trang Admin** (`/admin` — link ở footer dashboard, chỉ IP quản trị).
  - **Vòng học nội bộ (không internet):** trang Admin có 3 tab — *Câu hỏi chưa hiểu*, *Tất cả câu hỏi* (gom theo nội dung + thống kê theo intent), *Gợi ý học (KB)*. Ở tab Gợi ý: mỗi câu chưa hiểu kèm chủ đề KB gần nhất; admin sửa/nhập câu trả lời rồi **Duyệt** → lưu `data/kb-learned.json` và **chatbot trả lời được ngay** (intent `learned`), không sửa code, không gửi dữ liệu ra ngoài. Mở rộng sâu vẫn có thể sửa `DEFINITIONS`/`USAGE`/`METRICS`/`SYNONYMS` trong `chatbot.js`.
  - **Mô hình AI (tùy chọn, để thông minh hơn) — chọn qua `LLM_PROVIDER`:** chỉ dùng cho câu hỏi bot **chưa hiểu** hoặc người dùng bấm **👎 Báo sai**; câu trả lời được **lưu lại làm "kinh nghiệm"** (`data/kb-learned.json`, đánh dấu nguồn) để lần sau trả lời ngay, không gọi AI lại. Số liệu/tra cứu/đối ứng **luôn tính bằng SQL nội bộ**, AI chỉ diễn giải — con số luôn chính xác. Mặc định **TẮT** (`LLM_PROVIDER` để trống → chạy thuần rule/intent).
    - **`LLM_PROVIDER=local` — AI nội bộ trong LAN** (Ollama `/api/chat` hoặc OpenAI-compatible): đặt `LLM_URL`. **Khóa an toàn:** server **từ chối** nếu URL trỏ ra ngoài mạng nội bộ (không phải 10.x/192.168.x/172.16–31.x/tên máy LAN) → không gửi dữ liệu ra ngoài.
    - **`LLM_PROVIDER=anthropic` — AI đám mây (Claude):** ⚠️ **gửi nội dung câu hỏi RA NGOÀI công ty** (dịch vụ công cộng) — chỉ bật khi đã có phê duyệt an ninh. Bắt buộc `LLM_ALLOW_PUBLIC=true` (xác nhận chủ đích) + `LLM_API_KEY` (không commit) + cài `npm i @anthropic-ai/sdk`. **Che dữ liệu nhạy cảm** (`LLM_REDACT=true`, mặc định): tự động thay Part/Serial/Label/số tàu bằng `[MÃ]`/`[TÀU]` trước khi gửi. **Ghi audit** mỗi lần gọi vào `logs/llm-cloud-YYYY-MM-DD.log` (giờ · provider · redacted · ok · nội dung đã gửi). Câu AI đám mây học được hiển thị ở trang Admin với nhãn **☁ AI đám mây · CẦN KIỂM TRA**; admin **✔ Xác nhận** hoặc **Xóa**. **Tắt** bất cứ lúc nào bằng cách xóa `LLM_PROVIDER` trong `.env`.
    - Adapter ở `llm.js` (grounding bằng kho tri thức: chỉ dùng kiến thức được cung cấp, không bịa số liệu).
- **Ghi log truy cập:** mọi request được ghi vào `logs/access-YYYY-MM-DD.log` (1 file/ngày, định dạng TSV — mở trực tiếp bằng Excel) gồm: thời gian, IP, tên máy, method, đường dẫn, mã trạng thái, thời gian xử lý. Thư mục `logs/` không commit lên git (`.gitignore`).
  - **Tra tên máy** theo 2 bước, cache 10 phút/IP: (1) reverse-DNS (PTR record) — chỉ có nếu DNS nội bộ khai báo; (2) nếu thất bại và server chạy trên **Windows**, thử `nbtstat -A <ip>` (NetBIOS qua UDP 137) — không phụ thuộc DNS, thường lấy được tên máy Windows trong cùng LAN. Nếu cả hai đều thất bại (mạng khác VLAN chặn UDP 137, máy tắt NetBIOS, hoặc server chạy Linux/macOS), cột tên máy ghi `N/A` — vẫn còn cột IP để tra thủ công.

## 7. Bảo mật & performance

- Mật khẩu chỉ nằm trong `.env` (không hardcode, không commit).
- Mọi query dùng **tham số hóa** (`@param`) — tránh SQL injection.
- Giới hạn `TOP (@MAX_ROWS)` mỗi query để không tải quá nhiều dữ liệu một lúc.
- Bật `compression` (gzip) cho response.
- **Cache bộ nhớ (TTL)**: dashboard/báo cáo 60 giây, danh mục filter 10 phút — đổi tab hoặc nhiều người cùng xem không query lại DB. Cache giới hạn theo **dung lượng** (tổng 150 MB, entry > 30 MB không cache) để kỳ NĂM không làm phình RAM.
- **Không bật CORS**: API chỉ phục vụ cùng origin với trang — web khác trong LAN không đọc trộm được số liệu qua trình duyệt người dùng.
- **Chi tiết lỗi SQL chỉ trả cho máy quản trị** (localhost + `ADMIN_IPS`); người dùng thường nhận thông báo chung, chi tiết ghi ở log server.
- **Rate-limit "Báo sai"** 5 lần/phút/IP — chặn spam gọi LLM đám mây tốn phí; câu đã có trong KB học không gọi LLM lại mà đánh dấu 🚩 chờ admin kiểm tra.
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
| `GET /api/part-onoff` | Tra cứu Part On/Off (`WO_PART_ON_OFF`, linked server DWH_DB). 6 tham số riêng, khớp **chính xác**, kết hợp AND (bỏ trống = bỏ qua): `event`, `labelno` (số) · `partno`, `serialno`, `partnoOff`, `serialnoOff` (chữ). Giờ VN = ghép `MUTATION` (số ngày AMOS) + `MUTATION_TIME` (ms từ 0h) + 7h thành 1 cột; `CREATED_DATE` cũng là số ngày AMOS → chỉ có ngày (không giờ). |
| `POST /api/chat` | Trợ lý TAT. Body JSON `{ message, ...filter }` → `{ reply, intent }`. Số liệu/tra cứu tính bằng SQL nội bộ; câu chưa hiểu mới (tùy chọn) chuyển AI theo `LLM_PROVIDER`. |
| `POST /api/chat/flag` | Người dùng **👎 Báo sai** một câu trả lời. Body `{ message }` → nhờ AI (nếu bật) trả lời lại + lưu kinh nghiệm; nếu AI tắt thì ghi nhận để admin review. |
| `GET /api/admin/chat-unknown` | Gộp log câu hỏi chatbot chưa hiểu (gom theo nội dung, đếm số lần). Query `days` (0 = tất cả). Trang xem: `/admin` hoặc `/admin.html`. **Chỉ IP quản trị.** |
| `POST /api/admin/kb-review` | Đánh dấu một mục AI (đám mây/nội bộ) học được là **đã kiểm tra**. Body `{ key }`. **Chỉ IP quản trị.** |
| `GET /api/admin/llm-status` | Trạng thái LLM: provider, sẵn sàng/bị chặn, model, che dữ liệu, có API key hay chưa (không lộ khóa). **Chỉ IP quản trị.** |
| `GET /api/admin/report-status` | Trạng thái báo cáo định kỳ Teams/SharePoint (lịch, kỳ, kênh đã bật). **Chỉ IP quản trị.** |
| `POST /api/admin/report-now` | Chạy báo cáo định kỳ NGAY (để test webhook/thư mục xuất). **Chỉ IP quản trị.** |
| `POST /api/admin/llm-test` | Gọi thử LLM một lần để kiểm tra kết nối. Body `{ message }` → `{ ok, reply, sent, ms, error }`. **Chỉ IP quản trị.** |

**Bảo mật trang Admin:** `/admin`, `/admin.html` và `/api/admin/*` chỉ cho phép truy cập từ **localhost** và các IP trong `ADMIN_IPS` (mặc định `10.99.89.120`). IP khác bị **từ chối (403)** kèm cảnh báo, và mọi lần truy cập (ALLOW/DENY) được ghi vào `logs/admin-access-YYYY-MM-DD.log` + cảnh báo ra console. Kiểm tra dựa trên **IP socket thật** (không tin `x-forwarded-for` → chống giả mạo). Nếu chạy sau reverse proxy, thêm IP proxy vào `ADMIN_IPS`.

Tham số query chung: `periodType=month|week|quarter|year`, `month=YYYY-MM`, `week=YYYY-MM-DD`, `quarter=YYYY-Qn` (vd `2026-Q3`), `year=YYYY`, `station`, `store`, `department`, `excludeCC=1`.
