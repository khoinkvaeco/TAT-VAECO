/**
 * ============================================================================
 *  llm.js  -  "Cong tac" goi MO HINH AI cho tro ly TAT - TUY CHON, MAC DINH TAT
 *  ---------------------------------------------------------------------------
 *  Ho tro 2 nha cung cap (LLM_PROVIDER):
 *   1) 'local'     : LLM noi bo (Ollama /api/chat hoac OpenAI-compatible).
 *                    KHOA AN TOAN: chi cho phep endpoint MANG NOI BO (LAN),
 *                    tru khi LLM_ALLOW_PUBLIC=true.
 *   2) 'anthropic' : LLM DAM MAY (Claude Messages API). Vi day la dich vu
 *                    CONG CONG (gui du lieu RA NGOAI cong ty) nen:
 *                    - Bat buoc LLM_ALLOW_PUBLIC=true (nguoi quan tri xac nhan).
 *                    - MAC DINH CHE (redact) cac dinh danh nhay cam (part/serial/
 *                      label/so tau) TRUOC KHI gui (LLM_REDACT=true).
 *                    - Can LLM_API_KEY (khong hardcode; dat trong .env).
 *
 *  Nguyen tac: chi dung LLM cho cau hoi bot CHUA hieu / nguoi dung bao sai;
 *  cau hoi so lieu cu the van do rule-based xu ly (khong gui ra ngoai).
 * ============================================================================
 */
'use strict';

const CFG = {
  // 'local' | 'anthropic' | '' (tat). Neu khong dat nhung co LLM_URL -> coi la 'local'.
  provider: (process.env.LLM_PROVIDER || (process.env.LLM_URL ? 'local' : '')).trim().toLowerCase(),
  // --- Chung ---
  model: (process.env.LLM_MODEL || '').trim(),
  timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || '20000', 10),
  allowPublic: String(process.env.LLM_ALLOW_PUBLIC || 'false').toLowerCase() === 'true',
  // --- local (Ollama / OpenAI-compatible) ---
  url: process.env.LLM_URL || '',                 // vd: http://10.0.0.5:11434/api/chat
  // --- anthropic (dam may) ---
  apiKey: (process.env.LLM_API_KEY || '').trim(),
  maxTokens: parseInt(process.env.LLM_MAX_TOKENS || '600', 10),
  // Che dinh danh nhay cam truoc khi gui ra dam may (mac dinh BAT).
  redact: String(process.env.LLM_REDACT || 'true').toLowerCase() !== 'false',
};

/** Model mac dinh theo nha cung cap. */
function modelName() {
  if (CFG.model) return CFG.model;
  return CFG.provider === 'anthropic' ? 'claude-opus-4-8' : 'qwen2.5:7b';
}

/** LLM co duoc bat khong (da chon provider + du cau hinh toi thieu). */
function isEnabled() {
  if (CFG.provider === 'anthropic') return !!CFG.apiKey;
  if (CFG.provider === 'local') return !!CFG.url;
  return false;
}

/** Host co thuoc mang NOI BO (private/LAN/loopback) khong. */
function isPrivateHost(urlStr) {
  let host;
  try {
    host = new URL(urlStr).hostname.toLowerCase();
  } catch (_) {
    return false;
  }
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) return true;
  // IPv4 private ranges
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // Ten may LAN: khong co dau '.' (netbios) hoac hau to noi bo
  if (!host.includes('.')) return true;
  if (/\.(local|lan|internal|corp|intra|intranet)$/.test(host)) return true;
  return false;
}

/** Ly do khong the goi LLM (de log/hien thi), hoac null neu OK. */
function blockReason() {
  if (!CFG.provider) return 'chua chon LLM_PROVIDER';
  if (CFG.provider === 'anthropic') {
    if (!CFG.apiKey) return 'chua cau hinh LLM_API_KEY';
    if (!CFG.allowPublic) {
      return 'LLM dam may gui du lieu RA NGOAI cong ty -> can bat LLM_ALLOW_PUBLIC=true de xac nhan';
    }
    return null;
  }
  if (CFG.provider === 'local') {
    if (!CFG.url) return 'chua cau hinh LLM_URL';
    if (!isPrivateHost(CFG.url) && !CFG.allowPublic) {
      return `LLM_URL (${CFG.url}) KHONG thuoc mang noi bo -> tu choi de tranh gui du lieu ra ngoai`;
    }
    return null;
  }
  return `LLM_PROVIDER khong hop le: ${CFG.provider}`;
}

/**
 * CHE (redact) cac dinh danh nhay cam truoc khi gui ra dich vu dam may.
 * Muc tieu: khong lo Part No / Serial No / Label / So tau ra ben ngoai.
 * Cau hoi nghiep vu/dinh nghia van du nghia sau khi che (ten trung tam khong
 * co chu so nen giu nguyen; vd "CNBDNT", "TAT install").
 */
function redact(text) {
  let s = String(text || '');
  // So tau: VN-A868, VNA868...
  s = s.replace(/\bVN-?[A-Z0-9]{3,5}\b/gi, '[TÀU]');
  // Part number so co dau gach: vd 3214352-5, 2-1234-56
  s = s.replace(/\b\d{2,}(?:-\d+)+\b/g, '[MÃ]');
  // Chuoi ky tu vua-chu-vua-so (part/serial), do dai >= 5: vd ABC1234, 65B12345
  s = s.replace(/\b(?=[A-Z0-9][A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{4,}\b/gi, '[MÃ]');
  // Chuoi so dai >= 5 (label/serial thuan so)
  s = s.replace(/\b\d{5,}\b/g, '[MÃ]');
  return s;
}

/** Goi LLM DAM MAY (Anthropic Messages API) qua SDK chinh thuc. */
async function askAnthropic(system, user) {
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (_) {
    throw new Error("chua cai '@anthropic-ai/sdk' (chay: npm i @anthropic-ai/sdk)");
  }
  const client = new Anthropic({ apiKey: CFG.apiKey, timeout: CFG.timeoutMs });
  const msg = await client.messages.create({
    model: modelName(),
    max_tokens: CFG.maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (msg.stop_reason === 'refusal') {
    throw new Error('mo hinh tu choi tra loi (refusal)');
  }
  const block = (msg.content || []).find((b) => b.type === 'text');
  return block ? String(block.text || '').trim() : '';
}

/** Goi LLM NOI BO (Ollama / OpenAI-compatible) qua fetch. */
async function askLocal(system, user) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);
  try {
    const res = await fetch(CFG.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelName(),
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        options: { temperature: 0.2 },
      }),
    });
    if (!res.ok) throw new Error('LLM HTTP ' + res.status);
    const data = await res.json();
    const text =
      (data.message && data.message.content) ||
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ||
      '';
    return String(text).trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Goi LLM. system + user -> tra ve { text, redacted, provider }.
 * - Voi provider 'anthropic' va LLM_REDACT=true: che dinh danh nhay cam trong `user`.
 * - Nem loi neu bi chan (blockReason) hoac loi mang -> caller tu fallback.
 */
async function ask(system, user) {
  const reason = blockReason();
  if (reason) throw new Error('LLM khong kha dung: ' + reason);

  const isCloud = CFG.provider === 'anthropic';
  const sent = isCloud && CFG.redact ? redact(String(user || '')) : String(user || '');
  const text = isCloud ? await askAnthropic(system, sent) : await askLocal(system, sent);
  return { text, redacted: isCloud && CFG.redact, provider: CFG.provider, sent };
}

module.exports = {
  isEnabled, isPrivateHost, blockReason, redact, ask, modelName, CFG,
};
