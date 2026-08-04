/* ============================================================================
   TEST-HIGHER-ASSY.sql  —  Chay THU truc tiep tren SQL Server (SSMS)

   MUC DICH: tim ra COT NAO trong [DWH_DB]..[STG_AMOS].WO_PART_ON_OFF cho biet
   thiet bi duoc LAP VAO MOT CUM CAO HON (higher assembly) thay vi LAP LEN TAU.

   Boi canh nghiep vu:
     - Bao cao "Xuat kho chua lap" dang liet ke cac phieu xuat KHONG tim thay
       su kien lap (on_off vm='YE') theo labelno.
     - Thuc te co thiet bi KHONG lap len tau (khong co YA/YE) ma duoc gan vao
       higher_PN / higher_SN -> dang bi liet ke NHAM la "chua lap".
     - Nhung thiet bi nay PHAI: (1) bi LOAI khoi "Xuat kho chua lap",
       (2) duoc dua vao "Chi tiet TAT" nhung CHI the hien chang LAP LEN.

   ----------------------------------------------------------------------------
   CACH DUNG
     1. Mo bang SSMS (database nao cung duoc - cac bang deu ghi day du ten).
     2. Sua ngay o khoi DECLARE cua TUNG PHAN (moi phan tu khai bao rieng vi
        lenh GO ket thuc batch, bien khai bao truoc do se mat).
     3. Boi den TUNG PHAN roi F5 -> biet ngay phan nao loi.
     4. Gui lai KET QUA cua PHAN 1, PHAN 4 va PHAN 5 (quan trong nhat).

   AN TOAN: file nay CHI DOC (SELECT). Khong INSERT/UPDATE/DELETE, khong tao
   index, khong doi cau truc bang nao.
   ============================================================================ */
SET NOCOUNT ON;
GO

/* ===== PHAN 1: WO_PART_ON_OFF CO NHUNG COT GI? =============================
   Day la buoc quan trong nhat: xem DANH SACH COT THAT (khong doan ten cot).
   Nhin cac cot co ten kieu HIGHER..., ASSY..., NHA (next higher assembly),
   AC_..., TYPE, LEVEL, POS... -> do la ung vien danh dau "lap vao cum".
   Chay xong: gui lai anh chup toan bo cac cot + 3 dong mau. */
SELECT TOP 3 * FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF];
GO

/* ===== PHAN 2: on_off (NQT) DANG DUNG [higher_par] NHU THE NAO? ============
   Code hien tai coi  vm='YE' AND higher_par IS NULL  = "lap thang len tau".
   Neu co nhieu dong  vm='YE' AND higher_par IS NOT NULL  -> chinh la cac ca
   "lap vao cum cao hon" va co the KHONG can den WO_PART_ON_OFF. */
DECLARE @tuNgay date = '2026-07-01';   -- <<< SUA NGAY BAT DAU KY
DECLARE @denNgay date = '2026-08-01';  -- <<< SUA NGAY KET THUC KY (khong bao gom)
DECLARE @amosEpoch date = '1971-12-31';
DECLARE @fromDay int = DATEDIFF(DAY, @amosEpoch, @tuNgay);
DECLARE @toDay   int = DATEDIFF(DAY, @amosEpoch, @denNgay);

SELECT RTRIM(o.[vm]) AS vm,
       COUNT(*)                                                     AS tong,
       SUM(CASE WHEN o.[higher_par] IS NULL     THEN 1 ELSE 0 END)   AS higher_par_rong,
       SUM(CASE WHEN o.[higher_par] IS NOT NULL THEN 1 ELSE 0 END)   AS higher_par_co
FROM [NQT].[dbo].[on_off] o
WHERE o.[mutation] BETWEEN @fromDay AND @toDay
GROUP BY o.[vm]
ORDER BY COUNT(*) DESC;
GO

/* ===== PHAN 3: VI DU DONG on_off co higher_par ============================ */
DECLARE @tuNgay date = '2026-07-01';   -- <<< SUA NGAY
DECLARE @denNgay date = '2026-08-01';  -- <<< SUA NGAY
DECLARE @amosEpoch date = '1971-12-31';
DECLARE @fromDay int = DATEDIFF(DAY, @amosEpoch, @tuNgay);
DECLARE @toDay   int = DATEDIFF(DAY, @amosEpoch, @denNgay);

SELECT TOP 20
       RTRIM(o.[partno])     AS partno,
       RTRIM(o.[serialno])   AS serialno,
       o.[labelno]           AS labelno,
       RTRIM(o.[vm])         AS vm,
       o.[higher_par]        AS higher_par,
       RTRIM(o.[ac_registr]) AS ac_registr,
       o.[psn]               AS psn,
       o.[mut_t]             AS thoi_diem_vn
FROM [NQT].[dbo].[on_off] o
WHERE o.[vm] IN ('YE','YA')
  AND o.[higher_par] IS NOT NULL
  AND o.[mutation] BETWEEN @fromDay AND @toDay
ORDER BY o.[mutation] DESC, o.[mutation_t] DESC;
GO

/* ===== PHAN 4: THIET BI "XUAT KHO CHUA LAP" NHUNG DA GAN VAO CUM ==========
   Lay danh sach phieu xuat KHONG co su kien lap (dung dung dieu kien cua bao
   cao "Xuat kho chua lap"), roi noi sang ROTABLES qua [psn] de xem thiet bi
   hien dang gan vao higher_PN / higher_SN nao.
   -> So dong tra ve chinh la so ca dang bi liet ke NHAM. */
DECLARE @tuNgay date = '2026-07-01';   -- <<< SUA NGAY
DECLARE @denNgay date = '2026-08-01';  -- <<< SUA NGAY
DECLARE @amosEpoch date = '1971-12-31';
DECLARE @tzOffset int = 7;
DECLARE @fromDay int = DATEDIFF(DAY, @amosEpoch, @tuNgay);
DECLARE @toDay   int = DATEDIFF(DAY, @amosEpoch, @denNgay);
DECLARE @from datetime = CAST(@tuNgay AS datetime);
DECLARE @to   datetime = CAST(@denNgay AS datetime);

SELECT TOP 200
       RTRIM(k.[partno])     AS partno,
       RTRIM(k.[serialno])   AS serialno,
       k.[labelno]           AS labelno,
       RTRIM(k.[voucherno])  AS voucher_xuat,
       RTRIM(k.[ac_registr]) AS ac_registr,
       ro.[psn]              AS psn,
       RTRIM(ro.[location])  AS vi_tri_hien_tai,
       RTRIM(ro.[PARTNONEW]) AS higher_pn,
       RTRIM(ro.[SERIALNONEW]) AS higher_sn,
       DATEADD(HOUR, @tzOffset,
         DATEADD(MILLISECOND, CAST(k.[mutation_t] % 86400000 AS int),
           DATEADD(DAY, CAST(k.[mutation] AS int), CAST(@amosEpoch AS datetime)))) AS gio_xuat_vn
FROM [NQT].[dbo].[kho_ser1] k
LEFT JOIN [NQT].[dbo].[on_off] o
       ON k.[labelno] = o.[labelno] AND o.[vm] = 'YE'
OUTER APPLY (
       SELECT TOP 1 op.[psn] FROM [NQT].[dbo].[on_off] op
       WHERE op.[partno] = k.[partno] AND op.[serialno] = k.[serialno]
         AND op.[psn] IS NOT NULL ORDER BY op.[mut_t] DESC) px(psn)
LEFT JOIN [DWH_DB]..[STG_AMOS].[ROTABLES] ro ON ro.[psn] = px.psn
WHERE k.[vm] = 'T'
  AND k.[voucherno] LIKE 'P-%'
  AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'
  AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')
  AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'
  AND k.[ac_registr] IS NOT NULL
  AND o.[partno] IS NULL                      -- khong tim thay su kien LAP
  AND NOT EXISTS (SELECT 1 FROM [NQT].[dbo].[real_us1] r2
                  WHERE r2.[labelno] = k.[labelno] AND r2.[voucher_s] = k.[voucherno])
  AND NOT EXISTS (SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
                  WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
                    AND tc.[partno] = k.[partno] AND tc.[serialno] = k.[serialno]
                    AND tc.[labelno] = k.[labelno])
  AND k.[mutation] BETWEEN @fromDay AND @toDay
ORDER BY k.[mutation] DESC;
GO

/* ===== PHAN 5: CHINH LA CAU HOI - DONG WO_PART_ON_OFF CUA CHUNG TRONG NHU NAO?
   Lay 1 THIET BI CU THE trong ket qua PHAN 4 (co higher_pn/higher_sn) roi xem
   TOAN BO cac cot cua no trong WO_PART_ON_OFF. So sanh voi mot thiet bi LAP
   LEN TAU binh thuong -> cot nao khac nhau chinh la cot danh dau.
   >>> SUA @pn / @sn thanh part/serial lay tu ket qua PHAN 4 <<< */
DECLARE @pn varchar(50) = 'SUA_PARTNO_O_DAY';
DECLARE @sn varchar(50) = 'SUA_SERIALNO_O_DAY';

SELECT * FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF]
WHERE [PARTNO] = UPPER(@pn) AND [SERIALNO] = UPPER(@sn);

-- Neu thiet bi bi THAO ra thi no nam o cot _OFF:
SELECT * FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF]
WHERE [PARTNO_OFF] = UPPER(@pn) AND [SERIALNO_OFF] = UPPER(@sn);
GO

/* ===== PHAN 6: PHAN BO GIA TRI CAC COT UNG VIEN =============================
   Cot danh dau thuong chi co VAI GIA TRI (vi du 'AC' / 'SHOP', 'Y' / 'N').
   Chay tung cau de xem cot nao "it gia tri" -> do la ung vien.
   NEU PHAN 1 cho thay ten cot KHAC, sua lai ten cot trong cac cau duoi. */
SELECT RTRIM([STATUS]) AS gia_tri, COUNT(*) AS so_dong
FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF]
GROUP BY RTRIM([STATUS]) ORDER BY COUNT(*) DESC;

SELECT RTRIM([AC_POSITION]) AS gia_tri, COUNT(*) AS so_dong
FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF]
GROUP BY RTRIM([AC_POSITION]) ORDER BY COUNT(*) DESC;

SELECT RTRIM([LOCID_PK]) AS gia_tri, COUNT(*) AS so_dong
FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF]
GROUP BY RTRIM([LOCID_PK]) ORDER BY COUNT(*) DESC;
GO
