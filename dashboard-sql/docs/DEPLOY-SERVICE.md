# Triển khai Dashboard TAT & chạy như Windows Service

Hướng dẫn cài dashboard lên **một máy Windows** trong mạng VAECO và cho chạy
**nền như dịch vụ** (tự khởi động khi bật máy, tự chạy lại nếu lỗi) — không phải
mở CMD chạy `npm start` thủ công.

---

## A. Chuẩn bị máy đích (một lần)

1. **Cài Node.js LTS** (khuyến nghị Node 20 hoặc 22) từ nodejs.org → chọn bản
   Windows `.msi`. Cài xong mở CMD kiểm tra:
   ```cmd
   node -v
   npm -v
   ```
2. **Copy mã nguồn** thư mục `dashboard-sql` sang máy đích (qua git clone hoặc
   copy USB/mạng nội bộ). Ví dụ đặt ở `C:\apps\dashboard-sql`.
3. **Cài thư viện** (chạy trong thư mục dự án):
   ```cmd
   cd C:\apps\dashboard-sql
   npm install
   ```
   > `npm install` sẽ cài luôn `node-windows` (trong optionalDependencies) để
   > đăng ký service. Nếu mạng chặn npm registry, xem mục **F. Không có internet**.
4. **Tạo file `.env`** (copy từ `.env.example` rồi sửa):
   ```cmd
   copy .env.example .env
   notepad .env
   ```
   Sửa các mục quan trọng cho **production**:
   - `DB_SERVER`, `DB_DATABASE=NQT`, `DB_USER`, `DB_PASSWORD`, `DB_PORT=1433`
   - `DEMO_MODE=false`
   - `PORT=3000` (hoặc cổng khác)
   - `MAX_ROWS=20000`
   - `ADMIN_IPS=10.99.89.120` (IP máy quản trị được vào trang /admin)
   - (tuỳ chọn) `SIGN_CACHE=true`, `LLM_URL=` để trống nếu chưa có AI nội bộ.

---

## B. Chạy thử trước khi cài service

Luôn chạy thử bằng tay để chắc chắn cấu hình đúng:
```cmd
npm start
```
Mở trình duyệt `http://localhost:3000` (đúng PORT). Kiểm tra:
- Trang tải được, có dữ liệu (hoặc báo lỗi kết nối rõ ràng nếu sai `.env`).
- `http://localhost:3000/api/health` trả `{"status":"ok","mode":"live"}`.

Chạy tốt thì **Ctrl+C** để dừng, rồi sang bước cài service.

> Lần đầu nên chạy `docs/INDEXES.sql` trong SSMS trên database NQT để tạo index
> (tăng tốc), và đảm bảo tài khoản DB có quyền đọc `NQT` và `DWH_DB`.

---

## C. Cài chạy như Windows Service

1. Mở **CMD hoặc PowerShell với quyền Administrator**
   (chuột phải → *Run as administrator*).
2. Vào thư mục dự án và cài service:
   ```cmd
   cd C:\apps\dashboard-sql
   npm run service:install
   ```
   Script sẽ tạo service tên **`DashboardTAT`** và tự khởi động.
3. Kiểm tra: mở `services.msc` → thấy **DashboardTAT** đang *Running*, Startup
   type = *Automatic*. Hoặc bằng lệnh:
   ```cmd
   sc query DashboardTAT
   ```
4. Mở `http://localhost:3000` — dashboard đã chạy nền, kể cả sau khi **đăng xuất
   / khởi động lại máy**.

### Quản lý service
```cmd
sc stop DashboardTAT      &:: dừng
sc start DashboardTAT     &:: chạy
sc query DashboardTAT     &:: xem trạng thái
```
Hoặc dùng giao diện `services.msc`.

### Gỡ service
```cmd
:: (Administrator)
npm run service:uninstall
```

---

## D. Cập nhật code sau này

Mỗi lần sửa/cập nhật mã nguồn:
```cmd
cd C:\apps\dashboard-sql
git pull                  &:: hoặc copy đè file mới
npm install               &:: nếu có thay đổi thư viện
sc stop DashboardTAT
sc start DashboardTAT     &:: khởi động lại service để nạp code mới
```
> Sửa file trong `public/` (giao diện) thì chỉ cần **F5/Ctrl+F5** trên trình
> duyệt, không cần restart service.

---

## E. Firewall & mạng

- **Cho máy khác trong LAN truy cập:** mở cổng ứng dụng (vd 3000) chiều *Inbound*
  trong *Windows Defender Firewall* trên máy chạy service:
  ```powershell
  New-NetFirewallRule -DisplayName "Dashboard TAT 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
  ```
  Người dùng truy cập `http://<IP-may-chay-service>:3000`.
- **Kết nối tới SQL Server:** máy chạy service phải ra được `DB_SERVER:1433`
  (thường cùng LAN nên OK). Nếu SQL Server ở máy khác, mở cổng 1433 phía SQL.

---

## F. Lưu ý tài khoản chạy service

- Mặc định service chạy dưới tài khoản **LocalSystem**.
- Nếu `.env` dùng **SQL Authentication** (`DB_USER`/`DB_PASSWORD`) → LocalSystem
  chạy tốt, không cần chỉnh gì.
- Nếu dùng **Windows Authentication** để vào SQL Server → mở `services.msc` →
  chuột phải **DashboardTAT** → *Properties* → tab *Log On* → chọn *This account*
  và nhập tài khoản miền có quyền vào SQL Server.

---

## G. Xem log

- Log ứng dụng: thư mục `logs\` trong dự án
  (`access-*.log`, `chat-unknown-*.log`, `admin-access-*.log`).
- Log wrapper của service (stdout/stderr): thư mục `daemon\` do node-windows tạo
  cạnh `server.js`.

---

## H. Không có internet để `npm install` (mạng nội bộ đóng)

Cách 1 — chuẩn bị sẵn `node_modules`:
1. Trên một máy CÓ internet, chạy `npm install` trong thư mục dự án.
2. Copy cả thư mục dự án **kèm `node_modules`** sang máy đích. Không cần chạy
   `npm install` lại; vào thẳng bước **C** (cài service).

Cách 2 — dùng NSSM thay cho node-windows (không cần npm cài gì thêm):
1. Tải `nssm.exe` (bỏ vào máy đích qua USB).
2. (Administrator):
   ```cmd
   nssm install DashboardTAT "C:\Program Files\nodejs\node.exe" "C:\apps\dashboard-sql\server.js"
   nssm set DashboardTAT AppDirectory "C:\apps\dashboard-sql"
   nssm set DashboardTAT Start SERVICE_AUTO_START
   nssm start DashboardTAT
   ```

---

## I. Checklist trước khi bàn giao

- [ ] `.env`: `DEMO_MODE=false`, DB đúng, `ADMIN_IPS` đúng máy quản trị.
- [ ] `npm start` chạy thử OK, `/api/health` = live.
- [ ] Đã chạy `docs/INDEXES.sql` trên NQT.
- [ ] Service `DashboardTAT` = Running, Startup = Automatic.
- [ ] Mở cổng firewall cho LAN; người dùng vào được `http://<IP>:<PORT>`.
- [ ] Khởi động lại máy → service tự lên.
- [ ] Trang `/admin` chỉ vào được từ IP quản trị.
