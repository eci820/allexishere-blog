#!/usr/bin/env node
// 📊 성과 분석가 (자율 개선 에이전트 1단계).
//
// 매일 08:00 실행. GSC 에서 성과를 받아 주간 추세로 정리해 텔레그램에 보낸다.
// 분석·보고까지만 한다 — 글을 쓰지도, 고치지도, 발행하지도 않는다.
//
// 🔴 LLM 호출 0회. 노출·클릭 집계는 추론이 아니라 산수다. LLM 을 끼우면 비용과
//    불확정성만 늘고 숫자는 더 틀린다. 구독 한도를 브리핑에 온전히 남긴다.
//
// 설계 근거가 되는 실측 사실:
//  · GSC 데이터는 2~3일 지연된다(실측 3일). '어제 대비'는 애초에 불가능하다.
//  · 소표본에서 CTR 은 착시다. 노출 12에 클릭 1이면 8.3%지만 아무 의미 없다.
//    → 노출 100 미만이면 CTR 을 아예 표시하지 않는다.
//  · 신규 글은 색인에만 3~14일 걸린다. D+7 전에는 판정 대상에 넣지 않는다.
//
// 사용:
//   node automation/analyst.mjs --dry-run   # 화면에만 출력(텔레그램 전송 안 함)
//   node automation/analyst.mjs             # 텔레그램 전송 + 이력 누적
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT, AUTO_DIR } from './lib/env.mjs';
import { sendMessage } from './lib/telegram.mjs';
import * as gsc from './lib/gsc.mjs';

loadEnv();

const DRY = process.argv.includes('--dry-run');
const SITE_DOMAIN = 'allexishere.com';
const BLOG = path.join(ROOT, 'src', 'content', 'blog');
const HISTORY = path.join(ROOT, 'data', 'perf-history.json');

// 소표본 착시 방지 임계값 — 이 아래로는 비율 지표를 만들지 않는다.
const MIN_IMPRESSIONS_FOR_RATE = 100;
// 신규 글 판정 유예 — 색인 지연 + GSC 지연을 합친 기간.
const JUDGE_AFTER_DAYS = 7;
// 🅿️ 주차 파일럿 시작일. 이 이후 발행된 주차 글이 '신규', 그 전이 '대조군'.
const PARKING_PILOT_START = '2026-07-16';

// ── 로컬 글 메타(발행일·제목) ─────────────────────────────────────────
// URL → 글 정보 매핑. D+N 계산과 주차 분류에 쓴다.
// URL 규칙은 indexnow-bulk.mjs 와 동일: originalPath 있으면 그대로, 없으면 /entry/<dir>.
function loadPosts() {
  const out = new Map(); // pathname(디코드) → {slug,title,pubDate,draft}
  if (!fs.existsSync(BLOG)) return out;
  for (const dir of fs.readdirSync(BLOG)) {
    const f = path.join(BLOG, dir, 'index.md');
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, 'utf8');
    const pick = (re) => (raw.match(re) || [])[1] || '';
    const orig = pick(/^originalPath:\s*"?(.*?)"?\s*$/m);
    const pathname = orig ? (orig.startsWith('/') ? orig : '/' + orig) : '/entry/' + dir;
    out.set(pathname, {
      slug: dir,
      title: pick(/^title:\s*"?(.*?)"?\s*$/m),
      pubDate: pick(/^pubDate:\s*(.*?)\s*$/m).slice(0, 10),
      draft: /^draft:\s*true/m.test(raw),
    });
  }
  return out;
}

// ── URL 정규화 ────────────────────────────────────────────────────────
// 🔴 GSC 는 #앵커가 붙은 주소를 별개 행으로 준다. 킨텍스 글 하나가 5행으로 쪼개져
//    노출 249로 보였지만 합치면 401이었다 — 합산하지 않으면 글별 성과를 40% 과소평가한다.
export function normalizePage(url) {
  let u = String(url || '');
  u = u.split('#')[0].split('?')[0];          // 앵커·쿼리 제거
  u = u.replace(/^https?:\/\/[^/]+/, '');      // 도메인 제거 → pathname
  try { u = decodeURIComponent(u); } catch { /* 잘못된 인코딩은 원문 유지 */ }
  if (u.length > 1) u = u.replace(/\/$/, '');  // 끝 슬래시 제거(루트 제외)
  return u || '/';
}

// 같은 글의 여러 행을 하나로 합친다. CTR·순위는 합산 후 다시 계산해야 맞다.
export function aggregateByPage(rows) {
  const m = new Map();
  for (const r of rows) {
    const key = normalizePage(r.keys?.[0]);
    const cur = m.get(key) || { page: key, impressions: 0, clicks: 0, posSum: 0, rowCount: 0 };
    cur.impressions += r.impressions || 0;
    cur.clicks += r.clicks || 0;
    // 평균순위는 노출 가중 평균이 맞다(행별 단순평균은 왜곡).
    cur.posSum += (r.position || 0) * (r.impressions || 0);
    cur.rowCount++;
    m.set(key, cur);
  }
  for (const v of m.values()) {
    v.ctr = v.impressions ? v.clicks / v.impressions : 0;
    v.position = v.impressions ? v.posSum / v.impressions : null;
    delete v.posSum;
  }
  return [...m.values()];
}

// ── 표시 헬퍼 ─────────────────────────────────────────────────────────
const n = (x) => Number(x || 0).toLocaleString('ko-KR');
// 증감 표시. 직전 값이 0이면 % 가 무의미하므로 절대값만.
function delta(cur, prev) {
  const d = cur - prev;
  if (!prev) return d > 0 ? `(+${n(d)})` : '';
  const pct = Math.round((d / prev) * 100);
  return `(${d >= 0 ? '+' : ''}${n(d)} · ${pct >= 0 ? '+' : ''}${pct}%)`;
}
// 🔴 노출이 적으면 비율을 만들지 않는다 — 소표본 CTR 은 착시다.
function rate(clicks, impressions) {
  if (impressions < MIN_IMPRESSIONS_FOR_RATE) return `— (노출 ${n(impressions)}, 표본 부족)`;
  return ((clicks / impressions) * 100).toFixed(2) + '%';
}
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// ── 이력 누적 ─────────────────────────────────────────────────────────
function appendHistory(entry) {
  let h = { _note: '일별 GSC 성과 적재. analyst.mjs 가 매일 갱신.', days: {}, updatedAt: null };
  try { h = JSON.parse(fs.readFileSync(HISTORY, 'utf8')); } catch { /* 최초 실행 */ }
  h.days = h.days || {};
  h.days[entry.date] = entry;
  h.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  fs.writeFileSync(HISTORY, JSON.stringify(h, null, 1));
  return Object.keys(h.days).length;
}

// ── 본체 ──────────────────────────────────────────────────────────────
export async function runAnalyst({ dry = false } = {}) {
  // 속성 URL 은 추측하지 않고 API 에 묻는다.
  const resolved = await gsc.resolveSiteUrl(SITE_DOMAIN);
  if (!resolved.siteUrl) {
    throw Object.assign(
      new Error(`GSC 속성을 찾지 못했습니다(${SITE_DOMAIN}). 접근 가능 속성: ${resolved.sites.map((s) => s.siteUrl).join(', ') || '없음'}`),
      { kind: 'nosite' }
    );
  }
  const SITE = resolved.siteUrl;

  // ① 실제 데이터 지연 확인 — '언제까지의 데이터인가'를 리포트에 밝힌다.
  const dateRows = await gsc.searchAnalytics(SITE, {
    startDate: gsc.kstDaysAgo(14), endDate: gsc.kstDaysAgo(0), dimensions: ['date'],
  });
  const latest = dateRows.length ? dateRows[dateRows.length - 1].keys[0] : null;
  if (!latest) {
    const msg = '📊 성과 리포트\n\n⚠️ GSC 에 아직 데이터가 없습니다(신규 속성이거나 노출 0).';
    if (!dry) await sendMessage(process.env.TELEGRAM_CHAT_ID, msg);
    return { ok: true, empty: true, message: msg };
  }
  const lagDays = daysBetween(latest, gsc.kstDaysAgo(0));

  // ② 최신 데이터일 기준 7일 창 두 개(현재 vs 직전) — 일별 노이즈를 보지 않는다.
  const end = latest;
  const start = new Date(new Date(end) - 6 * 86400000).toISOString().slice(0, 10);
  const prevEnd = new Date(new Date(start) - 1 * 86400000).toISOString().slice(0, 10);
  const prevStart = new Date(new Date(prevEnd) - 6 * 86400000).toISOString().slice(0, 10);

  const [curTotals, prevTotals, curPagesRaw, prevPagesRaw] = await Promise.all([
    gsc.totals(SITE, start, end),
    gsc.totals(SITE, prevStart, prevEnd),
    gsc.searchAnalytics(SITE, { startDate: start, endDate: end, dimensions: ['page'], rowLimit: 500 }),
    gsc.searchAnalytics(SITE, { startDate: prevStart, endDate: prevEnd, dimensions: ['page'], rowLimit: 500 }),
  ]);

  const cur = aggregateByPage(curPagesRaw);
  const prev = new Map(aggregateByPage(prevPagesRaw).map((r) => [r.page, r]));
  const posts = loadPosts();
  const today = gsc.kstDaysAgo(0);

  // 글 정보 결합. isPost=false 면 홈·목록·태그 같은 비(非)글 페이지다.
  for (const r of cur) {
    const meta = posts.get(r.page);
    r.isPost = !!meta;
    r.title = meta?.title || r.page;
    r.pubDate = meta?.pubDate || null;
    r.ageDays = meta?.pubDate ? daysBetween(meta.pubDate, today) : null;
    const p = prev.get(r.page);
    r.prevClicks = p?.clicks || 0;
    r.prevImpressions = p?.impressions || 0;
  }

  // ③ 오른 글 / 내린 글 — 클릭 변화 기준(노출보다 실질적)
  // 홈(/)·목록(/page/2) 은 제외한다. 글이 아니라서 "제목을 고쳐라" 같은 조치가 성립하지 않는다.
  const judged = cur.filter((r) => r.isPost && (r.ageDays === null || r.ageDays >= JUDGE_AFTER_DAYS));
  const risers = judged.filter((r) => r.clicks > r.prevClicks).sort((a, b) => (b.clicks - b.prevClicks) - (a.clicks - a.prevClicks)).slice(0, 3);
  const fallers = judged.filter((r) => r.clicks < r.prevClicks).sort((a, b) => (a.clicks - a.prevClicks) - (b.clicks - b.prevClicks)).slice(0, 3);

  // ④ 🔴 노출은 많은데 클릭이 없는 글 — 제목·설명이 검색의도와 어긋난다는 신호.
  //    (실측 사례: 호남 반도체 클러스터 노출 481 클릭 0)
  const wasted = cur
    .filter((r) => r.isPost && r.impressions >= MIN_IMPRESSIONS_FOR_RATE && r.ctr < 0.005)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 3);

  // ⑤ 🅿️ 주차 니치 트래커 — 신규 A급 vs 기존 대조군
  const isParking = (r) => /주차/.test(r.title) || /주차/.test(r.page);
  const parkingAll = [...posts.entries()]
    .filter(([, m]) => !m.draft && /주차/.test(m.title))
    .map(([pathname, m]) => {
      const hit = cur.find((r) => r.page === pathname);
      return {
        title: m.title, pubDate: m.pubDate,
        age: m.pubDate ? daysBetween(m.pubDate, today) : null,
        impressions: hit?.impressions || 0, clicks: hit?.clicks || 0,
        isNew: m.pubDate >= PARKING_PILOT_START,
      };
    });
  const parkNew = parkingAll.filter((p) => p.isNew).sort((a, b) => b.impressions - a.impressions);
  const parkCtl = parkingAll.filter((p) => !p.isNew).sort((a, b) => b.impressions - a.impressions).slice(0, 3);
  const ready = parkNew.filter((p) => p.age !== null && p.age >= JUDGE_AFTER_DAYS).length;
  // 데이터 구간이 발행일에 도달했는지 — 도달 전엔 노출 0이 '실패'가 아니라 '아직'이다.
  const covered = parkNew.filter((p) => p.pubDate <= end).length;

  // ── 리포트 조립 ──
  const L = [];
  L.push(`📊 성과 리포트 ${today.slice(5)}`);
  L.push(`GSC 기준일 ${end} (${lagDays}일 지연 · 이건 정상입니다)`);
  L.push('');
  L.push(`【주간 합계】 ${start.slice(5)}~${end.slice(5)} vs 직전 7일`);
  L.push(`  노출 ${n(curTotals.impressions)} ${delta(curTotals.impressions, prevTotals.impressions)}`);
  L.push(`  클릭 ${n(curTotals.clicks)} ${delta(curTotals.clicks, prevTotals.clicks)}`);
  L.push(`  CTR  ${rate(curTotals.clicks, curTotals.impressions)}`);
  L.push(`  평균순위 ${curTotals.position ? curTotals.position.toFixed(1) : '—'}`);
  L.push(`  노출 발생 글 ${n(cur.filter((r) => r.isPost).length)}편` +
    (cur.some((r) => !r.isPost) ? ` (+ 홈·목록 ${n(cur.filter((r) => !r.isPost).length)})` : ''));

  if (risers.length) {
    L.push('');
    L.push('📈 오른 글');
    for (const r of risers) L.push(`  • ${r.title.slice(0, 28)} — 클릭 ${r.clicks} ${delta(r.clicks, r.prevClicks)}`);
  }
  if (fallers.length) {
    L.push('');
    L.push('🔻 내린 글');
    for (const r of fallers) L.push(`  • ${r.title.slice(0, 28)} — 클릭 ${r.clicks} ${delta(r.clicks, r.prevClicks)}`);
  }
  if (wasted.length) {
    L.push('');
    L.push('⚠️ 노출은 나는데 클릭이 없는 글 (제목·설명 개선 후보)');
    for (const r of wasted) {
      L.push(`  • ${r.title.slice(0, 28)}`);
      L.push(`    노출 ${n(r.impressions)} · 클릭 ${r.clicks} · 순위 ${r.position ? r.position.toFixed(1) : '—'}`);
    }
  }

  L.push('');
  L.push('🅿️ 주차 니치 추적');
  if (parkCtl.length) {
    L.push('  [대조군 — 파일럿 이전 글]');
    for (const p of parkCtl) L.push(`   ${String(p.impressions).padStart(4)} 노출 · ${String(p.clicks).padStart(2)} 클릭 — ${p.title.slice(0, 22)}`);
  }
  if (parkNew.length) {
    L.push(`  [신규 ${parkNew.length}편 — 파일럿]`);
    for (const p of parkNew) {
      const tag = p.pubDate > end ? '⏳ 데이터 구간 밖' : p.age < JUDGE_AFTER_DAYS ? `⏳ D+${p.age} 색인 대기` : '';
      L.push(`   ${String(p.impressions).padStart(4)} 노출 · ${String(p.clicks).padStart(2)} 클릭 — ${p.title.slice(0, 18)} ${tag}`);
    }
  }
  L.push(`  판정 준비도: ${ready}/${parkNew.length}편이 D+${JUDGE_AFTER_DAYS} 도달` +
    (covered < parkNew.length ? ` · ${parkNew.length - covered}편은 아직 데이터 구간 밖` : ''));
  L.push(ready === 0
    ? '  → 아직 판정 이릅니다(8월 중순 목표). 숫자가 0인 건 실패가 아니라 데이터 미도달입니다.'
    : ready < parkNew.length
      ? '  → 일부만 도달. 전편 도달까지 기다리는 걸 권합니다.'
      : '  → 전편 D+7 도달. 판정 가능한 수준입니다.');

  L.push('');
  L.push('💰 AdSense: 미연동(월 1회 직접 확인 권장)');

  const message = L.join('\n');

  // 이력 누적(요약만 — 원본 행은 저장하지 않는다)
  let days = 0;
  if (!dry) {
    days = appendHistory({
      date: today, gscDate: end, lagDays,
      window: { start, end }, prevWindow: { start: prevStart, end: prevEnd },
      totals: { impressions: curTotals.impressions, clicks: curTotals.clicks, position: curTotals.position },
      prevTotals: { impressions: prevTotals.impressions, clicks: prevTotals.clicks },
      pagesWithImpressions: cur.length,
      parking: { newCount: parkNew.length, ready, covered, newImpressions: parkNew.reduce((s, p) => s + p.impressions, 0) },
    });
    await sendMessage(process.env.TELEGRAM_CHAT_ID, message);
  }
  return { ok: true, message, days, site: SITE };
}

// 직접 실행일 때만 동작(import 시엔 아무 일 없음)
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runAnalyst({ dry: DRY })
    .then((r) => { if (r.message) console.log(r.message); if (DRY) console.log('\n(--dry-run: 텔레그램 전송·이력 저장 안 함)'); })
    .catch(async (e) => {
      console.error('[analyst] 실패:', e.kind || 'error', e.message);
      // 조용히 죽지 않는다 — 사람이 무엇을 고쳐야 할지 알려준다.
      const hint =
        e.kind === 'nokey' ? '\nautomation/secrets/gsc-key.json 이 있는지 확인하세요.'
        : e.kind === 'auth' ? '\n서비스 계정 키가 만료·폐기됐을 수 있습니다.'
        : e.kind === 'forbidden' ? '\nGSC 속성에 서비스 계정이 사용자로 추가돼 있는지 확인하세요.'
        : e.kind === 'nosite' ? '\nGSC 속성 URL 형식을 확인하세요.'
        : '';
      if (!DRY) { try { await sendMessage(process.env.TELEGRAM_CHAT_ID, `❌ 성과 리포트 실패: ${e.message}${hint}`); } catch {} }
      process.exit(1);
    });
}
