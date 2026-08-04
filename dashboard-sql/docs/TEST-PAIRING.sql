/* ============================================================================
   TEST-PAIRING.sql  —  Chay THU truc tiep tren SQL Server (SSMS)
   Kiem tra truy van "Doi ung thu cong (label lech)" cua dashboard: chay duoc
   khong, mat bao lau, ghep duoc bao nhieu cap.
   ----------------------------------------------------------------------------
   File nay duoc SINH RA TU DUNG CODE dang chay cua dashboard (server.js), nen
   SQL o day GIONG HET cai app gui xuong -> loi o day chinh la loi that cua app.

   CACH DUNG
     1. Mo bang SSMS (database nao cung duoc - cac bang deu ghi day du ten).
     2. Sua ngay/thang o khoi DECLARE (moi PHAN co san 1 khoi giong nhau).
     3. Boi den TUNG PHAN roi F5 -> biet ngay phan nao loi.
     4. Co loi -> gui nguyen van thong bao loi.

   AN TOAN: file nay CHI DOC (SELECT). Cac bang #temp la bang tam RIENG cua
   phien lam viec, tu mat khi dong cua so - khong dung gi den du lieu that.
   ============================================================================ */
SET NOCOUNT ON;
GO

/* ===== PHAN 1: CO DU CAC COT CAN THIET KHONG? ==============================
   [event_perf] phai co o CA HAI bang thi tieu chi "Khop event (WO)" moi chay.
   Thieu 1 ben -> app TU TAT tieu chi do (khong loi), cach ghep khac van chay. */
SELECT 'kho_ser1' AS bang,
       MAX(CASE WHEN COLUMN_NAME = 'event_perf' THEN 1 ELSE 0 END) AS co_event_perf,
       MAX(CASE WHEN COLUMN_NAME = 'ac_registr' THEN 1 ELSE 0 END) AS co_ac_registr,
       COUNT(*) AS tong_so_cot
FROM [NQT].[INFORMATION_SCHEMA].[COLUMNS]
WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'kho_ser1'
UNION ALL
SELECT 'real_us1',
       MAX(CASE WHEN COLUMN_NAME = 'event_perf' THEN 1 ELSE 0 END),
       MAX(CASE WHEN COLUMN_NAME = 'ac_registr' THEN 1 ELSE 0 END),
       COUNT(*)
FROM [NQT].[INFORMATION_SCHEMA].[COLUMNS]
WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'real_us1';

-- Kieu du lieu (de biet event_perf la SO hay CHU)
SELECT TABLE_NAME AS bang, COLUMN_NAME AS cot, DATA_TYPE AS kieu,
       CHARACTER_MAXIMUM_LENGTH AS do_dai
FROM [NQT].[INFORMATION_SCHEMA].[COLUMNS]
WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME IN ('kho_ser1','real_us1')
  AND COLUMN_NAME IN ('event_perf','ac_registr','on_ac','partno_off','serialno_o');
GO

/* ===== PHAN 2: DOC THU LINKED SERVER (Oracle) ==============================
   Neu PHAN nay loi hoac treo -> van de o LINKED SERVER, khong phai logic ghep. */
DECLARE @from      datetime     = '2026-07-01T00:00:00';   -- dau ky (>=)
DECLARE @to        datetime     = '2026-08-01T00:00:00';   -- cuoi ky (<, LOAI TRU)
DECLARE @tzOffset  int          = 7;                       -- AMOS (UTC) -> gio VN
DECLARE @amosEpoch varchar(10)  = '1971-12-31';            -- moc so ngay AMOS
DECLARE @top       int          = 200;                     -- gioi han dong khi test
DECLARE @fromDay int = DATEDIFF(DAY, TRY_CONVERT(datetime, @amosEpoch), @from) - 2;
DECLARE @toDay   int = DATEDIFF(DAY, TRY_CONVERT(datetime, @amosEpoch), @to)   + 2;
DECLARE @woFrom  int = @fromDay - 90;
DECLARE @woTo    int = @toDay   + 90;
SELECT TOP 5
       x.[EVENT_PERFNO_I], x.[PARTNO], x.[SERIALNO],
       x.[PARTNO_OFF], x.[SERIALNO_OFF], x.[MUTATION]
FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF] x
WHERE x.[MUTATION] BETWEEN @woFrom AND @woTo;
GO

/* ===== PHAN 3: DOI CHIEU SO LIEU VOI DASHBOARD ============================
   Vi sao dem tho ra 4416 nhung dashboard hien "Thiet bi xuat kho" it hon?
   Vi dashboard AP DUNG THEM cac bo loc nghiep vu + moc gio CHINH XAC.
   Bang duoi day tru dan tung buoc de thay ro so bien doi o dau.            */
DECLARE @from      datetime     = '2026-07-01T00:00:00';
DECLARE @to        datetime     = '2026-08-01T00:00:00';
DECLARE @tzOffset  int          = 7;
DECLARE @amosEpoch varchar(10)  = '1971-12-31';
DECLARE @fromDay int = DATEDIFF(DAY, TRY_CONVERT(datetime, @amosEpoch), @from) - 2;
DECLARE @toDay   int = DATEDIFF(DAY, TRY_CONVERT(datetime, @amosEpoch), @to)   + 2;

-- Bieu thuc doi gio AMOS -> gio VN (giong het app)
;WITH k AS (
  SELECT k.*,
         DATEADD(HOUR, @tzOffset,
           DATEADD(MILLISECOND,
             TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000),
             DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])),
                     TRY_CONVERT(datetime, @amosEpoch)))) AS issue_vn
  FROM [NQT].[dbo].[kho_ser1] k
  WHERE k.[vm] = 'T' AND k.[voucherno] LIKE 'P-%'
    AND k.[mutation] BETWEEN @fromDay AND @toDay
)
SELECT
  COUNT(*)                                                        AS [1_dem_tho_loc_+-2_ngay],
  SUM(CASE WHEN issue_vn >= @from AND issue_vn < @to
           THEN 1 ELSE 0 END)                                     AS [2_dung_moc_gio_chinh_xac],
  SUM(CASE WHEN issue_vn >= @from AND issue_vn < @to
            AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'
           THEN 1 ELSE 0 END)                                     AS [3_bo_costcenter_VN_SPL],
  SUM(CASE WHEN issue_vn >= @from AND issue_vn < @to
            AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'
            AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')
           THEN 1 ELSE 0 END)                                     AS [4_bo_store_MAIN_3RD],
  SUM(CASE WHEN issue_vn >= @from AND issue_vn < @to
            AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'
            AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')
            AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'
           THEN 1 ELSE 0 END)                                     AS [5_bo_condition_US_CON_LAI]
FROM k;

/* Dong [5] la tap phieu xuat ma dashboard XET. Tu tap nay dashboard con:
     - bo cac phieu cua trung tam CUVT (TAT CUVT do rieng),
     - nhanh "da doi ung" con doi hoi receiver <> '' va khu trung cap
       (1 phieu chi ghep 1 lan) -> mot so phieu khong roi vao ca 2 nhom.
   Nen KPI "Thiet bi xuat kho" = (da doi ung) + (chua doi ung) co the con
   NHO HON dong [5]. Kiem chung bang phep tinh cua chinh dashboard:
       Thiet bi xuat kho  -  Chua doi ung  =  So da doi ung
       (So da doi ung) / (Thiet bi xuat kho) x 100  =  Ty le doi ung %      */

-- So ban ghi "Other" (da tra US nhung CHUA co phieu xuat doi ung) trong cua so
SELECT COUNT(*) AS ban_ghi_other_trong_cua_so
FROM [NQT].[dbo].[real_us1] r
WHERE r.[on_ac] IS NOT NULL AND LTRIM(RTRIM(r.[on_ac])) <> ''
  AND r.[del_time] >= DATEADD(DAY,-30,@from) AND r.[del_time] < DATEADD(DAY,60,@to);

/* LUU Y QUAN TRONG: 199 ban ghi "Other" KHONG phai phan con lai cua 4416.
   Day la HAI TAP KHAC NHAU, nguoc chieu nhau:
     - Phieu xuat  : co XUAT nhung tim TRA       (thieu -> "chua doi ung")
     - Other       : co TRA  nhung thieu XUAT    (nguoc lai)
   Tab "Doi ung thu cong" chinh la cho ghep 2 tap nay lai voi nhau.          */
GO

/* ===== PHAN 4: TRUY VAN GHEP CAP — BAN THAT CUA APP =======================
   Day la SQL app thuc su gui xuong (sinh tu server.js).
   Xem thoi gian chay o goc duoi phai SSMS. Neu qua lau: giam @top, hoac thu
   ky ngan hon (vd 1 tuan), hoac chay docs/INDEXES.sql truoc.

   Cot can nhin:
     match_method  - ghep bang cach nao   |  confidence - do tin cay
     sug_*         - cap goi y (thiet bi thao + ban ghi tra)
     sug_serialno_off = NULL  ->  KHONG ghep duoc bang cach nao
   ========================================================================== */
DECLARE @from      datetime     = '2026-07-01T00:00:00';   -- dau ky (>=)
DECLARE @to        datetime     = '2026-08-01T00:00:00';   -- cuoi ky (<, LOAI TRU)
DECLARE @tzOffset  int          = 7;                       -- AMOS (UTC) -> gio VN
DECLARE @amosEpoch varchar(10)  = '1971-12-31';            -- moc so ngay AMOS
DECLARE @top       int          = 200;                     -- gioi han dong khi test
DECLARE @fromDay int = DATEDIFF(DAY, TRY_CONVERT(datetime, @amosEpoch), @from) - 2;
DECLARE @toDay   int = DATEDIFF(DAY, TRY_CONVERT(datetime, @amosEpoch), @to)   + 2;
DECLARE @woFrom  int = @fromDay - 90;
DECLARE @woTo    int = @toDay   + 90;

-- Don bang tam con sot tu lan chay loi truoc (connection pool dung lai
    -- cung phien -> #temp co the van ton tai va gay loi "already an object").
    IF OBJECT_ID('tempdb..#wo')    IS NOT NULL DROP TABLE #wo;
    IF OBJECT_ID('tempdb..#wo_ps') IS NOT NULL DROP TABLE #wo_ps;
    IF OBJECT_ID('tempdb..#wo_ev') IS NOT NULL DROP TABLE #wo_ev;
    IF OBJECT_ID('tempdb..#other') IS NOT NULL DROP TABLE #other;

    -- Tap "Other" (real_us1 co on_ac) trong cua so cua CA KY -> quet real_us1
    -- DUNG MOT LAN roi APPLY tren bang tam nho (truoc day quet lai theo TUNG
    -- dong ung vien -> rat cham tren du lieu that).
    SELECT RTRIM(r0.[partno_off]) AS partno_off,
           RTRIM(r0.[serialno_o]) AS serialno_off,
           r0.[labelno]   AS ret_labelno,
           r0.[voucher_s] AS ret_voucher,
           r0.[del_time]  AS ret_del_time,
           RTRIM(r0.[on_ac]) AS on_ac,
           RTRIM(ISNULL(r0.[ac_registr], '')) AS ac_registr,
           CASE
      WHEN TRY_CONVERT(bigint, r0.[event_perf]) IS NOT NULL
        THEN CONVERT(varchar(50), TRY_CONVERT(bigint, r0.[event_perf]))
      ELSE NULLIF(UPPER(LTRIM(RTRIM(CONVERT(varchar(50), r0.[event_perf])))), '')
    END AS event_key
    INTO #other
    FROM [NQT].[dbo].[real_us1] r0
    WHERE r0.[on_ac] IS NOT NULL AND LTRIM(RTRIM(r0.[on_ac])) <> ''
      AND r0.[del_time] IS NOT NULL AND r0.[del_time] >= '1902-01-01'
      -- Bao ham moi cua so cua tung dong: [gio xuat - 30, gio xuat + 60]
      AND r0.[del_time] >= DATEADD(DAY, -30, @from)
      AND r0.[del_time] <  DATEADD(DAY,  60, @to);
    CREATE INDEX IX_other_pn ON #other (partno_off);

    -- Keo WO_PART_ON_OFF (linked server Oracle) ve bang tam MOT LAN, roi join
    -- nhieu lan tren bang tam -> khong hoi linked server theo tung dong.
    SELECT RTRIM(x.[PARTNO]) AS partno_on, RTRIM(x.[SERIALNO]) AS serialno_on,
           RTRIM(x.[PARTNO_OFF]) AS part_off, RTRIM(x.[SERIALNO_OFF]) AS serial_off,
           CASE
      WHEN TRY_CONVERT(bigint, x.[EVENT_PERFNO_I]) IS NOT NULL
        THEN CONVERT(varchar(50), TRY_CONVERT(bigint, x.[EVENT_PERFNO_I]))
      ELSE NULLIF(UPPER(LTRIM(RTRIM(CONVERT(varchar(50), x.[EVENT_PERFNO_I])))), '')
    END AS event_key,
           TRY_CONVERT(float, x.[MUTATION]) AS mut
    INTO #wo
    FROM [DWH_DB]..[STG_AMOS].[WO_PART_ON_OFF] x
    WHERE x.[MUTATION] BETWEEN @woFrom AND @woTo
      AND x.[SERIALNO_OFF] IS NOT NULL AND LTRIM(RTRIM(x.[SERIALNO_OFF])) <> '';

    -- Ban ghi MOI NHAT theo (part, serial) da lap
    SELECT partno_on, serialno_on, part_off, serial_off
    INTO #wo_ps
    FROM (SELECT z.*, ROW_NUMBER() OVER (PARTITION BY z.partno_on, z.serialno_on
                                         ORDER BY z.mut DESC) AS rn FROM #wo z) a
    WHERE a.rn = 1;

    -- Ban ghi MOI NHAT theo EVENT (work order). PARTITION theo khoa chuan hoa
    -- -> moi event chi 1 dong -> LEFT JOIN ben duoi khong the nhan ban dong.
    SELECT event_key, part_off, serial_off
    INTO #wo_ev
    FROM (SELECT z.*, ROW_NUMBER() OVER (PARTITION BY z.event_key ORDER BY z.mut DESC) AS rn
          FROM #wo z WHERE z.event_key IS NOT NULL) a
    WHERE a.rn = 1;

    SELECT TOP (@top)
      k.[partno]     AS partno,          -- thiet bi XUAT KHO (lap len tau)
      k.[serialno]   AS serialno,
      k.[labelno]    AS labelno,         -- label cua phieu xuat
      k.[descriptio] AS description,
      k.[voucherno]  AS voucher_issue,
      k.[station]    AS station,
      k.[store]      AS store,
      k.[ac_registr] AS ac_registr,
      k.[event_perf] AS event_perf,
      k.[created_b2] AS staff,
      COALESCE(
      CASE WHEN LEFT(LTRIM(RTRIM(k.[created_b2])), 2) = 'PA' THEN 'PA' END,
      NULLIF(NULLIF(LTRIM(RTRIM(sm.[DEPARTMENT])), ''), 'UNKNOWN'),
      'PA') AS department,
      DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000), DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])), TRY_CONVERT(datetime, @amosEpoch)))) AS issue_time_vn,
      CAST(DATEDIFF(MINUTE, DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000), DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])), TRY_CONVERT(datetime, @amosEpoch)))), GETDATE()) AS float) / 1440.0 AS tat_days,
      -- Cap GOI Y. UU TIEN: [4] Other(on_ac) -> [1] WO theo part+serial ->
      -- [1b] WO theo EVENT -> [2] cung orderno/psn -> [3] cung tau.
      COALESCE(o4.partno_off,   w.part_off,   we.part_off,   o2.partno_off,   o3.partno_off)   AS sug_partno_off,
      COALESCE(o4.serialno_off, w.serial_off, we.serial_off, o2.serialno_off, o3.serialno_off) AS sug_serialno_off,
      CASE
        WHEN o4.serialno_off IS NOT NULL THEN N'Other (on_ac)'
        WHEN w.serial_off  IS NOT NULL   THEN N'WO_PART_ON_OFF'
        WHEN we.serial_off IS NOT NULL   THEN N'WO_PART_ON_OFF (theo event)'
        WHEN o2.serialno_off IS NOT NULL THEN N'Cùng orderno/psn'
        WHEN o3.serialno_off IS NOT NULL THEN N'Cùng tàu, gần thời gian'
        ELSE NULL
      END AS match_method,
      CASE
        -- Other: cham diem theo so tieu chi khop (event > tau > chi part no)
        WHEN o4.serialno_off IS NOT NULL THEN
          CASE WHEN o4.score >= 3 THEN N'Cao' WHEN o4.score = 2 THEN N'Trung bình' ELSE N'Thấp' END
        WHEN w.serial_off  IS NOT NULL   THEN N'Cao'
        WHEN we.serial_off IS NOT NULL   THEN N'Cao'
        WHEN o2.serialno_off IS NOT NULL THEN N'Trung bình'
        WHEN o3.serialno_off IS NOT NULL THEN N'Thấp'
        ELSE NULL
      END AS confidence,
      o4.on_ac      AS sug_on_ac,     -- ma ly do (NOI/ROB/DIR/CRO) neu ghep tu Other
      o4.match_note AS sug_match_note, -- cac tieu chi da khop (event / tau / part)
      -- Ban ghi TRA UNSERVICE cua thiet bi thao (ve con lai cua cap).
      -- Nguon [4] chinh la ban ghi tra -> lay truc tiep tu o4.
      COALESCE(o4.ret_labelno,  ret.ret_labelno)  AS sug_ret_labelno,
      COALESCE(o4.ret_voucher,  ret.ret_voucher)  AS sug_ret_voucher,
      COALESCE(o4.ret_del_time, ret.ret_del_time) AS sug_ret_del_time,
      CASE WHEN COALESCE(o4.ret_del_time, ret.ret_del_time) IS NOT NULL
        THEN CAST(DATEDIFF(MINUTE, DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000), DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])), TRY_CONVERT(datetime, @amosEpoch)))), COALESCE(o4.ret_del_time, ret.ret_del_time)) AS float) / 1440.0
      END AS sug_tat_days
    FROM [NQT].[dbo].[kho_ser1] k
    LEFT JOIN [NQT].[dbo].[real_us1] r
      ON k.[labelno] = r.[labelno] AND k.[voucherno] = r.[voucher_s]
    -- [4] UU TIEN 1: bang "Other" (real_us1 co on_ac) - thiet bi DA TRA US nhung
    --     chua co phieu xuat doi ung (dac biet ROB = thao xuong truoc).
    --     Cham diem: cung EVENT (WO) = 3 > cung PART + cung TAU = 2 > cung PART = 1.
    OUTER APPLY (
      SELECT TOP 1
             oa.partno_off, oa.serialno_off,
             oa.ret_labelno, oa.ret_voucher, oa.ret_del_time, oa.on_ac,
             CASE WHEN ((CASE
      WHEN TRY_CONVERT(bigint, k.[event_perf]) IS NOT NULL
        THEN CONVERT(varchar(50), TRY_CONVERT(bigint, k.[event_perf]))
      ELSE NULLIF(UPPER(LTRIM(RTRIM(CONVERT(varchar(50), k.[event_perf])))), '')
    END) IS NOT NULL AND oa.event_key IS NOT NULL AND oa.event_key = (CASE
      WHEN TRY_CONVERT(bigint, k.[event_perf]) IS NOT NULL
        THEN CONVERT(varchar(50), TRY_CONVERT(bigint, k.[event_perf]))
      ELSE NULLIF(UPPER(LTRIM(RTRIM(CONVERT(varchar(50), k.[event_perf])))), '')
    END)) THEN 3
                  WHEN (oa.partno_off = RTRIM(k.[partno])) AND (oa.ac_registr <> '' AND oa.ac_registr = RTRIM(ISNULL(k.[ac_registr], ''))) THEN 2
                  ELSE 1 END AS score,
             CASE WHEN ((CASE
      WHEN TRY_CONVERT(bigint, k.[event_perf]) IS NOT NULL
        THEN CONVERT(varchar(50), TRY_CONVERT(bigint, k.[event_perf]))
      ELSE NULLIF(UPPER(LTRIM(RTRIM(CONVERT(varchar(50), k.[event_perf])))), '')
    END) IS NOT NULL AND oa.event_key IS NOT NULL AND oa.event_key = (CASE
      WHEN TRY_CONVERT(bigint, k.[event_perf]) IS NOT NULL
        THEN CONVERT(varchar(50), TRY_CONVERT(bigint, k.[event_perf]))
      ELSE NULLIF(UPPER(LTRIM(RTRIM(CONVERT(varchar(50), k.[event_perf])))), '')
    END)) THEN N'Khớp event (WO)'
                  WHEN (oa.partno_off = RTRIM(k.[partno])) AND (oa.ac_registr <> '' AND oa.ac_registr = RTRIM(ISNULL(k.[ac_registr], ''))) THEN N'Khớp part no + số tàu'
                  ELSE N'Khớp part no' END AS match_note
      FROM #other oa
      -- Cua so +/- : ROB co the tra TRUOC ngay lam phieu xuat
      WHERE oa.ret_del_time >= DATEADD(DAY, -30, DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000), DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])), TRY_CONVERT(datetime, @amosEpoch)))))
        AND oa.ret_del_time <  DATEADD(DAY,  60, DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000), DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])), TRY_CONVERT(datetime, @amosEpoch)))))
        AND (((CASE
      WHEN TRY_CONVERT(bigint, k.[event_perf]) IS NOT NULL
        THEN CONVERT(varchar(50), TRY_CONVERT(bigint, k.[event_perf]))
      ELSE NULLIF(UPPER(LTRIM(RTRIM(CONVERT(varchar(50), k.[event_perf])))), '')
    END) IS NOT NULL AND oa.event_key IS NOT NULL AND oa.event_key = (CASE
      WHEN TRY_CONVERT(bigint, k.[event_perf]) IS NOT NULL
        THEN CONVERT(varchar(50), TRY_CONVERT(bigint, k.[event_perf]))
      ELSE NULLIF(UPPER(LTRIM(RTRIM(CONVERT(varchar(50), k.[event_perf])))), '')
    END)) OR (oa.partno_off = RTRIM(k.[partno])))
      ORDER BY score DESC, ABS(DATEDIFF(MINUTE, DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000), DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])), TRY_CONVERT(datetime, @amosEpoch)))), oa.ret_del_time)) ASC
    ) o4
    -- [1] WO_PART_ON_OFF theo (part, serial) da lap len tau
    LEFT JOIN #wo_ps w  ON w.partno_on = RTRIM(k.[partno]) AND w.serialno_on = RTRIM(k.[serialno])
    -- [1b] WO_PART_ON_OFF theo EVENT (work order) cua phieu xuat
    LEFT JOIN #wo_ev we ON we.event_key = (CASE
      WHEN TRY_CONVERT(bigint, k.[event_perf]) IS NOT NULL
        THEN CONVERT(varchar(50), TRY_CONVERT(bigint, k.[event_perf]))
      ELSE NULLIF(UPPER(LTRIM(RTRIM(CONVERT(varchar(50), k.[event_perf])))), '')
    END)
    -- [2] Cung ORDERNO/PSN: YE lap thiet bi vua xuat <-> YA thao
    OUTER APPLY (
      SELECT TOP 1 ya.[partno] AS partno_off, ya.[serialno] AS serialno_off
      FROM [NQT].[dbo].[on_off] ye
      INNER JOIN [NQT].[dbo].[on_off] ya
        ON ya.[orderno] = ye.[orderno] AND ya.[psn] = ye.[psn] AND ya.[vm] = 'YA'
      WHERE ye.[vm] = 'YE'
        AND ye.[partno] = k.[partno] AND ye.[serialno] = k.[serialno]
        AND ye.[mut_t] >= DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000), DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])), TRY_CONVERT(datetime, @amosEpoch))))
      ORDER BY ye.[mut_t] ASC
    ) o2
    -- [3] Cung SO TAU: YA gan nhat TRUOC gio lap YE
    OUTER APPLY (
      SELECT TOP 1 ya.[partno] AS partno_off, ya.[serialno] AS serialno_off
      FROM [NQT].[dbo].[on_off] ye
      INNER JOIN [NQT].[dbo].[on_off] ya
        ON ya.[ac_registr] = ye.[ac_registr] AND ya.[vm] = 'YA'
       AND ya.[mut_t] <= ye.[mut_t]
      WHERE ye.[vm] = 'YE'
        AND ye.[partno] = k.[partno] AND ye.[serialno] = k.[serialno]
        AND ye.[mut_t] >= DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000), DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])), TRY_CONVERT(datetime, @amosEpoch))))
        AND ye.[ac_registr] IS NOT NULL
      ORDER BY ye.[mut_t] ASC, ya.[mut_t] DESC
    ) o3
    -- Ban ghi tra unservice cua thiet bi THAO (cho cac nguon 1/1b/2/3)
    OUTER APPLY (
      SELECT TOP 1 r2.[labelno] AS ret_labelno, r2.[voucher_s] AS ret_voucher,
             r2.[del_time] AS ret_del_time
      FROM [NQT].[dbo].[real_us1] r2
      WHERE RTRIM(r2.[serialno_o]) = COALESCE(w.serial_off, we.serial_off, o2.serialno_off, o3.serialno_off)
        AND r2.[del_time] IS NOT NULL
        AND r2.[del_time] >= DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000), DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])), TRY_CONVERT(datetime, @amosEpoch))))
      ORDER BY r2.[del_time] ASC
    ) ret
    LEFT JOIN (
      SELECT [USER_SIGN], MAX([DEPARTMENT]) AS [DEPARTMENT]
      FROM [DWH_DB]..[STG_AMOS].[SIGN]
      GROUP BY [USER_SIGN]
    ) sm ON sm.[USER_SIGN] = k.[created_b2]
    WHERE k.[vm] = 'T'
      AND k.[voucherno] LIKE 'P-%'
      AND LTRIM(RTRIM(ISNULL(k.[costcenter], ''))) <> 'VN-SPL'
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[store], '')))) NOT IN ('MAIN','3RD')
      AND UPPER(LTRIM(RTRIM(ISNULL(k.[condition], '')))) <> 'US'
      AND COALESCE(
      CASE WHEN LEFT(LTRIM(RTRIM(k.[created_b2])), 2) = 'PA' THEN 'PA' END,
      NULLIF(NULLIF(LTRIM(RTRIM(sm.[DEPARTMENT])), ''), 'UNKNOWN'),
      'PA') <> 'CUVT'
      AND r.[partno] IS NULL                       -- chua doi ung theo label
      AND NOT EXISTS (
        SELECT 1 FROM [NQT].[dbo].[kho_ser1] tc
        WHERE tc.[vm] = 'TC' AND tc.[voucherno] LIKE 'P-CA-%'
          AND tc.[partno] = k.[partno] AND tc.[serialno] = k.[serialno]
          AND tc.[labelno] = k.[labelno])
      AND NOT (
    EXISTS (
      SELECT 1
      FROM [NQT].[dbo].[on_off] t1
      INNER JOIN [NQT].[dbo].[on_off] t2
        ON t2.[psn] = t1.[psn] AND t2.[orderno] = t1.[orderno]
       AND t2.[vm] = 'CI' AND t2.[location] = 'SHOPLOC'
      WHERE t1.[vm] = 'YA'
        AND t1.[labelno] = k.[labelno]
        AND t2.[mut_t] > DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000), DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])), TRY_CONVERT(datetime, @amosEpoch))))
    )
    AND EXISTS (
      SELECT 1 FROM [NQT].[dbo].[on_off] t3
      WHERE t3.[labelno] = k.[labelno]
        AND t3.[vm] = 'YE' AND t3.[higher_par] IS NULL
    )
  )                 -- chua doi ung kieu tra service
                  -- chua duoc doi ung THU CONG
      AND k.[mutation] BETWEEN @fromDay AND @toDay
      AND DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000), DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])), TRY_CONVERT(datetime, @amosEpoch)))) >= @from AND DATEADD(HOUR, @tzOffset, DATEADD(MILLISECOND, TRY_CONVERT(int, TRY_CONVERT(bigint, TRY_CONVERT(float, k.[mutation_t])) % 86400000), DATEADD(DAY, TRY_CONVERT(int, TRY_CONVERT(float, k.[mutation])), TRY_CONVERT(datetime, @amosEpoch)))) < @to
      
    ORDER BY issue_time_vn DESC;

    DROP TABLE #wo; DROP TABLE #wo_ps; DROP TABLE #wo_ev; DROP TABLE #other;
GO

/* ===== PHAN 6: VI TRI HIEN TAI (ROTABLES) cho "Xuat kho chua lap" =========
   Bao cao "Xuat kho chua lap" lay them cot Vi tri hien tai bang cach noi
   ROTABLES qua khoa [psn]. Chay phan nay de kiem tra:
     - Cot [psn] nam o bang nao (kho_ser1 hay chi co on_off)?
     - Doc duoc ROTABLES tren linked server khong?                           */
SELECT 'kho_ser1' AS bang, MAX(CASE WHEN COLUMN_NAME='psn' THEN 1 ELSE 0 END) AS co_psn
FROM [NQT].[INFORMATION_SCHEMA].[COLUMNS] WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='kho_ser1'
UNION ALL
SELECT 'on_off', MAX(CASE WHEN COLUMN_NAME='psn' THEN 1 ELSE 0 END)
FROM [NQT].[INFORMATION_SCHEMA].[COLUMNS] WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='on_off';

-- Doc thu ROTABLES (linked server Oracle)
SELECT TOP 5 [psn], [location] FROM [DWH_DB]..[STG_AMOS].[ROTABLES];

-- Thu chinh vi du nguoi dung dua
SELECT [psn], [location] FROM [DWH_DB]..[STG_AMOS].[ROTABLES] WHERE [psn] = 1064701;
GO

/* ===== PHAN 5: GHI CHU =====================================================
   Thu tu uu tien cac cach ghep (nhu tren dashboard):
     1. Other (on_ac)               - ROB/NOI/DIR/CRO, cham diem:
                                      khop event (WO) > part no + so tau > part no
     2. WO_PART_ON_OFF              - theo part + serial
     3. WO_PART_ON_OFF (theo event)
     4. Cung orderno/psn
     5. Cung tau, gan thoi gian

   Neu PHAN 4 chay OK o day nhung tren dashboard van loi -> gui log server
   (logs/) va anh chup thong bao loi de doi chieu.
   ========================================================================== */
