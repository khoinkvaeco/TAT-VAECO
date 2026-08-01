# Hướng dẫn triển khai báo cáo TAT lên SharePoint Online & Teams

> Dành cho người **chưa từng dùng SharePoint/Teams**. Làm tuần tự từ trên xuống,
> mỗi bước đều ghi rõ bấm vào đâu. Tổng thời gian lần đầu: khoảng 30–45 phút.

---

## 0. Bức tranh tổng thể — cái gì chạy ở đâu

```
┌─ MẠNG CÔNG TY (LAN) ──────────────────────────────┐      ┌─ CLOUD MICROSOFT 365 ─────────────┐
│                                                    │      │                                    │
│  SQL Server (NQT/AMOS)                             │      │  Kênh Teams  ◄── thẻ KPI mỗi sáng │
│        ▲                                           │      │                                    │
│  Dashboard TAT (Node.js, Windows service)  ────────┼──────┼─► Thư viện SharePoint ◄── file CSV │
│  http://<ip-server>:3000                           │      │   (qua thư mục OneDrive sync)      │
│                                                    │      │                                    │
└────────────────────────────────────────────────────┘      └────────────────────────────────────┘
```

- **Dashboard đầy đủ** (biểu đồ, tra cứu, chatbox) chỉ xem được **trong mạng công ty** — dữ liệu thô không bao giờ rời LAN.
- Thứ được đẩy lên cloud M365 là **báo cáo tổng hợp**: 1 thẻ KPI vào kênh Teams + 2 file CSV vào SharePoint, theo lịch (mặc định 6h30 sáng thứ 2, cho tuần vừa kết thúc).
- Người ở **ngoài công ty** (đi công tác, ở nhà) xem thẻ KPI trên app Teams điện thoại hoặc mở file CSV trong SharePoint — không cần VPN.

**Điều kiện cần trước khi bắt đầu:**

| # | Điều kiện | Ghi chú |
|---|-----------|---------|
| 1 | Tài khoản Microsoft 365 công ty (đăng nhập được Teams + SharePoint) | Hỏi IT nếu chưa có |
| 2 | Dashboard TAT đang chạy trên server (Windows service) | Đã làm ở `DEPLOY-SERVICE.md` |
| 3 | Server có ra được Internet (để gọi webhook Teams) | Nếu server bị chặn Internet → chỉ dùng được kênh CSV/OneDrive |
| 4 | Quyền sửa file `.env` trên server + restart service | |

---

## PHẦN A — Tạo kênh Teams nhận thẻ KPI (15 phút)

### A1. Tạo (hoặc chọn) kênh Teams

1. Mở ứng dụng **Microsoft Teams** → thanh trái chọn **Teams**.
2. Chọn team của phòng/đơn vị (VD *Phòng Kỹ thuật*). Nếu chưa có team, bấm **Join or create a team → Create team** và mời các thành viên cần xem báo cáo.
3. Bấm dấu **⋯** cạnh tên team → **Add channel**:
   - Channel name: `Báo cáo TAT`
   - Privacy: **Standard** (mọi người trong team đều xem được)
   - Bấm **Create**.

### A2. Tạo Workflow webhook (nơi dashboard "gõ cửa" để đăng bài)

> ⚠️ **Không dùng** mục *Connectors → Incoming Webhook* (kiểu cũ) — Microsoft đã
> khai tử. Phải dùng **Workflows** như dưới đây.

1. Đưa chuột lên kênh **Báo cáo TAT** → bấm dấu **⋯** → chọn **Workflows**.
   - *Không thấy mục Workflows?* → xem mục [Xử lý sự cố](#phần-e--xử-lý-sự-cố), lỗi E1.
2. Trong ô tìm kiếm gõ `webhook` → chọn mẫu **"Post to a channel when a webhook request is received"**.
3. Bấm **Next**. Kiểm tra đúng Team + Channel (Báo cáo TAT) → bấm **Add workflow** (hoặc **Create**).
4. Màn hình hiện **một đường link dài** dạng:
   `https://prod-xx.southeastasia.logic.azure.com/workflows/abc.../triggers/manual/paths/invoke?...`
   → bấm **Copy** và **lưu lại cẩn thận** (dán tạm vào Notepad). Bấm **Done**.

> 🔒 Link này ai có cũng đăng bài được vào kênh — coi nó như mật khẩu:
> chỉ dán vào `.env` trên server, không gửi qua email/chat công khai.

### A3. Khai báo webhook cho dashboard

Trên **server chạy dashboard**, mở file `.env` (cùng thư mục `server.js`), thêm/sửa:

```ini
TEAMS_WEBHOOK_URL=https://prod-xx.southeastasia.logic.azure.com/workflows/... (dán nguyên vẹn link đã copy)
REPORT_SCHEDULE=T2 06:30
REPORT_PERIOD=week
```

Ý nghĩa:
- `REPORT_SCHEDULE` — lịch gửi. `T2 06:30` = 6h30 sáng thứ Hai. Có thể ghi `T2,T5 06:30` (thứ 2 + thứ 5), `CN 18:00` (chủ nhật 18h). Chấp nhận `T2..T7`, `CN` hoặc `MON..SUN`.
- `REPORT_PERIOD` — `week` = báo cáo **tuần vừa kết thúc** (T2→CN tuần trước); `month` = **tháng vừa kết thúc** (khi đó nên đặt lịch ngày đầu tháng).

**Restart service** để nhận cấu hình mới (PowerShell, quyền Administrator):

```powershell
Restart-Service DashboardTAT
# hoặc: services.msc → DashboardTAT → Restart
```

### A4. Test ngay — không chờ đến thứ 2

1. Từ **máy quản trị** (máy 10.99.89.120 hoặc ngay trên server), mở trang **Admin**: `http://<ip-server>:3000/admin`.
2. Panel **📤 Báo cáo định kỳ** phải hiện `● BẬT — lịch: T2 06:30 · kỳ: week · Teams ✔`.
3. Bấm nút **📨 Gửi báo cáo ngay**.
4. Mở kênh Teams **Báo cáo TAT** → trong vòng ~10 giây phải thấy thẻ:

   > **📊 Báo cáo TAT — VAECO**
   > Tuần 20/07–26/07/2026
   > TAT install: 0.8 ngày (▼ 12% tốt hơn kỳ trước) …

Không thấy thẻ? → [Xử lý sự cố](#phần-e--xử-lý-sự-cố), lỗi E2/E3.

---

## PHẦN B — Đẩy file CSV lên thư viện SharePoint (15 phút)

Cơ chế: server ghi file vào một **thư mục đang được OneDrive đồng bộ** với thư viện
SharePoint → OneDrive tự upload → mọi người mở SharePoint (hoặc Teams) là thấy file.

### B1. Mở site SharePoint của team

Cách dễ nhất: trong Teams, vào kênh **Báo cáo TAT** → tab **Files** → bấm **⋯ → Open in SharePoint**.
Trình duyệt mở ra chính là **site SharePoint** của team đó (mỗi team Teams luôn có sẵn 1 site).

### B2. Bật đồng bộ (Sync) trên SERVER chạy dashboard

> Làm trên **server**, đăng nhập Windows bằng tài khoản mà service đang chạy
> (hoặc tài khoản luôn đăng nhập trên server đó).

1. Trên server, mở trình duyệt → vào site SharePoint (bước B1) → menu trái chọn **Documents**.
2. (Nên làm) Tạo thư mục riêng: **+ New → Folder** → đặt tên `Bao cao TAT` → mở thư mục đó.
3. Bấm nút **Sync** trên thanh công cụ. Trình duyệt sẽ xin phép mở **OneDrive** → đồng ý, đăng nhập tài khoản M365 nếu được hỏi.
4. Sau khi sync xong, trên server xuất hiện thư mục local dạng:
   ```
   C:\Users\<TênUser>\<Tên công ty>\<Tên team> - Documents\Bao cao TAT
   ```
   (mở File Explorer, mục có **biểu tượng tòa nhà màu xanh** ở cột trái). Copy **đường dẫn đầy đủ** của thư mục này (bấm vào thanh địa chỉ của Explorer).

### B3. Khai báo thư mục cho dashboard

Thêm vào `.env`:

```ini
REPORT_EXPORT_DIR=C:\Users\<TênUser>\<Tên công ty>\<Tên team> - Documents\Bao cao TAT
```

Restart service (`Restart-Service DashboardTAT`).

### B4. Test

1. Trang Admin → **📨 Gửi báo cáo ngay**. Kết quả phải hiện `Files: ...TAT-KPI_tuan_....csv, ...TAT-chitiet_tuan_....csv`.
2. Mở File Explorer trên server: 2 file CSV nằm trong thư mục, biểu tượng chuyển thành **✓ xanh** khi đã upload xong.
3. Mở SharePoint (hoặc Teams → kênh → Files) từ **máy khác / điện thoại**: thấy 2 file. Bấm mở `TAT-KPI_...csv` — SharePoint hiển thị ngay dạng bảng; muốn xem đẹp hơn thì **Open in Excel**.

> File CSV đã có sẵn BOM UTF-8 nên mở bằng Excel **không bị lỗi font tiếng Việt**.

### B5. Phân quyền ai được xem

- Mặc định: **mọi thành viên của team** Teams đều xem được (họ là member của site SharePoint).
- Muốn thêm người ngoài team: SharePoint → Documents → chuột phải thư mục `Bao cao TAT` → **Manage access → Share** → nhập email nội bộ → quyền **Can view**.
- **Không** bật "Anyone with the link" (chia sẻ vô danh) cho dữ liệu này.

---

## PHẦN C — Gắn link dashboard vào Teams & SharePoint (5 phút, nên làm)

Để mọi người trong mạng công ty mở dashboard đầy đủ chỉ bằng 1 cú bấm:

**Trong Teams:** mở kênh `Báo cáo TAT` → bấm **+** (Add a tab) trên thanh tab → chọn **Website** → Name: `Dashboard TAT`, URL: `http://<ip-server>:3000` → **Save**.
> Teams có thể chỉ mở ra trình duyệt (không nhúng trong khung Teams) vì dashboard chạy HTTP — vẫn dùng tốt. Muốn nhúng hẳn vào Teams thì cần cấp HTTPS cho dashboard (việc của IT, làm sau được).

**Trong SharePoint:** site → **Edit** menu trái (hoặc Settings ⚙ → Site contents → Navigation) → **+ Add link** → dán `http://<ip-server>:3000`, tên `Dashboard TAT (mở trong mạng công ty)`.

> Nhớ ghi chú cho người dùng: link này **chỉ mở được khi máy đang ở mạng công ty**. Ở ngoài thì xem thẻ KPI Teams / file CSV.

---

## PHẦN D — Vận hành hằng ngày

| Việc | Ai làm | Ở đâu |
|------|--------|-------|
| Xem thẻ KPI tuần | Mọi người | Kênh Teams `Báo cáo TAT` (điện thoại/máy tính, mọi nơi) |
| Xem chi tiết từng thiết bị của kỳ đã chốt | Mọi người | SharePoint → `Bao cao TAT` → file `TAT-chitiet_...csv` |
| Phân tích tương tác (lọc, drill-down, tra cứu, chatbox) | Mọi người **trong mạng công ty** | `http://<ip-server>:3000` |
| Gửi lại báo cáo / test | Quản trị | `http://<ip-server>:3000/admin` → 📨 Gửi báo cáo ngay |
| Kiểm tra lịch sử đã gửi gì | Quản trị | File `logs/report-YYYY-MM-DD.log` trên server |
| Tắt hẳn tính năng | Quản trị | Xóa `TEAMS_WEBHOOK_URL` và `REPORT_EXPORT_DIR` trong `.env` → restart service |

Lịch tự động: đến giờ trong `REPORT_SCHEDULE`, service tự gửi — **không cần ai bấm gì**. Nếu server tắt đúng thời điểm đó thì kỳ đó không gửi (bấm gửi tay bù); service có chống gửi trùng trong cùng 1 ngày.

---

## PHẦN E — Xử lý sự cố

| # | Hiện tượng | Nguyên nhân & cách xử lý |
|---|-----------|--------------------------|
| E1 | Kênh Teams không có mục **Workflows** | IT đang tắt Power Automate cho tổ chức, hoặc bản Teams cũ. → Nhờ IT bật *Power Automate / Workflows app* trong Teams admin center; hoặc tạo workflow tại `https://make.powerautomate.com` → Create → *Post to a channel when a webhook request is received*. |
| E2 | Bấm **Gửi ngay**, admin báo `Teams: HTTP 401/403` | URL webhook dán thiếu/thừa ký tự, hoặc workflow bị tắt. → Copy lại URL (Teams → ⋯ kênh → Workflows → workflow → Edit → bước trigger có nút xem URL), dán lại `.env`, restart. |
| E3 | `Teams: loi: fetch failed / ETIMEDOUT` | Server không ra được Internet (proxy/firewall). → Nhờ IT mở cho server gọi HTTPS ra `*.logic.azure.com`; nếu công ty bắt buộc proxy thì báo tôi để bổ sung cấu hình proxy cho service. |
| E4 | Thẻ hiện trong Teams nhưng **không có file CSV** | `REPORT_EXPORT_DIR` sai đường dẫn, hoặc tài khoản chạy service không ghi được vào thư mục. → Kiểm tra kết quả nút Gửi ngay (có dòng `CSV lỗi: ...`); sửa đường dẫn cho khớp File Explorer; đảm bảo service chạy bằng đúng user đã đăng nhập OneDrive. |
| E5 | File CSV nằm trong thư mục trên server nhưng **không lên SharePoint** | OneDrive chưa chạy/chưa đăng nhập trên server. → Mở OneDrive (icon đám mây cạnh đồng hồ), đăng nhập lại; icon file phải chuyển ✓ xanh. OneDrive phải luôn chạy cùng Windows (Settings → Start OneDrive automatically). |
| E6 | Thứ 2 không thấy báo cáo tự động (bấm tay thì được) | Xem `REPORT_SCHEDULE` có đúng định dạng không (log khởi động sẽ cảnh báo nếu sai); giờ trên server có đúng múi giờ VN không; service có đang chạy lúc 6h30 không. |
| E7 | Muốn đổi giờ/kỳ gửi | Sửa `REPORT_SCHEDULE` / `REPORT_PERIOD` trong `.env` → restart service. |

---

## PHẦN F — An toàn dữ liệu (đọc 1 lần)

- Thứ rời khỏi mạng công ty: **chỉ số tổng hợp KPI** (thẻ Teams) và **bảng chi tiết TAT của kỳ báo cáo** (CSV). **Không** có mật khẩu, không mở cổng nào vào SQL Server, không ai từ Internet truy cập ngược được vào dashboard.
- Mọi lần gửi được ghi vết tại `logs/report-YYYY-MM-DD.log` (giờ, kênh, kỳ, kết quả).
- URL webhook = "chìa khóa đăng bài vào kênh": chỉ lưu trong `.env` (file này không commit git). Nếu nghi lộ → vào Workflows xóa workflow cũ, tạo cái mới, thay URL.
- Muốn dừng chia sẻ ra cloud bất cứ lúc nào: xóa 2 dòng cấu hình trong `.env`, restart — dashboard nội bộ vẫn chạy bình thường.
