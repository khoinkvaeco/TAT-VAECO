/* ============================================================================
   INDEXES.sql — Index tang toc cho Dashboard TAT (VAECO)
   Chay 1 lan trong SSMS tren database NQT (nen chay NGOAI GIO cao diem:
   bang lon co the mat vai phut moi index; app van dung binh thuong khi
   chua co index — chi cham hon).

   Nguyen tac chon index (bam theo cac query trong server.js / QUERIES.sql):
   - kho_ser1 : loc theo (vm, mutation) cho ky bao cao; join theo
                (labelno, voucherno); tra cuu TC theo voucherno va theo
                (partno, serialno, labelno).
   - real_us1 : join theo (labelno, voucher_s); loc ky theo del_time.
   - on_off   : tra YE/YA theo (labelno, vm); YA theo (historyno_, vm);
                chuoi recertify CI theo (psn, orderno, vm).
   - SIGN_CACHE: app tu tao + tu danh index (xem refreshSignCache trong
                server.js) — KHONG can tao o day.

   Tat ca deu co IF NOT EXISTS -> chay lai nhieu lan khong sao.
   ============================================================================ */
USE [NQT];
GO

------------------------------------------------------------------------------
-- 1. kho_ser1
------------------------------------------------------------------------------
-- Loc ky bao cao: WHERE vm='T' AND mutation BETWEEN @fromDay AND @toDay
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_kho_ser1_vm_mutation' AND object_id = OBJECT_ID('dbo.kho_ser1'))
  CREATE INDEX [IX_kho_ser1_vm_mutation]
  ON [dbo].[kho_ser1] ([vm], [mutation])
  INCLUDE ([voucherno], [labelno], [mutation_t], [store], [station], [costcenter], [condition], [receiver], [created_b2]);
GO

-- Join doi ung: kho_ser1(labelno, voucherno) = real_us1(labelno, voucher_s)
-- + dedup "phieu xuat gan nhat" (k2 cung labelno+voucherno)
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_kho_ser1_label_voucher' AND object_id = OBJECT_ID('dbo.kho_ser1'))
  CREATE INDEX [IX_kho_ser1_label_voucher]
  ON [dbo].[kho_ser1] ([labelno], [voucherno])
  INCLUDE ([vm], [mutation], [mutation_t]);
GO

-- Tra cuu hoan kho / TRANSFER CANCELLED theo voucher (TC 'P-CA-%')
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_kho_ser1_voucherno' AND object_id = OBJECT_ID('dbo.kho_ser1'))
  CREATE INDEX [IX_kho_ser1_voucherno]
  ON [dbo].[kho_ser1] ([voucherno])
  INCLUDE ([vm], [labelno], [partno], [serialno]);
GO

-- Tra cuu hoan kho theo thiet bi (partno, serialno, labelno)
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_kho_ser1_part_serial_label' AND object_id = OBJECT_ID('dbo.kho_ser1'))
  CREATE INDEX [IX_kho_ser1_part_serial_label]
  ON [dbo].[kho_ser1] ([partno], [serialno], [labelno])
  INCLUDE ([vm], [voucherno]);
GO

------------------------------------------------------------------------------
-- 2. real_us1
------------------------------------------------------------------------------
-- Join doi ung tu phia kho_ser1 + dedup dong tra (r3 cung labelno+voucher_s)
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_real_us1_label_voucher' AND object_id = OBJECT_ID('dbo.real_us1'))
  CREATE INDEX [IX_real_us1_label_voucher]
  ON [dbo].[real_us1] ([labelno], [voucher_s])
  INCLUDE ([del_time], [reci_time], [historyno_]);
GO

-- Loc ky bao cao theo del_time (tab Tra unservice, TAT CUVT, dem so luong)
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_real_us1_del_time' AND object_id = OBJECT_ID('dbo.real_us1'))
  CREATE INDEX [IX_real_us1_del_time]
  ON [dbo].[real_us1] ([del_time])
  INCLUDE ([reci_time], [labelno], [voucher_s], [historyno_], [action_per], [department], [station], [store]);
GO

------------------------------------------------------------------------------
-- 3. on_off
------------------------------------------------------------------------------
-- Su kien LAP/THAO theo thiet bi: WHERE labelno = ? AND vm = 'YE'/'YA'
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_on_off_label_vm' AND object_id = OBJECT_ID('dbo.on_off'))
  CREATE INDEX [IX_on_off_label_vm]
  ON [dbo].[on_off] ([labelno], [vm])
  INCLUDE ([mutation], [mutation_t], [mut_t], [higher_par], [partno], [serialno], [psn], [orderno]);
GO

-- Su kien THAO khop dong tra US: WHERE historyno_ = ? AND vm = 'YA'
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_on_off_historyno_vm' AND object_id = OBJECT_ID('dbo.on_off'))
  CREATE INDEX [IX_on_off_historyno_vm]
  ON [dbo].[on_off] ([historyno_], [vm])
  INCLUDE ([mutation], [mutation_t], [mut_t]);
GO

-- Chuoi recertify (tra service): CI cung (psn, orderno) voi YA
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_on_off_psn_order_vm' AND object_id = OBJECT_ID('dbo.on_off'))
  CREATE INDEX [IX_on_off_psn_order_vm]
  ON [dbo].[on_off] ([psn], [orderno], [vm])
  INCLUDE ([location], [mut_t], [partno], [serialno], [labelno]);
GO

------------------------------------------------------------------------------
-- Kiem tra: liet ke cac index vua tao
------------------------------------------------------------------------------
SELECT OBJECT_NAME(i.object_id) AS bang, i.name AS ten_index, i.type_desc
FROM sys.indexes i
WHERE i.name LIKE 'IX\_%' ESCAPE '\'
  AND OBJECT_NAME(i.object_id) IN ('kho_ser1', 'real_us1', 'on_off', 'SIGN_CACHE')
ORDER BY bang, ten_index;
GO
