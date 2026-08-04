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

/* ===== PHAN 4: THIET BI "XUAT KHO CHUA LAP" (chi bang NOI BO, chay nhanh) ==
   Dung DUNG dieu kien cua bao cao "Xuat kho chua lap" nhung KHONG dung linked
   server -> chay rat nhanh, de doi chieu so luong voi dashboard.
   Cot [psn] lay san de PHAN 5 noi sang ROTABLES.
   LUU Y: cot vi tri / higher_pn / higher_sn nam o PHAN 5 (phai keo ROTABLES ve
   bang tam mot lan, khong join truc tiep qua linked server theo tung dong). */
DECLARE @tuNgay date = '2026-07-01';   -- <<< SUA NGAY
DECLARE @denNgay date = '2026-08-01';  -- <<< SUA NGAY
DECLARE @amosEpoch date = '1971-12-31';
DECLARE @tzOffset int = 7;
DECLARE @fromDay int = DATEDIFF(DAY, @amosEpoch, @tuNgay);
DECLARE @toDay   int = DATEDIFF(DAY, @amosEpoch, @denNgay);

SELECT TOP 200
       RTRIM(k.[partno])     AS partno,
       RTRIM(k.[serialno])   AS serialno,
       k.[labelno]           AS labelno,
       RTRIM(k.[voucherno])  AS voucher_xuat,
       RTRIM(k.[ac_registr]) AS ac_registr,
       px.psn                AS psn,
       DATEADD(HOUR, @tzOffset,
         DATEADD(MILLISECOND,
           TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000),
           DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])),
             TRY_CONVERT(datetime, @amosEpoch)))) AS gio_xuat_vn
FROM [NQT].[dbo].[kho_ser1] k
LEFT JOIN [NQT].[dbo].[on_off] o
       ON k.[labelno] = o.[labelno] AND o.[vm] = 'YE'
OUTER APPLY (
       SELECT TOP 1 op.[psn] FROM [NQT].[dbo].[on_off] op
       WHERE op.[partno] = k.[partno] AND op.[serialno] = k.[serialno]
         AND op.[psn] IS NOT NULL ORDER BY op.[mut_t] DESC) px(psn)
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

/* ===== PHAN 5: TU DONG DOI CHIEU (KHONG PHAI GO TAY PART/SERIAL) ===========
   Chay MOT LAN duy nhat khoi nay - no lam tat ca:
     (5a) Keo WO_PART_ON_OFF ve bang tam #wo MOT LAN (theo cua so ngay cua ky
          +/- 30 ngay). KHONG hoi linked server theo tung dong -> nhanh.
     (5b) In DANH SACH DAY DU CAC COT cua #wo theo chieu DOC (de chup man hinh).
     (5c) Dung lai danh sach "Xuat kho chua lap" (nhu PHAN 4) vao bang tam.
     (5d) Dem: bao nhieu cai co / khong co trong WO_PART_ON_OFF, bao nhieu cai
          KHONG he co dong nao trong on_off.
     (5e) In TOAN BO cac cot cua nhung dong khop -> nhin ra cot danh dau.
     (5f) In TOAN BO cac cot cua mot thiet bi LAP LEN TAU BINH THUONG de SO SANH.
   >>> CHI CAN SUA 2 DONG NGAY BEN DUOI <<< */
DECLARE @tuNgay  date = '2026-07-01';   -- <<< SUA NGAY BAT DAU KY
DECLARE @denNgay date = '2026-08-01';   -- <<< SUA NGAY KET THUC KY (khong bao gom)

DECLARE @amosEpoch date = '1971-12-31';
DECLARE @tzOffset  int  = 7;
DECLARE @fromDay int = DATEDIFF(DAY, @amosEpoch, @tuNgay);
DECLARE @toDay   int = DATEDIFF(DAY, @amosEpoch, @denNgay);
DECLARE @woFrom  int = @fromDay - 30;   -- lap co the xay ra truoc/sau ky
DECLARE @woTo    int = @toDay   + 30;

IF OBJECT_ID('tempdb..#wo')      IS NOT NULL DROP TABLE #wo;
IF OBJECT_ID('tempdb..#ro')      IS NOT NULL DROP TABLE #ro;
IF OBJECT_ID('tempdb..#chualap') IS NOT NULL DROP TABLE #chualap;

-- (5a) Keo ve bang tam MOT LAN, lay HET cac cot de con soi
SELECT * INTO #wo
FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF] x
WHERE x.[MUTATION] BETWEEN @woFrom AND @woTo;

-- (5a2) ROTABLES cung keo ve MOT LAN (KHONG join truc tiep qua linked server
--       theo tung dong - se rat cham). Chi lay 4 cot can dung.
SELECT x.[psn]                  AS psn,
       RTRIM(x.[location])      AS location,
       RTRIM(x.[PARTNONEW])     AS higher_pn,
       RTRIM(x.[SERIALNONEW])   AS higher_sn
INTO #ro
FROM [DWH_DB]..[STG_AMOS].[ROTABLES] x;
CREATE INDEX IX_ro_psn ON #ro (psn);

-- (5b) DANH SACH DAY DU CAC COT (chieu doc - de chup man hinh gui lai)
SELECT c.column_id AS stt, c.name AS ten_cot, t.name AS kieu_du_lieu,
       c.max_length AS do_dai, c.is_nullable AS cho_phep_null
FROM tempdb.sys.columns c
JOIN tempdb.sys.types   t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('tempdb..#wo')
ORDER BY c.column_id;

-- (5c) Danh sach "Xuat kho chua lap" cua ky (giong dieu kien cua bao cao)
SELECT RTRIM(k.[partno])      AS partno,
       RTRIM(k.[serialno])    AS serialno,
       k.[labelno]            AS labelno,
       RTRIM(k.[voucherno])   AS voucher_xuat,
       RTRIM(k.[ac_registr])  AS ac_registr,
       px.psn                 AS psn,
       ISNULL(ro.location, '')   AS vi_tri_hien_tai,
       ISNULL(ro.higher_pn, '')  AS higher_pn,
       ISNULL(ro.higher_sn, '')  AS higher_sn,
       DATEADD(HOUR, @tzOffset,
         DATEADD(MILLISECOND,
           TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000),
           DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])),
             TRY_CONVERT(datetime, @amosEpoch)))) AS gio_xuat_vn
INTO #chualap
FROM [NQT].[dbo].[kho_ser1] k
LEFT JOIN [NQT].[dbo].[on_off] o
       ON k.[labelno] = o.[labelno] AND o.[vm] = 'YE'
OUTER APPLY (
       SELECT TOP 1 op.[psn] FROM [NQT].[dbo].[on_off] op
       WHERE op.[partno] = k.[partno] AND op.[serialno] = k.[serialno]
         AND op.[psn] IS NOT NULL ORDER BY op.[mut_t] DESC) px(psn)
LEFT JOIN #ro ro ON ro.psn = px.psn
WHERE k.[vm] = 'T'
  AND k.[voucherno] LIKE 'P-%'
  AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'
  AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')
  AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'
  AND k.[ac_registr] IS NOT NULL
  AND o.[partno] IS NULL
  AND NOT EXISTS (SELECT 1 FROM [NQT].[dbo].[real_us1] r2
                  WHERE r2.[labelno] = k.[labelno] AND r2.[voucher_s] = k.[voucherno])
  AND NOT EXISTS (SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
                  WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
                    AND tc.[partno] = k.[partno] AND tc.[serialno] = k.[serialno]
                    AND tc.[labelno] = k.[labelno])
  AND k.[mutation] BETWEEN @fromDay AND @toDay;

-- (5d) BANG TONG KET - MOI DONG LA MOT CACH TIM, xem cach nao "bat" duoc
--      nhieu thiet bi nhat. Day la con so quan trong nhat de quyet dinh logic.
SELECT 1 AS stt, 'Tong "Xuat kho chua lap" trong ky' AS tieu_chi,
       COUNT(*) AS so_thiet_bi FROM #chualap
UNION ALL SELECT 2, 'Trong do: CO higher_pn hoac higher_sn (ROTABLES)',
       COUNT(*) FROM #chualap c WHERE c.higher_pn <> '' OR c.higher_sn <> ''
UNION ALL SELECT 3, 'KHONG co dong nao trong on_off (moi vm)',
       COUNT(*) FROM #chualap c
       WHERE NOT EXISTS (SELECT 1 FROM [NQT].[dbo].[on_off] o2 WHERE o2.[labelno] = c.labelno)
UNION ALL SELECT 4, 'Co dong on_off nhung KHONG phai YE',
       COUNT(*) FROM #chualap c
       WHERE EXISTS (SELECT 1 FROM [NQT].[dbo].[on_off] o2 WHERE o2.[labelno] = c.labelno)
UNION ALL SELECT 5, 'Khop WO_PART_ON_OFF theo PARTNO + SERIALNO',
       COUNT(*) FROM #chualap c
       WHERE EXISTS (SELECT 1 FROM #wo w WHERE RTRIM(w.[PARTNO]) = c.partno
                       AND RTRIM(w.[SERIALNO]) = c.serialno)
UNION ALL SELECT 6, 'Khop WO_PART_ON_OFF chi theo SERIALNO',
       COUNT(*) FROM #chualap c
       WHERE EXISTS (SELECT 1 FROM #wo w WHERE RTRIM(w.[SERIALNO]) = c.serialno)
UNION ALL SELECT 7, 'Khop WO_PART_ON_OFF theo LABELNO',
       COUNT(*) FROM #chualap c
       WHERE EXISTS (SELECT 1 FROM #wo w
                     WHERE TRY_CONVERT(float, w.[LABELNO]) = TRY_CONVERT(float, c.labelno))
UNION ALL SELECT 8, 'Khop WO_PART_ON_OFF o cot _OFF (thiet bi bi thao ra)',
       COUNT(*) FROM #chualap c
       WHERE EXISTS (SELECT 1 FROM #wo w WHERE RTRIM(w.[PARTNO_OFF]) = c.partno
                       AND RTRIM(w.[SERIALNO_OFF]) = c.serialno)
ORDER BY stt;

-- (5e) TOAN BO cac cot cua cac dong KHOP  <<< NHIN CHO NAY DE TIM COT DANH DAU
--      Da them c.labelno de doi chieu voi w.[LABELNO].
SELECT TOP 30 c.partno AS x_partno, c.serialno AS x_serialno, c.labelno AS x_labelno,
       c.higher_pn AS x_higher_pn, c.higher_sn AS x_higher_sn, w.*
FROM #chualap c
INNER JOIN #wo w ON RTRIM(w.[PARTNO]) = c.partno AND RTRIM(w.[SERIALNO]) = c.serialno;

-- (5h) NHUNG CAI CO higher_pn NHUNG KHONG KHOP WO_PART_ON_OFF thi trong ra sao?
--      Neu nhom nay dong -> WO_PART_ON_OFF KHONG du de nhan dien, phai dung
--      nguon khac (vd chinh ROTABLES) de xac dinh "da gan vao cum".
SELECT TOP 30 c.partno, c.serialno, c.labelno, c.voucher_xuat, c.ac_registr,
       c.psn, c.vi_tri_hien_tai, c.higher_pn, c.higher_sn, c.gio_xuat_vn,
       (SELECT COUNT(*) FROM [NQT].[dbo].[on_off] o5 WHERE o5.[labelno] = c.labelno) AS so_dong_on_off,
       (SELECT TOP 1 RTRIM(o6.[vm]) FROM [NQT].[dbo].[on_off] o6
         WHERE o6.[labelno] = c.labelno ORDER BY o6.[mutation] DESC) AS vm_moi_nhat
FROM #chualap c
WHERE (c.higher_pn <> '' OR c.higher_sn <> '')
  AND NOT EXISTS (SELECT 1 FROM #wo w WHERE RTRIM(w.[PARTNO]) = c.partno
                    AND RTRIM(w.[SERIALNO]) = c.serialno);

-- (5f) DE SO SANH: cac dong WO cua thiet bi LAP LEN TAU BINH THUONG
--      (co su kien on_off vm='YE' va higher_par IS NULL)
SELECT TOP 30 w.*
FROM #wo w
WHERE EXISTS (SELECT 1 FROM [NQT].[dbo].[on_off] o3
              WHERE RTRIM(o3.[partno]) = RTRIM(w.[PARTNO])
                AND RTRIM(o3.[serialno]) = RTRIM(w.[SERIALNO])
                AND o3.[vm] = 'YE' AND o3.[higher_par] IS NULL
                AND o3.[mutation] BETWEEN @fromDay AND @toDay);

-- (5g) SO SANH NHANH 2 NHOM tren 3 cot nghi ngo nhat (LABELNO / AC_POSITION /
--      LOCID_PK). Neu nhom "chua lap" luon rong o mot cot ma nhom binh thuong
--      luon co -> chinh cot do la dau hieu.
SELECT 'A. Nhom XUAT KHO CHUA LAP' AS nhom,
       COUNT(*) AS so_dong,
       SUM(CASE WHEN w.[LABELNO]     IS NULL THEN 1 ELSE 0 END) AS labelno_rong,
       SUM(CASE WHEN w.[AC_POSITION] IS NULL THEN 1 ELSE 0 END) AS ac_position_rong,
       SUM(CASE WHEN w.[LOCID_PK]    IS NULL THEN 1 ELSE 0 END) AS locid_pk_rong
FROM #chualap c
INNER JOIN #wo w ON RTRIM(w.[PARTNO]) = c.partno AND RTRIM(w.[SERIALNO]) = c.serialno
UNION ALL
SELECT 'B. Nhom LAP LEN TAU binh thuong',
       COUNT(*),
       SUM(CASE WHEN w.[LABELNO]     IS NULL THEN 1 ELSE 0 END),
       SUM(CASE WHEN w.[AC_POSITION] IS NULL THEN 1 ELSE 0 END),
       SUM(CASE WHEN w.[LOCID_PK]    IS NULL THEN 1 ELSE 0 END)
FROM #wo w
WHERE EXISTS (SELECT 1 FROM [NQT].[dbo].[on_off] o4
              WHERE RTRIM(o4.[partno]) = RTRIM(w.[PARTNO])
                AND RTRIM(o4.[serialno]) = RTRIM(w.[SERIALNO])
                AND o4.[vm] = 'YE' AND o4.[higher_par] IS NULL
                AND o4.[mutation] BETWEEN @fromDay AND @toDay);

DROP TABLE #wo;
DROP TABLE #ro;
DROP TABLE #chualap;
GO

/* ===== PHAN 6: PHAN BO GIA TRI CAC COT UNG VIEN =============================
   Cot danh dau thuong chi co VAI GIA TRI (vi du 'AC' / 'SHOP', 'Y' / 'N').
   Cot nao "it gia tri khac nhau" -> do la ung vien.
   NEU PHAN 5b cho thay ten cot KHAC, sua lai ten cot trong cac cau duoi. */
DECLARE @tuNgay  date = '2026-07-01';   -- <<< SUA NGAY
DECLARE @denNgay date = '2026-08-01';   -- <<< SUA NGAY
DECLARE @amosEpoch date = '1971-12-31';
DECLARE @woFrom int = DATEDIFF(DAY, @amosEpoch, @tuNgay) - 30;
DECLARE @woTo   int = DATEDIFF(DAY, @amosEpoch, @denNgay) + 30;

SELECT RTRIM([STATUS]) AS gia_tri, COUNT(*) AS so_dong
FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF]
WHERE [MUTATION] BETWEEN @woFrom AND @woTo
GROUP BY RTRIM([STATUS]) ORDER BY COUNT(*) DESC;

SELECT RTRIM([AC_POSITION]) AS gia_tri, COUNT(*) AS so_dong
FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF]
WHERE [MUTATION] BETWEEN @woFrom AND @woTo
GROUP BY RTRIM([AC_POSITION]) ORDER BY COUNT(*) DESC;

SELECT RTRIM([LOCID_PK]) AS gia_tri, COUNT(*) AS so_dong
FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF]
WHERE [MUTATION] BETWEEN @woFrom AND @woTo
GROUP BY RTRIM([LOCID_PK]) ORDER BY COUNT(*) DESC;
GO
