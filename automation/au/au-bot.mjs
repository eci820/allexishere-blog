// AU 봇 통합 계층 — bot.mjs 가 부르는 유일한 진입점.
//
// 🔴 bot.mjs 는 이 모듈을 '동적 import' 로 try/catch 안에서 로드한다. 여기서 무슨 일이
//    나도(임포트 에러·런타임 throw) 한국 봇은 죽지 않는다(폴링 루프·한국 경로 무관).
// 🔴 au 관련 카드·버튼·상태는 전부 영어. 콜백은 au* 접두사(한국 콜백과 분리).
// 🔴 발행·생성은 전부 사람 버튼 뒤. 생성은 후보당 CLI 1회(구독). 실패는 fail-loud.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendMessage, answerCallback, inlineButtons } from '../lib/telegram.mjs';
import { AU_ROOT, AU_BLOG, guardAuRealpath } from './au-guard.mjs';
import { buildPool } from './au-pool.mjs';
import { generateDraft } from './au-generate.mjs';
import { publish as auPublish } from './au-publish.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(HERE, '..', 'state', 'au');
const DRAFTS = path.join(STATE_DIR, 'drafts.json'); // { cardId: {slug,title} }
const KWMAP = path.join(STATE_DIR, 'kwmap.json'); // { cardId: candidateId }  (브리핑 augen 용)
const UPDMAP = path.join(STATE_DIR, 'updates.json'); // { updId: {slug,title,reasons} }  (auupd 용)
const GENQ = path.join(STATE_DIR, 'genqueue.json'); // [candidateId,…]  (재시작 복구용)
const PUBDAYS = path.join(STATE_DIR, 'publish-days.json'); // { 'YYYY-MM-DD': count }  발행 하드캡
const PUBLISH_CAP_PER_DAY = 2; // 🔴 발행 상한(하드캡) — 승인 흐름과 별개의 마지막 방어선

function loadJson(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return dflt;
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

let queue = []; // [{candidate, chatId}]
let busy = false;

const todayKey = () => new Date().toISOString().slice(0, 10);
function checkPublishCap() {
  const days = loadJson(PUBDAYS, {});
  const count = days[todayKey()] || 0;
  return { ok: count < PUBLISH_CAP_PER_DAY, count };
}
function recordPublish() {
  const days = loadJson(PUBDAYS, {});
  days[todayKey()] = (days[todayKey()] || 0) + 1;
  saveJson(PUBDAYS, days);
}

function log(msg) {
  console.log(`[au-bot] ${msg}`);
}

// 🔴 bot.mjs 부팅 시 1회. AU repo 가 없으면 throw → bot.mjs 가 catch → AU 비활성(한국 정상).
export async function init() {
  if (!fs.existsSync(AU_ROOT)) throw new Error(`AU repo not found: ${AU_ROOT}`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const pend = loadJson(GENQ, []);
  if (pend.length) log(`recovered ${pend.length} pending gen (not auto-run — re-trigger via /au or briefing)`);
  saveJson(GENQ, []);
  const pool = buildPool();
  log(`enabled — ${pool.counts.available} candidates available, ${pool.counts.published} published`);
}

function persistQueue() {
  saveJson(GENQ, queue.map((q) => q.candidate.id));
}

function enqueue(candidate, chatId) {
  queue.push({ candidate, chatId });
  persistQueue();
  drain();
}

async function drain() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const { candidate, chatId } = queue[0];
      try {
        const r = await generateDraft(candidate, { dryRun: false });
        const cardId = registerDraft(r);
        await sendDraftCard(chatId, cardId, r);
      } catch (e) {
        await sendMessage(chatId, `🇦🇺 ❌ Generation failed — ${candidate.title}\n${e.message}`);
      }
      queue.shift();
      persistQueue();
    }
  } finally {
    busy = false;
  }
}

function registerDraft(r) {
  const drafts = loadJson(DRAFTS, {});
  const cardId = shortId(r.slug);
  drafts[cardId] = { slug: r.slug, title: r.title };
  saveJson(DRAFTS, drafts);
  return cardId;
}

async function sendDraftCard(chatId, cardId, r) {
  const warn = [];
  if (r.checks?.titleBodyMismatch?.length) warn.push(`⚠️ title axes not in body: ${r.checks.titleBodyMismatch.join(', ')}`);
  if (r.checks?.gmapUnknown?.length) warn.push(`⚠️ unregistered map ids (no link): ${r.checks.gmapUnknown.join(', ')}`);
  if (r.checks?.unverifiedSources?.length) warn.push(`⚠️ ${r.checks.unverifiedSources.length} source(s) unverified — facts marked "unverified"`);
  const text = [
    `🇦🇺 *Draft ready* — ${r.title}`,
    `slug: \`${r.slug}\``,
    `sources used: ${r.sufficientCount}/${r.sources.length} · pain points in title: ${r.checks?.painPoints ?? '?'}`,
    warn.length ? warn.join('\n') : '✅ checks clean',
    ``,
    `Review the draft locally, then choose:`,
  ].join('\n');
  const rows = [
    [
      { text: '👁 View full draft', callback_data: `auview:${cardId}` },
      { text: '✏️ Edit', callback_data: `auedit:${cardId}` },
    ],
    [
      { text: '✅ Publish', callback_data: `auok:${cardId}` },
      { text: '❌ Reject', callback_data: `auno:${cardId}` },
    ],
  ];
  return sendMessage(chatId, text, { parse_mode: 'Markdown', ...inlineButtons(rows) });
}

// ── /au <query> : 수동 생성 ───────────────────────────────────────────────
export async function handleCommand(arg, chatId) {
  const q = String(arg || '').trim().toLowerCase();
  if (!q) {
    // 🔴 주 사용 흐름 = 클릭. 인자 없으면 브리핑 카드(주제 제안 + [✍️ Generate] 버튼)를 보낸다.
    //    (수동 조회는 /au <query> 로 특정 주제를 바로 생성.)
    const { sendBriefingCard } = await import('./au-briefing.mjs');
    return sendBriefingCard(chatId);
  }
  const pool = buildPool();
  let match = pool.candidates.find((c) => c.id === q);
  if (!match) {
    const hits = pool.candidates.filter((c) => c.id.includes(q) || c.title.toLowerCase().includes(q) || c.subject.includes(q));
    if (hits.length === 0) return sendMessage(chatId, `🇦🇺 No match for "${arg}". Send /au with no argument to list options.`);
    if (hits.length > 1) {
      const lines = hits.slice(0, 8).map((c) => `• \`${c.id}\` — ${c.title}`);
      return sendMessage(chatId, `🇦🇺 Multiple matches — reply \`/au <id>\`:\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
    }
    match = hits[0];
  }
  await sendMessage(chatId, `🇦🇺 Generating draft: ${match.title} …`);
  enqueue(match, chatId);
}

// ── au* 콜백 ─────────────────────────────────────────────────────────────
export async function handleCallback(action, id, cb) {
  const chatId = cb.message?.chat?.id;

  if (action === 'augen') {
    // 브리핑 카드 → 후보 생성
    const candidateId = loadJson(KWMAP, {})[id];
    const cand = candidateId ? buildPool().candidates.find((c) => c.id === candidateId) : null;
    if (!cand) return answerCallback(cb.id, 'Candidate not found');
    await answerCallback(cb.id, 'Generating…');
    await sendMessage(chatId, `🇦🇺 Generating draft: ${cand.title} …`);
    enqueue(cand, chatId);
    return;
  }

  if (action === 'auupd') {
    // 갱신 리뷰 — 즉시 생성하지 않고 진단(무엇이 낡았는지)부터. 한국과 동일 철학.
    const upd = loadJson(UPDMAP, {})[id];
    if (!upd) return answerCallback(cb.id, 'Update target not found');
    await answerCallback(cb.id, 'Diagnosing…');
    const { diagnose } = await import('./au-update.mjs');
    const dg = diagnose(upd.slug);
    const txt = dg.ok
      ? `🇦🇺 📋 *Update review* — ${dg.title}\nscore ${dg.score} · last updated: ${dg.lastUpdated || 'never'}\n${dg.reasons.map((r) => '• ' + r).join('\n')}\n\n(Refresh generation is wired when a real candidate first appears — none yet, so this is diagnosis only.)`
      : `🇦🇺 diagnose failed: ${dg.error}`;
    await sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    return;
  }

  const drafts = loadJson(DRAFTS, {});
  const d = drafts[id];
  if (!d) return answerCallback(cb.id, 'Draft not found (expired?)');

  if (action === 'auview') {
    // 전문 보기 — 초안 md 를 텍스트로 전송(자동 분할). 한국과 동일(문서첨부 아님).
    const file = path.join(AU_BLOG, `${d.slug}.md`);
    if (!fs.existsSync(file)) {
      await sendMessage(chatId, `🇦🇺 file not found: ${d.slug}`);
      return answerCallback(cb.id, 'not found');
    }
    await answerCallback(cb.id, 'Sending full draft…');
    const md = fs.readFileSync(file, 'utf8');
    await sendMessage(chatId, `📖 ${d.title}\n\n${md}`); // sendMessage 가 3800자에서 자동 분할
    return;
  }
  if (action === 'auok') {
    const cap = checkPublishCap();
    if (!cap.ok) {
      await sendMessage(chatId, `🇦🇺 ⛔ Daily publish cap reached (${cap.count}/${PUBLISH_CAP_PER_DAY}). Try again tomorrow.`);
      return answerCallback(cb.id, 'Cap reached');
    }
    try {
      const { url } = auPublish(d.slug);
      recordPublish();
      await sendMessage(chatId, `🇦🇺 ✅ Published: ${url}`);
    } catch (e) {
      await sendMessage(chatId, `🇦🇺 ❌ Publish failed — ${d.slug}\n${e.message}`);
    }
    return answerCallback(cb.id, 'Publish');
  }
  if (action === 'auedit') {
    const file = path.join(AU_BLOG, `${d.slug}.md`);
    await sendMessage(chatId, `🇦🇺 ✏️ Edit locally, then press ✅ Publish:\n\`${file}\``, { parse_mode: 'Markdown' });
    return answerCallback(cb.id, 'Edit locally');
  }
  if (action === 'auno') {
    try {
      const file = guardAuRealpath(path.join(AU_BLOG, `${d.slug}.md`)); // 🔴 AU 안만 삭제
      fs.rmSync(file, { force: true });
      delete drafts[id];
      saveJson(DRAFTS, drafts);
      await sendMessage(chatId, `🇦🇺 ❌ Rejected & draft deleted: ${d.slug}`);
    } catch (e) {
      await sendMessage(chatId, `🇦🇺 reject failed: ${e.message}`);
    }
    return answerCallback(cb.id, 'Rejected');
  }
  return answerCallback(cb.id, 'Unknown AU action');
}
