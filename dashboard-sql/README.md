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
├── tailwind.config.js # Cấu hình Tailwind cho bản dựng thật (xem §7c)
├── .env.example       # Mẫu cấu hình — copy thành .env
├── .gitignore
├── tools/
│   ├── smoke.js           # Gọi thử mọi endpoint, bắt lỗi dựng câu SQL
│   ├── sqlcheck.js        # Soi câu SQL thật (aggregate lồng subquery, APPLY…)
│   ├── build-assets.js    # Dựng public/vendor/ từ node_modules (§7c)
│   └── tailwind-src.css   # Đầu vào cho Tailwind CLI
└── public/
    ├── index.html     # Giao diện (KPI, charts, tables, tabs báo cáo)
    ├── style.css      # Bảng màu + theme sáng/tối
    ├── script.js      # Gọi API, vẽ chart/table, filter, export Excel
    └── vendor/        # Thư viện giao diện (Tailwind/Chart.js/Tabulator/SheetJS)
                       #   — KHÔNG lấy từ CDN, có commit vào repo, xem §7c
```

## 2. Cài đặt

Yêu cầu: **Node.js >= 18**.

```bash
cd dashboard-sql
npm install
npm run build:assets   # dựng public/vendor/ (chỉ cần khi mới clone hoặc sửa giao diện)
```

> **Không cần Internet lúc chạy.** Toàn bộ thư viện giao diện nằm sẵn trong
> `public/vendor/` và **đã được commit vào repo**, nên máy chủ nội bộ bị chặn ra
> ngoài vẫn mở trang bình thường. `npm run build:assets` chỉ dựng lại từ
> `node_modules` — cũng **không tải mạng**.

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
| `SCAN_PICKING_DIR` | Thư mục chứa **file scan PDF phiếu xuất kho** (mặc định `\\10.99.7.7\picking list\2026`). Chỉ là **giá trị mặc định** — sửa được ngay trên trang `/admin` (xem §6c) |
| `SCAN_RECEIVING_DIR` | Thư mục chứa **file scan PDF phiếu nhập kho** (mặc định `\\10.99.7.7\certificates\2026`). Cũng sửa được trên `/admin` |
| `SCAN_PICKING_DIR_HAN` / `_SGN` / `_DAD`<br>`SCAN_RECEIVING_DIR_HAN` / `_SGN` / `_DAD` | Thư mục **riêng cho từng station** — mỗi station scan vào một thư mục khác nhau (xem §6c). Để trống = dùng thư mục mặc định ở trên |
| `DB_REQUEST_TIMEOUT_MS` | Thời gian tối đa cho **một** câu truy vấn (mặc định `180000` = 3 phút). Cũ là 60 s nên hay báo *Timeout: Request failed to complete in 60000ms* |

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

### Kiểm tra nhanh trước khi triển khai (`npm run smoke`)

```bash
npm run smoke
```

Bật server ở chế độ **live** nhưng trỏ vào một địa chỉ DB không tồn tại, rồi gọi lần lượt **20 endpoint** có chạy truy vấn. Mỗi endpoint sẽ chạy **hết** phần dựng câu SQL rồi mới chết ở bước kết nối:

- báo **lỗi kết nối** → ĐẠT (code chạy tốt)
- báo **bất kỳ lỗi nào khác** → TRƯỢT, in rõ endpoint và thông báo lỗi

Sau đó chạy tiếp **`tools/sqlcheck.js`** (soi câu SQL thật) và **`tools/build-assets.js --check`** (kiểm tra `public/vendor/` có còn khớp mã nguồn không — xem §7c).

Cần thiết vì `DEMO_MODE=true` **không hề gọi** các hàm dựng câu SQL (chúng bị thay bằng dữ liệu mẫu), còn `node --check` chỉ kiểm cú pháp — nên lỗi kiểu *"Cannot access 'dept' before initialization"* lọt qua cả hai, đến lúc chạy thật mới vỡ.

**Giai đoạn 2 — `npm run sqlcheck`** (đã nằm trong `npm run smoke`): soi **chính câu SQL** mà server dựng ra. Giai đoạn 1 chết ở bước *kết nối* nên chỉ bắt được lỗi **JavaScript**; lỗi **ngữ nghĩa SQL** vẫn lọt. Đã dính thật một lần:

```sql
SUM(CASE WHEN ... EXISTS (SELECT ...) ... END)   -- Msg 130
-- "Cannot perform an aggregate function on an expression containing
--  an aggregate or a subquery"  -> tab Receiving vỡ hoàn toàn khi chạy thật,
--  trong khi smoke vẫn báo ĐẠT.
```

Cách làm: thay module `mssql` bằng bản giả (`tools/sqlspy.js`) — mỗi câu lệnh được **ghi lại** và trả về kết quả rỗng nên endpoint chạy hết các bước. Sau đó soi từng câu theo các luật:

| Luật | Bắt gì |
|---|---|
| **Hàm gom chứa subquery** | `SUM/MIN/MAX/AVG/COUNT(...)` có `SELECT` bên trong → SQL Server báo **Msg 130** |
| **APPLY vào linked server** | `OUTER/CROSS APPLY` vào `[DWH_DB]..` → mỗi dòng một lần gọi qua mạng (kỷ luật đã thống nhất của dự án) |

Thêm luật mới = thêm một hàm vào mảng `RULES` trong `tools/sqlcheck.js`.

### Chạy thử không cần SQL Server (DEMO)

Đặt `DEMO_MODE=true` trong `.env` rồi `npm start` — toàn bộ giao diện chạy với dữ liệu mẫu để bạn xem trước.

## 5. Các định nghĩa TAT (nghiệp vụ)

| Chỉ số | Định nghĩa |
|--------|-----------|
| **TAT Trung tâm (department)** | Từ lúc **xuất kho** (`kho_ser1` `vm='T'`, voucher `P-...`) đến lúc **trả unservice** (`real_us1.del_time`). Tính theo **ngày**. Link `kho_ser1(partno,serialno,voucherno)`=`real_us1(partno,serialno,voucher_s)`. **Trung tâm**: **ưu tiên `real_us1.department`** (đơn vị ghi **ngay lúc phát sinh** giao dịch); trống/`UNKNOWN` → `action_per` bắt đầu bằng `PA` thì `PA` → tra **`SIGN`** theo `action_per` → cuối cùng `PA`. Áp dụng cho mọi nơi **có dòng `real_us1`**: *TAT Trung tâm*, *TAT CUVT*, *Trả unservice*, *Other*, và biểu đồ TAT/phân bổ station. Các nhánh **không có dòng `real_us1`** (*trả service*, *chưa đối ứng*, *xuất kho chưa lắp*, *TAT hoàn kho*) buộc phải suy từ **người lập phiếu xuất** (`kho_ser1.created_b2` → `SIGN`) vì đó là nguồn duy nhất có. Bảng *Chi tiết TAT*: cột **Nhân viên** = người trả US (cùng nguồn với Trung tâm), thêm cột **Người lập phiếu** chỉ để đối chiếu. Kiểm tra bằng `/api/admin/diag/dept` — có cột `dept_neu_theo_nguoi_lap_phieu` cho biết nếu quy theo người lập phiếu thì ra trung tâm nào. *(Đã thử ưu tiên `SIGN`, rồi thử ưu tiên người lập phiếu xuất — cả hai đều trả lại vì dữ liệu thực tế cho thấy hai nguồn đó kém chính xác hơn.)* |
| **TAT CUVT** | `reci_time − del_time` trong `real_us1` (đều là datetime giờ VN). |
| **TAT hoàn kho** | Thiết bị hoàn kho (`vm='TC'`, voucher `P-CA-...`) đối chiếu phiếu xuất (`vm='T'`, `P-...`) cùng `partno/serialno/labelno`. TAT = thời điểm hoàn − thời điểm xuất (đơn vị: ngày). |
| **Xuất kho chưa lắp** | `kho_ser1 vm='T'` không có `on_off vm='YE'` (link `partno,serialno,labelno`). Có cột **Event (WO)** (`kho_ser1.event_perf` — số work order của phiếu xuất) và cột **Vị trí hiện tại** (`location`, lấy từ `[DWH_DB]..[STG_AMOS].[ROTABLES]` nối qua khóa **`psn`** — thiết bị đang nằm ở đâu). *(`PARTNONEW`/`SERIALNONEW` vẫn được lấy về nhưng **không hiển thị** — chỉ dùng nội bộ cho việc nhận diện nhóm “lắp vào cụm cao hơn” và cho `/api/admin/diag/higher`.)* Khóa `psn` ưu tiên lấy từ `kho_ser1`; bảng đó không có thì tra từ `on_off` theo part+serial (dò `INFORMATION_SCHEMA`, thiếu cột thì 3 cột này để trống chứ không lỗi). ROTABLES nằm trên linked server nên cả 3 cột được lấy trong **cùng một lượt hỏi theo lô** (`WHERE psn IN (…)`, 500/lượt) **sau khi** đã có kết quả — không hỏi từng dòng. **Đã loại nhóm "lắp vào cụm cao hơn"** — xem dòng dưới. |
| **Lắp vào cụm cao hơn** (*higher assembly*) | Thiết bị **không lắp lên tàu** (không sinh `on_off vm='YE'`) mà được gắn vào một **cụm cha** — `ROTABLES.PARTNONEW`/`SERIALNONEW` có giá trị. Lần lắp này **chỉ** được ghi ở `[DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF]`. **Nhận diện:** thiết bị nằm trong tập *Xuất kho chưa lắp* **và** có dòng `WO_PART_ON_OFF` trùng `(PARTNO, SERIALNO)` với thời điểm lắp **sau** giờ xuất kho → lấy **lần lắp sớm nhất** sau giờ xuất. (Đã đo thực tế: không có cột nào trong `WO_PART_ON_OFF` đánh dấu "lắp vào cụm" — `LOCID_PK` rỗng 55% ở nhóm này so với 52% ở nhóm lắp lên tàu, tức không phân biệt được; nên dùng chính **sự tồn tại của bản ghi lắp** làm căn cứ.) Nhóm này bị **loại khỏi** *Xuất kho chưa lắp* và **thêm vào** bảng *Chi tiết TAT* với `return_type = 'INSTALL'` (**"Chỉ lắp lên"**): chỉ có **Ngày lắp** và **TAT install**; Ngày tháo / Ngày trả / TAT tổng để trống. **Hai cột `Part No (off)` / `Serial No (off)` cũng để trống**: trong `WO_PART_ON_OFF` mỗi dòng là một lần **thay thế** trên cụm, nên `PARTNO_OFF`/`SERIALNO_OFF` là **thiết bị cũ bị thay ra** — một thiết bị **khác**, không phải thiết bị của dòng này bị tháo xuống. Giá trị vẫn được giữ ở `wo_partno_off`/`wo_serialno_off` (không hiển thị) và xem được qua `/api/admin/diag/higher`. Linked server được hỏi **theo lô** (`SERIALNO IN (…)`, 400/lượt) sau khi truy vấn chính đã trả về. Số đo 1 tháng: **110** thiết bị *xuất kho chưa lắp* → **18** thuộc nhóm này (16%), trong đó **13** có `higher_pn`/`higher_sn`. |
| **Quản lý xuất kho** (LGC ▸ Quản lý xuất kho) | `[DWH_DB]..[STG_AMOS].[PICKSLIP_BOOKED]` × `[PICKSLIP_HEADER]` (nối `PICKSLIPNO`). Kỳ tính theo **`PICKSLIP_DATE`**; đơn vị đếm là **số dòng**; **“hủy” = `QTY_CANCELED > 0`** (kể cả hủy một phần). KPI: số dòng · thực xuất · dòng bị hủy · **tỷ lệ hủy %** · số phiếu · phiếu có hủy. Biểu đồ: cột xếp chồng theo Trung tâm (thực xuất/hủy, tooltip có % hủy) · xu hướng theo ngày (cột số dòng + **đường % hủy** ở trục phải) · top 10 Part No bị hủy. Bảng chi tiết có ô tích **Chỉ dòng bị hủy** và xuất Excel. **Trung tâm** = `SIGN(MECH_SIGN)` → `PA`. ⚠️ Câu SQL gốc dùng `JOIN SIGN_CACHE` (INNER) — đã đổi thành **`LEFT JOIN`** vì `SIGN_CACHE` là bảng cache **tự tắt khi tài khoản chỉ có quyền đọc**, INNER JOIN sẽ làm lỗi truy vấn hoặc mất im lặng toàn bộ phiếu của nhân viên chưa có trong cache. Hai bảng AMOS được kéo về `#temp` **một lần**, mọi phép gom (KPI, 3 biểu đồ, bảng) chạy nội bộ trên `#temp`. `PICKSLIP_DATE` là **số ngày AMOS** (nghiệp vụ xác nhận) — `detectDateKind` nhận giá trị này làm mặc định và vẫn dò kiểu thật để **cảnh báo nếu lệch**, nên không lặp lại lỗi đọc `CREATED_DATE` ra năm 1954. **Phân loại Cancel / Return.** **Mốc để biết CÓ hủy/trả hay không là `QTY_CANCELED ≠ 0`**; sau đó mới dò **đuôi của `PICKSLIP_TEXT`** (lấy từ công cụ `AMOS_GUI`): `…cancel` / `…cancel booking` → **Cancel**; `…return` → **Return**; **không có từ khóa nào → “Hủy/trả khác”**. ⚠️ Nhóm *Hủy/trả khác* **vẫn được tính là hủy/trả** — trước đây bị xếp nhầm vào *Thực xuất* nên **đếm THIẾU** số dòng hủy/trả. **Bộ lọc nghiệp vụ** áp luôn trong truy vấn: `QTY_BOOKED ≠ 0` · `STATUS ∉ {1, 11}` · `LOCATION_FROM` không chứa `U/S`. ⚠️ Điều kiện **`STORE` kết thúc `MAIN`/`VNA` ĐÃ BỎ** — xem §6e; lọc **Station theo đuôi chuỗi** (`LIKE '%HAN'`) vì cột `STATION` có dạng `VNA-HAN`. **Đối chiếu file scan** (cột *Scan*): có file `<PICKING_LISTNO_I>-….pdf` trong thư mục scan hay chưa — xem §6c. Thẻ KPI *Đã scan / Chưa scan* **đếm theo PHIẾU** (`DISTINCT PICKING_LISTNO_I`) và **tính trên TOÀN KỲ**, xem §6d. **TAT return** (chỉ dòng *Return*): hỏi `[STG_AMOS].[HISTORY]` với `VM ∈ {EA, TC}` **theo lô** `PICKSLIPSEQNO_I IN (…)` (400/lượt, **sau khi** truy vấn chính trả về — không join qua linked server theo từng dòng), lấy `HISTORYNO_I` → **Phiếu trả** = `<HISTORYNO_I>-R`, `MUTATION` (số ngày AMOS) → **Ngày trả kho**, và **TAT return = Ngày trả kho − PICKSLIP_DATE (số ngày)**; ngoài ra có ***TAT hoàn kho (giờ)*** — xem §5b về mốc thời gian và độ chính xác. Một `PICKSLIPSEQNO_I` có nhiều dòng lịch sử thì lấy **lần trả sớm nhất**. Không tìm được → **NOT FOUND**. Cột *Scan phiếu trả* dò file `<HISTORYNO_I>-….pdf` trong **cùng thư mục picking list**. **TAT hoàn kho chính xác đến GIỜ**: `MUTATION` chỉ cho NGÀY, nên ghép thêm **`MUTATION_TIME`** (số **mili-giây** kể từ `00:00`) rồi +7h ra giờ VN — xem §5b. Có thêm cột *Giờ xuất kho*, *Giờ hủy*, *Giờ trả kho*, ***TAT hoàn kho (giờ)*** và biểu đồ **TAT hoàn kho theo Trung tâm** (trung bình / lâu nhất, đơn vị giờ). Hai bảng pickslip **không chắc** có `MUTATION_TIME` ở mọi môi trường nên server **dò trước** (`SELECT TOP 0`); thiếu thì các cột giờ để trống chứ **không làm vỡ truy vấn**. |
| **Receiving** (LGC ▸ Receiving) | Phiếu **nhập kho**: `[DWH_DB]..[STG_AMOS].[HISTORY]` với `VM = 'B1'`, kỳ theo **`DEL_DATE`** (số ngày AMOS, khoảng **chính xác** không đệm ±2 ngày). **Loại phiếu đã hủy nhập:** cùng lượt kéo cả `VM = 'CR'` về `#temp`, rồi bỏ mọi dòng `B1` có `RECDETAILNO_I` trùng với một dòng `CR` (KPI *Phiếu bị hủy nhập* cho biết loại bao nhiêu). **Bộ lọc nghiệp vụ** (lấy nguyên từ `AMOS_GUI`): `STATION` **chứa** station đang chọn · `CONDITION` **không chứa** `us`. ⚠️ Hai điều kiện về `STORE` (kết thúc `MAIN`/`VNA`, và loại riêng `STORE = 'MAIN'` ở `LOCATION ∈ {SHOPLOC, LG5}`) **ĐÃ BỎ** — xem §6e. **Đối chiếu file scan**: tên file cần có = `VOUCHERNO` **đã bỏ tiền tố `R-`**, so **nguyên tên** (không cắt trước dấu `-` như picking list). KPI **và biểu đồ** *đã scan / chưa scan* **đếm theo PHIẾU** (`DISTINCT VOUCHERNO`) và **tính trên TOÀN KỲ**, xem §6d. **Thống kê theo STATION và STORE, KHÔNG theo Trung tâm** (nhập kho là việc của kho, không quy về trung tâm bảo dưỡng) — nhờ vậy bỏ được cả phép nối sang bảng `SIGN`. Biểu đồ: cột xếp chồng *đã scan / chưa scan* theo **Station** và theo **Store** · số dòng nhập theo ngày. Ô lọc *Trung tâm* được ẩn ở tab này. Bảng chi tiết có ô tích **Chỉ phiếu chưa scan** và xuất Excel. |
| **Tháo chưa trả US** | `on_off vm='YA'` không có `real_us1` (link `historyno_`). Cột **Store** và **Location** là **vị trí hiện tại** của thiết bị: `ROTABLES` nối qua `psn`, rồi `LOCATION` nối theo `locationno_i` (`LEFT JOIN` nên không thể làm mất dòng; thiếu dữ liệu thì Store lùi về `on_off.store`). **Báo cáo tự cập nhật theo thực tế (đúng ý đồ):** điều kiện *chưa trả US* được xét tại **thời điểm xem**, nên thiết bị tháo tháng 7 mà trả US sang tháng 8 sẽ **tự biến mất** khỏi báo cáo tháng 7. Cùng một kỳ xem lại lúc khác ra số khác là bình thường. Điều kiện *chưa trả US* dùng **2 vế**: (1) không có `real_us1` khớp **`historyno_`** (khóa chính xác của lần tháo đó) **và** (2) không có `real_us1` cùng `labelno` với `del_time` **sau giờ tháo** (dự phòng cho bản ghi thiếu `historyno_`). *Trước đây chỉ so `labelno` không kèm điều kiện thời gian → một lần trả US của **chu kỳ trước** cũng làm mất dòng; đo thực tế 1 tháng: **loại oan 672 dòng**.* ⚠️ `WHERE` còn `RO.condition = 'US'` — tiêu chí **khác** với *đã trả US hay chưa*, lọc 468 → 238 dòng (nhóm bị loại có `condition` = I/RC/R/S/IT/CF…, tức đã được xử lý qua luồng khác). `RO.MUTATION > @fromDay` thực tế **không cắt dòng nào**. Đo bằng `diag/rnr`. Dùng **`GET /api/admin/diag/rnr`** để xem từng điều kiện cắt bớt bao nhiêu dòng (6 bước cộng dồn) và phân bố `condition` hiện tại của các dòng bị loại. |
| **Chưa đối ứng** | Có xuất service nhưng không có trả unservice. |
| **Chỉ lắp / Chỉ tháo** (trước đây: *Tháo trước lắp sau*) | Liệt kê các dòng `WO_PART_ON_OFF` **chỉ có một phía**: **ON** = có `PARTNO`/`SERIALNO` mà `PARTNO_OFF`/`SERIALNO_OFF` rỗng (lắp mà không tháo) · **OFF** = ngược lại (tháo mà chưa lắp). Đây là hai đầu của nghiệp vụ *tháo trước – lắp sau*, được AMOS ghi thành 2 dòng riêng nên không tự ghép với nhau bằng label. Cột **Có on_off** cho biết có sự kiện `YE` (phía ON) / `YA` (phía OFF) tương ứng không — **Không** nghĩa là các báo cáo dựa trên `on_off` (*Tháo chưa trả US*, *Xuất kho chưa lắp*) đang **bỏ sót** thiết bị đó. Kèm phiếu xuất kho gần nhất trước thời điểm và dòng trả unservice đầu tiên sau đó. Đo thực tế 1 tháng: trong **4.861** thiết bị bị thay ra khỏi cụm có **154** cái không có `on_off vm='YA'` (**22** đã trả US, **132** chưa). Bộ lọc Station/Center chỉ áp dụng khi tra ra được từ phiếu xuất hoặc dòng trả US; dòng không tra ra được vẫn hiển thị. Hiệu năng: `WO_PART_ON_OFF` kéo về `#temp` **một lần**; `kho_ser1`/`real_us1`/`on_off` cũng kéo về `#temp` **có index** theo `(partno, serialno)` rồi mới join — không tra linked server hay quét bảng theo từng dòng. |
| **Repair Admin** (LGC ▸ Repair Admin) | **Một tab duy nhất**. Thiết bị đang nằm ở **vị trí Unserviceable** (`LOCATION.location_type = -4`) có đơn sửa chữa `OD_DETAIL` với **`status = 0`**, **`backorder = 1`** và **`state = 'O'`**. Nguồn: `LOCATION × ROTABLES × OD_DETAIL` (nối `psn` + `labelno`). 4 cột `status`/`state`/`backorder`/`ext_state` **không hiển thị** — chúng chỉ dùng để lọc, mà mọi dòng còn lại đều mang cùng một bộ giá trị nên hiện lên không thêm thông tin gì. Phía trên bảng chi tiết có **bảng tổng hợp** (Station + Store + Vị trí × **< 30 ngày** / **≥ 30 ngày** / Tổng, kèm dòng **TỔNG CỘNG**) — dựng **ngay trên trình duyệt từ chính danh sách bên dưới** nên hai bảng không thể lệch nhau, và tự cập nhật theo bộ lọc. Nút **⬇ Excel** xuất danh sách chi tiết. Là **ảnh chụp hiện trạng** → **không** phụ thuộc kỳ báo cáo, chỉ lọc theo Station/Store. Tuổi tồn đọng tính từ `ROTABLES.orderdate` (đổi sang ngày theo **kiểu thật driver trả về**: `Date` dùng luôn; số → số ngày kể từ `AMOS_DATE_EPOCH`; ngoài khoảng 1990–2100 coi là không xác định). *(`CONSUMABLES` đã bỏ khỏi báo cáo: không có `psn` nên không nối được sang `OD_DETAIL`, mọi dòng đều bị lọc — giữ lại chỉ tốn thêm một lượt gọi linked server.)* |
| **Other (on_ac)** | Thiết bị **đã trả unservice** nhưng **chưa tìm được phiếu xuất service đối ứng**; ghi chú `on_ac` cho biết lý do. Mã: **NOI** = no issue pickslip (không có phiếu xuất) · **SWP** = swap, hoán đổi thiết bị · **ROB** = robbery, tháo xuống trước · **DIR** = lắp thẳng lên tàu vật tư trong kho · **CRO** = tháo vật tư repairable/consumable. Server tự giải mã thành cột **Lý do** + **Diễn giải** (khớp nguyên từ nên không bắt nhầm `DIRECT`/`CROSS`); tab có bộ lọc theo mã và dòng thống kê số lượng mỗi mã trong kỳ. |

### 5b. Ngày GIỜ chính xác — cặp `MUTATION` + `MUTATION_TIME`

| Cột | Ý nghĩa |
|---|---|
| `MUTATION`, `PICKSLIP_DATE`, `DEL_DATE`, `CREATED_DATE`, `ORDERDATE` | **số NGÀY** kể từ `AMOS_DATE_EPOCH` → chỉ ra **ngày**, giờ luôn `00:00` |
| `MUTATION_TIME` (và `mutation_t` ở `NQT`) | **số MILLI-GIÂY kể từ `00:00`** → phần **giờ** |

Ghép hai cột rồi cộng `AMOS_TZ_OFFSET_HOURS` (+7) ra **giờ Việt Nam**. Biểu thức nằm gọn trong
hàm **`amosDayTimeToVN(dayCol, timeCol)`** — truyền `timeCol = null` thì chỉ ra ngày.

Nhờ vậy *TAT hoàn kho* tính được **theo giờ** thay vì ngày tròn: trả lúc 22h cùng ngày trước
đây ra **0 ngày**, trả 8h sáng hôm sau ra **1 ngày** — dù thực tế chỉ cách nhau 10 tiếng.

**⚠️ `MUTATION` là lần SỬA CUỐI của bản ghi, KHÔNG phải giờ lập phiếu.** Đã đo thật
(`diag/mutation-time`): trên `PICKSLIP_BOOKED` có dòng `MUTATION = 19943` (07/08/2026) trong khi
`CREATED_DATE = 19701` (08/12/2025) — **lệch 8 tháng**. Vì vậy:

- **Giờ xuất kho** chỉ có GIỜ khi `PICKSLIP_HEADER.MUTATION` **rơi đúng vào** `PICKSLIP_DATE` —
  khi đó `MUTATION_TIME` mới đúng là giờ lập phiếu. Dòng đó **không** được đưa vào TAT trung bình
  theo giờ nếu không có giờ thật.
  Bảng chi tiết chỉ còn **MỘT cột thời gian xuất kho**: có giờ thật thì hiện `dd/mm/yyyy hh:mm`,
  không có thì lùi về **NGÀY phiếu** và ghi rõ **“(chỉ có ngày)”** kèm chữ mờ. Server trả kèm
  `issue_shown` (= `ISNULL(giờ thật, ngày phiếu)`, luôn có giá trị → sắp xếp và xuất Excel đều đúng)
  và `issue_exact` (0/1 → giao diện biết có nên làm mờ không).
  ⚠️ Khi không có giờ thật, giao diện **cắt hẳn phần giờ** (`slice(0, 10)`) chứ **không** cắt chuỗi
  `"00:00"`: nếu dữ liệu lỡ mang giờ rác thì hiện ra người đọc sẽ tưởng đó là giờ xuất kho thật.
  **Frontend KHÔNG phụ thuộc vào hai trường này.** Nếu server chưa được cập nhật (chỉ chép `public/`
  mà quên `server.js`, hoặc quên khởi động lại) thì `issue_shown` không tồn tại và cột sẽ **trống
  trơn — lỗi im lặng, không báo gì cả**. Đã xảy ra thật. Vì vậy `buSoLieuGioXuatKho()` trong
  `script.js` **tự bù** từ `issue_time_vn` + `pickslip_date` (server cũ vẫn trả đủ hai trường này)
  khi thiếu, nên trang chạy đúng với **cả server cũ lẫn mới** và thứ tự cập nhật file không còn
  quan trọng. Đã kiểm thử bằng cách giả lập server cũ (bỏ hẳn hai trường khỏi phản hồi).
  *(Trước đây bảng phải bày ba cột — `Ngày phiếu`, `Giờ xuất kho`, `Sửa cuối (dòng)` — vì cột giờ hay
  trống. Hai cột đầu và cột `Sửa cuối (dòng)` đã bỏ; bỏ `Ngày phiếu` mà không có `issue_shown` thì
  các dòng thiếu giờ sẽ **mất hẳn ngày**.)*
- **TAT hoàn kho (giờ)**: thiếu giờ thật ở đầu nào thì **lùi về NGÀY** ở đầu đó (sai số tối đa 1 ngày) — khác hẳn việc dùng `MUTATION` của dòng booked (lệch tới 8 tháng). KPI *“Chính xác đến giờ”* cho biết bao nhiêu dòng có giờ thật ở **cả hai** đầu. *(Trước đây bắt buộc cả hai đầu phải có giờ thật nên biểu đồ **TAT hoàn kho theo Trung tâm** gần như không bao giờ có dữ liệu — hiện ra trống trơn.)*
- **Giờ trả kho** lấy từ `HISTORY.MUTATION + MUTATION_TIME` — `HISTORY` là bảng **sự kiện**
  (mỗi dòng một lần dịch chuyển) nên `MUTATION` chính là thời điểm sự kiện; đo được `MUTATION`
  lệch `DEL_DATE` 0–2 ngày, chấp nhận được.
  Cột này **làm y hệt “Giờ xuất kho”**: gộp `Ngày trả kho` + `Giờ trả kho` thành **một cột** —
  có giờ thật thì hiện đủ, môi trường nào thiếu `MUTATION_TIME` thì hiện **NGÀY** kèm “(chỉ có ngày)”.
  Server trả kèm `return_shown` / `return_exact` (tính ở Node trong `enrichPickslipRows`, không phải SQL,
  vì phiếu trả lấy theo lô từ `HISTORY` sau truy vấn chính). Cột `Ngày trả kho` riêng đã bỏ.
  Cả hai cặp dùng **chung một formatter** `fmtNgayGioGop(<tên trường _exact>)` trong `script.js`.
- **MỘT cột “Giờ hủy / trả” cho CẢ Cancel lẫn Return.** Hai loại bản chất gần giống
  nhau (hàng quay ngược về kho) và cột *Loại* đã phân biệt rồi, nên không bày ba cột
  riêng nữa (`Sửa cuối (dòng hủy)`, `Ngày trả kho`, `Giờ trả kho` — đã bỏ hết).
  - Dòng **Return** → giờ hàng về kho; thiếu `MUTATION_TIME` thì hiện NGÀY kèm “(chỉ có ngày)”.
  - Dòng **Cancel** / **Hủy-trả khác** → AMOS **không có** cột riêng cho giờ hủy, nên đây là
    lần **SỬA CUỐI** của dòng: mốc gần nhất có thể coi là lúc hủy nhưng **KHÔNG chắc chắn** →
    hiện chữ mờ kèm **“(sửa cuối)”**. Nhóm *Hủy/trả khác* cũng được cấp mốc này (trước chỉ `CANCEL`).
  - Server trả `huytra_shown` / `huytra_kieu` / `huytra_exact`; `script.js` tự bù khi server cũ.
  - **Chỉ dòng Return** mới có *Phiếu trả* và *Scan phiếu trả* — hủy thì không có phiếu để đối chiếu.
  mốc gần nhất có thể coi là lúc hủy, và tên cột nói rõ điều đó thay vì hứa hẹn quá.

**Không đoán bảng nào có cột nào.** `INFORMATION_SCHEMA` không dùng được cho `[DWH_DB]..`
(máy chủ từ xa), nên `remoteHasColumn()` dò bằng `SELECT TOP 0 [cột]` — có thì trả về rỗng,
không có thì ném lỗi. Kết quả được cache; thiếu cột thì cột giờ **để trống**, không làm vỡ
truy vấn. Kiểm tra bằng **`GET /api/admin/diag/mutation-time`**: liệt kê bảng nào có cột gì,
kèm **5 dòng thật đã giải mã** để đối chiếu mắt thường. **Chỉ đọc. Chỉ IP quản trị.**

### Quy đổi giờ AMOS → VN

`mutation` (ngày AMOS, dạng `yyyymmdd`) + `mutation_t` (giờ AMOS = **số millisecond kể từ 00:00**) là **UTC**, được cộng `AMOS_TZ_OFFSET_HOURS` (mặc định +7) để ra giờ VN. Ví dụ `mutation_t = 71820341` → `19:57:00`. Biểu thức quy đổi nằm **duy nhất** trong hàm `amosToVN()` ở `server.js` — nếu định dạng khác, chỉ cần sửa ở đó. `del_time`, `reci_time` đã là datetime giờ VN nên dùng trực tiếp.

## 6. Tính năng

- **Điều hướng — 4 mục chính:** *📊 Tổng quan* · *📋 Các Báo cáo khác* (9 báo cáo) · *🏬 LGC* · *🔎 Tra cứu Part On/Off*.
  Ba việc **của LGC** (*Quản lý xuất kho*, *Receiving*, *Repair Admin*) gom vào **một nhóm “LGC”** có tab con — trước đây nằm rải rác 2 mục menu chính + 1 mục chôn ở cuối danh sách báo cáo. Nhân viên LGC vào thẳng bằng **`/lgc`** (xem mục dưới); các đơn vị khác không phải nhìn thấy nhóm này khi làm việc với TAT.
- **Ba ô lọc Station / Store / Trung tâm — CHỌN NHIỀU GIÁ TRỊ.** Bấm vào ô để mở menu tích chọn (có ô tìm, nút *Chọn tất cả* / *Bỏ chọn*); **không chọn gì = tất cả**. Dùng nút + menu tích chọn thay cho `<select multiple>` vì `select multiple` bắt người dùng **giữ Ctrl** để chọn thêm, chiếm nhiều chỗ trên thanh lọc và rất dễ bỏ chọn nhầm chỉ bằng một cú click. **Chỉ tải lại dữ liệu KHI ĐÓNG menu**, không phải mỗi lần tích — mọi truy vấn đều đi qua linked server nên tích 5 kho mà bắn 5 lượt là rất lãng phí. Mở một menu thì **hai menu kia tự đóng** (không chồng lên nhau). Lựa chọn lên URL dạng `?station=HAN,SGN&store=MAIN,VNA&department=PA,CUVT` (link cũ một giá trị vẫn chạy đúng) và nhớ vào localStorage. Phía SQL thành `col IN (@fStation0, @fStation1, …)`.
  - Cả ba ô dùng **chung một hàm dựng** `taoMultiSelect()` trong `script.js` — hành vi giống hệt nhau (học một lần dùng được cả ba, sửa lỗi một chỗ là hết), chỉ khác cấu hình: danh từ đếm trên nút (*“3 station”* / *“3 kho”* / *“3 trung tâm”*), nhóm ghim, và phần đánh dấu riêng của Store.
  - **Station hiện ĐỦ danh sách** lấy thẳng từ `SELECT DISTINCT station FROM [NQT].[dbo].[kho_ser1]` — trước đây bị **viết cứng** `HAN/SGN/DAD/Khác`, station khác không lọc riêng được. **`HAN`, `SGN`, `DAD` được ghim lên đầu**, in đậm và có **đường kẻ tách** khỏi phần còn lại (phần còn lại giữ thứ tự A–Z) để mắt nhận ra ngay ba station chính mà không phải đọc hết danh sách. Hàm `xepStationChinhLenDau()` ở `server.js` lo phần sắp xếp. Mục gộp **`OTHER`** không còn được đưa ra giao diện nữa, nhưng `stationClause()` **vẫn hiểu** giá trị này để link cũ / cấu hình đã lưu không âm thầm đổi ý nghĩa.
  - **Click vào một cột/miếng biểu đồ** (drill-down) đặt ô lọc tương ứng thành **đúng một giá trị**; click lại đúng cột đó thì bỏ lọc. Nút lọc được vẽ lại theo đó.
  - **Dùng được hoàn toàn bằng bàn phím** (người nhập liệu nhiều sẽ nhanh hơn hẳn chuột): khi đang focus vào nút, **↓ / Enter / Space** mở menu; trong menu **↑ ↓** di chuyển dòng sáng (chạy vòng qua đầu/cuối), **Home / End** về đầu / về cuối, **Space** tích–bỏ tích dòng đang sáng, **Enter** tích dòng đang sáng — hoặc nếu chưa chọn dòng nào mà sau khi gõ tìm chỉ còn **đúng một** mục thì tích luôn mục đó (gõ `dad` + Enter là xong), **Esc** hoặc **Tab** đóng menu. Dòng đang sáng được tô nền + viền và **tự cuộn vào tầm nhìn**.
  - CSS của menu **không phụ thuộc Tailwind**: `#stationWrap/#storeWrap/#deptWrap/#presetWrap { position: relative }` và `.multi-menu.hidden { display: none }` được khai báo thẳng trong `style.css`. Nếu để Tailwind lo hai class đó mà file Tailwind không nạp được thì **cả ba menu sẽ luôn mở và đè lên nhau** — đã gặp thật khi chạy kiểm thử giao diện trong môi trường chặn CDN.
  - Ô nằm gần rìa phải màn hình thì menu **tự neo sang phải** (`chinhViTriMenu()` đo xem có tràn khỏi khung nhìn không) để không bị cắt mất.
- **Tên cột bảng “Chi tiết dòng xuất kho”** dùng đúng từ nghiệp vụ: `Seq` → **`Event (WO)`** (`PICKSLIPSEQNO_I`, số Event/WO dùng để khớp với phiếu trả về kho) · `Picking list` → **`Phiếu xuất`** (`PICKING_LISTNO_I`, cũng là tên file scan cần tìm). Cột `Ngày phiếu` và `Sửa cuối (dòng)` đã **bỏ** — xem §5b, cột *Giờ xuất kho* nay tự mang đủ ngày + giờ.
- **Bộ lọc đã lưu (⭐).** Tổ hợp Station/Store/Trung tâm + 2 ô tích hay dùng thì đặt tên rồi gọi lại bằng **một cú bấm**, thay vì mở ba menu tích lại từ đầu mỗi sáng. Nút hiện **tên bộ lọc đang dùng** nếu bộ lọc trên màn hình trùng khớp một cái đã lưu, nên nhìn một cái là biết mình đang ở đâu; trong menu, dòng đó cũng được đánh dấu ✓.
  - **KỲ BÁO CÁO KHÔNG nằm trong bộ lọc đã lưu — có chủ ý.** Nếu lưu cả “tháng 2026-08” thì sang tháng bộ lọc đó thành **sai mà người dùng không biết**; còn lưu kiểu “tháng này” thì lại thêm một khái niệm nữa phải giải thích. Kỳ báo cáo có sẵn 4 nút ngay cạnh đó, chọn lại mất một giây. Bấm một bộ lọc đã lưu **giữ nguyên** kỳ đang xem.
  - Lưu ở **localStorage của từng máy** (`tat-presets-v1`, tối đa 20 bộ): đây là thói quen cá nhân của từng người, không phải cấu hình chung của công ty, nên **không** đưa lên server và **không** dính tới quy tắc phân quyền theo IP ở §6b.
  - Trùng tên thì hỏi ghi đè; xoá thì hỏi xác nhận. Toàn bộ nằm trong `initPresets()` ở `script.js`.
- **Ô tích “Bỏ qua các kho CAB”:** loại hẳn **`CAB`, `CAB-TD`, `P-THA`, `P-SAF`, `P-PAN`** khỏi **KPI Tổng quan và toàn bộ 9 báo cáo**. Điều kiện SQL nằm gọn trong `excludeCabClause()` (danh sách kho ở hằng `CAB_STORES`), được `buildFilterClause()` gắn tự động cho mọi báo cáo — trừ *Chỉ lắp / Chỉ tháo* tự dựng bộ lọc riêng nên gọi thêm một dòng. Viết dạng **`(store IS NULL OR store NOT IN (…))`**: **không bọc hàm** quanh cột (giữ được pushdown — xem §7b) và **vế `IS NULL` là bắt buộc** vì `NULL NOT IN (…)` cho ra `UNKNOWN` sẽ **loại oan** dòng không ghi kho. Ô này **ẩn ở tab LGC và Tra cứu Part On/Off** (không tác động số liệu ở đó). Khi bật, các kho CAB trong menu Store bị **làm mờ kèm nhãn “đang bỏ qua”**; nếu mọi kho đang chọn đều nằm trong nhóm bị bỏ qua thì menu hiện **cảnh báo kết quả sẽ rỗng** — thay vì để người dùng ngồi đoán vì sao báo cáo trống. Báo cáo *Other* không có ô lọc Store nhưng vẫn bỏ qua được kho CAB nhờ tham số `cabStore`.
- **Hàng điều kiện đang lọc (“chip”).** Ngay dưới thanh lọc, mỗi điều kiện đang áp dụng là một chip — `Station: HAN, SGN ×` · `Kho: MAIN ×` · `Bỏ qua các kho CAB ×` — kèm nút **Xoá tất cả bộ lọc**. Tự ẩn khi không lọc gì. **Không thêm chức năng lọc nào mới**, chỉ hiển thị lại thứ đã chọn.
  - Lý do: nút lọc chỉ nói **đang chọn mấy thứ** (“4 station”), không nói **là những gì** — muốn biết phải mở từng menu, ba ô thì mở ba lần. Người nhận link mình gửi lại càng không biết đang xem phạm vi nào. Bảng/biểu đồ trống cũng thấy ngay lý do (ví dụ đang lọc một trung tâm không có dữ liệu trong kỳ).
  - Bấm × bỏ đúng một điều kiện, thay vì mở menu → tìm → bỏ tích → đóng.
  - Chip **bám theo `FILTER_VIEWS`**: chỉ hiện chip của ô lọc **đang có tác dụng** trên màn hình đó. Bày chip *Trung tâm* ở tab Receiving là nói dối, vì tab đó không lọc theo trung tâm — đúng bằng bộ ô lọc đang hiện.
- **Chỉ hiện ô lọc CÓ TÁC DỤNG:** thanh lọc trước đây hiện **đủ mọi ô ở mọi tab**, kể cả ô mà truy vấn của tab đó không dùng đến (ví dụ *“Bỏ qua xuất costcenter”* — chỉ có trong nhánh `kho_ser1`, hoàn toàn không xuất hiện ở pickslip / receiving / repair-admin), nên người dùng chỉnh mà số liệu không đổi và tưởng là lỗi. Nay mỗi màn hình chỉ hiện đúng ô tác động lên số liệu đang xem: *Repair Admin* bỏ **Kỳ báo cáo** (ảnh chụp hiện trạng) và **Trung tâm** (chỉ lọc station/store); *Tra cứu Part On/Off* ẩn cả thanh lọc vì có 6 ô tìm riêng. Bảng quy định nằm ở hằng `FILTER_VIEWS` trong `script.js`.
- **Tab LGC đang THỬ NGHIỆM — ẩn khỏi thanh tab.** Ở trang `/` không thấy mục *🏬 LGC*; muốn vào phải **gõ thêm `/lgc`** trên thanh địa chỉ. Gỡ ẩn khi hết thử nghiệm = bỏ `hidden` ở nút `data-tab="lgc"` trong `index.html`.
- **LGC KHÔNG tự chạy truy vấn.** Các truy vấn của LGC đọc AMOS qua linked server nên **chậm**. Mở tab (hoặc đổi tab con) chỉ hiện thẻ *⏸ Chưa chạy truy vấn*; chọn kỳ báo cáo / Station / Store / Trung tâm xong bấm **▶ Chạy kiểm tra** thì mới gọi API. **Đổi bộ lọc cũng KHÔNG tự chạy lại** — mọi tab con quay về trạng thái *chưa chạy* để không ai đọc nhầm số liệu của bộ lọc cũ. Trạng thái *đã chạy* nhớ theo từng tab con, nên chuyển qua lại giữa 3 tab con không phải chạy lại. Nút đổi thành *⏳ Đang chạy…* và khoá lại trong lúc truy vấn.
- **Trang riêng cho LGC — `/lgc`** (`/lgc.html`; **`/kho`, `/kho.html` là địa chỉ cũ, vẫn chạy** để link đã gửi đi không chết): **cùng một `index.html`, cùng `script.js`, cùng service** — chỉ khác điểm vào. Frontend thấy đường dẫn này thì mở thẳng nhóm *LGC*, ẩn các tab TAT, đổi tiêu đề trang thành *VAECO · LGC*, và **không chạy truy vấn dashboard** (nặng, mà tab đó đang ẩn). Có link *“Xem dashboard TAT đầy đủ →”* để quay lại. ⚠️ Đây là **đơn giản hóa giao diện, KHÔNG phải phân quyền** — ai gõ `/` vẫn xem được đầy đủ, đúng như hiện nay (mọi đơn vị đều được xem). Muốn **chặn** thật thì phải chặn ở server như `adminGuard`.
- **Dashboard:** 9 KPI cards (kèm chip **▲▼ % so với kỳ liền trước** — TAT giảm hiện xanh, tăng hiện đỏ), 4 biểu đồ, bảng chi tiết + tìm kiếm + filter theo cột.
- **TAT tổng (3 chặng) = TAT install + TAT US return + TAT CUVT** — ba chặng **liên tiếp** của cùng một vòng đời khí tài: (1) xuất kho → lắp lên tàu; (2) tháo khỏi tàu → trả unservice; (3) trả unservice → CUVT nhận. Biểu đồ theo Trung tâm vẽ **cột xếp chồng** nên chiều cao cả cột chính là TAT tổng của trung tâm đó (rê chuột thấy dòng *TAT tổng*); các trung tâm xếp theo tổng giảm dần.
- **Số lượng xuất kho theo Trung tâm** — cột **xếp chồng**: **Đã trả** (xanh, `--good`) + **Chưa trả** (vàng, `--warning`) = tổng thiết bị xuất kho của trung tâm đó. Số lượng hiện **ở giữa từng đoạn** (đoạn thấp dưới 16px thì bỏ qua để chữ không chồng nhau), **tổng hiện trên đỉnh cột**; màu chữ tự chọn trắng/đen theo độ sáng nền nên đọc được ở cả theme sáng và tối. *Đã trả* = đã đối ứng (`deptAgg`) **cộng** các cặp đối ứng thủ công của trung tâm đó; *Chưa trả* = `notRecAgg`. Tổng tất cả các cột luôn **khớp KPI “Thiết bị xuất kho”**.
- **Phân bổ thiết bị (biểu đồ tròn)** — chia theo **Station** (HAN/SGN/DAD/Khác); riêng khi **đang chọn ĐÚNG MỘT Station** thì chia theo **Trung tâm** trong station đó (chia theo station lúc đó chỉ còn đúng 1 miếng, không nói lên điều gì). Chọn từ hai station trở lên vẫn chia theo station. Server báo qua trường `charts.pieStation.groupBy` (`station` | `department`) để frontend đổi tiêu đề thẻ **và** đổi khóa drill-down cho đúng. Cả hai chế độ đếm **cùng một tập** = **toàn bộ thiết bị xuất kho trong kỳ** (đã trả + chưa trả), nên **tổng biểu đồ tròn = tổng biểu đồ cột *Số lượng xuất kho* = KPI *Thiết bị xuất kho*** — ở chế độ theo Trung tâm, giá trị từng miếng trùng khít chiều cao từng cột. Aggregate `stationAgg` gồm **3 nhánh** (trả US + trả service + chưa đối ứng) cộng thêm các cặp đối ứng thủ công (không nằm trong nhánh nào). Miếng xếp theo số lượng giảm dần, tooltip có kèm **%**.
- **Trải nghiệm khi chờ tải:** đổi tab hoặc đổi bộ lọc là **dữ liệu cũ bị xóa ngay** (không để người dùng đọc nhầm số của tab trước), vùng dữ liệu được **phủ mờ + chặn thao tác** kèm vòng xoay và dòng chữ *Đang tải dữ liệu…*, tab đang tải có **chấm nhấp nháy**, và chip *Đang tải dữ liệu…* trên thanh lọc được làm nổi bật. Lớp phủ chỉ hiện sau **120 ms** nên dữ liệu lấy từ cache (đổi tab qua lại) không bị nhấp nháy.
- **Drill-down:** click 1 cột/miếng trên biểu đồ → lọc toàn dashboard theo Trung tâm/Station đó; click lại lần nữa để bỏ lọc.
- **Chia sẻ link:** bộ lọc hiện hành nằm trên URL (`?periodType=…&month=…&department=…`) — copy link gửi đồng nghiệp là họ mở ra đúng màn hình đang xem.
- **Báo cáo định kỳ → Teams/SharePoint (tùy chọn, mặc định TẮT):** theo lịch (`REPORT_SCHEDULE`, vd `T2 06:30`), server tự tính KPI **kỳ vừa kết thúc** kèm so sánh kỳ trước. `REPORT_PERIOD=week,month`: mỗi lần chạy gửi báo cáo **tuần**; báo cáo **tháng** tự gửi **1 lần/tháng** (lần chạy đầu tiên của tháng mới, cho tháng vừa kết thúc). Hai kênh: (1) **thẻ Adaptive Card** vào kênh Teams qua **Workflows webhook** (`TEAMS_WEBHOOK_URL` — Incoming Webhook kiểu cũ đã bị Microsoft khai tử); (2) file **Excel .xlsx** (sheet KPI + sheet Chi tiết TAT có filter/freeze header) vào thư mục SharePoint/OneDrive **sync** trên server (`REPORT_EXPORT_DIR`) → tự lên thư viện SharePoint, xem được từ mọi nơi. Trang Admin có nút **📨 Gửi báo cáo ngay** để test (gửi cả 2 kỳ). ⚠️ Bật tính năng này = số liệu **tổng hợp** rời mạng nội bộ lên cloud M365; mỗi lần gửi đều ghi audit `logs/report-YYYY-MM-DD.log`.
- **Đối ứng thủ công (label lệch):** tab riêng cho các ca bất thường — *tháo thiết bị này xuống, lắp thiết bị khác lên* nên **label của 2 thiết bị khác nhau**, join theo `labelno` không tự đối ứng được. Hệ thống **gợi ý cặp** theo thứ tự ưu tiên:
  Thứ tự chọn theo **ĐỘ TIN CẬY** giảm dần (không phải theo nguồn) — nguồn mạnh luôn thắng nguồn yếu:

  | Bậc | Cách ghép | Tin cậy |
  |---|---|---|
  | 1 | **Other (`on_ac`) · khớp event (WO)** | 🟢 Cao |
  | 2 | `WO_PART_ON_OFF` theo part+serial — AMOS ghi cả thiết bị lắp và tháo trong một dòng | 🟢 Cao |
  | 3 | `WO_PART_ON_OFF` theo event (WO) | 🟢 Cao |
  | 4 | **Other · khớp part no + số tàu** | 🟡 Trung bình |
  | 5 | `on_off` cùng `orderno`/`psn` | 🟡 Trung bình |
  | 6 | **Other · chỉ khớp part no** | 🔴 Thấp |
  | 7 | `on_off` cùng số tàu, gần thời gian | 🔴 Thấp |

  Nguồn **Other** = thiết bị đã trả US nhưng chưa có phiếu xuất; cửa sổ −30/+60 ngày quanh phiếu
  xuất (ROB/SWP có thể trả *trước* ngày lập phiếu). Mã **DIR** (lắp thẳng vật tư từ kho) **không
  dùng** để gợi ý ghép vì không phải ca label lệch — vẫn hiển thị bình thường ở tab *Other*.
  Danh sách loại trừ nằm ở hằng `ON_AC_EXCLUDE_FROM_MATCH` trong `server.js`.

  Cột *Cách ghép* ghi rõ nguồn + mã lý do + tiêu chí đã khớp (vd `Other — ROB (Robbery…) · Khớp event (WO)`). Bấm **✔ Xác nhận** → cặp lưu vào `data/reconcile-manual.json`, phiếu xuất hết nằm trong *Chưa đối ứng* và được tính là **đã đối ứng** trong KPI (`countManualPaired`). Xác nhận chỉ làm được từ **IP quản trị**.
  Kỹ thuật: bảng `WO_PART_ON_OFF` (linked server Oracle) được kéo về **bảng tạm một lần** rồi join nhiều lần — không hỏi linked server theo từng dòng; cột event dò qua `INFORMATION_SCHEMA` nên không vỡ nếu hệ thống khác tên cột.
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

## 6e. Trang LGC lấy dữ liệu của TẤT CẢ station / store / trung tâm

Trang LGC nay đã có đủ ba ô lọc *Station · Store · Trung tâm* (chọn nhiều) giống
trang dashboard, nên **người dùng quyết định phạm vi**, không phải truy vấn quyết
định hộ. Hai thay đổi:

**1. Bỏ ràng buộc cứng về `STORE` trong truy vấn.** Trước đây bê nguyên từ
`AMOS_GUI.py`:

| Màn hình | Điều kiện đã bỏ |
|---|---|
| Quản lý xuất kho | `STORE` kết thúc `main` **hoặc** `vna` |
| Receiving | như trên, **và** loại riêng `STORE = 'main'` ở `LOCATION ∈ {shoploc, lg5}` |

⚠️ **Mọi con số KPI của LGC sẽ TĂNG so với bản cũ** — đúng như vậy, vì trước đây
các kho khác bị bỏ sót ngay trong truy vấn mà giao diện không hề nói. Các điều
kiện **không** liên quan tới kho vẫn giữ nguyên: `QTY_BOOKED ≠ 0`,
`STATUS ∉ {1, 11}`, `LOCATION_FROM` không chứa `u/s`, `CONDITION` không chứa `us`.
Muốn xem đúng phạm vi cũ thì chọn các kho `…MAIN` / `…VNA` trong ô lọc Store —
và nay còn **lưu lại được** bằng ⭐ *Bộ lọc đã lưu*.

> `GET /api/admin/diag/linkserver` **vẫn giữ** hai điều kiện `STORE` trong câu đo:
> đó là phép **đo tác hại của “hàm trong `WHERE`”** (§7b), càng nhiều hàm càng đo
> rõ — không phải bộ lọc đang chạy.

**2. Mở `/lgc` là ba ô lọc về “Tất cả”.** Trang LGC dùng **chung** `localStorage`
với dashboard, nên bộ lọc chọn bên dashboard (ví dụ `station=HAN`) vẫn còn khi sang
LGC — nhân viên kho mở lên thấy số liệu thiếu mà không hiểu vì sao. Ngoại lệ: link
**có sẵn tham số lọc** (`/lgc?station=SGN`) thì giữ nguyên, vì đó là ý muốn rõ ràng
của người gửi link.

## 6b. Quyền tài khoản SQL Server (quan trọng)

Dashboard chạy tốt với tài khoản **CHỈ ĐỌC (read-only)**. Cụ thể:

| Việc | Ghi vào SQL Server? | Cần quyền gì |
|---|---|---|
| Toàn bộ KPI, biểu đồ, báo cáo, tra cứu | ❌ Không | `SELECT` trên `NQT.dbo.*` + `DWH_DB..STG_AMOS.*` |
| Truy vấn ghép cặp (bảng tạm `#wo`, `#other`) | ❌ Không (chỉ `#temp` trong tempdb) | Mặc định mọi login đều tạo được `#temp` |
| **Cặp đối ứng thủ công đã xác nhận** | ❌ **Không** — lưu **file JSON** trên máy chủ dashboard (`data/reconcile-manual.json`) | Không cần quyền DB |
| Câu hỏi chatbot / KB đã học / log | ❌ Không — file trong `data/`, `logs/` | Không cần quyền DB |
| `SIGN_CACHE` (tăng tốc, **tùy chọn**) | ✅ Có | `CREATE TABLE` + `INSERT` + `TRUNCATE` trên **riêng** bảng `[NQT].[dbo].[SIGN_CACHE]` |

**Nếu tài khoản chỉ đọc:** app tự phát hiện thiếu quyền, **tắt SIGN_CACHE** và quay về đọc thẳng
linked server — vẫn chạy đúng, chỉ **chậm hơn**. Đặt `SIGN_CACHE=false` trong `.env` để bỏ hẳn
thông báo. Muốn nhanh thì nhờ DBA cấp quyền ghi cho **đúng một bảng** `SIGN_CACHE` (không đụng
bảng nghiệp vụ nào).

### Ai được XEM, ai được SỬA

Dữ liệu đối ứng thủ công nằm trên **máy backend**; quyền tách làm 2 mức, chặn ở **server**
(dựa trên IP socket thật, không tin header → không giả mạo được):

| Thao tác | Máy quản trị (localhost + `ADMIN_IPS`) | Máy khác |
|---|---|---|
| Xem dashboard, KPI, mọi báo cáo | ✅ | ✅ |
| Xem tab *Đối ứng thủ công* (ứng viên + gợi ý cặp) | ✅ | ✅ |
| Xem tab *✔ Đã đối ứng thủ công* (các cặp đã chốt) + xuất Excel | ✅ | ✅ |
| **Xác nhận / gỡ cặp đối ứng** | ✅ | 🚫 **403** |
| Xem đường dẫn + trạng thái **thư mục file scan** | ✅ | ✅ |
| **Đổi đường dẫn thư mục file scan** | ✅ | 🚫 **403** |
| Trang `/admin` (LLM, log, KB, quản lý cặp) | ✅ | 🚫 **403** |

Trên tab *Đối ứng thủ công*, máy không có quyền thấy **🔒 Chỉ xem** thay cho nút *✔ Xác nhận*
(kèm IP của máy đó trong tooltip). Đây chỉ là gợi ý giao diện — chặn thật nằm ở server, nên
gọi thẳng API từ máy khác vẫn bị từ chối.

### Nên đặt thư mục dữ liệu Ở ĐÂU

File JSON **bắt buộc nằm trên máy chạy backend** (chỉ backend đọc/ghi được — trình duyệt
không ghi file). Nhưng **vị trí** thì nên đổi:

| Đặt ở đâu | Ưu / nhược |
|---|---|
| `dashboard-sql/data/` (mặc định) | ❌ Nằm **trong** thư mục app → `git pull` bị xung đột, cài lại/ghi đè app có thể **mất sạch** |
| **Thư mục riêng ngoài app** (khuyến nghị) — `DATA_DIR=D:\VAECO\dashboard-data` | ✅ Cài lại/nâng cấp app không đụng tới; dễ chỉ IT backup đúng 1 thư mục |
| Ổ mạng dùng chung (`\\server\share\...`) | ✅ IT backup tập trung · ❌ Mạng trục trặc là không xác nhận được cặp; tài khoản service phải có quyền ghi |
| SQL Server | ❌ Không dùng được — tài khoản DB chỉ có quyền **đọc** |

Đặt `DATA_DIR` trong `.env` rồi **chép thư mục `data/` cũ sang vị trí mới** trước khi restart.
Tài khoản chạy service phải có quyền **ghi** vào thư mục đó. Nếu để mặc định, log khởi động
sẽ **cảnh báo** nhắc chuyển ra ngoài.

**Chống hỏng file:** mỗi lần ghi đều làm 3 bước — ghi ra `.tmp` → giữ bản cũ thành `.bak` →
đổi tên `.tmp` thành file thật (thao tác nguyên tử). Service bị tắt đột ngột giữa chừng thì
file thật vẫn nguyên vẹn (hoặc bản cũ, hoặc bản mới), **không bao giờ cụt/hỏng**.

> ⚠️ **Sao lưu:** thư mục `data/` (cặp đối ứng thủ công + KB chatbot đã học) **không nằm trong git**.
> Trang Admin có nút **⬇ Tải bản sao lưu**; nên tải định kỳ, hoặc chép cả thư mục `data/` khi
> cài lại / đổi máy chủ. Mất file này = mất toàn bộ cặp đã xác nhận (thiết bị quay lại "Chưa đối ứng").

## 6c. Thư mục file scan PDF (đối chiếu phiếu đã scan)

Hai tab **LGC ▸ Quản lý xuất kho** và **LGC ▸ Receiving** đối chiếu từng phiếu với **file PDF đã scan**
nằm trên ổ mạng, để biết phiếu nào **chưa scan**:

| Thư mục | Dùng cho | Cách khớp tên file | Mặc định |
|---|---|---|---|
| **Picking list** | cột *Scan* (phiếu xuất) và *Scan phiếu trả* | lấy **phần trước dấu `-` đầu tiên** của tên file rồi so với `PICKING_LISTNO_I`, hoặc `HISTORYNO_I` với phiếu trả | `\\10.99.7.7\picking list\2026` |

**Tên file Picking list — cách cắt này bao được cả hai quy ước:**

| Station | Cách đặt tên | Ví dụ với picking list `700001` | Khóa cắt ra |
|---|---|---|---|
| **HAN** | số + phần đuôi | `700001-AOG.pdf` | `700001` |
| **SGN** | **đúng số picking list** | `700001.pdf` | `700001` |

Tên **không có** dấu `-` thì `split('-')[0]` trả về **nguyên tên**, nên dạng của SGN khớp sẵn —
**không cần cấu hình gì thêm**. Áp dụng y hệt cho *phiếu trả* (khóa là `HISTORYNO_I`).

> Điều **duy nhất** sẽ làm hỏng cách khớp này là tên file có **thêm ký tự ở ĐẦU** (ví dụ
> `PL-700001.pdf` hay `0700001.pdf`) — khi đó khóa cắt ra không còn bằng số picking list.
> Nếu gặp, báo lại để đổi cách khớp.
| **Receiving** | cột *Scan* của tab Receiving | so **nguyên tên file** với `VOUCHERNO`, chấp nhận **CẢ HAI** cách đặt tên (xem dưới) | `\\10.99.7.7\certificates\2026` |

**⚠️ Tên file Receiving khác nhau theo station:**

| Station | Cách đặt tên | Ví dụ với `VOUCHERNO = R-259454` |
|---|---|---|
| **HAN** | bỏ tiền tố `R-` | `259454.pdf` |
| **SGN** | **giữ nguyên** `R-` | `R-259454.pdf` |

Dashboard **thử cả hai dạng**, khớp dạng nào cũng tính là đã scan — hai dạng đều trỏ về **cùng
một voucher** nên không thể nhầm sang phiếu khác. Cách này không cần khai báo thêm và tự chịu
được nếu một station đổi quy ước. Cột **Tên file scan** hiển thị **đúng tên file thật** khi tìm
thấy, và liệt kê **cả hai dạng chấp nhận được** khi chưa thấy — để biết cần đặt tên thế nào.

*(Công cụ `AMOS_GUI` chỉ bỏ tiền tố `R-` vì nó chạy cho **một** station mỗi lần, mặc định HAN.
Dashboard xem nhiều station cùng lúc nên phải chịu được cả hai.)*

### MỖI STATION MỘT THƯ MỤC RIÊNG

Công cụ `AMOS_GUI` của nghiệp vụ có ô **Station** (SGN/HAN/DAD) và ô **Thư mục** **nằm cạnh
nhau** — đổi station thì đổi luôn thư mục, và `save_config` lưu **cả hai**. Nghĩa là mỗi
station scan vào một thư mục khác nhau.

Dashboard **xem được nhiều station cùng lúc**, nên không thể dùng một thư mục chung: nó tra cứu
**theo station của TỪNG phiếu** (cột `STATION` dạng `VNA-HAN` → khớp **đuôi** chuỗi). Station
nào chưa khai riêng thì dùng dòng **Mặc định**.

> ⚠️ *Trước đây dashboard chỉ có MỘT thư mục chung — chọn SGN vẫn đối chiếu vào thư mục HAN nên
> **mọi phiếu SGN đều bị báo “Chưa scan” oan**. Đã sửa.*

**Đường dẫn sửa được, không phải cố định trong code.** Thứ tự ưu tiên cho từng station:

1. File `data/scan-folders.json` (do trang `/admin` ghi ra) — **cao nhất**;
2. Biến `SCAN_PICKING_DIR_<STATION>` / `SCAN_RECEIVING_DIR_<STATION>` trong `.env`;
3. Dòng **Mặc định**: `SCAN_PICKING_DIR` / `SCAN_RECEIVING_DIR`;
4. Giá trị mặc định ở bảng trên.

Vào **`/admin` → khối 📁 Thư mục file scan PDF** (bảng **Station × Picking / Receiving**), sửa rồi bấm **💾 Lưu đường dẫn**: server lưu
file JSON **trên máy backend** (`saveJsonSafe`, chống hỏng file như mục §6b) và **đọc thử ngay**,
hiện luôn *đọc được bao nhiêu file PDF* hoặc *lỗi gì*. Để trống ô = quay về giá trị mặc định.
Đúng như nguyên tắc §6b: **chỉ máy quản trị** (localhost + `ADMIN_IPS`) sửa được — máy khác vẫn
`GET /api/scan-config` để **xem** được, nhưng `POST /api/admin/scan-config` bị **403**.

**Khi không với tới được thư mục mạng** (mất mạng, sai đường dẫn, thiếu quyền), cột *Scan* để
**`—`** chứ **không** báo "Chưa scan" — báo nhầm sẽ khiến người dùng đi tìm/scan lại những phiếu
thực ra đã có file. Đầu tab hiện **thanh cảnh báo vàng** kèm đường dẫn và lý do lỗi. Danh sách file được
**cache 60 giây** nên nhiều người cùng xem chỉ quét thư mục một lần.

⚠️ Tài khoản chạy service (Windows Service chạy dưới `LocalSystem` mặc định **không** có quyền
mạng) phải **đọc được** đường dẫn UNC — nếu không sẽ luôn thấy lỗi *Không có quyền đọc thư mục*.

## 6d. Cách đếm “đã scan / chưa scan” — theo PHIẾU và trên TOÀN KỲ

Nghiệp vụ yêu cầu **scan phải đạt 100%**, nên con số này phải đúng tuyệt đối.
Hai bẫy đã được xử lý:

| Bẫy | Hậu quả nếu để nguyên | Cách xử lý |
|---|---|---|
| Đếm theo **DÒNG** | Một picking list 50 dòng chưa scan hiện thành **50 “chưa scan”**, trong khi thực tế chỉ là **1 file** cần scan → con số phóng đại, không nói đúng khối lượng việc | KPI đếm theo **PHIẾU**: `DISTINCT PICKING_LISTNO_I` (xuất kho) / `DISTINCT VOUCHERNO` (receiving) |
| Tính trên **bảng chi tiết** | Bảng chi tiết bị cắt ở `TOP (MAX_ROWS)` = 5.000 dòng. Kỳ lớn thì phiếu chưa scan nằm ngoài phần bị cắt **biến mất khỏi KPI** → có thể hiện **100% trong khi thực tế vẫn còn thiếu** | Danh sách phiếu được lấy **riêng** bằng `SELECT DISTINCT` trên bảng tạm cho **cả kỳ**, không đi qua `TOP` |

Danh sách `DISTINCT` nhỏ hơn bảng chi tiết rất nhiều nên **không tốn thêm lượt gọi
linked server** (vẫn dùng chung bảng tạm `#ps` / `#hi` đã kéo về một lần).

Kết quả: **thẻ KPI đếm theo phiếu, toàn kỳ** — đây là con số dùng để theo dõi mục
tiêu 100% và bằng đúng **số file còn phải scan**. **Bảng chi tiết bên dưới vẫn theo
dòng** (để tra cứu) và vẫn bị cắt ở `MAX_ROWS`, nên **hai con số không bằng nhau là
bình thường** — dòng mô tả trên mỗi tab đã ghi rõ điều này. Server vẫn trả kèm
`daScanDong` / `chuaScanDong` để đối chiếu khi cần.

Thẻ *Đã scan* **tự đổi màu**: xanh khi `chưa scan = 0` (đạt 100%), vàng khi còn
thiếu; thẻ *Chưa scan* đỏ khi còn phiếu chưa scan. Nếu **không đọc được thư mục**
thì cột *Scan* để `—` và không dòng nào được tính là đã/chưa scan — xem §6c.

## 7b. Tăng tốc truy vấn qua linked server — **hàm trong `WHERE` mới là thủ phạm**

**Triệu chứng:** tab *Quản lý xuất kho* báo `Timeout: Request failed to complete in 60000ms`
ngay cả với kỳ **1 tuần**.

**Đã ĐO THẬT**, không đoán (`/api/admin/diag/linkserver`, kỳ 1 tuần 07/2026):

| Câu | ms | dòng |
|---|---:|---:|
| `PICKSLIP_BOOKED` — **chỉ lọc ngày** (điều kiện thuần) | **1.096** | 81.452 |
| `PICKSLIP_BOOKED` — **+ bộ lọc nghiệp vụ** (`LOWER/RTRIM/ISNULL/TRY_CONVERT`) | **22.806** | 44.779 |
| **NỐI cả 2 bảng**, điều kiện ngày thuần | **1.080** | 5.755 |
| `LOCATION` (Repair Admin) | 988 | 226 |
| `HISTORY` (Receiving) | 6.517 | 1.361 |

**Kết luận trái với dự đoán ban đầu: phép NỐI BẢNG không hề chậm — nó nhanh nhất trong nhóm.**
Thứ làm chậm **gấp 21 lần** là các hàm `LOWER / RTRIM / ISNULL / TRY_CONVERT` trong `WHERE`:
chúng **chặn SQL Server đẩy điều kiện xuống máy chủ AMOS**, nên AMOS phải trả về rất nhiều
dòng rồi mới lọc tại chỗ.

*(Đã từng thử tách ra hỏi từng bảng một rồi truyền khóa sang bảng kế tiếp — **chậm hơn**,
đã bỏ. Số đo ở trên là lý do.)*

**Quy tắc rút ra — áp cho cả 3 báo cáo của LGC:**

1. Câu gửi xuống AMOS chỉ lấy **CỘT THÔ**, `WHERE` chỉ có **điều kiện thuần** trên cột;
2. **Không** `RTRIM/ISNULL/LOWER/TRY_CONVERT` trong câu gửi xuống AMOS;
3. **Không dùng tham số `@p`** cho điều kiện gửi xuống AMOS — tham số cũng hay chặn việc đẩy
   điều kiện. Đặt **số trực tiếp** (số ngày AMOS, `location_type`…) do server tự tính nên
   không có rủi ro chèn lệnh; chuỗi thì nhân đôi dấu nháy;
4. Cắt gọt chuỗi, phân loại và **bộ lọc nghiệp vụ làm TẠI CHỖ** trên bảng tạm — vài nghìn dòng
   nên không tốn gì.

| Báo cáo | Câu gửi xuống AMOS | Làm tại chỗ |
|---|---|---|
| **Quản lý xuất kho** | `#raw` ← nối `PICKSLIP_BOOKED × PICKSLIP_HEADER`, `WHERE PICKSLIP_DATE >= 19911 AND < 19918` | `#ps` ← cắt gọt + phân loại Cancel/Return + bộ lọc nghiệp vụ |
| **Receiving** | `#hraw` ← `HISTORY`, `WHERE VM IN ('B1','CR') AND DEL_DATE >= … AND < …` | `#hi` ← cắt gọt + đổi ngày AMOS; lọc station/store/condition |
| **Repair Admin** | nối 3 bảng, `WHERE location_type = -4 AND status = 0` | cắt gọt chuỗi ở Node |

### Đo lại bất cứ lúc nào — `GET /api/admin/diag/linkserver`

Chạy từng bước riêng rẽ và bấm giờ. **A** = cách đang dùng (điều kiện thuần);
**B** = thêm bộ lọc nghiệp vụ gửi xuống AMOS (cách cũ); **C** = điều kiện ngày dùng tham số `@p`.
A phải nhanh hơn hẳn B và C. **Chỉ đọc. Chỉ IP quản trị.**

`npm run sqlcheck` cũng **nhắc** (không chặn) những chỗ còn hàm trong `WHERE` của câu chạm
`[DWH_DB]..`. Đây chỉ là cảnh báo vì luật này chưa đủ chính xác — một câu có thể vừa đọc bảng
tạm vừa `LEFT JOIN` sang `SIGN`, khi đó hàm ở bảng **tạm** vẫn bị bắt nhầm. Muốn chắc thì đo
bằng `diag/linkserver`.

## 7c. Thư viện giao diện để TRÊN MÁY BACKEND, không lấy từ CDN

Trước đây `index.html` nạp **5 file từ Internet**: `cdn.tailwindcss.com`,
`cdn.jsdelivr.net` (Chart.js), `unpkg.com` (Tabulator), `cdnjs.cloudflare.com`
(SheetJS) — `admin.html` thêm 3 file nữa. Ba vấn đề:

1. **Máy nội bộ bị chặn ra ngoài là trang hỏng.** Không phải hỏng nhẹ: Tailwind
   không tải được thì class `.hidden` và `.relative` **không tồn tại**, nên cả ba
   menu chọn nhiều luôn mở và đè lên nhau, bấm không được. Đã gặp thật khi chạy
   kiểm thử giao diện trong môi trường chặn CDN.
2. **Mỗi lượt mở trang đều gửi IP + đường dẫn trang cho bên thứ ba.** Sát với quy
   tắc “không gửi dữ liệu ra ngoài phạm vi công ty”.
3. **Bản Tailwind CDN là bản “play”**, chính Tailwind khuyến cáo **không dùng cho
   production** — nó biên dịch lại CSS ngay trên trình duyệt **mỗi lần mở trang**.

Nay cả 5 file nằm trong `public/vendor/`, dựng bằng `npm run build:assets`
(`tools/build-assets.js`) từ `node_modules` — phiên bản **ghim trong
`package.json`**, không tải mạng. Riêng Tailwind được **biên dịch thật** từ chính
HTML/JS của dự án: **8 KB** thay cho ~400 KB script biên dịch tại chỗ.

### Cái bẫy: file CSS cũ so với mã nguồn

Tailwind chỉ giữ những class **thực sự xuất hiện** trong `public/*.html` và
`public/*.js`. Thêm một class Tailwind mới mà quên dựng lại → class đó **không có
trong file CSS** → giao diện lệch mà không ai biết, vì không có lỗi nào cả.

Vì thế `npm run smoke` chạy thêm `node tools/build-assets.js --check`: dựng lại
vào file tạm rồi **so sánh** với `public/vendor/`, khác là **TRƯỢT** kèm hướng dẫn
chạy `npm run build:assets`. (Đã kiểm chứng bằng cách cố tình thêm một class mới —
`--check` trượt đúng như mong đợi.)

> ⚠️ **`tailwind.css` phải nạp SAU `style.css`** trong `<head>`. Bản CDN cũ chèn
> thẻ `<style>` vào cuối `<head>` lúc chạy, tức là **nằm sau** `style.css`, nên khi
> trùng độ ưu tiên thì lớp tiện ích của Tailwind **thắng**. Ví dụ
> `.chat-panel { display:flex }` trong `style.css` và `.hidden { display:none }`
> của Tailwind **đều là một lớp** — ai đứng sau thì thắng. Lần đầu chuyển sang bản
> dựng sẵn tôi đặt `tailwind.css` lên trước và **khung chat mở sẵn ngay khi vào
> trang**; đảo lại thứ tự là đúng như cũ.

## 7d. Nhật ký tiến trình thời gian thực (giống log của bản Python)

Truy vấn LGC đi qua linked server, có câu mất hàng chục giây. Trước đây người dùng
chỉ thấy **một vòng xoay** — không biết chương trình đang làm gì, còn bao lâu, hay
đã treo. Nay server **bắn từng bước về trình duyệt ngay khi nó xảy ra**, hiện trong
lớp phủ “đang tải”:

```
03:32:20  ▶ Dò cấu trúc bảng AMOS (MUTATION_TIME…)…
03:32:20  ✔ Dò cấu trúc bảng AMOS (MUTATION_TIME…) — 412 ms
03:32:20  Kỳ báo cáo: Tháng (2026-08-01 → 2026-09-01)
03:32:21  ▶ Kéo PICKSLIP_BOOKED × PICKSLIP_HEADER về #temp rồi gom số liệu (qua linked server — bước lâu nhất)…
03:32:48  ✔ Kéo PICKSLIP_BOOKED × PICKSLIP_HEADER về #temp rồi gom số liệu — 27.418 ms
03:32:48  ▶ Đọc thư mục file scan phiếu xuất…
```

Mỗi bước ghi kèm **thời gian chạy**, nên nhìn log là biết ngay bước nào thật sự chậm —
không phải đoán.

### Cách hoạt động

Dùng **SSE** (Server-Sent Events) — chỉ là HTTP thường, đi qua được mọi proxy nội bộ
và chỉ cần vài dòng code; ta chỉ cần **một chiều** server → trình duyệt nên không cần
WebSocket. Trình duyệt tự sinh một **mã việc** rồi:

1. mở `GET /api/progress/:job` (kết nối để mở, server đẩy dữ liệu về);
2. gọi `/api/pickslip?…&job=<mã>` như bình thường.

Server ghi các bước vào `JOBS[mã]`, SSE đẩy ngay về; xong thì bắn `xong: true` để
trình duyệt đóng kết nối. Phía server: `moNhatKy()` trả về hàm ghi, `buoc()` bấm giờ
một bước và tự ghi cả lúc bắt đầu lẫn lúc xong. Không có mã việc → `moNhatKy()` trả
hàm **rỗng**, nên chỗ gọi không phải kiểm tra gì.

Đã gắn cho: **Quản lý xuất kho**, **Receiving**, **Repair Admin** và **9 báo cáo**
(báo cáo chưa có bước riêng thì ít nhất có dòng mở đầu). Dashboard chưa gắn.

### Bốn cái bẫy đã xử lý (đều đã kiểm chứng)

1. **`compression` gom SSE lại thành một cục** → nhật ký hiện ra hết ở cuối, mất sạch
   ý nghĩa. Đã thêm `filter` bỏ qua `text/event-stream`. Kiểm tra: phản hồi SSE có
   `Content-Encoding` rỗng.
2. **Mã việc làm hỏng khóa cache.** Khóa cache trước đây là `req.originalUrl`, mà mã
   việc **ngẫu nhiên mỗi lần bấm** → không lần nào trúng cache, truy vấn nặng chạy lại
   từ đầu. `cacheKeyKhongJob()` bỏ `job` ra khỏi khóa (và `sort()` để thứ tự tham số
   không đổi khóa). Kiểm tra: gọi lại cùng URL với `job` khác → `X-Cache: HIT`.
3. **Dòng log đến trước khi lớp phủ kịp vẽ thì bị mất.** `setBusy()` vẽ trong
   `setTimeout`, nên ngay cả `delay = 0` nó vẫn vẽ ở tick **sau**. Dòng đầu tiên
   (ví dụ “lấy lại từ bộ nhớ đệm”) có thể tới trong cùng tick. Đã đệm ở `_nhatKyCho`
   rồi xả ra khi lớp phủ xuất hiện. Kiểm tra: bắn 8 dòng cùng tick với `setBusy` →
   hiện đủ 8 (trước khi sửa: 0).
4. **Lớp phủ căn giữa theo chiều cao pane** (KPI + 4 biểu đồ + bảng ≈ vài nghìn px)
   → vòng xoay và nhật ký rơi xuống tận giữa trang, ngoài tầm nhìn. Đã đổi sang căn
   **lên trên**.

Bộ nhớ: mỗi việc tự hết hạn sau 5 phút, tối đa 200 việc, mỗi việc giữ tối đa 200 dòng.
Nhịp tim 15 giây/lần để proxy không cắt kết nối “im lặng”.

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
| `GET /api/health` | Kiểm tra kết nối DB **và phiên bản code đang chạy**: `commit` (7 ký tự), `branch`, `startedAt`, kèm `diagRoutes`. Dùng để biết service đã nạp bản mới sau `git pull` hay chưa. |
| `GET /api/dashboard` | KPI + dữ liệu biểu đồ |
| `GET /api/tat/departments` | Bảng chi tiết TAT theo đơn vị |
| `GET /api/tat/cuvt` | Chi tiết TAT CUVT |
| `GET /api/reports/:name` | Báo cáo (`issued-not-installed`, `removed-not-returned`, `not-reconciled`, `removed-before-installed`, `other`, `return-store-tat`, `repair-admin`) |
| `GET /api/pickslip` | Tab *Quản lý xuất kho*: KPI + 4 biểu đồ + bảng chi tiết, kèm **đối chiếu file scan**, **phiếu trả** và **TAT return**. Trả thêm `scanFolder` (đường dẫn, số file PDF đọc được, lỗi nếu có). |
| `GET /api/receiving` | Tab *Receiving*: phiếu nhập kho (`HISTORY` `VM='B1'`, đã loại phiếu hủy nhập `CR`) + đối chiếu file scan theo `VOUCHERNO`. Trả thêm `scanFolder`. |
| `GET /api/scan-config` | Đường dẫn 2 thư mục file scan + **trạng thái thật** (đọc được bao nhiêu file PDF / lỗi gì) + `canEdit`. **Mọi máy xem được.** |
| `POST /api/admin/scan-config` | Đổi đường dẫn thư mục file scan (body `{ picking, receiving }`, để trống = dùng mặc định). Lưu vào `data/scan-folders.json` trên máy backend. **Chỉ IP quản trị.** |
| `GET /api/part-onoff` | Tra cứu Part On/Off (`WO_PART_ON_OFF`, linked server DWH_DB). 6 tham số riêng, khớp **chính xác**, kết hợp AND (bỏ trống = bỏ qua): `event`, `labelno` (số) · `partno`, `serialno`, `partnoOff`, `serialnoOff` (chữ). Giờ VN = ghép `MUTATION` (số ngày AMOS) + `MUTATION_TIME` (ms từ 0h) + 7h thành 1 cột; `CREATED_DATE` cũng là số ngày AMOS → chỉ có ngày (không giờ). |
| `POST /api/chat` | Trợ lý TAT. Body JSON `{ message, ...filter }` → `{ reply, intent }`. Số liệu/tra cứu tính bằng SQL nội bộ; câu chưa hiểu mới (tùy chọn) chuyển AI theo `LLM_PROVIDER`. |
| `POST /api/chat/flag` | Người dùng **👎 Báo sai** một câu trả lời. Body `{ message }` → nhờ AI (nếu bật) trả lời lại + lưu kinh nghiệm; nếu AI tắt thì ghi nhận để admin review. |
| `GET /api/admin/chat-unknown` | Gộp log câu hỏi chatbot chưa hiểu (gom theo nội dung, đếm số lần). Query `days` (0 = tất cả). Trang xem: `/admin` hoặc `/admin.html`. **Chỉ IP quản trị.** |
| `POST /api/admin/kb-review` | Đánh dấu một mục AI (đám mây/nội bộ) học được là **đã kiểm tra**. Body `{ key }`. **Chỉ IP quản trị.** |
| `GET /api/admin/llm-status` | Trạng thái LLM: provider, sẵn sàng/bị chặn, model, che dữ liệu, có API key hay chưa (không lộ khóa). **Chỉ IP quản trị.** |
| `GET /api/admin/manual-pairs` | Danh sách cặp đối ứng thủ công đã xác nhận. **Chỉ IP quản trị.** |
| `POST /api/admin/manual-pair/confirm` | Xác nhận 1 cặp (label lệch) → tính là đã đối ứng. **Chỉ IP quản trị.** |
| `GET /api/whoami` | Máy đang gọi có quyền sửa không → `{ ip, isAdmin }`. **Mọi máy gọi được** (frontend dùng để ẩn/hiện nút). |
| `GET /api/manual-pairs` | **Chỉ đọc** danh sách cặp đã xác nhận. **Mọi máy xem được.** |
| `GET /api/admin/manual-pairs/export` | Tải bản sao lưu JSON các cặp đã xác nhận. **Chỉ IP quản trị.** |
| `POST /api/admin/manual-pair/delete` | Gỡ 1 cặp đã xác nhận (thiết bị quay lại *Chưa đối ứng*). **Chỉ IP quản trị.** |
| `GET /api/admin/diag/rbi` | Chẩn đoán báo cáo *Tháo trước lắp sau* (đếm theo từng điều kiện nới lỏng dần). **Chỉ IP quản trị.** |
| `GET /api/admin/diag/remark` | Soi **đuôi chuỗi `REMARKS`** của các dòng có `QTY_CANCELED > 0` để tìm dấu hiệu phân biệt **hủy** với **trả**: liệt kê **từ cuối cùng** và **8/12/20 ký tự cuối** hay gặp nhất kèm số lần, cộng 20 remark nguyên văn. **Chỉ đọc. Chỉ IP quản trị.** |
| `GET /api/admin/diag/rnr` | Chẩn đoán báo cáo *Tháo chưa trả US*: đếm **6 bước cộng dồn** (tháo trong kỳ → chưa trả US → `higher_par IS NULL` → có trong ROTABLES → `MUTATION > đầu kỳ` → `condition = 'US'`) để thấy điều kiện nào cắt bớt bao nhiêu dòng, kèm phân bố `condition` hiện tại của nhóm bị loại. **Chỉ đọc. Chỉ IP quản trị.** |
| `GET /api/admin/diag/dept` | Soi vì sao một **Trung tâm** lại xuất hiện dưới một **Station** khác: nêu rõ hai nhánh số liệu đang dùng **hai cách suy ra Trung tâm khác nhau** (*đã đối ứng* → `real_us1.department` → `SIGN(action_per)`; *chưa đối ứng* → `SIGN(created_b2)`), trong khi **Station luôn lấy từ `kho_ser1.station`**. Trả về 30 dòng ví dụ kèm đủ nguồn (`dept_ghi_trong_real_us1`, `dept_tu_SIGN_theo_nguoi_tra`, `station_phieu_xuat`, `station_tra_us`) và bảng đếm 2 nhánh theo từng Trung tâm. Tham số: `?department=<mã>` + các bộ lọc thường dùng. **Chỉ đọc. Chỉ IP quản trị.** |
| `GET /api/admin/diag/higher` | Soi nhóm **lắp vào cụm cao hơn**: `ketQuaTach` cho biết trước khi loại bao nhiêu, còn lại bao nhiêu, bị chuyển sang *Chi tiết TAT* bao nhiêu (kèm 5 ví dụ có giờ lắp + TAT install); `chiThaoKhongCoLap` đếm chiều ngược lại — thiết bị **bị thay ra khỏi cụm** mà không có `on_off vm='YA'`, tách theo đã / chưa trả unservice; ngoài ra liệt kê cột thật của `WO_PART_ON_OFF` và thống kê phân bố giá trị từng cột. **Chỉ đọc. Chỉ IP quản trị.** |
| `GET /api/admin/report-status` | Trạng thái báo cáo định kỳ Teams/SharePoint (lịch, kỳ, kênh đã bật). **Chỉ IP quản trị.** |
| `POST /api/admin/report-now` | Chạy báo cáo định kỳ NGAY (để test webhook/thư mục xuất). **Chỉ IP quản trị.** |
| `POST /api/admin/llm-test` | Gọi thử LLM một lần để kiểm tra kết nối. Body `{ message }` → `{ ok, reply, sent, ms, error }`. **Chỉ IP quản trị.** |

**Bảo mật trang Admin:** `/admin`, `/admin.html` và `/api/admin/*` chỉ cho phép truy cập từ **localhost** và các IP trong `ADMIN_IPS` (mặc định `10.99.89.120`). IP khác bị **từ chối (403)** kèm cảnh báo, và mọi lần truy cập (ALLOW/DENY) được ghi vào `logs/admin-access-YYYY-MM-DD.log` + cảnh báo ra console. Kiểm tra dựa trên **IP socket thật** (không tin `x-forwarded-for` → chống giả mạo). Nếu chạy sau reverse proxy, thêm IP proxy vào `ADMIN_IPS`.

Tham số query chung: `periodType=month|week|quarter|year`, `month=YYYY-MM`, `week=YYYY-MM-DD`, `quarter=YYYY-Qn` (vd `2026-Q3`), `year=YYYY`, `station`, `store`, `department`, `excludeCC=1`.
