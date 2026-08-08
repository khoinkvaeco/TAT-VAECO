/**
 * SQLSPY - thay module 'mssql' bang ban GIA de LAY RA cau SQL that.
 * ---------------------------------------------------------------------------
 * Dung cho tools/sqlcheck.js. Moi cau lenh duoc ghi ra file (SQLSPY_OUT) va
 * tra ve KET QUA RONG, nho vay endpoint chay tiep den het thay vi dung o cau
 * dau tien - lay duoc nhieu cau lenh hon trong mot lan goi.
 *
 * KHONG dung file nay khi chay that.
 */
const Module = require('module');
const fs = require('fs');

const OUT = process.env.SQLSPY_OUT || '/tmp/sqlspy.jsonl';
fs.writeFileSync(OUT, '');

let current = '';
const fake = {
  ConnectionPool: class {
    constructor() {}
    connect() { return Promise.resolve(this); }
    on() {}
    request() {
      return {
        input() { return this; },
        query(text) {
          current = text;
          fs.appendFileSync(OUT, JSON.stringify({ sql: String(text) }) + '\n');
          // SQLSPY_DELAY_MS: gia lam truy van CHAM. Can cho cac phep do ve TAI
          // (hang doi, gop request): voi DB gia tra loi trong ~1ms thi con bao
          // ket thuc truoc khi kip do bat cu thu gi.
          const cho = Number(process.env.SQLSPY_DELAY_MS || 0);
          const kq = { recordset: [], recordsets: [] };
          if (cho > 0) return new Promise((r) => setTimeout(() => r(kq), cho));
          // Tra ve RONG (khong nem loi) de ham goi chay tiep cac buoc sau
          return Promise.resolve(kq);
        },
      };
    }
  },
  // Vai hang kieu du lieu phong khi server.js dung den
  Int: 'Int', BigInt: 'BigInt', VarChar: () => 'VarChar', NVarChar: () => 'NVarChar',
  Float: 'Float', DateTime: 'DateTime', Bit: 'Bit',
  get _last() { return current; },
};

const orig = Module._load;
Module._load = function (request) {
  if (request === 'mssql') return fake;
  return orig.apply(this, arguments);
};
