/* ============================================================================
   INDEXES.sql — Index tăng tốc cho Dashboard TAT (VAECO)
   ============================================================================
   Chạy MỘT lần trong SSMS trên database [NQT]. Nên chạy NGOÀI GIỜ cao điểm:
   bảng lớn có thể mất vài phút mỗi index. App vẫn chạy bình thường khi chưa có
   index — chỉ chậm hơn.

   ── TẠO INDEX **KHÔNG THAY ĐỔI DỮ LIỆU** ───────────────────────────────────
     · Không thêm/bớt/sửa một dòng dữ liệu nào.
     · Không thêm/bớt/đổi tên cột; cấu trúc bảng giữ nguyên.
     · Kết quả truy vấn trước và sau khi tạo index GIỐNG HỆT NHAU — chỉ NHANH hơn.
     · Index là cấu trúc tra cứu riêng bên cạnh bảng (như mục lục của quyển sách).

   ── ĐÁNH ĐỔI ───────────────────────────────────────────────────────────────
     · Tốn thêm dung lượng đĩa (thường 10–30% kích thước bảng cho mỗi index).
     · Ghi (INSERT/UPDATE) chậm hơn một chút vì phải cập nhật cả index.
     · Lúc TẠO index bảng bị KHOÁ → chạy ngoài giờ cao điểm.

   ── GỠ BỎ bất cứ lúc nào (cũng không mất dữ liệu) ──────────────────────────
     DROP INDEX [tên_index] ON [NQT].[dbo].[tên_bảng];

   ── NGUYÊN TẮC CHỌN INDEX (bám theo query thật trong server.js) ────────────
     kho_ser1   : lọc kỳ theo (vm, mutation); join (labelno, voucherno);
                  tra TC theo voucherno và theo (partno, serialno, labelno);
                  ⚠️ lọc Station/Kho của các báo cáo real_us1 đi QUA bảng này.
     real_us1   : join (labelno, voucher_s); lọc kỳ theo del_time; tra
                  theo serialno_o cho báo cáo đối ứng thủ công.
     on_off     : YE/YA theo (labelno, vm); YA theo (historyno_, vm);
                  chuỗi recertify CI theo (psn, orderno, vm).

   ── BẢNG DO APP TỰ TẠO — KHÔNG cần chạy gì ở đây ───────────────────────────
     [NQT].[dbo].[SIGN_CACHE]      cache bảng SIGN (app tự tạo + tự đánh index)
     [NQT].[dbo].[TAT_USER]        tài khoản đăng nhập (PK = ma_nv)
     [NQT].[dbo].[TAT_KPI_THANG]   bản lưu KPI theo tháng (PK 3 cột)
     ⚠️ App CHỈ được tạo/ghi vào bảng tiền tố TAT_ và SIGN_CACHE — xem README
        §7h. Có bài kiểm tự động canh điều này (tools/sqlcheck.js, LUẬT 4).

   ⚠️ TẤT CẢ lệnh dưới đây đều có IF NOT EXISTS → chạy lại nhiều lần không sao.
   ============================================================================ */
USE [NQT];
GO

------------------------------------------------------------------------------
-- 1. kho_ser1
------------------------------------------------------------------------------
-- Lọc kỳ báo cáo: WHERE vm='T' AND mutation BETWEEN @fromDay AND @toDay
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_kho_ser1_vm_mutation' AND object_id = OBJECT_ID('dbo.kho_ser1'))
  CREATE INDEX [IX_kho_ser1_vm_mutation]
  ON [dbo].[kho_ser1] ([vm], [mutation])
  INCLUDE ([voucherno], [labelno], [mutation_t], [store], [station], [costcenter], [condition], [receiver], [created_b2]);
GO

-- Join đối ứng: kho_ser1(labelno, voucherno) = real_us1(labelno, voucher_s)
-- + dedup "phiếu xuất gần nhất" (k2 cùng labelno+voucherno)
--
-- ⚠️ [station] và [store] nằm trong INCLUDE là CÓ CHỦ ĐÍCH (thêm 19/08/2026).
--    Bộ lọc Station/Kho của TAT CUVT và Trả unservice đi qua mệnh đề
--        EXISTS (SELECT 1 FROM kho_ser1 kx
--                WHERE kx.vm='T' AND kx.labelno=r.labelno
--                  AND kx.voucherno=r.voucher_s AND kx.station IN (…))
--    (xem khoTheoPhieuXuatClause trong server.js, README §7p). Thiếu hai cột
--    này thì mỗi dòng phải quay về bảng gốc lấy thêm — chậm hẳn.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_kho_ser1_label_voucher' AND object_id = OBJECT_ID('dbo.kho_ser1'))
  CREATE INDEX [IX_kho_ser1_label_voucher]
  ON [dbo].[kho_ser1] ([labelno], [voucherno])
  INCLUDE ([vm], [mutation], [mutation_t], [station], [store]);
GO

-- Tra cứu hoàn kho / TRANSFER CANCELLED theo voucher (TC 'P-CA-%')
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_kho_ser1_voucherno' AND object_id = OBJECT_ID('dbo.kho_ser1'))
  CREATE INDEX [IX_kho_ser1_voucherno]
  ON [dbo].[kho_ser1] ([voucherno])
  INCLUDE ([vm], [labelno], [partno], [serialno]);
GO

-- Tra cứu hoàn kho theo thiết bị (partno, serialno, labelno)
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_kho_ser1_part_serial_label' AND object_id = OBJECT_ID('dbo.kho_ser1'))
  CREATE INDEX [IX_kho_ser1_part_serial_label]
  ON [dbo].[kho_ser1] ([partno], [serialno], [labelno])
  INCLUDE ([vm], [voucherno]);
GO

-- Ghép cặp đối ứng THỦ CÔNG theo EVENT (WO)
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_kho_ser1_eventperf' AND object_id = OBJECT_ID('dbo.kho_ser1'))
  CREATE INDEX [IX_kho_ser1_eventperf]
  ON [dbo].[kho_ser1] ([event_perf]);
GO

------------------------------------------------------------------------------
-- 2. real_us1
------------------------------------------------------------------------------
-- Join đối ứng từ phía kho_ser1 + dedup dòng trả (r3 cùng labelno+voucher_s)
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_real_us1_label_voucher' AND object_id = OBJECT_ID('dbo.real_us1'))
  CREATE INDEX [IX_real_us1_label_voucher]
  ON [dbo].[real_us1] ([labelno], [voucher_s])
  INCLUDE ([del_time], [reci_time], [historyno_]);
GO

-- Lọc kỳ báo cáo theo del_time. MỘT index duy nhất phục vụ CẢ BA việc:
--   · tab Trả unservice          · TAT CUVT / đếm Nhận US – Trả US
--   · nguồn [4] của đối ứng thủ công (đọc ghi chú [on_ac])
-- ⚠️ Trước đây có thêm IX_real_us1_onac_deltime cũng khoá theo [del_time] —
--    THỪA (hai index cùng cột khoá), chỉ tốn đĩa và làm chậm ghi. Đã gộp
--    [on_ac], [partno_off], [serialno_o], [ac_registr] vào INCLUDE dưới đây.
--    Nếu CSDL đã lỡ tạo index cũ, câu DROP ở cuối file sẽ dọn giúp.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_real_us1_del_time' AND object_id = OBJECT_ID('dbo.real_us1'))
  CREATE INDEX [IX_real_us1_del_time]
  ON [dbo].[real_us1] ([del_time])
  INCLUDE ([reci_time], [labelno], [voucher_s], [historyno_], [action_per], [department],
           [station], [store], [on_ac], [partno_off], [serialno_o], [ac_registr]);
GO

-- Nhánh phụ của đối ứng thủ công: tra theo serial của thiết bị THÁO
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_real_us1_serialoff' AND object_id = OBJECT_ID('dbo.real_us1'))
  CREATE INDEX [IX_real_us1_serialoff]
  ON [dbo].[real_us1] ([serialno_o])
  INCLUDE ([del_time], [labelno], [voucher_s]);
GO

-- Báo cáo "Tháo chưa trả US": tra dòng trả theo historyno_ của lần tháo
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_real_us1_historyno' AND object_id = OBJECT_ID('dbo.real_us1'))
  CREATE INDEX [IX_real_us1_historyno]
  ON [dbo].[real_us1] ([historyno_])
  INCLUDE ([del_time], [labelno]);
GO

------------------------------------------------------------------------------
-- 3. on_off
------------------------------------------------------------------------------
-- Sự kiện LẮP/THÁO theo thiết bị: WHERE labelno = ? AND vm = 'YE'/'YA'
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_on_off_label_vm' AND object_id = OBJECT_ID('dbo.on_off'))
  CREATE INDEX [IX_on_off_label_vm]
  ON [dbo].[on_off] ([labelno], [vm])
  INCLUDE ([mutation], [mutation_t], [mut_t], [higher_par], [partno], [serialno], [psn], [orderno]);
GO

-- Sự kiện THÁO khớp dòng trả US: WHERE historyno_ = ? AND vm = 'YA'
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_on_off_historyno_vm' AND object_id = OBJECT_ID('dbo.on_off'))
  CREATE INDEX [IX_on_off_historyno_vm]
  ON [dbo].[on_off] ([historyno_], [vm])
  INCLUDE ([mutation], [mutation_t], [mut_t]);
GO

-- Chuỗi recertify (trả service): CI cùng (psn, orderno) với YA
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_on_off_psn_order_vm' AND object_id = OBJECT_ID('dbo.on_off'))
  CREATE INDEX [IX_on_off_psn_order_vm]
  ON [dbo].[on_off] ([psn], [orderno], [vm])
  INCLUDE ([location], [mut_t], [partno], [serialno], [labelno]);
GO

------------------------------------------------------------------------------
-- 4. DỌN index THỪA của bản cũ (an toàn — không mất dữ liệu)
------------------------------------------------------------------------------
-- IX_real_us1_onac_deltime khoá theo cùng cột [del_time] với
-- IX_real_us1_del_time → hai index trùng vai trò. Giữ cả hai chỉ tốn đĩa và
-- làm mọi lệnh ghi vào real_us1 chậm thêm.
IF EXISTS (SELECT 1 FROM sys.indexes
           WHERE name = 'IX_real_us1_onac_deltime' AND object_id = OBJECT_ID('dbo.real_us1'))
  DROP INDEX [IX_real_us1_onac_deltime] ON [dbo].[real_us1];
GO

------------------------------------------------------------------------------
-- 5. KIỂM TRA: liệt kê các index hiện có + dung lượng
------------------------------------------------------------------------------
SELECT OBJECT_NAME(i.object_id)                       AS bang,
       i.name                                         AS ten_index,
       i.type_desc                                    AS loai,
       CAST(SUM(a.used_pages) * 8.0 / 1024 AS DECIMAL(10, 1)) AS mb
FROM sys.indexes i
JOIN sys.partitions   p ON p.object_id = i.object_id AND p.index_id = i.index_id
JOIN sys.allocation_units a ON a.container_id = p.partition_id
WHERE i.name LIKE 'IX\_%' ESCAPE '\'
  AND OBJECT_NAME(i.object_id) IN ('kho_ser1', 'real_us1', 'on_off', 'SIGN_CACHE')
GROUP BY OBJECT_NAME(i.object_id), i.name, i.type_desc
ORDER BY bang, ten_index;
GO
