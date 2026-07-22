// 🇦🇺 AU 일일 브리핑 — 신규 주제 + 갱신 대상을 '제안'만 한다(생성은 버튼 클릭 뒤).
//
// 한국 briefing.mjs 의 '카드 → 버튼 → 생성' 흐름을 AU 에 이식:
//  · 신규 주제마다 [✍️ Generate] 버튼(callback_data = augen:<cardId>), kwmap 에 cardId→candidateId 기록.
//    버튼 클릭 → bot.mjs 의 au* 분기 → au-bot.handleCallback('augen') → 생성.
//  · 갱신 대상은 [🔄 Review update] 버튼(auupd:<id>) — 탭 시 진단 먼저(즉시 생성 안 함).
// 🔴 제안까지만(계약 §1). 하루 제안 2편(발행 상한 정책). 30일 재제안 쿨다운.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendMessage, inlineButtons } from '../lib/telegram.mjs';
import { buildPool } from './au-pool.mjs';
import { updateCandidates } from './au-update.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(HERE, '..', 'state', 'au');
const KWMAP = path.join(STATE_DIR, 'kwmap.json'); // { cardId: candidateId }  (augen 이 읽음)
const UPDMAP = path.join(STATE_DIR, 'updates.json'); // { updId: {slug,title,reasons} }
const BRIEFED = path.join(STATE_DIR, 'briefed.json'); // { candidateId: ISO }  재제안 쿨다운

const PROPOSAL_COUNT = 2; // 하루 신규 제안 수(발행 상한 정책)
const UPDATE_COUNT = 2;
const PROPOSE_COOLDOWN = 30 * 24 * 3600 * 1000;

function loadJson(p, d) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return d;
  }
}
function saveJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}
function shortId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function today() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

// 제안할 것들을 고른다(전송·쓰기 없음). { newCands, updates, lowStock, warnings }
export function buildBriefing() {
  const pool = buildPool();
  const briefed = loadJson(BRIEFED, {});
  const now = Date.now();
  const fresh = pool.candidates.filter((c) => {
    const t = briefed[c.id];
    return !t || now - Date.parse(t) > PROPOSE_COOLDOWN;
  });
  const newCands = fresh.slice(0, PROPOSAL_COUNT);
  const updates = updateCandidates(UPDATE_COUNT);
  return { newCands, updates, lowStock: pool.lowStock, warnings: pool.warnings, counts: pool.counts };
}

// 카드 텍스트 + 버튼 구성(전송 안 함). { text, rows, kwmap, updmap, briefedIds }
export function composeCard(b) {
  const lines = [`🇦🇺 *AU daily brief* — ${today()}`, ''];
  const rows = [];
  const kwmap = {};
  const updmap = {};
  const briefedIds = [];

  // 신규
  if (b.newCands.length) {
    lines.push(`✍️ *New topics* (${b.newCands.length}):`);
    b.newCands.forEach((c, i) => {
      const cardId = shortId(c.id);
      kwmap[cardId] = c.id;
      briefedIds.push(c.id);
      lines.push(`${i + 1}. [${c.axis}] ${c.title}${c.timeSensitive ? '  ⏳' : ''}`);
      const label = c.title.length > 32 ? c.title.slice(0, 30) + '…' : c.title;
      rows.push([{ text: `✍️ Generate: ${label}`, callback_data: `augen:${cardId}` }]);
    });
  } else {
    lines.push(`✍️ *New topics*: none available (pool exhausted or all recently proposed).`);
  }

  // 갱신 — 없으면 정직하게 표시(계약 §7·§8)
  lines.push('');
  if (b.updates.length) {
    lines.push(`📋 *Updates* (${b.updates.length}):`);
    b.updates.forEach((u) => {
      const updId = shortId('upd:' + u.slug);
      updmap[updId] = { slug: u.slug, title: u.title, reasons: u.reasons };
      lines.push(`• ${u.title}\n   ↳ ${u.reasons.join(' · ')}`);
      const label = u.title.length > 32 ? u.title.slice(0, 30) + '…' : u.title;
      rows.push([{ text: `🔄 Review update: ${label}`, callback_data: `auupd:${updId}` }]);
    });
  } else {
    lines.push(`📋 *Updates*: no update candidates yet (site is new / no stale content).`);
  }

  if (b.lowStock) lines.push('', `⚠️ AU pool low (${b.counts.available} left) — add verified topics to au-pool.mjs.`);
  if (b.warnings?.length) lines.push('', `⚠️ ${b.warnings.join(' · ')}`);
  lines.push('', `Tap ✍️ Generate to draft. Nothing is published until you press ✅ Publish.`);

  return { text: lines.join('\n'), rows, kwmap, updmap, briefedIds };
}

// 카드를 실제로 보낸다(+상태 기록). /au 와 launchd 둘 다 이걸 쓴다.
export async function sendBriefingCard(chatId) {
  const b = buildBriefing();
  const { text, rows, kwmap, updmap, briefedIds } = composeCard(b);

  // kwmap·updmap 은 누적(과거 카드 버튼도 유효하게), briefed 는 쿨다운 갱신
  saveJson(KWMAP, { ...loadJson(KWMAP, {}), ...kwmap });
  saveJson(UPDMAP, { ...loadJson(UPDMAP, {}), ...updmap });
  const briefed = loadJson(BRIEFED, {});
  const iso = new Date().toISOString();
  for (const id of briefedIds) briefed[id] = iso;
  saveJson(BRIEFED, briefed);

  return sendMessage(chatId, text, rows.length ? { parse_mode: 'Markdown', ...inlineButtons(rows) } : { parse_mode: 'Markdown' });
}

// launchd standalone 진입점(추후 11:00 등록). env 에서 토큰·chat id 로드.
export async function runBriefing() {
  const { loadEnv } = await import('../lib/env.mjs');
  loadEnv();
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID 없음');
  return sendBriefingCard(chatId);
}

// dry-run: node au-briefing.mjs        (전송·쓰기 없음 — 카드 미리보기)
// 실제 전송: node au-briefing.mjs --send  (launchd 가 부를 경로)
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--send')) {
    runBriefing().then((r) => console.log('sent:', r?.message_id)).catch((e) => {
      console.error('send failed:', e.message);
      process.exit(1);
    });
  } else {
    const b = buildBriefing();
    const { text, rows } = composeCard(b);
    console.log('=== au-briefing dry-run (전송·쓰기 없음) ===\n');
    console.log(text);
    console.log('\n--- buttons ---');
    rows.forEach((r) => r.forEach((btn) => console.log(`  [${btn.text}]  → ${btn.callback_data}`)));
  }
}
