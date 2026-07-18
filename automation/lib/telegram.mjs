// 텔레그램 Bot API 헬퍼 (raw fetch, 의존성 없음).
const API = (method) =>
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;

async function call(method, params = {}) {
  const res = await fetch(API(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} 실패: ${data.description}`);
  return data.result;
}

// 4096자 제한 대응: 길면 나눠 보냄
export async function sendMessage(chatId, text, opts = {}) {
  const CHUNK = 3800;
  if (text.length <= CHUNK) {
    return call('sendMessage', { chat_id: chatId, text, ...opts });
  }
  let last;
  for (let i = 0; i < text.length; i += CHUNK) {
    last = await call('sendMessage', {
      chat_id: chatId,
      text: text.slice(i, i + CHUNK),
      // 버튼(reply_markup)은 마지막 조각에만
      ...(i + CHUNK >= text.length ? opts : {}),
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
