/**
 * ============================================================================
 *  llm.js  -  "Cong tac" goi MO HINH AI NOI BO (local LLM) - TUY CHON
 *  - Chi hoat dong khi cau hinh LLM_URL trong .env (mac dinh TAT).
 *  - KHOA AN TOAN: chi cho phep goi endpoint trong MANG NOI BO (private/LAN).
 *    Neu LLM_URL tro ra dia chi PUBLIC -> TU CHOI goi (tranh gui du lieu ra
 *    ngoai pham vi cong ty) tru khi bat LLM_ALLOW_PUBLIC=true (khong khuyen nghi).
 *  - Ho tro Ollama (/api/chat) va endpoint OpenAI-compatible (/v1/chat/completions).
 * ============================================================================
 */
'use strict';

const CFG = {
  url: process.env.LLM_URL || '',                 // vd: http://10.0.0.5:11434/api/chat
  model: process.env.LLM_MODEL || 'qwen2.5:7b',
  timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || '20000', 10),
  allowPublic: String(process.env.LLM_ALLOW_PUBLIC || 'false').toLowerCase() === 'true',
};

/** LLM co duoc bat khong (da cau hinh URL). */
function isEnabled() {
  return !!CFG.url;
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
  if (!CFG.url) return 'chua cau hinh LLM_URL';
  if (!isPrivateHost(CFG.url) && !CFG.allowPublic) {
    return `LLM_URL (${CFG.url}) KHONG thuoc mang noi bo -> tu choi de tranh gui du lieu ra ngoai`;
  }
  return null;
}

/**
 * Goi LLM noi bo. system + user -> tra ve text.
 * Nem loi neu bi chan (public host) hoac loi mang/timeout -> caller tu fallback.
 */
async function ask(system, user) {
  const reason = blockReason();
  if (reason) throw new Error('LLM khong kha dung: ' + reason);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);
  try {
    const res = await fetch(CFG.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: CFG.model,
        stream: false,
        // Ollama va OpenAI-compatible deu nhan 'messages'
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        options: { temperature: 0.2 },
      }),
    });
    if (!res.ok) throw new Error('LLM HTTP ' + res.status);
    const data = await res.json();
    // Ollama: data.message.content ; OpenAI: data.choices[0].message.content
    const text =
      (data.message && data.message.content) ||
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ||
      '';
    return String(text).trim();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isEnabled, isPrivateHost, blockReason, ask, CFG };
