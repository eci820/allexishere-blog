#!/usr/bin/env node
// 🤖 autopilot — 하루 N편 자동 작성·검증·발행 (2026-11-25 신설, 사용자 지시).
//
// 사용자 지시: "하루 5개씩 니가 알아서 업로드까지. 내가 선택하지 않고."
//              "다만 AI 가 양산해서 저품질이 되지 않도록 철저하게(시기·방식·종류)."
//
// 🔴 이 파일은 운영 원칙 §7('자동 게시 경로는 없다')을 사용자 지시로 바꾼 유일한 예외 경로다.
//    그래서 사람 대신 '품질 관문(lib/harness.passesGate)'이 승인 역할을 한다. 관문을 못 넘은 글은
//    버리지 않고 기존 초안 카드로 보내 사람이 판단한다(손실 없음). 발행은 기존 publish() 로만 한다(계약 §3).
//
// 양산 방지 장치:
//   · 한 번 실행 = 최대 1편. launchd 가 하루 5개 시각(config.autopilot.slots)에 부르고, 매번 0~jitter 분
//     더 기다린다 → 발행 시각이 매일 같지 않고 한꺼번에 몰리지 않는다.
//   · ramp: 2→3→5편/일. 🔴 2026-07-18~19 이틀 34편 발행 직후 사이트 전체 노출이 0이 됐다(GSC 실측).
//   · 분야 순환: 직전 2편과 같은 series 는 피한다. 🅿️ 주차는 하루 1편까지(도어웨이 신호 방지).
//   · YMYL(건강·금융·부동산)·실검은 자동 대상에서 제외(config.autopilot.excludeTiers).
//   · 같은 키워드는 30일 안에 다시 시도하지 않는다(보류된 초안이 매 슬롯 재생성되는 것 방지).
//
// 멈춤: 텔레그램 /autopause · 재개 /autoresume · 상태 /autostatus (bot.mjs) — 또는 config.autopilot.enabled=false.
//
// 사용:
//   node automation/autopilot.mjs            # 정상 실행(지터 대기 포함)
//   node automation/autopilot.mjs --now      # 지터 없이 즉시
//   node automation/autopilot.mjs --dry-run  # 주제 선택까지만 출력(생성·발행·전송 없음)
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, loadConfig, AUTO_DIR } from './lib/env.mjs';

loadEnv();
const STATE = path.join(AUTO_DIR, 'state');
const FILE = path.join(STATE, 'autopilot.json');
const LOCK = path.join(STATE, 'autopilot.lock');
const ME = process.env.TELEGRAM_CHAT_ID; // 🇰🇷 한국 봇 채팅. 호주(au-*)와 섞지 않는다.
const DRY = process.argv.includes('--dry-run');
const NOW = process.argv.includes('--now') || DRY;
const DAY = 24 * 3600 * 1000;

const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
export function loadState() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { paused: false, runs: [] }; }
}
export function saveState(s) {
  s.runs = (s.runs || []).slice(-400);
  fs.writeFileSync(FILE, JSON.stringify(s, null, 1));
}
export function perDayFor(ap, day = kstToday()) {
  const ramp = ap.ramp || [];
  let n = ramp.length ? ramp[0].perDay : ap.targetPerDay || 5; // 램프 시작 전엔 가장 낮은 단계
  for (const r of ramp) if (r.from <= day) n = r.perDay;
  if (ramp.length && ramp[ramp.length - 1].from <= day) n = Math.min(n, ap.targetPerDay || n);
  return n;
}

function acquireLock() {
  try {
    const st = fs.statSync(LOCK);
    if (Date.now() - st.mtimeMs < 50 * 60 * 1000) return false; // 50분 안 된 잠금 = 다른 실행 중
  } catch {}
  fs.writeFileSync(LOCK, String(process.pid));
  return true;
}
const releaseLock = () => { try { fs.unlinkSync(LOCK); } catch {} };

// ── 주제 선택 ──
async function pickTopic(cfg, state) {
  const { loadPool, savePool, nicheAllows, liveDupe } = await import('./lib/topicsPool.mjs');
  const ap = cfg.autopilot;
  const pool = loadPool();
  const today = kstToday();
  const todays = state.runs.filter((r) => r.day === today && r.result === 'published');
  const parkingToday = todays.some((r) => r.tier === 'parking' || r.series === 'parking');
  const lastSeries = state.runs.filter((r) => r.result === 'published').slice(-2).map((r) => r.series);
  const tried = new Set(state.runs.filter((r) => Date.now() - Date.parse(r.ts) < 30 * DAY).map((r) => r.keyword));
  const now = Date.now();

  const cand = pool.topics.filter((t) =>
    t.status === 'pending' &&
    !(ap.excludeTiers || []).includes(t.tier) &&
    nicheAllows(t, cfg) &&
    !tried.has(t.keyword) &&
    !(parkingToday && (t.tier === 'parking' || t.series === 'parking')) &&
    !lastSeries.includes(t.series || t.tier)
  );
  const fresh = (t) => t.origin === 'scout' && now - Date.parse(t.addedAt) < 14 * DAY;
  cand.sort((a, b) =>
    (fresh(b) - fresh(a)) ||
    ((b.metrics?.stars || 0) - (a.metrics?.stars || 0)) ||
    (Date.parse(a.addedAt || 0) - Date.parse(b.addedAt || 0))
  );
  let dirty = false;
  for (const t of cand) {
    const m = liveDupe(t.keyword, t.tier);
    if (m) { t.status = 'published'; t.slug = m.slug; t.publishedNote = 'live-match'; dirty = true; continue; }
    if (dirty) savePool(pool);
    return { topic: t, freshLeft: cand.filter(fresh).length };
  }
  if (dirty) savePool(pool);
  return { topic: null, freshLeft: 0 };
}

export async function runAutopilot() {
  const cfg = loadConfig();
  const ap = cfg.autopilot || {};
  if (!ap.enabled) return console.log('[autopilot] config.autopilot.enabled=false — 건너뜀');
  const state = loadState();
  if (state.paused) return console.log('[autopilot] /autopause 상태 — 건너뜀');
  if (!acquireLock()) return console.log('[autopilot] 다른 실행이 진행 중 — 건너뜀');
  const { sendMessage } = await import('./lib/telegram.mjs');
  try {
    if (!NOW) {
      const wait = Math.floor(Math.random() * ((ap.jitterMinutes ?? 25) + 1));
      console.log(`[autopilot] 지터 ${wait}분 대기`);
      await new Promise((r) => setTimeout(r, wait * 60 * 1000));
      fs.utimesSync(LOCK, new Date(), new Date()); // 잠금 갱신
    }
    const today = kstToday();
    const perDay = perDayFor(ap, today);
    const done = state.runs.filter((r) => r.day === today && r.result === 'published').length;
    const attempts = state.runs.filter((r) => r.day === today).length;
    if (done >= perDay) return console.log(`[autopilot] 오늘 목표 달성 ${done}/${perDay}`);
    if (attempts >= perDay * 2) return console.log(`[autopilot] 오늘 시도 상한(${attempts}) — 관문 불통과가 많습니다. 사람 검수 대기`);

    // 화제 재고가 마르면 하루 1회 스카우트
    let { topic, freshLeft } = await pickTopic(cfg, state);
    if ((freshLeft < 3 || !topic) && state.lastScout !== today && !DRY) {
      const { runScout } = await import('./lib/scout.mjs');
      const s = await runScout(cfg);
      state.lastScout = today;
      saveState(state);
      console.log('[autopilot]', s.note);
      if (ME) await sendMessage(ME, s.note);
      ({ topic } = await pickTopic(cfg, state));
    }
    if (!topic) {
      if (ME && !DRY) await sendMessage(ME, '🤖 자동 발행: 고를 주제가 없습니다(재고 소진·중복 제외). 스카우트는 내일 다시 돕니다.');
      return console.log('[autopilot] 주제 없음');
    }
    console.log(`[autopilot] 주제: ${topic.keyword} (${topic.tier}/${topic.series || '-'}) · 오늘 ${done}/${perDay}`);
    if (DRY) return;

    const run = { ts: new Date().toISOString(), day: today, keyword: topic.keyword, tier: topic.tier, series: topic.series || topic.tier };
    state.runs.push({ ...run, result: 'started' });
    saveState(state);

    const { generateOne, sendDraftCard, sendFailure } = await import('./generate.mjs');
    const r = await generateOne(topic.keyword, { source: topic.tier, series: topic.series, angle: topic.angle, auto: true }, cfg, ME);
    const st = loadState(); // 생성 중 /autopause 등이 바뀌었을 수 있다
    const rec = st.runs.findLast((x) => x.ts === run.ts) || run;
    if (!r.ok) {
      Object.assign(rec, { result: 'failed', why: r.message || r.reason });
      saveState(st);
      if (ME) await sendFailure(ME, { keyword: topic.keyword, source: topic.tier }, r);
      return;
    }
    rec.slug = r.slug;
    if (st.paused) {
      Object.assign(rec, { result: 'held', why: ['생성 중 /autopause'] });
      saveState(st);
      if (ME) await sendDraftCard(ME, r.slug, r.title, { ...r.cardOpts, note: '🤖 자동 발행 보류 — 일시정지 중' });
      return;
    }
    if (!r.gate || !r.gate.pass) {
      const why = r.gate ? r.gate.why : ['하네스 꺼짐 — 자동 발행은 하네스 관문이 필수'];
      Object.assign(rec, { result: 'held', why });
      saveState(st);
      if (ME) await sendDraftCard(ME, r.slug, r.title, { ...r.cardOpts, note: `🤖 자동 발행 보류(사람 검수 필요)\n   ↳ ${why.join('\n   ↳ ')}` });
      return;
    }
    const { publish } = await import('./publish.mjs');
    const p = await publish({ slug: r.slug, title: r.title, keyword: topic.keyword });
    if (!p.ok) {
      Object.assign(rec, { result: 'publish-failed', why: p.error });
      saveState(st);
      if (ME) await sendDraftCard(ME, r.slug, r.title, { ...r.cardOpts, note: `🤖 자동 발행 실패: ${p.error}` });
      return;
    }
    Object.assign(rec, { result: 'published', url: p.url });
    saveState(st);
    const n = st.runs.filter((x) => x.day === today && x.result === 'published').length;
    if (ME)
      await sendMessage(ME,
        `🤖 자동 발행 (오늘 ${n}/${perDay})\n📝 ${r.title}\n🔑 ${topic.keyword}\n🔗 ${p.url}\n` +
        `${r.cardOpts.harnessLine || ''}\n\n내리려면: /unpublish ${r.slug}\n멈추려면: /autopause`);
  } catch (e) {
    console.error('[autopilot] 오류:', e);
    if (ME) await sendMessage(ME, `🤖 자동 발행 오류: ${String(e.message).slice(0, 150)}`).catch(() => {});
  } finally {
    releaseLock();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runAutopilot();
}
