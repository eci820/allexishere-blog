// 📈 성과 학습 — "노출이 잘 안 되는 글은 원인을 분석하고, 그 결과를 다음 글 작성에 보완 반영" (2026-11-26 사용자 지시).
//
// 주 1회(autopilot 이 교훈이 7일 넘게 묵었을 때 부른다). 흐름:
//   ① 셈(LLM 0회): 발행 D+14 이상 글마다 GSC 노출·클릭·순위·검색어 + 글 특징(분량·소제목·표·문체 등급·
//      형식·하네스 점수·제목 길이·제목 연도 꼬리) → 원인 유형 분류
//        · 노출 0          → 검색 의도·검색어 선택 문제(또는 미색인) 후보
//        · 노출 있음·클릭 0 → 제목·설명문(스니펫) 문제 후보
//        · 평균 순위 20위 밖 → 상위 글 대비 깊이·정보 이득 부족 후보
//      + 관문 불통과로 폐기된 초안의 사유 집계(무엇 때문에 자꾸 떨어지나)
//   ② 정리(LLM 1회): 위 숫자만 근거로 '다음 글에 적용할 규칙' ≤6개 + '주제 고를 때 힌트' ≤4개
//   ③ 저장: state/lessons.json → generate.mjs(작성 프롬프트)·scout.mjs(주제 발굴)가 읽는다.
//
// 🔴 데이터 성숙도(계약 §7): 노출 있는 성숙 글이 5편 미만이면 '성과' 교훈은 만들지 않고, 폐기 사유 같은
//    셀 수 있는 것만 쓴다. 숫자가 0인 게 실패가 아니라 데이터 미도달일 수 있다 — 리포트가 그걸 말한다.
// ⚠️ 정직한 한계: 사이트가 2026-07-20 사이트 단위 강등 상태라 글 단위 차이가 노출에 덜 드러날 수 있다.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, AUTO_DIR } from './env.mjs';
import { claudeText } from './harness.mjs';
import { lintAiTone } from './aiTone.mjs';
import { bodyOf, h2List } from './textMetrics.mjs';

const FILE = path.join(AUTO_DIR, 'state', 'lessons.json');
const DAY = 24 * 3600 * 1000;
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };

export function lessonsStale(days = 7) {
  const L = read();
  return !L || Date.now() - Date.parse(L.ts) > days * DAY;
}

export function lessonsForPrompt() {
  const L = read();
  if (!L || Date.now() - Date.parse(L.ts) > 21 * DAY || !(L.rules || []).length) return '';
  return `\n\n[지난 글 성과 분석에서 나온 교훈 — ${L.ts.slice(0, 10)} 기준, 반드시 반영]\n` + L.rules.map((r) => `- ${r}`).join('\n');
}
export function topicHintsForScout() {
  const L = read();
  if (!L || Date.now() - Date.parse(L.ts) > 21 * DAY) return [];
  return L.topicHints || [];
}

export async function buildLessons(config, { dry = false } = {}) {
  const gsc = await import('./gsc.mjs');
  const { urlKey } = await import('./sitemap.mjs');
  const sw = await import('../seo-watch.mjs');
  const site = (await gsc.resolveSiteUrl('allexishere.com')).siteUrl;
  const end = gsc.kstDaysAgo(3), start = gsc.kstDaysAgo(90);
  const pages = await gsc.searchAnalytics(site, { startDate: start, endDate: end, dimensions: ['page'], rowLimit: 5000 });
  const pq = await gsc.searchAnalytics(site, { startDate: start, endDate: end, dimensions: ['page', 'query'], rowLimit: 5000 });
  const byPage = new Map(pages.map((r) => [urlKey(r.keys[0]), r]));
  const queries = new Map();
  for (const r of pq) { const k = urlKey(r.keys[0]); if (!queries.has(k)) queries.set(k, []); queries.get(k).push(`${r.keys[1]}(${r.impressions})`); }

  const hlog = new Map();
  try {
    for (const line of fs.readFileSync(path.join(AUTO_DIR, 'state', 'harness-log.jsonl'), 'utf8').trim().split('\n')) {
      const x = JSON.parse(line); hlog.set(x.slug, x);
    }
  } catch {}

  const posts = sw.scanPosts().filter((p) => !p.draft && !p.noindex);
  await sw.attachSitemapUrls(posts);
  const now = Date.now();
  const rows = [];
  for (const p of posts) {
    const pub = Date.parse(p.pubDate || '');
    if (!p.url || !pub || now - pub < 14 * DAY) continue; // D+14 전은 판정하지 않는다(색인·GSC 지연)
    const raw = fs.readFileSync(path.join(ROOT, 'src', 'content', 'blog', p.slug || p.dir, 'index.md'), 'utf8');
    const body = bodyOf(raw);
    const g = byPage.get(urlKey(p.url));
    const h = hlog.get(p.slug || p.dir);
    const imp = g?.impressions || 0, clk = g?.clicks || 0, pos = g?.position || null;
    const cause = imp === 0 ? '노출0' : clk === 0 && imp >= 30 ? '클릭0' : pos && pos > 20 ? '순위낮음' : clk > 0 ? '성과' : '소량노출';
    rows.push({
      title: p.title, days: Math.round((now - pub) / DAY), imp, clk, pos: pos ? +pos.toFixed(1) : null, cause,
      chars: body.length, h2: h2List(body).length, table: /^\s*\|.*\|\s*$/m.test(body), tone: lintAiTone(body).grade,
      titleLen: [...p.title].length, yearTail: /\(?20\d\d[^)]*\)?\s*$/.test(p.title),
      format: h?.format || null, human: h?.final?.humanScore ?? h?.verify?.humanScore ?? null,
      queries: (queries.get(urlKey(p.url)) || []).slice(0, 3).join(', '),
    });
  }
  // 관문 불통과 폐기 사유(최근 30일)
  let discards = [];
  try {
    const ap = JSON.parse(fs.readFileSync(path.join(AUTO_DIR, 'state', 'autopilot.json'), 'utf8'));
    discards = ap.runs.filter((r) => r.result === 'discarded' && now - Date.parse(r.ts) < 30 * DAY).flatMap((r) => r.why || []);
  } catch {}
  const reasonCount = {};
  for (const w of discards) { const k = w.replace(/\d+(\.\d+)?/g, 'N').slice(0, 40); reasonCount[k] = (reasonCount[k] || 0) + 1; }

  const withImp = rows.filter((r) => r.imp > 0).length;
  const mature = withImp >= 5;
  const tally = rows.reduce((a, r) => ((a[r.cause] = (a[r.cause] || 0) + 1), a), {});
  const basis = { matured: rows.length, withImpressions: withImp, causes: tally, discards: discards.length, window: `${start}~${end}` };

  // 표본: 성과 좋은 글 전부 + 나머지는 원인별로 고르게(프롬프트 길이 제한)
  const pick = [...rows.filter((r) => r.cause === '성과'), ...rows.filter((r) => r.cause !== '성과').sort((a, b) => b.imp - a.imp)].slice(0, 45);
  const prompt = `당신은 이 블로그의 성과 분석가입니다. 아래 '숫자'만 근거로, 다음 글을 쓸 때 적용할 규칙을 만드세요.
🔴 데이터에 근거하지 않은 일반 SEO 조언("키워드를 넣으세요" 류) 금지. 각 규칙 끝에 근거를 괄호로(예: "(노출0 글 12편 중 9편이 ~)").
${mature ? '' : '⚠️ 노출이 있는 성숙 글이 5편 미만입니다 — 성과 비교 규칙은 만들지 말고, 폐기 사유에서 나오는 작성 규칙만 만드세요.'}

[분석 기간] ${basis.window} · 발행 D+14 이상 글 ${rows.length}편 · 노출 있는 글 ${withImp}편 · 원인 분포 ${JSON.stringify(tally)}
[글별 지표] 제목 | 경과일 | 노출 | 클릭 | 평균순위 | 원인 | 분량 | h2 | 표 | 문체 | 제목길이 | 제목연도꼬리 | 형식 | 사람다움 | 상위검색어
${pick.map((r) => [r.title.slice(0, 40), r.days, r.imp, r.clk, r.pos ?? '-', r.cause, r.chars, r.h2, r.table ? 'Y' : 'N', r.tone, r.titleLen, r.yearTail ? 'Y' : 'N', r.format || '-', r.human ?? '-', r.queries || '-'].join(' | ')).join('\n')}

[자동 발행 관문 불통과 사유(최근 30일, ${discards.length}건)]
${Object.entries(reasonCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `- ${k} ×${v}`).join('\n') || '- (없음)'}

아래 JSON 하나만 출력(코드펜스·설명 금지):
{"rules":["다음 글 작성 규칙(근거)"],"topicHints":["주제·검색어 고를 때 힌트(근거)"],"diagnosis":"원인 진단 요약 2~3문장","confidence":"low|mid|high"}`;

  let out = { rules: [], topicHints: [], diagnosis: '', confidence: 'low' }, costUsd = 0, error = null;
  if (rows.length || discards.length) {
    try {
      const r = await claudeText(prompt, { model: config.cliModel, timeoutSec: 300, tools: [] });
      costUsd = r.costUsd;
      const t = String(r.result).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      const o = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
      out = { rules: (o.rules || []).map(String).slice(0, 6), topicHints: (o.topicHints || []).map(String).slice(0, 4), diagnosis: String(o.diagnosis || '').slice(0, 400), confidence: o.confidence || 'low' };
    } catch (e) { error = String(e.message).slice(0, 120); }
  }
  const L = { ts: new Date().toISOString(), ...out, basis, mature, error, costUsd };
  const note = error ? `⚠️ 교훈 정리 실패: ${error}` : `규칙 ${out.rules.length}개 · 주제 힌트 ${out.topicHints.length}개 (성숙 글 ${rows.length} · 노출 ${withImp} · 폐기 ${discards.length}${mature ? '' : ' · 성과 데이터 부족'})`;
  if (!dry) {
    fs.writeFileSync(FILE, JSON.stringify(L, null, 1));
    try {
      const { sendMessage } = await import('./telegram.mjs');
      if (process.env.TELEGRAM_CHAT_ID)
        await sendMessage(process.env.TELEGRAM_CHAT_ID,
          `📈 주간 성과 학습 (${L.ts.slice(0, 10)})\n${note}\n` +
          (out.diagnosis ? `\n🩺 ${out.diagnosis}\n` : '') +
          (out.rules.length ? `\n다음 글에 반영할 규칙:\n${out.rules.map((r) => '· ' + r).join('\n')}` : '') +
          (out.topicHints.length ? `\n\n주제 선정 힌트:\n${out.topicHints.map((r) => '· ' + r).join('\n')}` : ''));
    } catch {}
  }
  return { ...L, note };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv, loadConfig } = await import('./env.mjs');
  loadEnv();
  const r = await buildLessons(loadConfig(), { dry: !process.argv.includes('--write') });
  console.log(JSON.stringify(r, null, 1));
}
