/**
 * Cau hinh Tailwind cho ban dung THAT (build ra public/vendor/tailwind.css).
 *
 * TRUOC DAY trang nap https://cdn.tailwindcss.com - script nay bien dich Tailwind
 * NGAY TREN TRINH DUYET. Hai van de:
 *   1. May noi bo bi chan ra Internet -> khong tai duoc -> trang VO layout
 *      (da gap that: ca ba menu chon nhieu luon mo va de len nhau).
 *   2. Moi luot mo trang deu lo IP + duong dan cho ben thu ba.
 * Nay bien dich san mot lan bang `npm run build:assets`.
 *
 * `content` phai liet ke CA public/*.js: script.js sinh ra HTML co class Tailwind
 * (vi du 'hidden', 'flex'), neu bo sot thi cac class do bi cat khoi file CSS.
 *
 * LOAI TRU wp.* : trang "Ra soat ho so bao duong" KHONG dung Tailwind, no co
 * bo CSS rieng (wp.css) voi he mau toi khac han dashboard. De no trong danh
 * sach quet thi cac ten class rieng cua no lam file tailwind.css phinh len va
 * doi vo ich moi lan sua trang do.
 */
module.exports = {
  content: ['./public/*.html', './public/*.js', '!./public/wp.html', '!./public/wp.js'],
  // An toan: mot so class chi xuat hien khi ghep chuoi trong JS nen Tailwind
  // khong "nhin thay" bang cach quet van ban. Giu lai bang tay.
  safelist: ['hidden', 'flex', 'items-center', 'gap-2'],
  theme: { extend: {} },
  plugins: [],
};
