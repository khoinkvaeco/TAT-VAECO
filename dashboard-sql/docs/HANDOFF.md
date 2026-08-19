# HANDOFF — bàn giao cho phiên làm việc mới

> **Đọc tệp này TRƯỚC**, rồi mới đọc `README.md`. README rất dài (~1.900 dòng) và là tài liệu
> tra cứu; tệp này là bản đồ để biết **phải đọc mục nào**.
>
> Cập nhật lần cuối: **19/08/2026** · nhánh `claude/web-dashboard-sql-server-5rhzeg` · commit `e8003a7`

---

## 1. Chương trình này là gì

Dashboard web báo cáo **TAT (Turn-Around-Time)** cho **VAECO** — quản lý vật tư khí tài hàng không.
Node.js + Express, không framework frontend (HTML + `script.js` thuần + Tabulator + Chart.js).

Dữ liệu đọc từ **SQL Server**, hai nguồn:

| Nguồn | Cách truy cập | Đặc điểm |
|---|---|---|
| `[NQT].[dbo].*` (`kho_ser1`, `real_us1`, `on_off`) | bảng **local** | nhanh, index được — xem `docs/INDEXES.sql` |
| `[DWH_DB]..[STG_AMOS].*` (`HISTORY`, `PICKSLIP_*`, `SIGN`, `WO_*`) | **LINKED SERVER** sang AMOS (Oracle) | **rất chậm** nếu viết sai — đây là nguồn của hầu hết mọi sự cố hiệu năng |

Thư mục làm việc: `/home/user/TAT-VAECO/dashboard-sql`

---

## 2. RÀNG BUỘC BẤT DI BẤT DỊCH (người dùng đã nêu rõ, không được vi phạm)

1. **Không tự suy diễn.** Chưa rõ thì **hỏi trước khi làm** — đã bị nhắc nhiều lần.
2. **Không gửi dữ liệu ra ngoài phạm vi công ty.** Chatbot phải chạy nội bộ. Đây là **điều cấm**.
3. **App CHỈ được tạo/ghi vào bảng tiền tố `TAT_`** (và `SIGN_CACHE` có sẵn). **Tuyệt đối không**
   sửa bảng khác của SQL Server. → `tools/sqlcheck.js` LUẬT 4 canh việc này.
4. **Trang `/admin` chỉ vào được từ localhost hoặc IP `10.99.89.120`**, có cảnh báo khi IP khác truy cập.
5. Tệp cấu hình JSON nằm **trên máy backend**; chỉ máy quản trị sửa được, máy khác chỉ xem.

### ⚠️ Việc còn treo về bảo mật
Người dùng từng gửi `AMOS_GUIHAN.py` có **mật khẩu SQL Server để trần** (`tranvanhung` /
`hungtv@2024` / `10.99.150.201`). Đã khuyên **đổi mật khẩu + dùng biến môi trường**, và **cố ý
KHÔNG commit tệp đó**. Chưa rõ người dùng đã đổi chưa — nếu có dịp thì nhắc lại.

---

## 3. Cách làm việc mà người dùng mong đợi

* **Viết chú thích bằng tiếng Việt không dấu** trong mã nguồn; **tiếng Việt có dấu** trong README,
  giao diện và thông báo lỗi.
* **Chú thích giải thích VÌ SAO**, không mô tả lại code. Mọi quyết định lạ đều phải có lý do kèm
  theo, tốt nhất là **con số đo được**.
* **Mỗi lần sửa lỗi phải kèm một bài kiểm tra CHỨNG MINH được nó bắt đúng lỗi đó** — gài lại bug,
  chạy, xác nhận `✖`, rồi khôi phục. Đây là kỷ luật đã được lặp lại suốt dự án.
* Trả lời bằng **tiếng Việt**.
* Xong việc thì **commit + push** lên nhánh `claude/web-dashboard-sql-server-5rhzeg`.

---

## 4. Chạy và kiểm thử

```bash
cd /home/user/TAT-VAECO/dashboard-sql
npm run smoke          # 12 bộ, ~300 trường hợp — PHẢI đạt trước khi commit
npm run build:assets   # dựng lại tailwind.css/vendor khi đổi HTML/CSS (smoke có kiểm)
DEMO_MODE=true PORT=3000 LGC_GATE=true node server.js   # chạy thử không cần SQL Server
```

| Bộ kiểm | Canh điều gì |
|---|---|
| `smoke.js` | mọi endpoint dựng câu SQL không lỗi lập trình |
| `sqlcheck.js` | soi **CHÍNH câu SQL thật** (mssql giả) — 8 luật, xem §5 |
| `sqlfilecheck.js` | `docs/INDEXES.sql` chạy lại được, không index thừa |
| `gatecheck.js` | cổng đăng nhập **thật sự chặn** (31 ca) |
| `loadcheck.js` · `snapcheck.js` | gộp request + hàng đợi · bản lưu KPI tháng |
| `chatcheck.js` · `wpcheck.js` | chatbot (55 câu) · trang `/wp` (30 phép đổi đơn vị) |
| `kpicheck.js` | bảng KPI theo nhân viên khớp số liệu |
| `scancheck.js` | mở file scan + tra cứu chứng từ **an toàn** (36 ca) |
| `admincheck.js` | mục tiêu KPI · tài khoản LGC · **các đẳng thức giữa thẻ KPI** (41 ca) |

> ⚠️ **`DEMO_MODE` không chạm vào SQL thật.** Đã từng có lỗi lọt lên sản xuất vì mọi bài kiểm
> chạy ở demo — nơi `demo-data.js` **luôn có đủ** cột — trong khi câu SQL thật thiếu cột.
> Đó là lý do `sqlcheck.js` tồn tại. **Đừng bao giờ tin một bài kiểm chỉ chạy ở demo.**

---

## 5. Tám LUẬT của `sqlcheck.js` — mỗi luật sinh ra từ một sự cố THẬT

| Luật | Cấm điều gì | Sự cố gốc |
|---|---|---|
| 1 | subquery bên trong hàm gộp | `Msg 130`, vỡ tab Receiving |
| 2 | `APPLY` vào bảng linked server | mỗi dòng một lượt gọi mạng |
| 3 | hàm bọc quanh cột trong `WHERE` gửi xuống linked server *(chỉ cảnh báo)* | đo thật: **1.096 ms → 22.806 ms**, chậm 21 lần |
| 4 | ghi vào bảng không phải của app | ràng buộc §2.3 |
| 5 | câu SQL thiếu cột mà Node/giao diện đọc | lỗi **đã lọt lên sản xuất** |
| 6 | câu kéo `#hraw` lọc trên **hai** cột ngày | quét cả bảng `HISTORY` → chạy rất lâu và hỏng |
| 7 | áp bộ lọc Station/Kho **thẳng vào `real_us1`** | thẻ KPI hiện **2/2** thay vì 635/636 |
| 8 | Receiving kéo lại `#ps` dù tab xuất kho vừa chạy | lãng phí lượt hỏi AMOS nặng nhất |

> ⚠️ **Thứ tự `ENDPOINTS` trong `sqlcheck.js` là một phần của bài kiểm.** Ba dòng
> `pickslip → receiving → receiving?nocache=1` **không được đổi**: đặt `?nocache=1` lên trước thì
> chính nó nạp cache, LUẬT 8 mất tác dụng hoàn toàn. **Đã dính đúng lỗi đó một lần.**

---

## 6. Những cái BẪY đã trả giá — đừng lặp lại

| Bẫy | Chi tiết | Mục README |
|---|---|---|
| **HAI con số TAT khác nhau** | `tatTotalAvg` (3 chặng, **bỏ qua thời gian trên tàu**) ≠ `tat_days` (xuất kho → trả US, **chặng đặt mục tiêu 2 ngày**). Hai thẻ cạnh nhau nhìn như mâu thuẫn. | §7m |
| **`doiMk` = “CÒN PHẢI đổi”**, không phải “đã đổi” | Viết `if (!ai || !ai.doiMk)` là **lật ngược cổng 180°** | §7q |
| **`Number(null) === 0`** | phải loại `null/undefined/''` **trước** `Number()`, nếu không sẽ bịa ra delta “▲ 36 so tháng trước” khi không có kỳ trước | §7k |
| **Bộ lọc lấy giá trị từ bảng A, áp vào bảng B** | ô lọc Kho dựng từ `kho_ser1.store`, đem lọc `real_us1.store` → cắt sạch, **không báo lỗi** | §7p |
| **Hai cột ngày trong một `OR`** gửi xuống linked server | AMOS không dùng được chỉ mục → quét cả bảng | §7o |
| **Tabulator `responsiveLayout:'collapse'`** | **bắt buộc** phải có cột `formatter:'responsiveCollapse'`, nếu không cột bị ẩn mà không có cách mở | — |
| **`tailwind.css` dựng sẵn** | thêm lớp tiện ích mới phải chạy `npm run build:assets` | §7c |
| **Dữ liệu demo phải tuân quan hệ của dữ liệu thật** | demo từng sinh “80 đã nhận / 50 đã giao” — chuyện không thể xảy ra; bài kiểm vì thế vô nghĩa | §7p |
| **AMOS dùng BA đơn vị thời gian** | `PICKSLIP_HEADER.BOOKING_TIME` = **phút** · `MUTATION_TIME` = **mili giây** · `WO_TEXT_ACTION.ACTION_TIME` = **phút** | §7j |
| `pkill -f "node server.js"` trả exit 144 | vô hại, nhớ tách riêng khỏi lệnh khác | — |

---

## 7. Kiến trúc — chỗ nào làm gì

```
server.js      (~8.400 dòng) toàn bộ backend: truy vấn, API, cổng đăng nhập, chẩn đoán
auth-lgc.js    xác thực (mã NV + mật khẩu, scrypt), bảng TAT_USER
chatbot.js     chatbot nội bộ (KHÔNG gửi dữ liệu ra ngoài)
demo-data.js   dữ liệu mẫu cho DEMO_MODE — phải TUÂN quan hệ của dữ liệu thật
wp-validator.js  rà soát hồ sơ bảo dưỡng (/wp)
public/        index.html · script.js · style.css · admin.html · lgc-login.html · wp.*
tools/         12 bộ kiểm tra (xem §4)
docs/          INDEXES.sql · QUERIES.sql · TEST-*.sql · HANDOFF.md (tệp này)
data/          JSON trên máy backend: scan-folders.json · kpi-targets.json · lgc-secret.txt
```

### Phân quyền — HAI mức, đừng lẫn lộn
| Mức | Chặn gì | Ai qua được |
|---|---|---|
| 1 — **Đăng nhập** | **toàn bộ** chương trình, kể cả dashboard | **mọi** nhân viên có mã trong `SIGN` |
| 2 — **Trung tâm** | riêng nhóm **LGC** + file scan + tra cứu chứng từ | chỉ **CUVT** (`DEPTS_LGC`) |

Cả hai nằm trong `lgcGuard`. `/admin` có **cổng riêng theo IP** (`adminGuard`).

### Ba tệp cấu hình trong `data/`
`scan-folders.json` (thư mục PDF, 3 loại × 4 station) · `kpi-targets.json` (mục tiêu TAT, mặc định
**2 ngày**) · `lgc-secret.txt` (khoá ký cookie — mất là mọi người phải đăng nhập lại).

---

## 8. Trạng thái hiện tại + việc còn treo

### Vừa xong (5 commit gần nhất)
`e8003a7` tab Tra cứu chứng từ · bỏ dò lại schema · giờ hoàn thành · Receiving dùng lại `#ps`
`17df033` đăng nhập cho cả chương trình · LGC về làm một tab · thanh tab dính · gom thẻ KPI
`34c088e` sửa bộ lọc Kho/Station áp nhầm vào `real_us1`
`1d39d58` Receiving kéo như ban đầu, ghép return từ phần phiếu xuất + VM `ES`
`514bda2` chẩn đoán số dòng return bị bộ lọc `CONDITION` cắt

### ❗ Việc người dùng cần làm trên máy thật
1. Vào `/admin` điền đường dẫn cột **Chứng chỉ nhập kho** — để trống thì tab tra cứu không dùng
   được cho loại đó.
2. Chạy `docs/INDEXES.sql` bản mới (nó **tự dọn** index thừa của bản cũ).
3. Từ bản `17df033`, **mọi người phải đăng nhập**. Lần đầu: mật khẩu = **mã nhân viên VIẾT HOA**,
   bắt buộc đổi ngay. Quên/khoá → panel 🔑 *Tài khoản LGC* ở `/admin`.

### ❓ Câu hỏi đang chờ người dùng trả lời
* **`VM = 'RN'`** (42 dòng / 15 phiếu, số phiếu dạng `P-CA-…`) có phải phiếu trả không? Đã thêm
  `ES` theo yêu cầu, **chưa** thêm `RN` vì người dùng không nhắc.
* Ngưỡng **“quá hạn”** cho biểu đồ *Aging tồn đọng* — hiện lấy từ `kpi-targets.json`.
* Có bật **cảnh báo tự động qua Teams/email** không? Khung báo cáo định kỳ đã có nhưng **chưa cấu hình**.
* `HISTORY.CREATED_BY` có đúng là cột inspector không — **chưa bao giờ được xác nhận**.

---

## 9. Nghiệp vụ — những định nghĩa dễ hiểu sai nhất

* **CANCEL** = thủ kho huỷ khi người nhận **không lấy**; hàng **chưa ra khỏi kho** → inspector
  **không** có việc → **không** tính vào Receiving.
* **RETURN** = người nhận **đã lấy ra rồi** không dùng (hoặc không dùng hết) nên mang trả lại →
  inspector **phải kiểm như một thao tác nhập hàng** → **có** tính vào Receiving.
* **Phiếu trả** nhận biết bằng `VM_PHIEU_TRA = ['EA','TC','ES']` — **một hằng số duy nhất** cho cả
  chương trình.
* Dòng RETURN của tab Receiving lấy từ **phần phiếu xuất** → là *“phiếu trả của các **phiếu xuất**
  trong kỳ”*, **không** phải *“phiếu trả **phát sinh** trong kỳ”*. Cố ý — để hai tab luôn khớp.
* **Trả US** = `real_us1.del_time` · **Nhận US** = `real_us1.reci_time`. Nhận **luôn ≤** Trả.
* **Station/Kho LUÔN lấy từ `kho_ser1`** (tức là từ **phiếu xuất**) — quy tắc của cả dashboard.
