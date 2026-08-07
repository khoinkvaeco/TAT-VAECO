#!/usr/bin/env node
/**
 * DUNG THU VIEN GIAO DIEN VAO public/vendor/ - KHONG con phu thuoc CDN.
 *
 * VI SAO: index.html truoc day nap 5 file tu cdn.tailwindcss.com / jsdelivr /
 * unpkg / cdnjs. Hau qua:
 *   - May noi bo bi chan ra Internet thi trang VO layout hoac trang trang.
 *     Da gap that khi chay kiem thu giao dien: Tailwind khong tai duoc nen
 *     `.hidden` khong ton tai -> ca ba menu chon nhieu luon mo va de len nhau.
 *   - Moi luot mo trang deu gui IP + duong dan trang cho ben thu ba.
 *   - Ban Tailwind CDN la ban "play", chinh Tailwind khuyen cao KHONG dung cho
 *     production (bien dich lai CSS ngay tren trinh duyet moi lan mo trang).
 *
 * CACH DUNG:
 *   node tools/build-assets.js          # dung lai public/vendor/
 *   node tools/build-assets.js --check  # KHONG ghi gi, chi bao co lech khong
 *
 * `--check` chay trong `npm run smoke`. No bat dung mot cai bay that: ai do
 * them class Tailwind moi vao HTML/JS ma quen chay lai build -> class do khong
 * co trong file CSS -> giao dien lech ma khong ai biet.
 *
 * Nguon: node_modules (da ghim phien ban trong package.json), KHONG tai mang.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'public', 'vendor');
const CHECK = process.argv.includes('--check');

/** Cac file chi can CHEP thang tu node_modules. */
const COPY = [
  ['chart.js/dist/chart.umd.js', 'chart.umd.js'],
  ['tabulator-tables/dist/js/tabulator.min.js', 'tabulator.min.js'],
  ['tabulator-tables/dist/css/tabulator.min.css', 'tabulator.min.css'],
  ['xlsx/dist/xlsx.full.min.js', 'xlsx.full.min.js'],
];

const lech = [];   // mo ta cac cho khong khop (chi dung o che do --check)

function ghiHoacSoSanh(dich, noiDung, ten) {
  if (!CHECK) {
    fs.writeFileSync(dich, noiDung);
    console.log(`  ✔ ${ten}  ${(noiDung.length / 1024).toFixed(0)} KB`);
    return;
  }
  if (!fs.existsSync(dich)) { lech.push(`${ten}: CHUA CO trong public/vendor/`); return; }
  const cu = fs.readFileSync(dich);
  if (!cu.equals(Buffer.from(noiDung))) lech.push(`${ten}: KHAC voi ban dung lai`);
  else console.log(`  ✔ ${ten}`);
}

function main() {
  if (!CHECK) fs.mkdirSync(VENDOR, { recursive: true });

  // --- 1. Chep thang cac thu vien dung san ---
  for (const [nguon, ten] of COPY) {
    const p = path.join(ROOT, 'node_modules', nguon);
    if (!fs.existsSync(p)) {
      const msg = `Thieu ${nguon} - chay \`npm install\` truoc.`;
      if (CHECK) { lech.push(msg); continue; }
      throw new Error(msg);
    }
    ghiHoacSoSanh(path.join(VENDOR, ten), fs.readFileSync(p), ten);
  }

  // --- 2. Bien dich Tailwind tu chinh HTML/JS cua du an ---
  const cli = path.join(ROOT, 'node_modules', '.bin', 'tailwindcss');
  if (!fs.existsSync(cli)) {
    const msg = 'Thieu tailwindcss (devDependency) - chay `npm install`.';
    if (CHECK) { lech.push(msg); }
    else throw new Error(msg);
  } else {
    // Luon dung ra file tam roi moi so sanh/di chuyen: khong bao gio de lai
    // public/vendor/tailwind.css hong giua chung neu CLI loi.
    const tam = path.join(os.tmpdir(), `tw-${process.pid}.css`);
    execFileSync(cli, [
      '-c', path.join(ROOT, 'tailwind.config.js'),
      '-i', path.join(__dirname, 'tailwind-src.css'),
      '-o', tam, '--minify',
    ], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    const css = fs.readFileSync(tam);
    fs.unlinkSync(tam);
    ghiHoacSoSanh(path.join(VENDOR, 'tailwind.css'), css, 'tailwind.css');
  }

  if (!CHECK) {
    console.log('\n✔ Xong. Da dung lai public/vendor/ tu node_modules (khong tai mang).');
    return;
  }
  if (lech.length) {
    console.error('\n✘ public/vendor/ KHONG khop voi ma nguon hien tai:');
    lech.forEach((v) => console.error('    · ' + v));
    console.error('\n  Chay `npm run build:assets` roi commit lai public/vendor/.');
    process.exit(1);
  }
  console.log('\n✔ DAT: public/vendor/ khop voi ma nguon hien tai.');
}

main();
