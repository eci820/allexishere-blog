// 브리핑 전송 재전송 큐 — genqueue 의 '재시작 후 유실 통지' 패턴을 그대로 딴다.
//
// 왜 필요한가: briefing.mjs 는 주제 선정을 sendMessage 직전에 persist 한다. 그래서
// 전송이 네트워크로 실패하면(이동/절전 중 fire) 선정은 남지만 카드는 유실된다.
// telegram.sendMessage 의 짧은 재시도(30초×3)로 못 넘긴 긴 단절은, 카드를 파일에
// 남겨 다음 브리핑 실행이나 봇 기동에서 재전송한다.
//
// 🔴 중복 발송 방지: 카드마다 안정적 id(본문 해시)로 구분한다. 이미 대기 중이면 안 쌓고,
//    재전송에 성공하면 파일에서 지운다 — 파일의 '부재'가 곧 '전송 완료' 플래그다.
//    kwmap.json 은 병합식이라 지난 카드의 버튼 id 도 유효하게 남는다(재전송해도 버튼 동작).
import fs from 'node:fs';
import path from 'node:path';
import { AUTO_DIR } from './env.mjs';
import { sendMessage, inlineButtons } from './telegram.mjs';

const PENDING = path.join(AUTO_DIR, 'state', 'briefing-pending.json');
const MAX_TRIES = 5; // 재전송을 이만큼 실패하면 폐기한다(무한 누적 방지).

const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };

function load() { try { return JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch { return []; } }
function save(arr) {
  try {
    if (!arr.length) { fs.rmSync(PENDING, { force: true }); return; } // 비면 파일을 남기지 않는다
    fs.mkdirSync(path.dirname(PENDING), { recursive: true });
    fs.writeFileSync(PENDING, JSON.stringify(arr, null, 1));
  } catch (e) { console.error('[briefing] 재전송 대기 저장 실패:', e.message); }
}

// 전송 실패한 카드를 대기열에 남긴다. 같은 카드(id)는 중복으로 쌓지 않는다.
export function stashPending({ text, rows = [], id } = {}) {
  if (!text) return null;
  id = id || 'b' + Math.abs(hash(text)).toString(36);
  const arr = load();
  if (arr.some((p) => p.id === id)) return id; // 이미 대기 중
  arr.push({ id, text, rows, ts: Date.now(), tries: 0 });
  save(arr);
  return id;
}

// 대기 중인 카드를 재전송한다. 성공분은 제거(=전송 완료), 실패분은 tries++ 후 남긴다.
// 다음 브리핑 실행(선정 전)과 봇 기동에서 호출한다. 반환: { sent, kept }.
export async function flushPending(chatId) {
  const arr = load();
  if (!arr.length) return { sent: 0, kept: 0 };
  const keep = [];
  let sent = 0;
  for (const p of arr) {
    try {
      // 재전송은 짧게만 시도한다(30초×3 긴 재시도는 최초 전송의 몫). 여기서 실패하면
      // 파일에 남겨 다음 기회(다음 브리핑·봇 기동)에 다시 시도하므로 기동을 오래 막지 않는다.
      await sendMessage(chatId, p.text, {
        ...(p.rows.length ? inlineButtons(p.rows) : {}),
        retries: 2, retryGapMs: 2000,
      });
      sent++; // keep 에 넣지 않음 → 파일에서 사라짐
    } catch (e) {
      const tries = (p.tries || 0) + 1;
      console.error(`[briefing] 미전송 카드 재전송 실패(${tries}/${MAX_TRIES}): ${e.message}`);
      if (tries < MAX_TRIES) keep.push({ ...p, tries });
      else console.error(`[briefing] ${MAX_TRIES}회 실패 — 카드 폐기(${p.id})`);
    }
  }
  save(keep);
  return { sent, kept: keep.length };
}

export const PENDING_PATH = PENDING;
