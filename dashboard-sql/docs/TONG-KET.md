# TỔNG KẾT HỆ THỐNG DASHBOARD TAT — VAECO

Tài liệu review: chức năng, cách xử lý dữ liệu, và các rủi ro/lỗi có thể xảy ra.
Cập nhật: 10/07/2026.

---

## 1. Kiến trúc

| Thành phần | Công nghệ |
|---|---|
| Backend | Node.js + Express + `mssql` (kết nối pool) — `server.js` |
| Frontend | HTML + Tailwind CSS + Chart.js + Tabulator (CDN) — `public/` |
| Cấu hình | `.env` (không hardcode mật khẩu) |
| Chạy thử | `DEMO_MODE=true` → dữ liệu mẫu, không cần SQL Server (`demo-data.js`) |
| Nguồn dữ liệu | `NQT.dbo.kho_ser1`, `NQT.dbo.real_us1`, `NQT.dbo.on_off` (SQL Server) + `DWH_DB..STG_AMOS.SIGN` (**linked server Oracle**) |

## 2. Quy tắc xử lý dữ liệu nền tảng (đã hiệu chỉnh bằng dữ liệu thật)

### 2.1 Quy đổi thời gian AMOS → giờ VN
- `mutation` = **số ngày** kể từ epoch **1971-12-31** (xác định từ mốc neo: 08/07/2026 = AMOS 19913).
- `mutation_t` = **số millisecond** kể từ 00:00 (vd 71820341 = 19:57:00).
- Cộng **+7h** (AMOS lưu UTC). Cấu hình: `AMOS_DATE_EPOCH`, `AMOS_TZ_OFFSET_HOURS` trong `.env`.
- `del_time`, `reci_time` là datetime giờ VN — dùng trực tiếp.
- Toàn bộ nằm trong **một hàm `amosToVN()`** — sửa 1 chỗ là đổi mọi nơi.
- Hiển thị frontend đọc bằng `getUTC*` để **không bị trình duyệt cộng thêm 7h lần nữa**.
- Giá trị sentinel (năm ≤ 1901, vd `01/01/1900`) → hiển thị **trống**.

### 2.2 Xác định Trung tâm (department)
Thứ tự ưu tiên:
1. `real_us1.department` (bỏ rỗng / `UNKNOWN`);
2. Nhân viên bắt đầu bằng `PA` → Trung tâm = `PA`;
3. Tra nhân viên vào bảng `SIGN` lấy `DEPARTMENT`;
4. Mặc định `PA`.

Cột nhân viên dùng để tra theo từng bảng:
- `real_us1` → `action_per`
- `kho_ser1` → `created_b2` (riêng **TAT hoàn kho**: `created_b2` của **phiếu xuất** vm='T')
- `on_off` → `created_by`

Tra SIGN qua **LEFT JOIN bảng con `GROUP BY USER_SIGN`** — kéo về 1 lần (tránh lỗi Oracle OLE DB khi hỏi từng dòng) và không nhân bản dòng khi `USER_SIGN` trùng.

### 2.3 So sánh khóa
- `labelno`, `historyno_`, `mutation` là **cột số (float)** → so sánh **bằng trực tiếp**.
  (Bài học: bọc `RTRIM()` làm float → chuỗi 6 chữ số có nghĩa → `1042487` khớp nhầm `1042489`.)
- `voucherno` là chuỗi → được phép `RTRIM`.

### 2.4 Điều kiện lọc chung cho kho_ser1
- `vm='T'`, `voucherno LIKE 'P-%'` (xuất kho); `vm='TC'`, `'P-CA-%'` (hoàn kho).
- Bỏ qua `costcenter = 'VN-SPL'`.
- Chỉ tính `store` **MAIN** hoặc **3RD** (giống nhau ở mọi station).
- Chi tiết TAT: thêm điều kiện `receiver` ≠ rỗng.

### 2.5 Bộ lọc giao diện
- **Station**: chỉ HAN / SGN / DAD + **"Khác"** (= mọi station còn lại, `NOT IN`).
- **Kỳ**: tháng (chọn YYYY-MM) hoặc **tuần T5→T5** (thứ 5 tuần trước → thứ 5 tuần này, `[from, to)`).
- Store, Trung tâm: danh sách từ DB.
- Filter **được lưu localStorage** — mở lại trang tự áp dụng.

## 3. Chức năng từng màn hình

### 3.1 Tab Tổng quan
- **6 KPI**: TAT TB Trung tâm / TAT CUVT / TAT hoàn kho (ngày) · Thiết bị xuất kho · Chưa đối ứng · Tỷ lệ đối ứng (%).
- **4 biểu đồ**: TAT TB theo Trung tâm · Phân bổ thiết bị theo Station (HAN/SGN/DAD/Khác) · Số lượng xuất kho & trả unservice theo Trung tâm · TAT hoàn kho theo Trung tâm.
- **Bảng Chi tiết TAT**: checkbox **"Bỏ qua"** từng dòng + nút **"Tính lại TAT"** (loại item đặc biệt khỏi trung bình — chỉ tính lại card KPI đầu, có ghi chú gốc/mới) + "Đặt lại". Cột: Event Perf, PN/SN/Label, Mô tả, Receiver, Trung tâm, Nhân viên, Station, Store (filter), Pickslip (`voucherno`), Phiếu xuất (`picking_li`), Giờ xuất, Giờ trả US, TAT (ngày).

### 3.2 Các tab báo cáo (đều có tìm kiếm, filter cột, export Excel, cột Nhân viên)

| Tab | Logic | Ghi chú |
|---|---|---|
| **Trả unservice** (đầu tiên) | `real_us1` có `del_time` trong kỳ | del_staff, del_time, reci_time; không có cột Store |
| **Xuất kho chưa lắp** | kho_ser1 T không có on_off YE (khớp part+serial+label); **loại thiết bị đã return** (đã trả US hoặc đã hoàn kho) | **TAT tồn = GETDATE() − giờ xuất** |
| **Tháo chưa trả US** | on_off YA không có real_us1 (khóa `historyno_`) | |
| **Chưa đối ứng** | kho_ser1 T không có real_us1 (part+serial+voucher=voucher_s); **loại thiết bị đã hoàn kho** (P-CA cùng part/serial/label) | |
| **Tháo trước lắp sau** | Ghép theo **labelno**: lấy lần **lắp YE gần nhất TRƯỚC ngày xuất kho** và lần **tháo YA gần nhất trước lúc lắp**; chỉ lấy **ngày xuất > ngày lắp** | Hiển thị rõ PN/SN tháo vs PN/SN xuất; 2 TAT: "Xuất sau lắp" và "tháo → trả US" |
| **Other (on_ac)** | `real_us1.on_ac` ≠ rỗng (kể cả `del_time` null/sentinel) | |
| **TAT hoàn kho** | Ghép số PS: `P-CA-<PS>` ↔ `P-<PS>` + cùng labelno; TAT = giờ hoàn − giờ xuất | Trung tâm theo `created_b2` phiếu xuất |

### 3.3 Hiệu năng
- Lọc thô **sargable**: `mutation BETWEEN @fromDay AND @toDay` trước khi tính biểu thức giờ → dùng index.
- **Cache server** (TTL): dashboard/báo cáo 60s, danh mục filter 10 phút.
- **Cache frontend**: kết quả báo cáo theo (tab + filter) — đổi tab không gọi lại API; xóa khi "Áp dụng".
- `/api/dashboard` trả kèm `rows` → không chạy query nặng 2 lần.
- `TOP (@MAX_ROWS)` (mặc định 5000), gzip.
- **Khuyến nghị CREATE INDEX** trong README mục 7 (chưa chạy thì trang sẽ chậm).

## 4. RỦI RO / LỖI CÓ THỂ XẢY RA (cần review)

### Mức cao — ảnh hưởng trực tiếp số liệu
1. **MAX_ROWS + ORDER BY TAT DESC gây thiên lệch trung bình**: nếu kỳ có > 5000 dòng, chỉ 5000 dòng TAT **lớn nhất** được lấy → TAT trung bình bị **thổi phồng**. Kiểm tra: nếu bảng chi tiết đúng 5000 dòng thì đã bị cắt. Hướng xử lý: tăng `MAX_ROWS`, hoặc yêu cầu tôi tính KPI bằng `AVG()` ngay trong SQL (chính xác tuyệt đối, không phụ thuộc TOP).
2. **Epoch ngày AMOS cố định `1971-12-31`**: nếu mốc neo lệch 1 ngày, mọi giờ AMOS lệch 24h. Kiểm chứng bằng `/debug.html` → bảng `epochCalib` (cột `implied_epoch` phải ra đúng 1971-12-31 ở mọi dòng).
3. **Trung tâm mặc định 'PA'**: nhân viên không có trong SIGN và không bắt đầu 'PA' đều rơi về PA → PA có thể bị "phình" số liệu. Review: lọc Trung tâm = PA và xem cột Nhân viên có mã lạ không.
4. **Tháo trước lắp sau ghép theo labelno**: label dùng lại nhiều lần → tôi lấy sự kiện *gần nhất trước phiếu xuất*; cần đối chiếu vài ca thật với AMOS để xác nhận cách ghép.

### Mức trung bình — sai theo tình huống
5. **TAT hoàn kho ghép số PS bằng vị trí ký tự** (`SUBSTRING(voucherno, 6, ...)`): đúng với dạng chuẩn `P-CA-xxxx`; nếu có voucher dạng khác (vd `P-CA2-`) sẽ trượt.
6. **Chưa đối ứng loại "đã hoàn kho" theo part+serial+label**: nếu phiếu hoàn không cùng labelno với phiếu xuất → không loại được.
7. **TAT tồn (Xuất kho chưa lắp) dùng `GETDATE()`** của SQL Server: server phải chạy múi giờ VN, nếu không TAT lệch số giờ tương ứng.
8. **TAT CUVT loại bản ghi `reci_time < del_time`** (sentinel chưa nhận) — đúng chủ đích, nhưng cũng loại luôn bản ghi nhập sai giờ thật.
9. **Ranh giới tuần T5→T5** đang là `[thứ 5 tuần trước 00:00, thứ 5 tuần này 00:00)` — cần xác nhận đúng quy ước đơn vị.

### Mức thấp — vận hành / giao diện
10. **Cache 60s**: dữ liệu vừa nhập vào AMOS trong vòng 1 phút chưa hiện — không phải mất dữ liệu.
11. **Filter được lưu localStorage**: mở trang thấy "thiếu dữ liệu" có thể do đang áp filter cũ (kiểm tra thanh filter trước khi kết luận).
12. **"Tính lại TAT" chỉ ở client**: chỉ cập nhật card *TAT TB Trung tâm*, không ảnh hưởng biểu đồ, các KPI khác và file Excel.
13. **Bảng rỗng khi tab ẩn** (Tabulator): đã sửa (chỉ vẽ khi tab hiển thị + redraw + xóa filter tìm kiếm cũ) — nếu còn tái diễn, chụp lại kèm con số "N dòng" góc phải.
14. **Không có xác thực (auth)**: API mở cho mọi người trong mạng LAN; cần cân nhắc nếu triển khai rộng (có thể thêm đăng nhập/reverse proxy).
15. **SIGN kéo qua linked server Oracle mỗi lượt query** (đã gộp 1 lần/query + cache 60s): nếu SIGN lớn hoặc Oracle chậm, nên đồng bộ về bảng local định kỳ và đổi tên bảng trong `signJoin()`.
16. **CDN**: giao diện cần internet để tải Tailwind/Chart.js/Tabulator/SheetJS; môi trường chặn internet cần chuyển sang file cục bộ.

## 5. Công cụ chẩn đoán
- **`/debug.html`** (và `/api/debug`): kiểm tra epoch (`epochCalib`), định dạng mutation/mutation_t, phân bố `vm`, mẫu voucher, khoảng del/reci_time, số lượng bản ghi từng loại. Nên gỡ bỏ hoặc chặn khi đưa vào sử dụng chính thức.
- **DEMO_MODE**: chạy thử giao diện không cần DB.
