#!/usr/bin/env node
// 🔍 SEO 감시자 (자율 개선 에이전트 2단계).
//
// 주 1회 실행. SEO 손상은 조용히 누적되다 늦게 터지므로 조기 경보만 담당한다.
// 감시·경보까지만 한다 — 코드를 고치거나 발행하거나 배포하지 않는다.
//
// LLM 호출 0회. 집계·비교는 산수다.
//
// ── 설계 판단(실측 근거) ──────────────────────────────────────────────
// ① 색인 커버리지 리포트는 API 가 없다. 페이지별 상태는 URL Inspection API 뿐이며
//    사이트당 하루 2,000회 한도다. 발행글 143편이면 주 1회 전수 검사가 넉넉하다.
// ② 사이트맵의 contents[].indexed 는 항상 "0"(폐기 필드) — 색인 수로 쓰면 안 된다.
//    submitted·errors·warnings·lastDownloaded 만 유효하다.
// ③ h1 개수·alt 누락은 점검하지 않는다. rehype-seo-fix 가 빌드 시점에 교정하므로
//    소스에 h1/빈 alt 가 있어도 렌더 결과에는 새어나가지 않는다(빌드 산출물로 확인:
//    본문 h1 있는 글 → <h1> 1개, 이미지 7개 전부 alt 채워짐). 잡아봐야 거짓 경보다.
//    대신 플러그인이 못 고치는 것(깨진 이미지 파일, 중복 URL)을 본다.
// ④ 네이버는 서치어드바이저에 성과·진단 API 가 없다(수집요청 API 뿐). 자동으로 볼 수
//    있는 척하지 않고, 직접 확인하라는 리마인더와 링크만 낸다.
//
// 사용:
//   node automation/seo-watch.mjs --dry-run        # 화면 출력만
//   node automation/seo-watch.mjs --quick          # URL 검사 생략(로컬+사이트맵만, 빠름)
//   node automation/seo-watch.mjs                  # 전체 + 텔레그램 전송 + 이력 누적
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT, AUTO_DIR } from './lib/env.mjs';
import { sendMessage } from './lib/telegram.mjs';
import * as gsc from './lib/gsc.mjs';
import { fetchSitemapUrls, resolveUrl, urlKey } from './lib/sitemap.mjs';
import { classifyIndex, CLASS_LABEL, CLASS_ACTION, INDEX_GRACE_DAYS, UNKNOWN_ALERT_DAYS } from './lib/indexState.mjs';

loadEnv();

const DRY = process.argv.includes('--dry-run');
const QUICK = process.argv.includes('--quick');
const SITE_DOMAIN = 'allexishere.com';
const ORIGIN = `https://${SITE_DOMAIN}`;
const BLOG = path.join(ROOT, 'src', 'content', 'blog');
const HISTORY = path.join(ROOT, 'data', 'seo-history.json');
const NAVER_DIAG = 'https://searchadvisor.naver.com/console/site/diagnosis';

// 색인 수가 직전 대비 이 비율 이상 줄면 급감으로 본다.
const INDEX_DROP_ALERT = 0.15;

// ── 🔎 '미발견' 감시 기준(2026-07-19 전수 조사로 정한 값) ─────────────
// 🔴 미발견 '편수'를 그대로 리포트에 싣지 않는다.
//    실측: 미발견 16편 중 14편이 D+0~12 로 정상 색인 대기였다. 원시 개수를 매주
//    올리면 사람이 대부분 정상인 숫자를 계속 보게 되고, 그러다 진짜 신호를 놓친다
//    (계약 §4 — 오탐이 쌓이면 경보 자체가 무력해진다).
//    게다가 이 상태는 빠르게 움직인다: 같은 글 3편이 45분 만에 미발견→발견됨으로
//    바뀌었다. 주간 스냅샷의 절대값은 애초에 큰 의미가 없다.
// 그래서 '이상 신호'만 올린다:
//    · D+14 미만          → 보고하지 않음(정상 대기)
//    · D+14 이상          → 조용한 카운터(추세만, 경보 아님)
//    · D+30 이상          → ⚠️ 경보(발견 경로 의심)
//    · 성숙 미발견 급증    → 🚨 경보(배포·사이트맵 사고 의심)
const UNKNOWN_SURGE_DELTA = 3; // D+14 이상 미발견이 직전 대비 이만큼 늘면 급증

const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// ── 로컬 발행글 스캔 ──────────────────────────────────────────────────
// 🔴 URL 을 여기서 '만들지' 않는다. pathname 은 로컬 글을 사이트맵과 이어붙이기 위한
//    후보일 뿐이고, GSC 에 검사시킬 실제 URL 은 attachSitemapUrls() 가 사이트맵에서
//    가져와 채운다. 폴더명으로 추측했다가 대문자 슬러그 글에서 404 를 검사해
//    거짓 미색인 판정을 냈던 사고(2026-07-19) 때문이다.
export function scanPosts() {
  const posts = [];
  if (!fs.existsSync(BLOG)) return posts;
  for (const dir of fs.readdirSync(BLOG)) {
    const f = path.join(BLOG, dir, 'index.md');
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, 'utf8');
    const pick = (re) => (raw.match(re) || [])[1] || '';
    const orig = pick(/^originalPath:\s*"?(.*?)"?\s*$/m);
    const pathname = orig ? (orig.startsWith('/') ? orig : '/' + orig) : '/entry/' + dir;
    const body = raw.split(/^---\s*$/m).slice(2).join('---');

    // 깨진 이미지 참조 — 플러그인이 못 고치는 실제 결함(파일이 없으면 404 이미지).
    const broken = [];
    for (const m of body.matchAll(/!\[[^\]]*\]\((\.\/[^)]+)\)/g)) {
      if (!fs.existsSync(path.join(BLOG, dir, m[1].slice(2)))) broken.push(m[1]);
    }
    // cover 도 같은 방식으로 확인
    const cover = pick(/^cover:\s*"?(.*?)"?\s*$/m);
    if (cover.startsWith('./') && !fs.existsSync(path.join(BLOG, dir, cover.slice(2)))) broken.push(cover);

    posts.push({
      dir, pathname,
      url: null,          // 사이트맵에서 채운다(attachSitemapUrls)
      inSitemap: false,   // 사이트맵에 없으면 그 자체가 조사할 신호
      title: pick(/^title:\s*"?(.*?)"?\s*$/m),
      description: pick(/^description:\s*"?(.*?)"?\s*$/m),
      pubDate: pick(/^pubDate:\s*(.*?)\s*$/m).slice(0, 10),
      draft: /^draft:\s*true/m.test(raw),
      originalPath: orig,
      broken,
    });
  }
  return posts;
}

// 사이트맵(정본)에서 실제 URL 을 채운다. 못 찾은 글은 url=null 로 남아
// '사이트맵 누락'으로 보고된다 — 추측으로 메우지 않는다.
export async function attachSitemapUrls(posts, origin = ORIGIN) {
  const { byKey, urls } = await fetchSitemapUrls(origin);
  for (const p of posts) {
    const real = resolveUrl(byKey, p.pathname);
    p.url = real;
    p.inSitemap = !!real;
  }
  return { sitemapCount: urls.length };
}

// ── 자기잠식·중복 탐지 ────────────────────────────────────────────────
// 오늘 여러 번 겪은 문제: 같은 시설의 종합가이드와 모디파이어 글이 함께 존재해
// 서로 순위를 갉아먹는 상태. 주차 글은 시설명으로 묶어 판정한다.
// 불용어 — 이것만 겹치는 건 자기잠식이 아니다.
// 첫 판에 '신청·2026' 같은 일반어로 치매 지원금과 근로장려금을 묶는 오탐이 났다.
// 오탐이 쌓이면 경보 자체를 무시하게 되므로, 일반어는 넓게 걸러낸다.
const STOP = new Set([
  '주차', '주차장', '주차요금', '요금', '총정리', '가이드', '완벽', '무료', '근처', '경기일',
  '얼마', '기준', '조건', '정리', '방법', '위치', '신청', '조회', '지원', '효능', '효과',
  '용량', '용법', '복용법', '부작용', '원인', '치료', '예방', '종류', '환급', '비교', '최신',
  '팁', '핵심', '한눈', '이유', '차이', '추천', '나올까', '있나', '까지', '부터', '으로',
  // 앞에 붙는 수식어 — 주제어가 아니다. ('여성 갱년기'의 주제는 갱년기, '가성비 올리브유'의 주제는 올리브유)
  '여성', '남성', '가성비', '최고', '인기', '국내', '해외', '초보', '직장인', '노인', '어린이',
]);
const tokens = (s) => String(s || '').replace(/[^가-힣a-zA-Z0-9]/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
// 제목의 '주제어' — 불용어를 뺀 첫 토큰. 킨텍스 주차요금 → 킨텍스 / 비타민C 효능 → 비타민C
export function subjectOf(title) {
  const t = tokens(title).filter((w) => !STOP.has(w) && !/^\d{4}$/.test(w));
  return t[0] || null;
}
export const facilityOf = subjectOf; // 주차 글에서는 주제어 = 시설명

// 같은 주제를 다루는 글이 둘 이상인가.
// 판정 기준을 '주제어 일치'로 잡는다 — 일반어 겹침만으로는 잡지 않는다.
// (비타민C vs 비타민D 는 주제어가 달라 걸리지 않는다. 의도한 동작이다.)
function groupBySubject(posts) {
  const m = new Map();
  for (const p of posts) {
    const s = subjectOf(p.title);
    if (!s) continue;
    if (!m.has(s)) m.set(s, []);
    m.get(s).push(p);
  }
  return m;
}

export function findCannibalization(published) {
  const issues = [];
  for (const [subject, list] of groupBySubject(published)) {
    if (list.length < 2) continue;
    const isParking = list.every((p) => /주차/.test(p.title));
    issues.push({ type: isParking ? 'parking' : 'general', key: subject, posts: list });
  }
  return issues;
}

// 🔴 초안 단계 중복 — 오늘 실제로 겪은 문제(창원NC파크 초안 2개, 롯데백화점 초안 2개).
// 발행 전에 잡으면 자기잠식이 아예 생기지 않는다. 발행글끼리의 중복보다 이게 더 중요하다.
// (기존 3중 방어는 '발행글 vs 새 주제'만 봐서 초안끼리는 못 거른다.)
export function findDuplicateDrafts(all) {
  const drafts = all.filter((p) => p.draft);
  const published = all.filter((p) => !p.draft);
  const pubBySubject = groupBySubject(published);
  const out = [];
  for (const [subject, list] of groupBySubject(drafts)) {
    const clash = pubBySubject.get(subject) || [];
    if (list.length >= 2 || clash.length) {
      out.push({ subject, drafts: list, published: clash });
    }
  }
  return out;
}

// ── 🧪 실험 추적 ──────────────────────────────────────────────────────
// data/seo-experiments.json 에 실험을 추가하기만 하면 매주 자동 추적된다.
// 개별 실험을 코드에 하드코딩하지 않는다 — 앞으로 C유형 나머지, 갱신 효과 측정 등
// 무엇을 실험하든 파일에 한 줄 넣으면 이 구역이 알아서 따라간다.
//
// status 흐름: running(진행중) → indexed(색인 전환) → closed(판정 완료, 리포트에서 빠짐)
const EXPERIMENTS = path.join(ROOT, 'data', 'seo-experiments.json');

export function loadExperiments() {
  try { return JSON.parse(fs.readFileSync(EXPERIMENTS, 'utf8')); }
  catch { return null; }
}
function saveExperiments(data) {
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(EXPERIMENTS, JSON.stringify(data, null, 1));
}

// 실험별 현재 상태를 판정한다. inspectedByKey: urlKey → 검사결과
// 반환: { lines, changed } — changed 가 true 면 파일을 저장할 값이 생긴 것.
export function trackExperiments(data, inspectedByKey, today) {
  const out = { lines: [], changed: false, active: 0 };
  if (!data?.experiments?.length) return out;
  const live = data.experiments.filter((e) => e.status !== 'closed');
  out.active = live.length;
  if (!live.length) return out;

  out.lines.push('🧪 진행 중인 실험');
  for (const e of live) {
    const ins = e.url ? inspectedByKey.get(urlKey(e.url)) : null;
    const days = e.startedAt ? Math.round((new Date(today) - new Date(e.startedAt)) / 86400000) : null;
    const nowState = ins ? (ins.coverageState || ins.verdict) : null;
    const isIndexed = ins?.verdict === 'PASS';
    const wasIndexed = !!e.indexedAt;

    // 🔴 색인 전환을 처음 감지한 주 — 사람이 목록을 대조하지 않아도 알게 한다.
    if (isIndexed && !wasIndexed) {
      e.indexedAt = today;
      e.status = 'indexed';
      out.changed = true;
    }

    out.lines.push(`  • 슬러그 ${e.slug} (${e.type || '실험'}) — D+${days ?? '?'}`);
    out.lines.push(`    기준선: ${e.baseline?.coverageState || '-'}`);
    if (!ins) {
      out.lines.push(`    현재  : (이번 실행에서 검사되지 않음)`);
    } else {
      out.lines.push(`    현재  : ${nowState}`);
      if (isIndexed && e.indexedAt === today) {
        out.lines.push(`    ✅✅ 색인 전환! (${e.baseline?.date} → ${today}, ${days}일 소요)`);
      } else if (isIndexed) {
        out.lines.push(`    ✅ 색인 유지 중 (전환일 ${e.indexedAt})`);
      } else if (nowState && nowState !== e.baseline?.coverageState) {
        out.lines.push(`    🔄 상태 변화 있음 (아직 색인은 아님)`);
      } else {
        out.lines.push(`    ⏳ 기준선과 동일 — 아직 변화 없음`);
      }
    }
    if (e.verdictDue) out.lines.push(`    판정일: ${e.verdictDue}`);
  }
  out.lines.push('  (판정이 끝난 실험은 status 를 closed 로 바꾸면 이 구역에서 빠집니다)');
  return out;
}

// ── 이력 ──────────────────────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY, 'utf8')); }
  catch { return { _note: 'SEO 감시 이력. seo-watch.mjs 가 갱신.', runs: {}, updatedAt: null }; }
}
function saveHistory(h, entry) {
  h.runs = h.runs || {};
  h.runs[entry.date] = entry;
  h.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  fs.writeFileSync(HISTORY, JSON.stringify(h, null, 1));
}
const prevRun = (h) => {
  const keys = Object.keys(h.runs || {}).sort();
  return keys.length ? h.runs[keys[keys.length - 1]] : null;
};

// ── 본체 ──────────────────────────────────────────────────────────────
export async function runSeoWatch({ dry = false, quick = false } = {}) {
  const today = gsc.kstDaysAgo(0);
  const resolved = await gsc.resolveSiteUrl(SITE_DOMAIN);
  if (!resolved.siteUrl) throw Object.assign(new Error('GSC 속성을 찾지 못했습니다'), { kind: 'nosite' });
  const SITE = resolved.siteUrl;

  const history = loadHistory();
  const prev = prevRun(history);

  // ① 사이트맵 상태
  const maps = await gsc.sitemaps(SITE);
  const submitted = maps.reduce((s, m) => Math.max(s, m.submitted), 0);
  const mapErrors = maps.reduce((s, m) => s + m.errors, 0);
  const mapWarnings = maps.reduce((s, m) => s + m.warnings, 0);
  const staleMaps = maps.filter((m) => {
    if (!m.lastDownloaded) return true;
    return (Date.now() - new Date(m.lastDownloaded)) / 86400000 > 7;
  });

  // ② 로컬 스캔 + 사이트맵에서 실제 URL 해석(추측 금지)
  const all = scanPosts();
  await attachSitemapUrls(all);
  const published = all.filter((p) => !p.draft);
  // 사이트맵에 없는 발행글 — 이제 이게 '진짜 누락'이다(대소문자 오탐이 아니라).
  const notInSitemap = published.filter((p) => !p.inSitemap);
  const drafts = all.filter((p) => p.draft);
  const brokenImages = published.filter((p) => p.broken.length);
  const noDescription = published.filter((p) => !p.description.trim());
  // 같은 URL 을 주장하는 글 — 빌드 충돌·중복 색인의 원인
  const byUrl = new Map();
  for (const p of published) {
    if (!byUrl.has(p.pathname)) byUrl.set(p.pathname, []);
    byUrl.get(p.pathname).push(p);
  }
  const dupUrls = [...byUrl.entries()].filter(([, v]) => v.length > 1);
  const cannibal = findCannibalization(published);
  const dupDrafts = findDuplicateDrafts(all);

  // ③ 색인 상태(URL Inspection) — quick 모드에서는 건너뛴다
  let inspected = [], indexedCount = null, notIndexed = [], regressed = [], crawlStale = [];
  // 미발견 감시 집계. --quick 이면 null 로 남아 '검사되지 않음'으로 표시된다.
  let unknownStats = null;
  if (!quick) {
    // 사이트맵에서 해석된 URL 만 검사한다. 해석 실패분은 아래에서 따로 보고한다.
    const urls = published.filter((p) => p.url).map((p) => p.url);
    const t0 = Date.now();
    inspected = await gsc.inspectMany(SITE, urls, {
      concurrency: 8,
      onProgress: (d, t) => { if (d % 40 === 0 || d === t) console.log(`[seo-watch] 색인 검사 ${d}/${t} (${Math.round((Date.now() - t0) / 1000)}초)`); },
    });
    const byUrlIns = new Map(inspected.map((r) => [r.url, r]));
    indexedCount = inspected.filter((r) => r.verdict === 'PASS').length;
    notIndexed = published
      .map((p) => ({ ...p, ins: byUrlIns.get(p.url) }))
      .filter((p) => p.ins && p.ins.verdict !== 'PASS')
      // 상태를 뭉뚱그리지 않는다 — 세 갈래는 처방이 정반대다(lib/indexState.mjs).
      .map((p) => ({
        ...p,
        cls: classifyIndex(p.ins.coverageState || p.ins.verdict),
        age: p.pubDate ? daysBetween(p.pubDate, today) : null,
      }));
    // 🔴 색인됨 → 제외됨 회귀: 지난 실행에 PASS 였는데 지금 아닌 글
    const prevPass = new Set(prev?.passUrls || []);
    regressed = inspected.filter((r) => r.verdict !== 'PASS' && prevPass.has(r.url));
    // 크롤이 오래된 글(60일 초과)
    crawlStale = inspected.filter((r) => r.lastCrawlTime &&
      (Date.now() - new Date(r.lastCrawlTime)) / 86400000 > 60);
  }

  // 실험 추적용 — urlKey 로 찾을 수 있게. quick 모드면 비어 있고, 그 경우
  // 실험 구역은 "이번 실행에서 검사되지 않음"으로 정직하게 표시된다.
  const inspectedByKey = new Map(inspected.map((r) => [urlKey(r.url), r]));

  // 색인 급감 판정
  const prevIndexed = prev?.indexedCount ?? null;
  const indexDrop = (indexedCount !== null && prevIndexed)
    ? (prevIndexed - indexedCount) / prevIndexed : 0;

  // ── 리포트 ──
  const L = [];
  const problems = [];
  L.push(`🔍 SEO 감시 리포트 ${today.slice(5)}`);
  L.push(`주 1회 정밀 점검 · 감시만 합니다(조치는 승인 후)`);
  L.push(`※ 급변 감지는 매일 08:00 성과 리포트가 담당합니다 — 여기는 상태 전반을 봅니다.`);
  L.push('');

  L.push('【색인】');
  if (quick) {
    L.push('  (--quick: URL 색인 검사 생략)');
  } else {
    L.push(`  색인됨 ${indexedCount} / 발행 ${published.length}편` +
      (prevIndexed !== null ? ` (직전 ${prevIndexed})` : ''));
    if (indexDrop >= INDEX_DROP_ALERT) {
      const line = `🚨 색인 급감 ${Math.round(indexDrop * 100)}% (${prevIndexed}→${indexedCount})`;
      L.push('  ' + line); problems.push(line);
    }
    if (regressed.length) {
      const line = `🚨 색인됨→제외됨 ${regressed.length}편`;
      L.push('  ' + line); problems.push(line);
      for (const r of regressed.slice(0, 5)) {
        L.push(`     • ${decodeURIComponent(r.url).replace(ORIGIN, '').slice(0, 40)}`);
        L.push(`       ${r.coverageState || r.verdict}`);
      }
    }
    if (notIndexed.length) {
      // 미색인은 '검색에 아예 안 나오는 글'이라 가장 실질적인 손실이다.
      // 다만 상태별로 처방이 정반대라 뭉뚱그리지 않고 갈라서 보여준다.
      const pct = Math.round((notIndexed.length / published.length) * 100);
      const l = `미색인 ${notIndexed.length}편 (${pct}%)`;
      problems.push(l);
      L.push(`  ${pct >= 20 ? '🚨' : '⚠️'} ${l} — 상태별로 처방이 다릅니다:`);
      for (const cls of ['rejected', 'discovered', 'unknown', 'other']) {
        const set = notIndexed.filter((p) => p.cls === cls);
        if (!set.length) continue;
        L.push(`     ▸ ${CLASS_LABEL[cls]} ${set.length}편 — ${CLASS_ACTION[cls]}`);
        for (const p of set.slice(0, 3)) {
          L.push(`        • ${p.title.slice(0, 24)} (D+${p.age ?? '?'})`);
        }
        if (set.length > 3) L.push(`        … 외 ${set.length - 3}편`);
      }
    }
    if (crawlStale.length) {
      const l = `60일 넘게 재크롤 안 된 글 ${crawlStale.length}편`;
      problems.push(l);
      L.push(`  ⏳ ${l}`);
    }

    // ── 🔎 미발견 감시 — 이상 신호만 ──
    // 원시 개수는 올리지 않는다. D+14 미만은 정상 대기라 아예 언급하지 않는다.
    const unknownAll = notIndexed.filter((p) => p.cls === 'unknown');
    const unknownMature = unknownAll.filter((p) => (p.age ?? 0) >= INDEX_GRACE_DAYS);
    const unknownAged = unknownAll.filter((p) => (p.age ?? 0) >= UNKNOWN_ALERT_DAYS);
    const prevMature = prev?.unknownMature ?? null;

    unknownStats = {
      total: unknownAll.length,
      mature: unknownMature.length,
      aged: unknownAged.length,
      matureSlugs: unknownMature.map((p) => p.dir),
    };

    L.push('');
    L.push('  🔎 미발견(구글이 주소를 모름) 감시');
    // 조용한 카운터 — 경보가 아니라 추세다. D+14 미만은 세지 않는다.
    L.push(`     D+${INDEX_GRACE_DAYS} 이상 미발견 ${unknownMature.length}편` +
      (prevMature !== null ? ` (직전 ${prevMature})` : '') +
      ` · D+${INDEX_GRACE_DAYS} 미만은 정상 대기라 세지 않습니다`);

    // ⚠️ 오래된 미발견 — 단순 대기로 보기 어려운 구간
    if (unknownAged.length) {
      const l = `D+${UNKNOWN_ALERT_DAYS} 넘게 미발견 ${unknownAged.length}편 (발견 경로 의심)`;
      problems.push(l);
      L.push(`     ⚠️ ${l}`);
      for (const p of unknownAged.slice(0, 4)) L.push(`        • ${p.title.slice(0, 24)} (D+${p.age})`);
      L.push(`        → 사이트맵에 있고 200 이면 대개 시간이 해결합니다. 반복되면 색인 요청을 검토하세요.`);
    }

    // 🚨 급증 — 배포·사이트맵 사고 신호
    if (prevMature !== null && unknownMature.length >= prevMature + UNKNOWN_SURGE_DELTA) {
      const l = `🚨 성숙 글 미발견 급증 ${prevMature}→${unknownMature.length}편 (배포·사이트맵 사고 의심)`;
      problems.push(l);
      L.push(`     ${l}`);
    }

    // 🚨 미발견 + 사이트맵 없음은 여기서 관측할 수 없다 — 정직하게 밝혀둔다.
    //    사이트맵에서 URL 을 못 찾은 글은 애초에 검사 대상에서 빠지므로(url=null),
    //    'unknown' 버킷에 나타날 수 없다. 그 경우는 아래 【글 상태】의
    //    '사이트맵에 없는 발행글' 경보가 이미 잡고 있다. 여기서 중복해 세지 않는다.
    if (notInSitemap.length) {
      L.push(`     ※ 사이트맵에 없는 발행글 ${notInSitemap.length}편은 검사 대상에서 빠집니다`);
      L.push(`        → 그건 아래 【글 상태】의 사이트맵 경보가 담당합니다(여기서 중복 계상 안 함).`);
    }
  }

  L.push('');
  L.push('【사이트맵】');
  for (const m of maps) {
    L.push(`  • ${m.path.replace(ORIGIN + '/', '')} — 제출 ${m.submitted}개` +
      (m.errors ? ` · 오류 ${m.errors}` : '') + (m.warnings ? ` · 경고 ${m.warnings}` : ''));
    L.push(`    최종 처리 ${m.lastDownloaded?.slice(0, 10) || '기록 없음'}`);
  }
  if (mapErrors) { const l = `🚨 사이트맵 오류 ${mapErrors}건`; L.push('  ' + l); problems.push(l); }
  if (staleMaps.length) { const l = `⚠️ 7일 넘게 재처리 안 된 사이트맵 ${staleMaps.length}개`; L.push('  ' + l); problems.push(l); }
  if (prev?.submitted && submitted < prev.submitted) {
    const l = `⚠️ 사이트맵 제출 URL 감소 ${prev.submitted}→${submitted}`;
    L.push('  ' + l); problems.push(l);
  }

  L.push('');
  L.push('【글 상태】');
  L.push(`  발행 ${published.length}편 · 초안 ${drafts.length}편`);
  if (notInSitemap.length) {
    const l = `사이트맵에 없는 발행글 ${notInSitemap.length}편 (검색에 노출될 수 없음)`;
    problems.push(l);
    L.push(`  🚨 ${l}`);
    for (const p of notInSitemap.slice(0, 5)) L.push(`     • ${p.dir.slice(0, 44)}`);
  }
  if (dupUrls.length) {
    const l = `🚨 같은 주소를 쓰는 글 ${dupUrls.length}쌍 (빌드 충돌·중복 색인)`;
    L.push('  ' + l); problems.push(l);
    for (const [u, list] of dupUrls.slice(0, 3)) L.push(`     • ${u} ← ${list.map((p) => p.dir).join(', ')}`);
  }
  if (brokenImages.length) {
    const l = `🚨 깨진 이미지 참조 ${brokenImages.length}편`;
    L.push('  ' + l); problems.push(l);
    for (const p of brokenImages.slice(0, 3)) L.push(`     • ${p.title.slice(0, 24)} → ${p.broken[0]}`);
  }
  if (cannibal.length) {
    // 발행글 중복은 '이미 벌어진 일'이라 판단이 필요하다. 의도적으로 각도를 나눈
    // 경우도 있으므로 자동 조치 대상으로 올리지 않고 검토 목록으로만 낸다.
    L.push(`  ⚠️ 같은 주제 발행글 ${cannibal.length}건 (일부는 의도된 각도 분리일 수 있어 판단 필요)`);
    for (const c of cannibal.sort((a, b) => b.posts.length - a.posts.length).slice(0, 4)) {
      L.push(`     • [${c.key}] ${c.posts.length}편`);
      for (const p of c.posts.slice(0, 3)) L.push(`       - ${p.title.slice(0, 32)}`);
    }
    if (cannibal.length > 4) L.push(`     … 외 ${cannibal.length - 4}건`);
  }
  // 초안 중복은 '아직 막을 수 있는' 문제라 발행글 중복보다 먼저 보여준다.
  if (dupDrafts.length) {
    const l = `⚠️ 중복 초안 ${dupDrafts.length}건 (발행 전에 정리하면 자기잠식을 막습니다)`;
    L.push('  ' + l); problems.push(l);
    for (const d of dupDrafts.slice(0, 4)) {
      L.push(`     • [${d.subject}] 초안 ${d.drafts.length}편` + (d.published.length ? ` + 발행글 ${d.published.length}편` : ''));
      for (const p of d.drafts.slice(0, 3)) L.push(`       - (초안) ${p.title.slice(0, 30)}`);
      for (const p of d.published.slice(0, 2)) L.push(`       - (발행) ${p.title.slice(0, 30)}`);
      L.push(`       → 하나만 남기고 /delete 하세요`);
    }
  }
  if (noDescription.length) L.push(`  ℹ️ description 없는 글 ${noDescription.length}편 (본문 앞부분으로 자동 대체되나, 직접 쓰는 편이 낫습니다)`);

  // 🧪 실험 추적 — 파일에 실험을 추가하기만 하면 여기 자동으로 뜬다.
  const expData = loadExperiments();
  const exp = trackExperiments(expData, inspectedByKey, today);
  if (exp.lines.length) {
    L.push('');
    L.push(...exp.lines);
  }

  L.push('');
  L.push('【네이버】 ⚠️ 자동 확인 불가');
  L.push('  서치어드바이저는 성과·진단 API 를 제공하지 않습니다(수집요청 API 만 있음).');
  L.push('  주 1회 직접 확인해 주세요 — 사이트 진단·수집 현황:');
  L.push(`  ${NAVER_DIAG}`);

  L.push('');
  if (problems.length) {
    // 무엇이 조치 후보인지 한 줄로 다시 보여준다 — 위에서 ⚠️ 를 세어보게 만들지 않는다.
    L.push(`📌 조치 후보 ${problems.length}건`);
    for (const p of problems) L.push(`  · ${p}`);
    L.push('무엇부터 할지 지시해 주세요. 자동으로 고치지 않습니다.');
  } else {
    L.push('✅ 특이사항 없습니다.');
  }

  const message = L.join('\n');

  if (!dry) {
    // 색인 전환을 감지했으면 실험 파일에 기록한다(다음 주엔 '유지 중'으로 표시).
    if (exp.changed) { saveExperiments(expData); console.log('[seo-watch] 실험 상태 갱신됨'); }
    saveHistory(history, {
      date: today,
      indexedCount, publishedCount: published.length,
      submitted, mapErrors, mapWarnings,
      brokenImages: brokenImages.length, dupUrls: dupUrls.length,
      cannibal: cannibal.length, notIndexed: notIndexed.length,
      // 상태별 내역 — 다음 실행이 '무엇이 늘었나'를 상태 단위로 비교할 수 있게.
      byClass: quick ? (prev?.byClass ?? null) : {
        rejected: notIndexed.filter((p) => p.cls === 'rejected').length,
        discovered: notIndexed.filter((p) => p.cls === 'discovered').length,
        unknown: notIndexed.filter((p) => p.cls === 'unknown').length,
        other: notIndexed.filter((p) => p.cls === 'other').length,
      },
      // 🔴 급증 판정의 기준선. --quick 이면 이번 회차에 안 쟀으므로 직전 값을 그대로
      //    물려준다 — 0 으로 덮으면 다음 주에 가짜 급증이 뜬다.
      unknownMature: quick ? (prev?.unknownMature ?? null) : unknownStats?.mature ?? null,
      unknownAged: quick ? (prev?.unknownAged ?? null) : unknownStats?.aged ?? null,
      unknownMatureSlugs: quick ? (prev?.unknownMatureSlugs ?? []) : (unknownStats?.matureSlugs ?? []),
      // 다음 실행에서 '색인됨→제외됨' 을 판정하기 위한 스냅샷
      passUrls: quick ? (prev?.passUrls || []) : inspected.filter((r) => r.verdict === 'PASS').map((r) => r.url),
      problems,
    });
    await sendMessage(process.env.TELEGRAM_CHAT_ID, message);
  }
  return { ok: true, message, problems: problems.length };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runSeoWatch({ dry: DRY, quick: QUICK })
    .then((r) => { console.log(r.message); if (DRY) console.log('\n(--dry-run: 전송·이력 저장 안 함)'); })
    .catch(async (e) => {
      console.error('[seo-watch] 실패:', e.kind || 'error', e.message);
      if (!DRY) { try { await sendMessage(process.env.TELEGRAM_CHAT_ID, `❌ SEO 감시 실패: ${e.message}`); } catch {} }
      process.exit(1);
    });
}
