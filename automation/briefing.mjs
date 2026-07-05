// 키워드 브리핑: 하루 3회 후보 8~10개를 인라인 버튼으로 텔레그램에 전송.
// 버튼 탭 = 그 키워드로 초안 생성(bot.mjs 가 처리). 발행/기출 주제는 제외.
import fs from 'node:fs';
import path from 'node:path';
import { AUTO_DIR, loadConfig } from './lib/env.mjs';
import { briefingCandidates } from './keywords.mjs';
import { sendMessage, inlineButtons } from './lib/telegram.mjs';

const STATE = path.join(AUTO_DIR, 'state');
const BRIEFED = path.join(STATE, 'briefed.json'); // keyword -> ts (30일 보관)
const KWMAP = path.join(STATE, 'kwmap.json'); // id -> {keyword, source, gossip}

const load = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };

export async function runBriefing({ chatId, config } = {}) {
  config = config || loadConfig();
  fs.mkdirSync(STATE, { recursive: true });

  // 이전 브리핑에 나온 주제(30일) 제외
  const briefed = load(BRIEFED);
  const cut = Date.now() - 30 * 864e5;
  for (const k of Object.keys(briefed)) if (briefed[k] < cut) delete briefed[k];
  const exclude = new Set(Object.keys(briefed));

  const { candidates, source, note } = await briefingCandidates(config, exclude);
  if (!candidates.length) {
    if (chatId) await sendMessage(chatId, '🗞 브리핑: 새 후보가 없습니다(모두 발행/기출).');
    return 0;
  }

  const kwmap = load(KWMAP);
  const rows = [];
  let n = Object.keys(kwmap).length;
  for (const c of candidates) {
    const id = 'k' + Math.abs(hash(c.keyword)).toString(36) + '_' + n++;
    kwmap[id] = c;
    briefed[c.keyword] = Date.now();
    const icon = c.gossip ? '⚠️' : c.source === 'evergreen' ? '🌲' : '🔥';
    rows.push([{ text: `${icon} ${c.keyword.slice(0, 44)}`, callback_data: 'gen:' + id }]);
  }
  fs.writeFileSync(KWMAP, JSON.stringify(kwmap, null, 1));
  fs.writeFileSync(BRIEFED, JSON.stringify(briefed));

  const header =
    `🗞 키워드 브리핑 (${source || 'evergreen'}${note ? ', ⚠️' + note : ''})\n` +
    `탭하면 그 키워드로 초안을 만들어 승인 대기로 보냅니다.\n여러 개 탭하면 순차 생성됩니다. (🔥실검 🌲에버그린 ⚠️가십주의)`;
  await sendMessage(chatId, header, inlineButtons(rows));
  return candidates.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv, requireSecrets } = await import('./lib/env.mjs');
  loadEnv();
  requireSecrets(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  await runBriefing({ chatId: process.env.TELEGRAM_CHAT_ID, config: loadConfig() });
}
