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
