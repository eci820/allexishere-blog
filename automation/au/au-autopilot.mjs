#!/usr/bin/env node
// 🇦🇺🤖 AU autopilot — au.allexishere.com 하루 N편 자동 작성·검증·발행 (2026-11-26, 사용자 지시: "호주도 마찬가지로").
//
// 한국 automation/autopilot.mjs 와 같은 원칙, 호주 저장소·호주 안전막으로:
//   주제(au-pool 큐레이션 후보 → 소진 시 au-scout 화제 주제) → 상위 노출 글 분석(serp, en) →
//   au-generate(공식 출처 원문만 사실로 사용 + 분석·교훈·문체 지시) → 하네스(en: 검증·수정·재채점) →
//   관문 통과 시 au-publish(가드·락·명시적 git add) / 불통과 시 state/au/rejected 로 폐기 후 다른 주제.
// 🔴 한국 무영향(README 절대 규칙): 쓰기·git 은 au-generate/au-publish 의 guardAuRealpath 경로로만.
//    상태는 state/au/ 에만. 텔레그램은 같은 채팅이지만 모든 문구에 🇦🇺 접두 — 한국 알림과 구분.
// 사람 승인 없음(사용자 지시). 품질 관문이 마지막 장치. 멈춤: /au autopause · /au autoresume (au-bot) 또는 config.auAutopilot.enabled=false.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, loadConfig } from '../lib/env.mjs';

loadEnv();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.resolve(HERE, '..', 'state', 'au');
const FILE = path.join(STATE, 'autopilot.json');
const LOCK = path.join(STATE, 'autopilot.lock');
const ME = process.env.TELEGRAM_CHAT_ID;
const DRY = process.argv.includes('--dry-run');
const NOW = process.argv.includes('--now') || DRY;
const DAY = 24 * 3600 * 1000;

const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const kstHM = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(11, 16);
export function loadState() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { paused: false, runs: [] }; } }
export function saveState(s) { fs.mkdirSync(STATE, { recursive: true }); s.runs = (s.runs || []).slice(-400); fs.writeFileSync(FILE, JSON.stringify(s, null, 1)); }
// 구독 한도·CLI 오류로 글을 쓰지도 못한 실패는 시도로 치지 않는다 — 2026-11-27: 몇 초 만에 끝난 한도 실패 6건이
// 하루 상한(10)을 채워 저녁 슬롯이 아예 돌지 않았고, 그 주제들은 30일간 다시 안 뽑혔다.
const cliFail = (r) => r.result === 'failed' && /종료코드|한도|limit|시간 초과|claude 실행 실패/.test(String(r.why || ''));
function acquireLock() {
  fs.mkdirSync(STATE, { recursive: true });
  try { if (Date.now() - fs.statSync(LOCK).mtimeMs < 50 * 60 * 1000) return false; } catch {}
  fs.writeFileSync(LOCK, String(process.pid)); return true;
}
const releaseLock = () => { try { fs.unlinkSync(LOCK); } catch {} };
const touchLock = () => { try { fs.utimesSync(LOCK, new Date(), new Date()); } catch {} };

const VOICE_EN = `
[SOUND HUMAN — readers and Google both punish mass-produced AI text]
- Write like a knowledgeable local who checked the official pages, not a brochure. Never invent visits or experiences; show checking via sources ("Transport for NSW says…").
- Vary sentence length; use some short sentences. Avoid three-item lists, "delve/landscape/tapestry/navigate", "In conclusion", "Whether you're…", "Hope this helps".
- Em-dashes: at most 3 in the whole article. Bold: at most 5. No emoji except the 📍 map links.
- Answer the search query directly in the first 1–2 sentences. Put the core search phrase early in the title, in the first paragraph and in one H2.
- Don't end every title with "(2026)" or "Guide". Don't close with a generic disclaimer paragraph; put "as of" dates next to the facts they belong to.`;

async function pickCandidate(state) {
  const tried = new Set(state.runs.filter((r) => Date.now() - Date.parse(r.ts) < 30 * DAY && !cliFail(r)).map((r) => r.id));
  const { pickForBriefing } = await import('./au-pool.mjs');
  const curated = pickForBriefing(5, tried)[0];
  // 검색어 = 장소명 + 핵심 구(콜론 뒤 앞 3단어). 제목 전체를 검색어로 쓰면 SEO 검사가 'avoid' 같은 단어까지 요구한다(2026-11-27 실측).
  if (curated) {
    const [head, tail = ''] = String(curated.title).split(':');
    const kw = (curated.keyword || `${head} ${tail.trim().split(/\s+/).slice(0, 3).join(' ')}`).replace(/[^\w\s'-]/g, ' ').replace(/^\s*the\s+/i, '').replace(/\s+/g, ' ').trim();
    return { cand: { ...curated, keyword: kw }, origin: 'curated' };
  }
  const { loadScoutPool } = await import('./au-scout.mjs');
  const s = loadScoutPool().items.find((i) => i.status === 'pending' && !tried.has(i.id));
  return s ? { cand: s, origin: 'scout' } : { cand: null };
}

function archive(slug) {
  try {
    const { AU_BLOG } = { AU_BLOG: path.resolve(HERE, '..', '..', '..', 'allexishere-au', 'src', 'content', 'blog') };
    const src = path.join(AU_BLOG, `${slug}.md`);
    if (!fs.existsSync(src)) return null;
    const dst = path.join(STATE, 'rejected', `${slug}.md`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    return dst;
  } catch (e) { console.error('[au-autopilot] archive failed:', e.message); return null; }
}

export async function runAuAutopilot() {
  const cfg = loadConfig();
  const ap = cfg.auAutopilot || {};
  if (!ap.enabled) return console.log('[au-autopilot] disabled');
  const state = loadState();
  if (state.paused) return console.log('[au-autopilot] paused');
  // 🔴 구독 한도 백오프(2026-11-27 실측: 한도에 걸린 CLI 가 '종료코드 1'만 남겨 매 시도가 연쇄 실패)
  if (state.backoffUntil && Date.now() < Date.parse(state.backoffUntil)) return console.log('[autopilot] 한도 백오프 중 — ' + state.backoffUntil);
  if (!acquireLock()) return console.log('[au-autopilot] another run in progress');
  const { sendMessage } = await import('../lib/telegram.mjs');
  try {
    if (!NOW) { const w = Math.floor(Math.random() * ((ap.jitterMinutes ?? 25) + 1)); console.log(`[au-autopilot] jitter ${w}m`); await new Promise((r) => setTimeout(r, w * 60000)); touchLock(); }
    const tries = Math.max(1, ap.attemptsPerSlot ?? 2);
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (attempt > 1) { Object.assign(state, loadState()); touchLock(); }
      if (state.paused) return;
      const today = kstToday();
      const perDay = ap.perDay || 5;
      const done = state.runs.filter((r) => r.day === today && r.result === 'published').length;
      const attempts = state.runs.filter((r) => r.day === today && !cliFail(r)).length;
      if (done >= perDay) return console.log(`[au-autopilot] target met ${done}/${perDay}`);
      if (attempts >= (ap.maxAttemptsPerDay || perDay * 3)) return console.log('[au-autopilot] daily attempt cap');

      if (!DRY && attempt === 1) {
        try {
          const { lessonsStale, buildLessons } = await import('../lib/lessons.mjs');
          if (lessonsStale(7, 'au')) console.log('[au-autopilot] lessons:', (await buildLessons(cfg, { site: 'au' })).note);
        } catch (e) { console.error('[au-autopilot] lessons failed:', e.message); }
      }
      let { cand, origin } = await pickCandidate(state);
      if (!cand && state.lastScout !== today && !DRY) {
        const { runAuScout } = await import('./au-scout.mjs');
        const s = await runAuScout(cfg);
        Object.assign(state, { lastScout: today, lastScoutNote: s.note }); saveState(state);
        console.log('[au-autopilot]', s.note);
        ({ cand, origin } = await pickCandidate(state));
      }
      if (!cand) { console.log('[au-autopilot] no candidate'); return; }
      console.log(`[au-autopilot] topic: ${cand.title} (${origin}) · today ${done}/${perDay}`);
      if (DRY) return;

      const run = { ts: new Date().toISOString(), day: today, id: cand.id, keyword: cand.keyword, title: cand.title, origin };
      state.runs.push({ ...run, result: 'started' }); saveState(state);
      const rec = () => { const s = loadState(); return { s, r: s.runs.find((x) => x.ts === run.ts) || run }; };

      // 1) 상위 노출 글 분석 + 교훈 + 문체 → au-generate 에 추가 지시로
      const { serpBrief, serpForPrompt } = await import('../lib/serp.mjs');
      const sb = cfg.serp?.enabled !== false ? await serpBrief(cand.keyword, cfg, { lang: 'en' }) : { brief: null };
      let lessons = '';
      try { lessons = (await import('../lib/lessons.mjs')).lessonsForPrompt('au'); } catch {}
      const extra = serpForPrompt(sb.brief, 'en') + lessons + VOICE_EN;
      touchLock();

      // 2) 생성(공식 출처 원문만 사실로)
      const { generateDraft } = await import('./au-generate.mjs');
      let g;
      try { g = await generateDraft(cand, { extra }); } catch (e) {
        const { s, r } = rec(); Object.assign(r, { result: 'failed', why: String(e.message).slice(0, 160) }); saveState(s);
        if (/종료코드 1|limit|한도/i.test(e.message)) { const s2 = loadState(); s2.backoffUntil = new Date(Date.now() + 90 * 60000).toISOString(); saveState(s2); console.log('[au-autopilot] claude failure (likely quota) → 90m backoff'); return; }
        if (/auth|login/i.test(e.message)) { if (ME) await sendMessage(ME, `🇦🇺 자동 발행 중단: ${String(e.message).slice(0, 120)}`); return; }
        continue;
      }
      if (!g.wrote) {
        const { s, r } = rec(); Object.assign(r, { result: 'held', why: [g.heldReason || 'not written'] }); saveState(s);
        if (origin === 'scout') (await import('./au-scout.mjs')).markScout(cand.id, 'no-source');
        continue;
      }
      touchLock();

      // 3) 하네스(en)
      const { AU_BLOG } = await import('./au-guard.mjs');
      const f = path.join(AU_BLOG, `${g.slug}.md`);
      const raw = fs.readFileSync(f, 'utf8');
      const m = raw.match(/^(---\n[\s\S]*?\n---\n+)([\s\S]*)$/);
      const fm = m[1], body = m[2].trim();
      const fmv = (k) => { const v = (fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1] || ''; try { return JSON.parse(v); } catch { return v.replace(/^"|"$/g, ''); } };
      const { runHarness, passesGate, harnessCardLine, logHarness } = await import('../lib/harness.mjs');
      const h = await runHarness({ title: fmv('title'), description: fmv('description'), body }, { keyword: cand.keyword, opts: { source: 'au-' + (cand.cls || 'info') }, config: cfg, minChars: 0, lang: 'en', serp: sb.brief });
      const warnings = [];
      if (g.checks?.gmapUnknown?.length) warnings.push(`unknown map ids: ${g.checks.gmapUnknown.join(', ')}`);
      const gate = passesGate(h.report, { warnings }, cfg.harness || {});
      h.report.serpUsed = !!sb.brief;
      logHarness(STATE, g.slug, h.report, gate);

      if (!gate.pass) {
        const { s, r } = rec(); Object.assign(r, { result: 'discarded', slug: g.slug, why: gate.why, archived: archive(g.slug) });
        if (gate.why.some((w) => /종료코드 1/.test(w))) { s.backoffUntil = new Date(Date.now() + 90 * 60000).toISOString(); saveState(s); console.log('[au-autopilot] claude failure in harness → 90m backoff'); return; }
        saveState(s);
        console.log(`[au-autopilot] gate failed → discarded: ${cand.title} — ${gate.why.join(' / ')}`);
        if (origin === 'scout') (await import('./au-scout.mjs')).markScout(cand.id, 'discarded');
        continue;
      }
      // 수정본 반영(제목·설명·본문) — guard 는 au-publish 가 다시 검증한다
      let nfm = fm.replace(/^title:.*$/m, `title: ${JSON.stringify(h.draft.title)}`).replace(/^description:.*$/m, `description: ${JSON.stringify(h.draft.description)}`);
      fs.writeFileSync(f, nfm + h.draft.body.trim() + '\n', 'utf8');

      // 4) 발행
      const { publish } = await import('./au-publish.mjs');
      let p;
      try { p = publish(g.slug); } catch (e) {
        const { s, r } = rec(); Object.assign(r, { result: 'publish-failed', slug: g.slug, why: String(e.message).slice(0, 160), archived: archive(g.slug) }); saveState(s);
        if (ME) await sendMessage(ME, `🇦🇺 자동 발행 실패(배포 문제): ${h.draft.title}\n${String(e.message).slice(0, 160)}`);
        return;
      }
      const { s, r } = rec(); Object.assign(r, { result: 'published', slug: g.slug, url: p.url }); saveState(s);
      if (origin === 'scout') (await import('./au-scout.mjs')).markScout(cand.id, 'published', { slug: g.slug });
      const n = s.runs.filter((x) => x.day === today && x.result === 'published').length;
      if (ME) await sendMessage(ME, `🇦🇺🤖 AU 자동 발행 (오늘 ${n}/${perDay})\n📝 ${h.draft.title}\n🔗 ${p.url}\n${harnessCardLine(h.report)}`);
      return;
    }
  } catch (e) {
    console.error('[au-autopilot] error:', e);
    if (ME) await sendMessage(ME, `🇦🇺 자동 발행 오류: ${String(e.message).slice(0, 150)}`).catch(() => {});
  } finally {
    try { await dailySummary(cfg.auAutopilot || {}, sendMessage); } catch {}
    releaseLock();
  }
}

async function dailySummary(ap, sendMessage) {
  const s = loadState(), today = kstToday();
  const runs = s.runs.filter((r) => r.day === today), pub = runs.filter((r) => r.result === 'published');
  if (s.summarySent === today || DRY || !ME) return;
  if (pub.length < (ap.perDay || 5) && kstHM() < (ap.summaryAfter || '19:30')) return;
  const c = (k) => runs.filter((r) => r.result === k).length;
  await sendMessage(ME, `🇦🇺🤖 AU 오늘 자동 발행 요약 (${today})\n✅ 발행 ${pub.length}/${ap.perDay || 5}\n` +
    pub.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url || ''}`).join('\n') +
    `\n🗑 관문 불통과 폐기 ${c('discarded')} · ⏸ 출처 부족 보류 ${c('held')} · ❌ 실패 ${c('failed')}` +
    (s.lastScout === today && s.lastScoutNote ? `\n${s.lastScoutNote}` : '') + `\n\n멈추려면 /au autopause`);
  s.summarySent = today; saveState(s);
}

if (import.meta.url === `file://${process.argv[1]}`) await runAuAutopilot();
