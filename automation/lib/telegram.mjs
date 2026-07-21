// 텔레그램 Bot API 헬퍼 (raw fetch, 의존성 없음).
const API = (method) =>
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;

// 네트워크성 오류만 판별한다(DNS·타임아웃·연결 리셋 등). API 오류(!data.ok, 예: 401
// Unauthorized·400)는 재시도해도 낫지 않으므로 여기서 걸러 즉시 던지게 한다.
const NET_RE = /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EHOSTUNREACH|Connect Timeout|socket hang up|network/i;
function isNetworkError(e) {
  const s = `${e?.message || e} | ${e?.cause?.code || ''} | ${e?.cause?.message || ''}`;
  return NET_RE.test(s);
}

// retries: 네트워크 오류 시 추가 재시도 횟수(기본 0 = 재시도 안 함). getUpdates·answerCallback
// 처럼 폴링 루프가 자체 주기로 재시도하는 경로는 0 그대로 둔다 — 여기서 막으면 폴링이 멈춘다.
// 전송(sendMessage·sendDocument)만 켠다. API 오류는 retries 와 무관하게 첫 시도에서 던진다.
async function call(method, params = {}, { retries = 0, retryGapMs = 30000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(API(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(`Telegram ${method} 실패: ${data.description}`);
      return data.result;
    } catch (e) {
      if (attempt < retries && isNetworkError(e)) {
        console.error(`[telegram] ${method} 네트워크 실패 — ${Math.round(retryGapMs / 1000)}s 후 재시도(${attempt + 1}/${retries}): ${e.message}`);
        await new Promise((r) => setTimeout(r, retryGapMs));
        continue;
      }
      throw e;
    }
  }
}

// 4096자 제한 대응: 길면 나눠 보냄.
// opts 에 retries·retryGapMs 를 넣으면 네트워크 오류 시 재시도한다(기본 3회·30초).
// 나머지 opts(reply_markup 등)는 그대로 텔레그램 파라미터로 전달.
export async function sendMessage(chatId, text, opts = {}) {
  const { retries = 3, retryGapMs = 30000, ...msgOpts } = opts;
  const send = (params) => call('sendMessage', params, { retries, retryGapMs });
  const CHUNK = 3800;
  if (text.length <= CHUNK) {
    return send({ chat_id: chatId, text, ...msgOpts });
  }
  let last;
  for (let i = 0; i < text.length; i += CHUNK) {
    last = await send({
      chat_id: chatId,
      text: text.slice(i, i + CHUNK),
      // 버튼(reply_markup)은 마지막 조각에만
      ...(i + CHUNK >= text.length ? msgOpts : {}),
    });
  }
  return last;
}

// 마크다운 파일 첨부로 전문 전송
export async function sendDocument(chatId, filename, content, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([content], { type: 'text/markdown' }), filename);
  const res = await fetch(API('sendDocument'), { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(`sendDocument 실패: ${data.description}`);
  return data.result;
}

// ── 📷 파일 수신(현장 캡처 발행) ──────────────────────────
// Bot API 제약: 봇이 받을 수 있는 파일은 최대 20MB. 초과분은 getFile 단계에서 거절된다.
export const TG_FILE_LIMIT = 20 * 1024 * 1024;

// file_id → 텔레그램 서버상의 상대 경로(file_path). 만료 전(1시간) 다운로드에 씀.
export async function getFile(fileId) {
  return call('getFile', { file_id: fileId });
}

// file_path 를 실제 바이트로. 토큰이 URL 에 들어가므로 로그에 찍지 않는다.
export async function downloadFile(filePath) {
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`파일 다운로드 실패(HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('빈 파일');
  return buf;
}

// file_id 하나를 바이트로 (getFile → download 합본).
export async function fetchFileBytes(fileId) {
  const info = await getFile(fileId);
  if (info.file_size && info.file_size > TG_FILE_LIMIT) {
    throw new Error(`파일이 20MB를 넘습니다(${Math.round(info.file_size / 1e6)}MB) — 텔레그램 봇 수신 한도`);
  }
  return downloadFile(info.file_path);
}

export async function getUpdates(offset, timeoutSec) {
  return call('getUpdates', {
    offset,
    timeout: timeoutSec,
    allowed_updates: ['message', 'callback_query'],
  });
}

export async function answerCallback(id, text) {
  try {
    await call('answerCallbackQuery', { callback_query_id: id, text: text || '' });
  } catch {
    /* 만료된 콜백은 무시 */
  }
}

export function inlineButtons(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}
