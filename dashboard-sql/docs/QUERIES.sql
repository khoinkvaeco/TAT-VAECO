/* ============================================================================
   QUERIES.sql — SQL cua tung bao cao trong Dashboard TAT (VAECO)
   Muc dich: doc hieu logic va TEST truc tiep tren SQL Server (SSMS).
   Cach dung: sua khoang thoi gian o khoi DECLARE roi chay tung section (F5).
   Dong bo 1-1 voi server.js (cap nhat gan nhat: dong bo khoa lien ket
   kho_ser1<->real_us1 ve labelno+voucherno cho TOAN BO cac truy van).

   QUY UOC CHUNG (ap dung moi query):
   - Gio AMOS  : v.time_vn = @epoch + mutation (so NGAY) + mutation_t (so MILLISECOND) + 7h
                 (khai bao 1 lan bang CROSS APPLY cho de doc — chinh la ham amosToVN() trong code)
   - Trung tam : real_us1  -> department; neu rong/UNKNOWN -> action_per bat dau 'PA' => 'PA',
                              nguoc lai tra action_per vao SIGN; cuoi cung 'PA'
                 kho_ser1  -> created_b2 (bat dau 'PA' => 'PA', nguoc lai tra SIGN); mac dinh 'PA'
   - SIGN      : join qua bang con GROUP BY USER_SIGN (linked server Oracle — keo 1 lan,
                 khong nhan ban dong khi USER_SIGN trung; tranh loi
                 "Cannot get the data of the row from OLE DB provider OraOLEDB.Oracle")
   - kho_ser1  : chi tinh vm='T' & voucher 'P-%', bo costcenter='VN-SPL',
                 bo store IN ('MAIN','3RD'), bo condition='US'
   - Lien ket kho_ser1 <-> real_us1: theo (labelno, voucherno = voucher_s)
                 — KHONG con dung partno/serialno (doi theo yeu cau moi nhat,
                 vi thiet bi tra ve co the khac vat ly voi thiet bi xuat).
   - Khoa so   : labelno / historyno_ / mutation la FLOAT -> so sanh bang TRUC TIEP
                 (khong boc RTRIM: float->varchar chi giu 6 chu so -> ghep nham!)
   - mutation BETWEEN @fromDay AND @toDay: loc tho theo index truoc khi tinh gio chinh xac
   - MAX_ROWS  : app gioi han so dong o bang chi tiet (mac dinh 20000, san toi
                 thieu 1000) — KHONG anh huong KPI/bieu do (luon AVG/COUNT
                 tren toan bo, xem section B/L). Cac TOP 1000 duoi day chi de
                 chay thu nhanh trong SSMS, khong phai gioi han cua app.
   ============================================================================ */

------------------------------------------------------------------------------
-- 0. THAM SO DUNG CHUNG (sua thoi gian tai day)
------------------------------------------------------------------------------
DECLARE @from     datetime = '2026-07-01';          -- dau ky (gio VN)
DECLARE @to       datetime = '2026-08-01';          -- cuoi ky (khong bao gom)
DECLARE @tz       int      = 7;                     -- AMOS(UTC) -> VN
DECLARE @epoch    datetime = '1971-12-31';          -- moc ngay AMOS (2026-07-08 = 19913)
DECLARE @fromDay  int      = DATEDIFF(DAY, @epoch, @from) - 2;  -- loc tho theo mutation
DECLARE @toDay    int      = DATEDIFF(DAY, @epoch, @to)   + 2;

------------------------------------------------------------------------------
-- A. CHI TIET TAT THEO THIET BI  (bang chinh tab Tong quan)
--    TAT tach 2 THANH PHAN (don vi NGAY):
--      TAT_install   = lap len tau (on_off YE dau tien cung labelno, SAU gio xuat) - gio xuat kho
--      TAT_US_return = tra US (real_us1.del_time) - thao tu tau (on_off YA khop historyno_)
--    (tat_ngay tong = tra US - xuat kho, giu de tham khao)
--    Lien ket kho_ser1 <-> real_us1: labelno + voucherno=voucher_s
------------------------------------------------------------------------------
SELECT TOP 1000
    k.event_perf, k.partno, k.serialno,
    r.partno_off, r.serialno_o AS serialno_off,     -- thiet bi thao doi ung (tu real_us1)
    k.labelno, k.descriptio AS mo_ta,
    k.receiver, k.station, k.store1,                -- hien thi store1 (loc van theo store)
    k.voucherno   AS pickslip,
    k.picking_li  AS phieu_xuat,
    r.action_per  AS nhan_vien,
    COALESCE(NULLIF(NULLIF(LTRIM(RTRIM(r.department)), ''), 'UNKNOWN'),
             CASE WHEN LEFT(LTRIM(RTRIM(r.action_per)), 2) = 'PA' THEN 'PA' END,
             NULLIF(NULLIF(LTRIM(RTRIM(sm.DEPARTMENT)), ''), 'UNKNOWN'),
             'PA')  AS trung_tam,
    v.time_vn      AS gio_xuat_vn,
    ye.install_time AS ngay_lap,
    ya.removal_time AS ngay_thao,
    r.del_time     AS gio_tra_us,
    CAST(DATEDIFF(MINUTE, v.time_vn, ye.install_time) AS float) / 1440.0 AS tat_install,
    CAST(DATEDIFF(MINUTE, ya.removal_time, r.del_time) AS float) / 1440.0 AS tat_us_return,
    CAST(DATEDIFF(MINUTE, v.time_vn, r.del_time) AS float) / 1440.0 AS tat_ngay
FROM NQT.dbo.kho_ser1 k
JOIN NQT.dbo.real_us1 r
  ON k.labelno = r.labelno AND k.voucherno = r.voucher_s
LEFT JOIN (SELECT USER_SIGN, MAX(DEPARTMENT) AS DEPARTMENT
           FROM DWH_DB..STG_AMOS.SIGN GROUP BY USER_SIGN) sm
  ON sm.USER_SIGN = r.action_per
CROSS APPLY (SELECT DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
    TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.mutation_t)) % 86400000),
    DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.mutation)), @epoch)))) v(time_vn)
-- Lan LAP (YE) DAU TIEN cung labelno, SAU gio xuat kho
OUTER APPLY (
    SELECT TOP 1 DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
        TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, o.mutation_t)) % 86400000),
        DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, o.mutation)), @epoch))) AS install_time
    FROM NQT.dbo.on_off o
    WHERE o.labelno = k.labelno AND o.vm = 'YE'
      AND DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
          TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, o.mutation_t)) % 86400000),
          DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, o.mutation)), @epoch))) > v.time_vn
    ORDER BY o.mutation ASC, o.mutation_t ASC
) ye
-- Su kien THAO (YA) khop CHINH XAC historyno_ cua dong tra US
OUTER APPLY (
    SELECT TOP 1 DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
        TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, o.mutation_t)) % 86400000),
        DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, o.mutation)), @epoch))) AS removal_time
    FROM NQT.dbo.on_off o
    WHERE o.historyno_ = r.historyno_ AND o.vm = 'YA'
    ORDER BY o.mutation ASC, o.mutation_t ASC
) ya
WHERE k.vm = 'T' AND k.voucherno LIKE 'P-%'
  AND LTRIM(RTRIM(ISNULL(k.receiver,   ''))) <> ''        -- bo receiver rong
  AND LTRIM(RTRIM(ISNULL(k.costcenter, ''))) <> 'VN-SPL'  -- bo VN-SPL
  AND UPPER(LTRIM(RTRIM(ISNULL(k.store, '')))) NOT IN ('MAIN','3RD')
  AND UPPER(LTRIM(RTRIM(ISNULL(k.condition, '')))) <> 'US'  -- bo qua condition US
  AND r.del_time >= @from AND r.del_time < @to
ORDER BY tat_ngay DESC;

------------------------------------------------------------------------------
-- B. KPI 2 THANH PHAN theo Trung tam (AVG tren TOAN BO — cach dashboard tinh)
--    avg_install / avg_us_return khop card "TAT install" / "TAT US return" +
--    bieu do cot 2 series dau tien tren Dashboard. AVG() tu bo NULL -> dong
--    thieu su kien lap/thao KHONG tinh vao trung binh.
------------------------------------------------------------------------------
SELECT x.trung_tam,
       COUNT(*) AS so_thiet_bi,
       AVG(x.tat_install)   AS avg_install,   COUNT(x.tat_install)   AS cnt_install,
       AVG(x.tat_us_return) AS avg_us_return, COUNT(x.tat_us_return) AS cnt_us_return
FROM (
    SELECT COALESCE(NULLIF(NULLIF(LTRIM(RTRIM(r.department)), ''), 'UNKNOWN'),
                    CASE WHEN LEFT(LTRIM(RTRIM(r.action_per)), 2) = 'PA' THEN 'PA' END,
                    NULLIF(NULLIF(LTRIM(RTRIM(sm.DEPARTMENT)), ''), 'UNKNOWN'),
                    'PA')  AS trung_tam,
           CAST(DATEDIFF(MINUTE, v.time_vn, ye.install_time) AS float) / 1440.0 AS tat_install,
           CAST(DATEDIFF(MINUTE, ya.removal_time, r.del_time) AS float) / 1440.0 AS tat_us_return
    FROM NQT.dbo.kho_ser1 k
    JOIN NQT.dbo.real_us1 r
      ON k.labelno = r.labelno AND k.voucherno = r.voucher_s
    LEFT JOIN (SELECT USER_SIGN, MAX(DEPARTMENT) AS DEPARTMENT
               FROM DWH_DB..STG_AMOS.SIGN GROUP BY USER_SIGN) sm
      ON sm.USER_SIGN = r.action_per
    CROSS APPLY (SELECT DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
        TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.mutation_t)) % 86400000),
        DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.mutation)), @epoch)))) v(time_vn)
    OUTER APPLY (
        SELECT TOP 1 DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
            TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, o.mutation_t)) % 86400000),
            DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, o.mutation)), @epoch))) AS install_time
        FROM NQT.dbo.on_off o
        WHERE o.labelno = k.labelno AND o.vm = 'YE'
          AND DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
              TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, o.mutation_t)) % 86400000),
              DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, o.mutation)), @epoch))) > v.time_vn
        ORDER BY o.mutation ASC, o.mutation_t ASC
    ) ye
    OUTER APPLY (
        SELECT TOP 1 DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
            TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, o.mutation_t)) % 86400000),
            DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, o.mutation)), @epoch))) AS removal_time
        FROM NQT.dbo.on_off o
        WHERE o.historyno_ = r.historyno_ AND o.vm = 'YA'
        ORDER BY o.mutation ASC, o.mutation_t ASC
    ) ya
    WHERE k.vm = 'T' AND k.voucherno LIKE 'P-%'
      AND LTRIM(RTRIM(ISNULL(k.receiver,   ''))) <> ''
      AND LTRIM(RTRIM(ISNULL(k.costcenter, ''))) <> 'VN-SPL'
      AND UPPER(LTRIM(RTRIM(ISNULL(k.store, '')))) NOT IN ('MAIN','3RD')
      AND UPPER(LTRIM(RTRIM(ISNULL(k.condition, '')))) <> 'US'
      AND r.del_time >= @from AND r.del_time < @to
) x
GROUP BY x.trung_tam
ORDER BY avg_install DESC;

------------------------------------------------------------------------------
-- C. TAT CUVT  =  reci_time − del_time (real_us1), bo ban ghi chua nhan
------------------------------------------------------------------------------
SELECT COUNT(*) AS so_dong,
       AVG(CAST(DATEDIFF(MINUTE, r.del_time, r.reci_time) AS float) / 1440.0) AS tat_cuvt_tb_ngay
FROM NQT.dbo.real_us1 r
WHERE r.del_time IS NOT NULL AND r.reci_time IS NOT NULL
  AND r.reci_time >= r.del_time              -- loai sentinel (chua nhan) gay TAT am
  AND r.del_time >= @from AND r.del_time < @to;

------------------------------------------------------------------------------
-- D. TAB "TRA UNSERVICE"  (real_us1 co del_time trong ky)
------------------------------------------------------------------------------
SELECT TOP 1000
    r.partno_off AS partno, r.serialno_o AS serialno, r.labelno,
    r.descriptio AS mo_ta, r.historyno_,
    r.ac_registr, r.action_per AS nhan_vien, r.station,
    COALESCE(NULLIF(NULLIF(LTRIM(RTRIM(r.department)), ''), 'UNKNOWN'),
             CASE WHEN LEFT(LTRIM(RTRIM(r.action_per)), 2) = 'PA' THEN 'PA' END,
             NULLIF(NULLIF(LTRIM(RTRIM(sm.DEPARTMENT)), ''), 'UNKNOWN'),
             'PA')  AS trung_tam,
    r.del_staff, r.del_time, r.reci_time
FROM NQT.dbo.real_us1 r
LEFT JOIN (SELECT USER_SIGN, MAX(DEPARTMENT) AS DEPARTMENT
           FROM DWH_DB..STG_AMOS.SIGN GROUP BY USER_SIGN) sm
  ON sm.USER_SIGN = r.action_per
WHERE r.del_time IS NOT NULL
  AND r.del_time >= @from AND r.del_time < @to
ORDER BY r.del_time DESC;

------------------------------------------------------------------------------
-- E. TAB "XUAT KHO CHUA LAP"
--    kho_ser1 T chua co on_off YE (cung part+serial+label), chua duoc return
--    (chua tra US theo labelno+voucherno, chua hoan kho P-CA cung part/serial/label)
--    TAT ton = GETDATE() − gio xuat
------------------------------------------------------------------------------
SELECT TOP 1000
    k.partno, k.serialno, k.labelno, k.descriptio AS mo_ta,
    k.station, k.store, k.voucherno AS phieu_xuat, k.ac_registr,
    k.created_b2 AS nhan_vien,
    v.time_vn    AS gio_xuat_vn,
    CAST(DATEDIFF(MINUTE, v.time_vn, GETDATE()) AS float) / 1440.0 AS tat_ton_ngay
FROM NQT.dbo.kho_ser1 k
LEFT JOIN NQT.dbo.on_off o
  ON k.partno = o.partno AND k.serialno = o.serialno
 AND k.labelno = o.labelno AND o.vm = 'YE'
CROSS APPLY (SELECT DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
    TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.mutation_t)) % 86400000),
    DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.mutation)), @epoch)))) v(time_vn)
WHERE k.vm = 'T' AND k.voucherno LIKE 'P-%'
  AND LTRIM(RTRIM(ISNULL(k.costcenter, ''))) <> 'VN-SPL'
  AND UPPER(LTRIM(RTRIM(ISNULL(k.store, '')))) NOT IN ('MAIN','3RD')
  AND UPPER(LTRIM(RTRIM(ISNULL(k.condition, '')))) <> 'US'
  AND o.partno IS NULL                                   -- chua lap
  AND NOT EXISTS (SELECT 1 FROM NQT.dbo.real_us1 r2      -- chua tra unservice
                  WHERE r2.labelno = k.labelno AND r2.voucher_s = k.voucherno)
  AND NOT EXISTS (SELECT 1 FROM NQT.dbo.kho_ser1 tc      -- chua hoan kho
                  WHERE tc.vm = 'TC' AND tc.voucherno LIKE 'P-CA-%'
                    AND tc.partno = k.partno AND tc.serialno = k.serialno
                    AND tc.labelno = k.labelno)
  AND k.mutation BETWEEN @fromDay AND @toDay
  AND v.time_vn >= @from AND v.time_vn < @to
ORDER BY v.time_vn DESC;

------------------------------------------------------------------------------
-- F. TAB "THAO CHUA TRA US"
--    on_off YA khong co real_us1 (khoa historyno_ — so sanh SO truc tiep)
------------------------------------------------------------------------------
SELECT TOP 1000
    o.partno, o.serialno, o.labelno, o.historyno_,
    o.station, o.store, o.ac_registr,
    o.created_by AS nhan_vien,
    v.time_vn    AS gio_thao_vn
FROM NQT.dbo.on_off o
LEFT JOIN NQT.dbo.real_us1 r ON o.historyno_ = r.historyno_
CROSS APPLY (SELECT DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
    TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, o.mutation_t)) % 86400000),
    DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, o.mutation)), @epoch)))) v(time_vn)
WHERE o.vm = 'YA'
  AND r.historyno_ IS NULL
  AND o.mutation BETWEEN @fromDay AND @toDay
  AND v.time_vn >= @from AND v.time_vn < @to
ORDER BY v.time_vn DESC;

------------------------------------------------------------------------------
-- G. TAB "CHUA DOI UNG"
--    Xuat service (kho_ser1 T) khong co tra unservice (labelno+voucherno),
--    va CHUA hoan kho. TAT ton = GETDATE() − gio xuat.
------------------------------------------------------------------------------
SELECT TOP 1000
    k.partno, k.serialno, k.labelno, k.descriptio AS mo_ta,
    k.station, k.store,
    k.voucherno  AS pickslip,
    k.picking_li AS phieu_xuat,
    k.created_b2 AS nhan_vien,
    v.time_vn    AS gio_xuat_vn,
    CAST(DATEDIFF(MINUTE, v.time_vn, GETDATE()) AS float) / 1440.0 AS tat_ton_ngay
FROM NQT.dbo.kho_ser1 k
LEFT JOIN NQT.dbo.real_us1 r
  ON k.labelno = r.labelno AND k.voucherno = r.voucher_s
CROSS APPLY (SELECT DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
    TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.mutation_t)) % 86400000),
    DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.mutation)), @epoch)))) v(time_vn)
WHERE k.vm = 'T' AND k.voucherno LIKE 'P-%'
  AND LTRIM(RTRIM(ISNULL(k.costcenter, ''))) <> 'VN-SPL'
  AND UPPER(LTRIM(RTRIM(ISNULL(k.store, '')))) NOT IN ('MAIN','3RD')
  AND UPPER(LTRIM(RTRIM(ISNULL(k.condition, '')))) <> 'US'
  AND r.partno IS NULL                                   -- khong co tra US
  AND NOT EXISTS (SELECT 1 FROM NQT.dbo.kho_ser1 tc      -- bo qua da hoan kho
                  WHERE tc.vm = 'TC' AND tc.voucherno LIKE 'P-CA-%'
                    AND tc.partno = k.partno AND tc.serialno = k.serialno
                    AND tc.labelno = k.labelno)
  AND k.mutation BETWEEN @fromDay AND @toDay
  AND v.time_vn >= @from AND v.time_vn < @to
ORDER BY v.time_vn DESC;

------------------------------------------------------------------------------
-- H. TAB "THAO TRUOC LAP SAU"  (ngay XUAT KHO > ngay LAP; ghep theo labelno)
--    ye = lan LAP gan nhat TRUOC ngay xuat; ya = lan THAO gan nhat truoc luc lap
------------------------------------------------------------------------------
SELECT TOP 1000
    k.labelno,
    ya.partno    AS pn_thao,        ya.serialno AS sn_thao,
    ya.time_vn   AS ngay_thao,
    ye.time_vn   AS ngay_lap,
    k.partno     AS pn_xuat,        k.serialno  AS sn_xuat,
    vk.time_vn   AS ngay_xuat_kho,
    CAST(DATEDIFF(MINUTE, ye.time_vn, vk.time_vn) AS float) / 1440.0 AS xuat_sau_lap_ngay,
    r.del_time   AS gio_tra_us,
    CAST(DATEDIFF(MINUTE, ya.time_vn, r.del_time) AS float) / 1440.0 AS tat_thao_tra_ngay,
    k.ac_registr, k.station, k.created_b2 AS nhan_vien
FROM NQT.dbo.kho_ser1 k
CROSS APPLY (SELECT DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
    TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.mutation_t)) % 86400000),
    DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.mutation)), @epoch)))) vk(time_vn)
-- Lan LAP (YE) gan nhat TRUOC ngay xuat kho, cung labelno
OUTER APPLY (
    SELECT TOP 1 DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
        TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, o.mutation_t)) % 86400000),
        DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, o.mutation)), @epoch))) AS time_vn
    FROM NQT.dbo.on_off o
    WHERE o.labelno = k.labelno AND o.vm = 'YE'
      AND DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
          TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, o.mutation_t)) % 86400000),
          DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, o.mutation)), @epoch))) < vk.time_vn
    ORDER BY o.mutation DESC, o.mutation_t DESC
) ye
-- Lan THAO (YA) gan nhat truoc/luc lap, cung labelno
OUTER APPLY (
    SELECT TOP 1 o.historyno_, o.partno, o.serialno,
        DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
        TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, o.mutation_t)) % 86400000),
        DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, o.mutation)), @epoch))) AS time_vn
    FROM NQT.dbo.on_off o
    WHERE o.labelno = k.labelno AND o.vm = 'YA'
      AND DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
          TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, o.mutation_t)) % 86400000),
          DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, o.mutation)), @epoch))) <= ye.time_vn
    ORDER BY o.mutation DESC, o.mutation_t DESC
) ya
LEFT JOIN NQT.dbo.real_us1 r ON r.historyno_ = ya.historyno_
WHERE k.vm = 'T' AND k.voucherno LIKE 'P-%'
  AND LTRIM(RTRIM(ISNULL(k.costcenter, ''))) <> 'VN-SPL'
  AND UPPER(LTRIM(RTRIM(ISNULL(k.store, '')))) NOT IN ('MAIN','3RD')
  AND UPPER(LTRIM(RTRIM(ISNULL(k.condition, '')))) <> 'US'
  AND ye.time_vn IS NOT NULL                    -- co lap truoc khi xuat => "xuat sau lap"
  AND k.mutation BETWEEN @fromDay AND @toDay
  AND vk.time_vn >= @from AND vk.time_vn < @to
ORDER BY k.mutation DESC;

------------------------------------------------------------------------------
-- I. TAB "OTHER (on_ac)"  (ghi chu on_ac; ke ca del_time null/sentinel)
------------------------------------------------------------------------------
SELECT TOP 1000
    r.partno_off, r.serialno_o AS serialno_off, r.batchno_of AS batchno_off,
    r.qty_off, r.action_per AS nhan_vien, r.station,
    COALESCE(NULLIF(NULLIF(LTRIM(RTRIM(r.department)), ''), 'UNKNOWN'),
             CASE WHEN LEFT(LTRIM(RTRIM(r.action_per)), 2) = 'PA' THEN 'PA' END,
             NULLIF(NULLIF(LTRIM(RTRIM(sm.DEPARTMENT)), ''), 'UNKNOWN'),
             'PA')  AS trung_tam,
    r.del_staff, r.del_time,
    r.on_ac AS ghi_chu
FROM NQT.dbo.real_us1 r
LEFT JOIN (SELECT USER_SIGN, MAX(DEPARTMENT) AS DEPARTMENT
           FROM DWH_DB..STG_AMOS.SIGN GROUP BY USER_SIGN) sm
  ON sm.USER_SIGN = r.action_per
WHERE r.on_ac IS NOT NULL AND LTRIM(RTRIM(r.on_ac)) <> ''
  AND (r.del_time IS NULL OR r.del_time < '1902-01-01'
       OR (r.del_time >= @from AND r.del_time < @to))
ORDER BY r.del_time DESC;

------------------------------------------------------------------------------
-- K. TAB "TAT HOAN KHO"
--    tc (vm='TC', 'P-CA-<PS>')  <->  t (vm='T', 'P-<PS>') cung so PS + cung labelno
--    TAT = gio hoan − gio xuat; Trung tam theo created_b2 cua PHIEU XUAT.
--    KHONG tinh cho Trung tam CUVT.
------------------------------------------------------------------------------
SELECT TOP 1000
    tc.partno, tc.serialno, tc.labelno, tc.descriptio AS mo_ta,
    tc.station, tc.store,
    t.voucherno  AS pickslip,
    t.picking_li AS phieu_xuat,
    t.created_b2 AS nhan_vien,
    COALESCE(CASE WHEN LEFT(LTRIM(RTRIM(t.created_b2)), 2) = 'PA' THEN 'PA' END,
             NULLIF(NULLIF(LTRIM(RTRIM(sm.DEPARTMENT)), ''), 'UNKNOWN'),
             'PA')  AS trung_tam,
    vt.time_vn   AS gio_xuat_vn,
    vc.time_vn   AS gio_hoan_vn,
    CAST(DATEDIFF(MINUTE, vt.time_vn, vc.time_vn) AS float) / 1440.0 AS tat_ngay
FROM NQT.dbo.kho_ser1 tc
JOIN NQT.dbo.kho_ser1 t
  ON RTRIM(t.voucherno) = 'P-' + SUBSTRING(RTRIM(tc.voucherno), 6, 50)  -- P-CA-<PS> -> P-<PS>
 AND t.labelno = tc.labelno
 AND t.vm = 'T' AND t.voucherno LIKE 'P-%'
LEFT JOIN (SELECT USER_SIGN, MAX(DEPARTMENT) AS DEPARTMENT
           FROM DWH_DB..STG_AMOS.SIGN GROUP BY USER_SIGN) sm
  ON sm.USER_SIGN = t.created_b2
CROSS APPLY (SELECT DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
    TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, t.mutation_t)) % 86400000),
    DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, t.mutation)), @epoch)))) vt(time_vn)
CROSS APPLY (SELECT DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
    TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, tc.mutation_t)) % 86400000),
    DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, tc.mutation)), @epoch)))) vc(time_vn)
WHERE tc.vm = 'TC' AND tc.voucherno LIKE 'P-CA-%'
  AND LTRIM(RTRIM(ISNULL(t.costcenter, ''))) <> 'VN-SPL'
  AND UPPER(LTRIM(RTRIM(ISNULL(t.store, '')))) NOT IN ('MAIN','3RD')
  AND UPPER(LTRIM(RTRIM(ISNULL(t.condition, '')))) <> 'US'
  AND COALESCE(CASE WHEN LEFT(LTRIM(RTRIM(t.created_b2)), 2) = 'PA' THEN 'PA' END,
               NULLIF(NULLIF(LTRIM(RTRIM(sm.DEPARTMENT)), ''), 'UNKNOWN'), 'PA') <> 'CUVT'
  AND tc.mutation BETWEEN @fromDay AND @toDay
  AND vc.time_vn >= @from AND vc.time_vn < @to
ORDER BY tat_ngay DESC;

------------------------------------------------------------------------------
-- L. KPI TONG HOP DASHBOARD (nhu qDashboardAgg trong server.js) — DOI CHIEU NHANH
--    Chay tung khoi de so sanh voi cac card KPI tren Dashboard (cung ky/filter):
--      [B]/[l0] -> card "TAT TB Trung tam" + bieu do cot 1
--      [C]      -> card "TAT CUVT"
--      [l2]     -> card "TAT hoan kho" + bieu do cot 4
--      [l3]     -> card "Chua doi ung"
--      [l4]     -> bieu do "So luong xuat kho & tra US theo Trung tam" (phan tra US)
--      [l5]     -> card "Thiet bi xuat kho" (thanh phan chua lap)
--      [l6]     -> bieu do tron "Phan bo theo Station"
------------------------------------------------------------------------------

-- [l3] Chua doi ung theo Trung tam (KPI "Chua doi ung")
SELECT COALESCE(CASE WHEN LEFT(LTRIM(RTRIM(k.created_b2)), 2) = 'PA' THEN 'PA' END,
                NULLIF(NULLIF(LTRIM(RTRIM(sm.DEPARTMENT)), ''), 'UNKNOWN'), 'PA') AS trung_tam,
       COUNT(*) AS so_luong
FROM NQT.dbo.kho_ser1 k
LEFT JOIN NQT.dbo.real_us1 r
  ON k.labelno = r.labelno AND k.voucherno = r.voucher_s
LEFT JOIN (SELECT USER_SIGN, MAX(DEPARTMENT) AS DEPARTMENT
           FROM DWH_DB..STG_AMOS.SIGN GROUP BY USER_SIGN) sm
  ON sm.USER_SIGN = k.created_b2
WHERE k.vm = 'T' AND k.voucherno LIKE 'P-%'
  AND LTRIM(RTRIM(ISNULL(k.costcenter, ''))) <> 'VN-SPL'
  AND UPPER(LTRIM(RTRIM(ISNULL(k.store, '')))) NOT IN ('MAIN','3RD')
  AND UPPER(LTRIM(RTRIM(ISNULL(k.condition, '')))) <> 'US'
  AND r.partno IS NULL
  AND NOT EXISTS (SELECT 1 FROM NQT.dbo.kho_ser1 tc
                  WHERE tc.vm = 'TC' AND tc.voucherno LIKE 'P-CA-%'
                    AND tc.partno = k.partno AND tc.serialno = k.serialno AND tc.labelno = k.labelno)
  AND k.mutation BETWEEN @fromDay AND @toDay
  AND DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
      TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.mutation_t)) % 86400000),
      DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.mutation)), @epoch))) >= @from
  AND DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
      TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.mutation_t)) % 86400000),
      DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.mutation)), @epoch))) < @to
GROUP BY COALESCE(CASE WHEN LEFT(LTRIM(RTRIM(k.created_b2)), 2) = 'PA' THEN 'PA' END,
                  NULLIF(NULLIF(LTRIM(RTRIM(sm.DEPARTMENT)), ''), 'UNKNOWN'), 'PA');

-- [l5] Xuat kho chua lap (tong so, KHONG chia Trung tam — dung cho card "Thiet bi xuat kho")
SELECT COUNT(*) AS so_luong
FROM NQT.dbo.kho_ser1 k
LEFT JOIN NQT.dbo.on_off o
  ON k.partno = o.partno AND k.serialno = o.serialno AND k.labelno = o.labelno AND o.vm = 'YE'
WHERE k.vm = 'T' AND k.voucherno LIKE 'P-%'
  AND LTRIM(RTRIM(ISNULL(k.costcenter, ''))) <> 'VN-SPL'
  AND UPPER(LTRIM(RTRIM(ISNULL(k.store, '')))) NOT IN ('MAIN','3RD')
  AND UPPER(LTRIM(RTRIM(ISNULL(k.condition, '')))) <> 'US'
  AND o.partno IS NULL
  AND NOT EXISTS (SELECT 1 FROM NQT.dbo.real_us1 r2
                  WHERE r2.labelno = k.labelno AND r2.voucher_s = k.voucherno)
  AND NOT EXISTS (SELECT 1 FROM NQT.dbo.kho_ser1 tc
                  WHERE tc.vm = 'TC' AND tc.voucherno LIKE 'P-CA-%'
                    AND tc.partno = k.partno AND tc.serialno = k.serialno AND tc.labelno = k.labelno)
  AND k.mutation BETWEEN @fromDay AND @toDay
  AND DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
      TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.mutation_t)) % 86400000),
      DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.mutation)), @epoch))) >= @from
  AND DATEADD(HOUR, @tz, DATEADD(MILLISECOND,
      TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.mutation_t)) % 86400000),
      DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.mutation)), @epoch))) < @to;

-- [l6] Phan bo Station cua tap DA DOI UNG (dung cho bieu do tron; app tu gom HAN/SGN/DAD/Khac)
SELECT k.station, COUNT(*) AS so_luong
FROM NQT.dbo.kho_ser1 k
JOIN NQT.dbo.real_us1 r
  ON k.labelno = r.labelno AND k.voucherno = r.voucher_s
WHERE k.vm = 'T' AND k.voucherno LIKE 'P-%'
  AND LTRIM(RTRIM(ISNULL(k.receiver, ''))) <> ''
  AND LTRIM(RTRIM(ISNULL(k.costcenter, ''))) <> 'VN-SPL'
  AND UPPER(LTRIM(RTRIM(ISNULL(k.store, '')))) NOT IN ('MAIN','3RD')
  AND UPPER(LTRIM(RTRIM(ISNULL(k.condition, '')))) <> 'US'
  AND r.del_time >= @from AND r.del_time < @to
GROUP BY k.station;

-- [l1] KPI "SL nhan / SL giao (CUVT)" — tu dong so voi card moi nhat tren Dashboard.
--    reci = so thiet bi CUVT DA NHAN hop le (del_time+reci_time trong ky, reci>=del)
--    del  = tong so thiet bi DA GIAO/tra unservice trong ky (= tong tab "Tra unservice")
SELECT
  (SELECT COUNT(*) FROM NQT.dbo.real_us1 r
   WHERE r.del_time IS NOT NULL AND r.reci_time IS NOT NULL AND r.reci_time >= r.del_time
     AND r.del_time >= @from AND r.del_time < @to)  AS so_luong_reci,
  (SELECT COUNT(*) FROM NQT.dbo.real_us1 r
   WHERE r.del_time IS NOT NULL
     AND r.del_time >= @from AND r.del_time < @to)  AS so_luong_del;
