#!/usr/bin/env node
// 🩺 품질 검토자 (자율 개선 에이전트 4단계).
//
// 주 1회. "이 글이 왜 검색에서 실패하는가"를 객관 지표로 진단한다.
// 진단까지만 — 글을 고치지도, 발행하지도, 커밋하지도 않는다.
//
// 🔴 LLM 호출 0회.
//    사용자가 "LLM 은 품질 판단에만, 주 1~3회"를 허용했지만 계약 §5 는 먼저
//    "LLM 없이 되나?"를 물으라고 한다. 물어본 결과 — 된다.
//    이 에이전트가 내는 판단은 전부 셈할 수 있는 것이다: 출처 없는 수치 개수,
//    h2 개수, 표 유무, 본문 길이, D+N, 검색어-제목 토큰 매칭. LLM 을 끼우면
//    "품질이 낮아 보입니다" 같은 주관 문장이 섞여 들어와 오히려 근거가 흐려진다.
//    ⚠️ 그래서 이 파일에는 '품질이 낮다'는 판정이 없다. 지표와 그 임계값만 있다.
//
// ── 역할 경계 ─────────────────────────────────────────────────────────
//  · 성과 분석가(daily)   — 지금 성과가 어떤가            → 목록만, 진단 없음
//  · SEO 감시자(weekly)   — 기존 글이 괜찮은가(유지)      → 미색인 '편수'를 센다
//  · 콘텐츠 큐레이터      — 무엇을 새로 쓸까(생성)
//  · 품질 검토자(여기)    — 왜 실패하는가(진단)           ★ 검색 실패 축
//  · 갱신 트랙(updateTrack.mjs, 5번) — 오래됐으니 새로고침 ★ 시간 축
//
// 🔴 5번(updateTrack)과 겹치지 않게 하는 규칙:
//    updateTrack 은 '낡은 연도·계절 도래·얇은 글'로 후보를 고른다(시간 축).
//    품질 검토자는 그 세 신호를 **후보 선정 기준으로 쓰지 않는다.**
//    여기서 후보가 되는 조건은 오직 두 가지, 둘 다 '검색이 실제로 실패한 증거'다:
//      Ⓐ 색인 거절 — 구글이 크롤하고도 색인을 안 만들었다(URL Inspection)
//      Ⓑ 노출은 나는데 클릭이 없다 — 검색 결과에 뜨는데 아무도 안 누른다
//    본문 길이는 Ⓐ의 '왜'를 설명하는 근거로만 쓰고, 후보를 고르는 데는 쓰지 않는다.
//    또 updateTrack 쿨다운(90일) 중인 글은 제외한다 — 두 트랙이 같은 글을 동시에
//    제안하면 사람이 어느 쪽 말을 들어야 할지 모르게 된다.
//
// ── 🧪 9번 색인 실험 존중 ─────────────────────────────────────────────
// data/seo-experiments.json 의 slug 9 실험(C유형 전면 재작성)이 판정 중이다.
// 판정 전에 나머지 C유형 6편을 같은 방식으로 일괄 갱신하자고 제안하면,
// 실패했을 때 6편을 한꺼번에 망가뜨린다. 실험이란 게 그래서 있는 것이다.
//   · running  → 진단만. 일괄 갱신 제안·버튼 없음. "결과 대기 중"을 명시.
//   · indexed  → 실험 성공. 나머지 C유형으로 갱신 제안 확대(버튼 제공).
//   · closed   → indexedAt 있으면 성공으로 보고 확대, 없으면 '방치 권고'.
// 이 판정은 experimentGate() 한 곳에만 있다 — 코드 여기저기에 흩지 않는다.
//
// 사용:
//   node automation/quality-review.mjs --dry-run   # 화면 출력만(전송·저장 없음)
//   node automation/quality-review.mjs --quick     # URL 색인 검사 생략(정적 분석만)
//   node automation/quality-review.mjs             # 텔레그램 카드 + 이력 저장
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT, AUTO_DIR } from './lib/env.mjs';
import { sendMessage, inlineButtons } from './lib/telegram.mjs';
import * as gsc from './lib/gsc.mjs';
import { urlKey } from './lib/sitemap.mjs';
import { scanPosts, attachSitemapUrls, loadExperiments } from './seo-watch.mjs';
import { sameFacility } from './curator.mjs';
import { loadCooldown } from './lib/updateTrack.mjs';
import { classifyIndex, CLASS_LABEL } from './lib/indexState.mjs';

loadEnv();

const DRY = process.argv.includes('--dry-run');
const QUICK = process.argv.includes('--quick');
const SITE_DOMAIN = 'allexishere.com';
const BLOG = path.join(ROOT, 'src', 'content', 'blog');
const HISTORY = path.join(ROOT, 'data', 'quality-history.json');
const UPDATES = path.join(AUTO_DIR, 'state', 'updates.json');

// ── 임계값 ────────────────────────────────────────────────────────────
// 색인 지연은 3~14일이다. D+14 전의 '미색인'은 실패가 아니라 아직 안 온 것이다.
const INDEX_GRACE_DAYS = 14;
// 소표본 CTR 은 착시다(analyst.mjs 와 같은 기준). 이 아래로는 비율을 만들지 않는다.
const MIN_IMPRESSIONS = 100;
// 이 아래면 '노출은 나는데 클릭이 없다'로 본다.
const DEAD_CTR = 0.005;
// CTR 판정도 색인·GSC 지연을 피해 D+7 이후만.
const JUDGE_AFTER_DAYS = 7;
// 한 번에 사람에게 들이미는 진단 수 — 카드가 길면 안 읽는다.
const DIAGNOSE_CAP = 8;

// ── 정적 품질 지표 ────────────────────────────────────────────────────
// 🔴 여기 있는 건 전부 '셀 수 있는 것'이다. "글이 부실하다" 같은 판단은 만들지 않는다.

// 출처로 인정하는 표지. 기관명·연도 병기·명시적 출처 표기·링크.
// (운영 원칙: 기관 수치를 쓸 때는 기관명·연도·기준을 병기한다)
const SOURCE_MARK = /(출처|자료|기준일|참고|고시|보건복지부|식약처|질병관리청|국세청|행정안전부|국토교통부|통계청|기상청|한국소비자원|WHO|FDA|EFSA|KDRIs|NIH|논문|가이드라인|\[[^\]]+\]\(https?:\/\/)/;
// 수치 주장으로 보는 패턴 — 단위가 붙은 숫자. 날짜·목차 번호는 제외하려고 단위를 요구한다.
const NUMERIC_CLAIM = /\d[\d,.]*\s*(%|퍼센트|mg|g|kg|ml|L|리터|원|만원|억|배|시간|분|초|일|개월|년치|칼로리|kcal|cm|mm|도|℃)/;

// 본문을 문장 단위로 자른다. 표·코드블록은 따로 세므로 여기서 뺀다.
function proseSentences(body) {
  const noCode = body.replace(/```[\s\S]*?```/g, '');
  const noTable = noCode.split('\n').filter((l) => !/^\s*\|/.test(l)).join('\n');
  return noTable.split(/(?<=[.!?。])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

// 🔴 이 저장소에서 가장 비싼 교훈의 지표.
//    폴더 9(물과 건강)는 출처 없는 구체 수치가 49개였고, 구글이 크롤하고도
//    색인을 거절했다. YMYL 글에서 이 값이 크면 색인 거절의 유력한 설명이 된다.
//
//    ⚠️ 정직하게: 이건 휴리스틱이다. '같은 문장 안에 출처 표지가 없는 수치 문장'을
//    셀 뿐, 문단 위에 출처를 한 번 밝히고 아래에서 수치를 나열한 경우를 과다 계상한다.
//    그래서 리포트는 이 값을 '판정'이 아니라 '확인해 볼 지점'으로 표시한다.
export function unsourcedNumbers(body) {
  const sents = proseSentences(body);
  const claims = sents.filter((s) => NUMERIC_CLAIM.test(s));
  const unsourced = claims.filter((s) => !SOURCE_MARK.test(s));
  return { claims: claims.length, unsourced: unsourced.length, samples: unsourced.slice(0, 2) };
}

// 마크다운 표 개수 — 연속된 | 줄 묶음 하나를 표 1개로 센다.
function countTables(body) {
  let n = 0, inTable = false;
  for (const line of body.split('\n')) {
    const isRow = /^\s*\|/.test(line);
    if (isRow && !inTable) { n++; inTable = true; }
    else if (!isRow) inTable = false;
  }
  return n;
}

// 발행글 1편의 정적 지표. 파일을 못 읽으면 null.
export function analyzePost(slug) {
  const f = path.join(BLOG, slug, 'index.md');
  if (!fs.existsSync(f)) return null;
  const raw = fs.readFileSync(f, 'utf8');
  const pick = (re) => (raw.match(re) || [])[1] || '';
  const body = raw.split(/^---\s*$/m).slice(2).join('---').split('<!--')[0].trim();
  const title = pick(/^title:\s*"?(.*?)"?\s*$/m);
  const description = pick(/^description:\s*"?(.*?)"?\s*$/m);
  const num = unsourcedNumbers(body);
  return {
    slug, title, description,
    pubDate: pick(/^pubDate:\s*(.*?)\s*$/m).slice(0, 10),
    originalPath: pick(/^originalPath:\s*"?(.*?)"?\s*$/m),
    bodyLen: body.length,
    h2: (body.match(/^##\s+/gm) || []).length,
    h3: (body.match(/^###\s+/gm) || []).length,
    // 🔴 h2 개수만으로 '구조가 없다'고 판정하면 틀린다. 실측(2026-07-19): 슬러그 10·38 은
    //    h2 가 0이지만 ### 로 6~7개 절을 나눠 구조가 멀쩡하다. h2 만 세서 경보를 내면
    //    거짓 경보가 되고, 거짓 경보가 쌓이면 사람이 리포트 자체를 안 읽는다(계약 §4).
    //    → 실제 결함은 '헤딩이 아예 없는 글'이다. 슬러그 56 은 **굵은 글씨**를 헤딩처럼
    //      쓰고 있어 검색엔진이 절 구조를 읽지 못한다. 그건 진짜 결함이라 따로 센다.
    headings: (body.match(/^#{2,4}\s+/gm) || []).length,
    pseudoHeadings: (body.match(/^\s*\*\*[^*\n]{2,40}\*\*\s*$/gm) || []).length,
    tables: countTables(body),
    // FAQ 는 갱신 표준의 필수 항목이라 따로 센다.
    faq: /FAQ|자주\s*묻는/i.test(body) ? (body.match(/^###\s+/gm) || []).length : 0,
    links: (body.match(/\[[^\]]+\]\(https?:\/\//g) || []).length,
    images: (body.match(/!\[[^\]]*\]\(/g) || []).length,
    numericClaims: num.claims,
    unsourced: num.unsourced,
    unsourcedSamples: num.samples,
    hasDisclaimer: /의료진|전문의|상담|참고용|진단을 대신|투자 판단/.test(body),
    titleLen: title.length,
    descLen: description.length,
  };
}

// ── 검색의도 매칭 ─────────────────────────────────────────────────────
// 노출은 나는데 클릭이 없을 때, 가장 흔한 설명은 '검색어와 제목이 어긋난다'는 것이다.
// 🔴 계약 §4 — 토큰 겹침으로 판정하지 않는다. curator 의 sameFacility(수식어 제거 →
//    4자 이상 토큰 겹침 → 한글↔영문 별칭)를 그대로 쓴다. 새 판정 로직을 만들면
//    '주차·요금' 같은 흔한 단어로 전부 매칭됐다고 나와 지표가 무의미해진다.
//
// 🔴 NFC 정규화가 반드시 먼저다(2026-07-19 실측 버그).
//    GSC 는 한글 검색어를 NFD(자모 분해)로 준다. "클러스터" 가 ㅋ+ㅡ+ㄹ… 형태다.
//    로컬 글 제목은 NFC(완성형)다. 토큰 정규식의 [가-힣] 은 완성형(AC00–D7A3)만
//    잡고 분해 자모(1100–11FF)는 못 잡는다 → 검색어 토큰이 통째로 사라져
//    **모든 글의 매칭이 항상 0%** 로 나온다. 숫자는 나오는데 전부 틀린 상태라
//    지표가 없느니만 못하다. 그래서 양쪽을 NFC 로 맞춘 뒤에 비교한다.
export function intentMatch(title, queries) {
  const t = String(title || '').normalize('NFC');
  const matched = [], missed = [];
  for (const q of queries) {
    if (sameFacility(String(q.query || '').normalize('NFC'), t)) matched.push(q);
    else missed.push(q);
  }
  const impMatched = matched.reduce((s, q) => s + q.impressions, 0);
  const impTotal = matched.concat(missed).reduce((s, q) => s + q.impressions, 0);
  return {
    matched, missed,
    // 노출 가중 — 검색어 개수보다 '노출이 어디서 나는가'가 중요하다.
    coverage: impTotal ? impMatched / impTotal : null,
    topMissed: missed.sort((a, b) => b.impressions - a.impressions).slice(0, 3),
  };
}

// ── 🧪 실험 게이트 ────────────────────────────────────────────────────
// C유형 일괄 갱신을 열지 말지를 여기 한 곳에서만 정한다.
// 반환: { state, allowBulk, reason, exp }
export function experimentGate(expData, { type = 'C유형' } = {}) {
  const exps = expData?.experiments || [];
  // 이 게이트가 보는 건 'C유형 갱신 실험'이다. 다른 실험은 관여하지 않는다.
  const exp = exps.find((e) => (e.type || '').includes(type));
  if (!exp) {
    return {
      state: 'none', allowBulk: false, exp: null,
      reason: 'C유형 갱신 실험 기록이 없습니다. 근거 없이 일괄 갱신을 제안하지 않습니다.',
    };
  }
  if (exp.status === 'running') {
    return {
      state: 'running', allowBulk: false, exp,
      reason: `실험(슬러그 ${exp.slug}) 판정 대기 중 — 판정일 ${exp.verdictDue || '미정'}. ` +
        '결과가 나오기 전에 나머지를 같은 방식으로 고치면, 실패했을 때 한꺼번에 망가집니다.',
    };
  }
  if (exp.status === 'indexed' || (exp.status === 'closed' && exp.indexedAt)) {
    return {
      state: 'success', allowBulk: true, exp,
      reason: `실험 성공 — 슬러그 ${exp.slug} 가 ${exp.indexedAt || '?'} 에 색인 전환됐습니다. ` +
        '같은 처방(출처 명시·구조 보강)을 나머지 C유형에 적용할 근거가 생겼습니다.',
    };
  }
  if (exp.status === 'closed' && !exp.indexedAt) {
    return {
      state: 'failed', allowBulk: false, exp,
      reason: `실험 실패 — 슬러그 ${exp.slug} 는 전면 재작성 후에도 색인되지 않았습니다. ` +
        '같은 처방을 6편에 반복하는 건 비용만 쓰는 일입니다. C유형은 방치하고 신규 글에 자원을 쓰는 편이 낫습니다.',
    };
  }
  return { state: 'unknown', allowBulk: false, exp, reason: `실험 상태를 해석하지 못했습니다(status=${exp.status}).` };
}

// 색인 상태 분류는 lib/indexState.mjs 로 옮겼다 — seo-watch 도 같은 기준으로
// 판정해야 두 리포트가 어긋나지 않는다. 여기서 재-export 해 기존 사용처를 유지한다.
// 품질 진단(explainNotIndexed)과 갱신 제안은 'rejected'(크롤 후 거절)에만 적용한다.
export { classifyIndex };

// ── 진단: 왜 색인이 거절됐나 ──────────────────────────────────────────
// 🔴 여기서 내는 건 '설명 후보'지 원인 확정이 아니다. 구글은 색인 거절 사유를
//    알려주지 않는다(coverageState 는 상태지 이유가 아니다). 그래서 문장을
//    "…일 수 있습니다"로 쓰고, 리포트 하단에 한계를 명시한다.
export function explainNotIndexed(m) {
  const signals = [];
  if (m.unsourced >= 10) signals.push({ w: 3, s: `출처 없는 수치 문장 ${m.unsourced}개 (수치 주장 ${m.numericClaims}개 중) — 슬러그 9 사례와 같은 유형` });
  if (m.bodyLen < 1500) signals.push({ w: 2, s: `본문 ${m.bodyLen}자 — 검색 결과 상위 글 대비 얇음` });
  // 헤딩이 아예 없는 글 — 굵은 글씨를 헤딩처럼 쓰면 검색엔진은 절 구조를 못 읽는다.
  if (m.headings === 0 && m.pseudoHeadings >= 3) {
    signals.push({ w: 3, s: `헤딩 0개 · 굵은 글씨를 헤딩처럼 쓴 곳 ${m.pseudoHeadings}군데 — 검색엔진이 절 구조를 읽지 못함` });
  } else if (m.headings <= 2) {
    signals.push({ w: 2, s: `헤딩 ${m.headings}개 — 구조가 평면적이라 무엇을 답하는 글인지 드러나지 않음` });
  } else if (m.h2 === 0) {
    // 구조는 있으나 h3부터 시작 — 경보가 아니라 참고 사항이다(가중치 최하).
    signals.push({ w: 0, s: `절 ${m.headings}개가 모두 h3 이하 — 구조는 있으나 최상위 계층이 없음(경미)` });
  }
  if (m.tables === 0) signals.push({ w: 1, s: '표 0개 — 비교·기준 정보가 문장에만 있음' });
  if (m.links === 0) signals.push({ w: 1, s: '외부 출처 링크 0개' });
  if (!m.descLen) signals.push({ w: 1, s: 'description 없음' });
  signals.sort((a, b) => b.w - a.w);
  return signals;
}

// ── 진단: 왜 노출만 나고 클릭이 없나 ──────────────────────────────────
export function explainNoClicks(m, im, row) {
  const signals = [];
  if (im.coverage !== null && im.coverage < 0.5) {
    signals.push({ w: 3, s: `노출의 ${Math.round((1 - im.coverage) * 100)}% 가 제목과 안 맞는 검색어에서 발생` });
  }
  for (const q of im.topMissed.slice(0, 2)) {
    signals.push({ w: 2, s: `"${q.query}" 노출 ${q.impressions} — 이 말이 제목에 없음` });
  }
  if (row.position && row.position > 10) {
    signals.push({ w: 2, s: `평균순위 ${row.position.toFixed(1)} — 2페이지 이하라 클릭이 나기 어려움(제목보다 순위 문제)` });
  }
  if (!m.descLen) signals.push({ w: 2, s: 'description 없음 — 검색 결과 스니펫을 구글이 임의로 자름' });
  else if (m.descLen > 160) signals.push({ w: 1, s: `description ${m.descLen}자 — 검색 결과에서 잘림(160자 권장)` });
  if (m.titleLen > 40) signals.push({ w: 1, s: `제목 ${m.titleLen}자 — 모바일 검색 결과에서 잘림` });
  signals.sort((a, b) => b.w - a.w);
  return signals;
}

// ── 갱신 대기 레지스트리 ──────────────────────────────────────────────
// 🔴 새 발행 경로를 만들지 않는다(계약 §3). bot.mjs 의 기존 사슬을 그대로 탄다:
//      여기서 state/updates.json 에 항목을 넣고 [🔧 갱신 초안 생성] 버튼(upgen:)을 낸다
//        → bot 의 upgen 핸들러가 refreshPublished() 로 초안 생성(주소 불변·백업)
//        → [✅ 갱신 반영] 에서만 recordUpdated() + commitUpdate() 로 커밋·배포
//    즉 이 파일은 글을 건드리지 않는다. 사람이 버튼을 두 번 눌러야 배포된다.
//    id 접두사를 'q' 로 둬 bot 이 만드는 'u' 항목과 충돌하지 않게 한다.
function registerUpdate(entry) {
  fs.mkdirSync(path.dirname(UPDATES), { recursive: true });
  let map = {};
  try { map = JSON.parse(fs.readFileSync(UPDATES, 'utf8')); } catch {}
  const h = (s) => Math.abs([...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0)).toString(36);
  let id, i = 0;
  do { id = 'q' + h(entry.slug + '#q' + i); i++; } while (map[id]);
  map[id] = { ...entry, ts: Date.now(), source: 'quality-review' };
  fs.writeFileSync(UPDATES, JSON.stringify(map, null, 1));
  return id;
}

// ── 이력 ──────────────────────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY, 'utf8')); }
  catch { return { _note: '품질 검토 이력. quality-review.mjs 가 갱신. 같은 글이 반복해서 걸리는지 비교용.', runs: {}, updatedAt: null }; }
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

const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// ── 본체 ──────────────────────────────────────────────────────────────
export async function runQualityReview({ dry = false, quick = false } = {}) {
  const today = gsc.kstDaysAgo(0);
  const resolved = await gsc.resolveSiteUrl(SITE_DOMAIN);
  if (!resolved.siteUrl) throw Object.assign(new Error('GSC 속성을 찾지 못했습니다'), { kind: 'nosite' });
  const SITE = resolved.siteUrl;

  const history = loadHistory();
  const prev = prevRun(history);

  // ① 로컬 발행글 + 사이트맵에서 실제 URL 해석(추측 금지 — 운영 원칙 §8)
  const all = scanPosts();
  await attachSitemapUrls(all);
  const published = all.filter((p) => !p.draft);

  // 90일 쿨다운 중인 글은 제외한다 — 갱신 트랙(5번)이 이미 손댄 글이다.
  const cd = loadCooldown();
  const inCooldown = (slug) => {
    const t = cd.slugs?.[slug];
    return t && Date.now() - Date.parse(t) < 90 * 86400000;
  };

  // ② 색인 상태
  let inspected = [], notIndexed = [];
  if (!quick) {
    const urls = published.filter((p) => p.url).map((p) => p.url);
    const t0 = Date.now();
    inspected = await gsc.inspectMany(SITE, urls, {
      concurrency: 8,
      onProgress: (d, t) => { if (d % 40 === 0 || d === t) console.log(`[quality] 색인 검사 ${d}/${t} (${Math.round((Date.now() - t0) / 1000)}초)`); },
    });
    const byUrl = new Map(inspected.map((r) => [r.url, r]));
    notIndexed = published
      .map((p) => ({ ...p, ins: byUrl.get(p.url) }))
      .filter((p) => p.ins && p.ins.verdict !== 'PASS')
      // 🔴 데이터 성숙도 — D+14 전의 미색인은 실패가 아니라 '아직'이다.
      .filter((p) => p.pubDate && daysBetween(p.pubDate, today) >= INDEX_GRACE_DAYS);
  }

  // ③ 검색어·페이지 성과(최근 28일). GSC 90일 데이터라 우리 이력 길이와 무관하다.
  const start = gsc.kstDaysAgo(31), end = gsc.kstDaysAgo(3);
  const [pageRows, pqRows] = await Promise.all([
    gsc.searchAnalytics(SITE, { startDate: start, endDate: end, dimensions: ['page'], rowLimit: 500 }),
    gsc.searchAnalytics(SITE, { startDate: start, endDate: end, dimensions: ['page', 'query'], rowLimit: 5000 }),
  ]);
  // 앵커(#) 분할을 합산한다 — 합치지 않으면 글별 노출을 크게 과소평가한다(analyst 실측).
  const pageAgg = new Map();
  for (const r of pageRows) {
    const k = urlKey(r.keys[0]);
    const cur = pageAgg.get(k) || { key: k, impressions: 0, clicks: 0, posSum: 0 };
    cur.impressions += r.impressions || 0;
    cur.clicks += r.clicks || 0;
    cur.posSum += (r.position || 0) * (r.impressions || 0);
    pageAgg.set(k, cur);
  }
  for (const v of pageAgg.values()) {
    v.ctr = v.impressions ? v.clicks / v.impressions : 0;
    v.position = v.impressions ? v.posSum / v.impressions : null;
  }
  // 페이지별 검색어
  const queriesByPage = new Map();
  for (const r of pqRows) {
    const k = urlKey(r.keys[0]);
    if (!queriesByPage.has(k)) queriesByPage.set(k, []);
    queriesByPage.get(k).push({ query: r.keys[1], impressions: r.impressions || 0, clicks: r.clicks || 0 });
  }

  // ④ Ⓑ 후보 — 노출은 나는데 클릭이 없다
  const noClicks = published
    .filter((p) => p.pubDate && daysBetween(p.pubDate, today) >= JUDGE_AFTER_DAYS)
    .filter((p) => !inCooldown(p.dir))
    .map((p) => ({ p, row: pageAgg.get(urlKey(p.pathname)) }))
    .filter(({ row }) => row && row.impressions >= MIN_IMPRESSIONS && row.ctr < DEAD_CTR)
    .sort((a, b) => b.row.impressions - a.row.impressions);

  // ⑤ 🧪 실험 게이트
  const expData = loadExperiments();
  const gate = experimentGate(expData);

  // ⑥ 진단 조립
  const cTypeDiag = [];
  for (const p of notIndexed) {
    if (inCooldown(p.dir)) continue;
    const m = analyzePost(p.dir);
    if (!m) continue;
    const isExperiment = gate.exp && gate.exp.slug === p.dir;
    const coverageState = p.ins.coverageState || p.ins.verdict;
    const cls = classifyIndex(coverageState);
    cTypeDiag.push({
      slug: p.dir, title: p.title, url: p.url, m, isExperiment, cls,
      age: daysBetween(p.pubDate, today),
      coverageState,
      lastCrawl: p.ins.lastCrawlTime ? p.ins.lastCrawlTime.slice(0, 10) : null,
      // 🔴 품질 진단은 '크롤 후 거절'에만 붙인다. 크롤되지 않은 글에 품질 사유를
      //    달면 읽지도 않은 글을 고치라는 말이 된다.
      signals: cls === 'rejected' ? explainNotIndexed(m) : [],
    });
  }
  cTypeDiag.sort((a, b) => b.m.unsourced - a.m.unsourced);
  const rejected = cTypeDiag.filter((d) => d.cls === 'rejected');
  const notCrawled = cTypeDiag.filter((d) => d.cls !== 'rejected');

  const clickDiag = [];
  for (const { p, row } of noClicks.slice(0, DIAGNOSE_CAP)) {
    const m = analyzePost(p.dir);
    if (!m) continue;
    const qs = queriesByPage.get(urlKey(p.pathname)) || [];
    const im = intentMatch(p.title, qs);
    clickDiag.push({ slug: p.dir, title: p.title, url: p.url, m, row, im, signals: explainNoClicks(m, im, row) });
  }

  // ── 리포트 ──
  const L = [];
  L.push(`🩺 품질 검토 리포트 ${today.slice(5)}`);
  L.push('주 1회 · 진단만 합니다. 갱신은 승인 후 기존 갱신 트랙으로.');
  L.push('※ LLM 0회 — 아래 숫자는 전부 셈한 값입니다(주관 판정 없음).');
  L.push('');

  // 🧪 실험 상태를 맨 위에 — 이게 이번 회차에 무엇을 제안할 수 있는지 정한다.
  L.push('【🧪 C유형 실험 상태】');
  L.push(`  ${gate.state === 'running' ? '⏳ 진행 중' : gate.state === 'success' ? '✅ 성공' : gate.state === 'failed' ? '❌ 실패' : 'ℹ️ 없음'}`);
  L.push(`  ${gate.reason}`);
  if (!gate.allowBulk) L.push('  → 이번 회차는 **진단만** 합니다. 일괄 갱신 제안·버튼 없음.');
  L.push('');

  L.push(`【Ⓐ 미색인 진단】 ${quick ? '(--quick: 검사 생략)' : `${cTypeDiag.length}편 (D+${INDEX_GRACE_DAYS} 이상)`}`);
  if (!quick && !cTypeDiag.length) L.push('  해당 없음.');
  if (!quick && cTypeDiag.length) {
    // 🔴 세 갈래를 먼저 갈라 보여준다 — 처방이 정반대라 뭉뚱그리면 헛수고를 시킨다.
    L.push(`  크롤 후 거절(C유형) ${rejected.length}편 · 크롤 안 됨 ${notCrawled.length}편`);
    L.push('');
    L.push(`  ▸ 크롤 후 색인 거절 — 구글이 본문을 읽고 안 만들었습니다(품질이 설명 가능)`);
    if (!rejected.length) L.push('    해당 없음.');
    for (const d of rejected.slice(0, DIAGNOSE_CAP)) {
      L.push(`  • [${d.slug}] ${d.title.slice(0, 26)}${d.isExperiment ? ' 🧪실험대상' : ''}`);
      L.push(`    D+${d.age}${d.lastCrawl ? ` · 최종크롤 ${d.lastCrawl}` : ''}`);
      L.push(`    지표: ${d.m.bodyLen}자 · 절 ${d.m.headings}개(h2 ${d.m.h2}) · 표 ${d.m.tables} · 링크 ${d.m.links} · 수치 ${d.m.numericClaims}(출처없음 ${d.m.unsourced})`);
      for (const s of d.signals.slice(0, 3)) L.push(`    → ${s.s}`);
    }
    if (rejected.length > DIAGNOSE_CAP) L.push(`    … 외 ${rejected.length - DIAGNOSE_CAP}편`);

    if (notCrawled.length) {
      L.push('');
      L.push(`  ▸ 크롤조차 안 된 글 ${notCrawled.length}편 — ⚠️ 본문을 고쳐도 색인되지 않습니다`);
      L.push('    구글이 읽지 않은 글이라 품질이 원인일 수 없습니다. 갱신 대상이 아닙니다.');
      L.push('    필요한 건 발견·크롤입니다: 내부 링크 추가 · 사이트맵 확인 · 색인 요청.');
      const byCls = new Map();
      for (const d of notCrawled) {
        if (!byCls.has(d.cls)) byCls.set(d.cls, []);
        byCls.get(d.cls).push(d);
      }
      for (const [cls, list] of byCls) {
        L.push(`    · ${CLASS_LABEL[cls]} ${list.length}편: ${list.slice(0, 4).map((d) => d.slug.slice(0, 14)).join(', ')}${list.length > 4 ? ` 외 ${list.length - 4}` : ''}`);
      }
    }
  }

  L.push('');
  L.push(`【Ⓑ 노출은 나는데 클릭 0 진단】 ${clickDiag.length}편`);
  L.push(`  (최근 28일 · 노출 ${MIN_IMPRESSIONS} 이상 · CTR ${DEAD_CTR * 100}% 미만 · D+${JUDGE_AFTER_DAYS} 이상)`);
  if (!clickDiag.length) L.push('  해당 없음.');
  for (const d of clickDiag) {
    L.push(`  • [${d.slug}] ${d.title.slice(0, 26)}`);
    L.push(`    노출 ${d.row.impressions} · 클릭 ${d.row.clicks} · 순위 ${d.row.position ? d.row.position.toFixed(1) : '—'}`);
    L.push(`    제목 ${d.m.titleLen}자 · description ${d.m.descLen || '없음'}${d.m.descLen ? '자' : ''}` +
      (d.im.coverage !== null ? ` · 검색의도 매칭 ${Math.round(d.im.coverage * 100)}%` : ''));
    for (const s of d.signals.slice(0, 3)) L.push(`    → ${s.s}`);
    // 🔴 설명 후보가 없으면 없다고 말한다. 억지로 사유를 지어내면 사람이 엉뚱한 걸 고친다.
    //    (실측: 호남 반도체 클러스터 — 제목이 검색의도와 92% 맞고 순위도 8.9인데 클릭 0.
    //     값싼 설명이 전부 해당 없음 = '글 자체가 검색 의도에 답하지 않는다'는 뜻일 수 있고,
    //     그 판단은 지표로 못 한다.)
    if (!d.signals.length) {
      L.push('    → 값싼 설명(제목 불일치·순위·스니펫)이 모두 해당 없음.');
      L.push('      지표로는 설명되지 않습니다 — 글이 그 검색 의도에 답하는지 직접 봐 주세요.');
    }
  }

  // ── 승인 = 반영 일치(계약 §2) ──
  // 버튼을 내는 경우, 무엇을 누르면 무슨 일이 일어나는지 정확히 미리 보여준다.
  const buttons = [];
  const actionable = [];
  L.push('');
  // 🔴 갱신 대상은 '크롤 후 거절'뿐이다. 크롤 안 된 글은 버튼 후보에도 넣지 않는다.
  if (gate.allowBulk && rejected.length) {
    const targets = rejected.filter((d) => !d.isExperiment).slice(0, 3);
    L.push(`【승인 시 반영될 내용】 갱신 초안 생성 대상 ${targets.length}편`);
    for (const d of targets) {
      L.push(`  · [${d.slug}] ${d.title.slice(0, 28)}`);
      L.push(`    무엇을: 출처 없는 수치 ${d.m.unsourced}개 정리 + 구조 보강(절 ${d.m.headings}개→h2 6, 표 ${d.m.tables}→2, FAQ 신설)`);
      L.push(`    주소: ${d.url ? '불변' : '⚠️ 사이트맵 미해석'}`);
      actionable.push(d);
    }
    const excluded = rejected.length - targets.length;
    if (excluded > 0) L.push(`  🚫 자동 제외 ${excluded}편 — 실험 대상(슬러그 ${gate.exp?.slug}) 또는 이번 회차 상한(3편) 초과`);
    if (notCrawled.length) L.push(`  🚫 크롤 안 된 ${notCrawled.length}편은 애초에 대상이 아닙니다(본문 문제가 아님).`);
    L.push('');
    L.push('[🔧 갱신 초안 생성]을 누르면 위 글의 갱신 초안이 만들어집니다(주소 불변·원본 백업).');
    L.push('그것도 아직 반영이 아닙니다 — 초안 확인 후 [✅ 갱신 반영]을 눌러야 커밋·배포됩니다.');
  } else if (rejected.length) {
    L.push('【조치】 없음 — 진단만 했습니다.');
    L.push(`  ${gate.state === 'running' ? '실험 판정 후 이 구역에 갱신 버튼이 자동으로 열립니다.' : '근거가 생기면 자동으로 열립니다.'}`);
  }

  // 🔴 정직한 한계(계약 §6)
  L.push('');
  L.push('【이 리포트가 못 하는 것】');
  L.push('  · 구글은 색인 거절 사유를 알려주지 않습니다. 위 "→" 는 원인이 아니라 설명 후보입니다.');
  L.push('  · "출처 없는 수치"는 같은 문장 안에 출처 표지가 없는 경우를 셉니다.');
  L.push('    문단 위에 출처를 한 번 밝힌 글은 과다 계상됩니다 — 숫자를 보고 직접 확인해 주세요.');
  L.push('  · 글이 검색 의도에 맞는지, 문장이 읽을 만한지는 판단하지 않습니다(사람의 몫).');
  if (quick) L.push('  · --quick 실행이라 색인 상태는 이번에 검사되지 않았습니다.');

  if (prev) {
    const rep = rejected.filter((d) => (prev.cTypeSlugs || []).includes(d.slug)).length;
    if (rep) L.push(`  · 참고: ${rep}편은 지난 회차에도 같은 진단을 받았습니다(변화 없음).`);
  }

  const message = L.join('\n');

  // 버튼은 실제로 반영 가능한 대상이 있을 때만 — 누를 게 없는 버튼은 만들지 않는다.
  if (!dry && actionable.length) {
    for (const d of actionable) {
      const gid = registerUpdate({ slug: d.slug, title: d.title, url: d.url });
      buttons.push([{ text: `🔧 ${d.title.slice(0, 12)} 갱신`, callback_data: 'upgen:' + gid }]);
    }
    buttons.push([{ text: '❌ 넘기기', callback_data: 'cancel:x' }]);
  }

  if (!dry) {
    saveHistory(history, {
      date: today,
      publishedCount: published.length,
      cTypeCount: rejected.length,
      cTypeSlugs: rejected.map((d) => d.slug),
      notCrawledCount: notCrawled.length,
      notCrawledSlugs: notCrawled.map((d) => d.slug),
      noClickCount: clickDiag.length,
      noClickSlugs: clickDiag.map((d) => d.slug),
      experimentState: gate.state,
      allowBulk: gate.allowBulk,
      quick,
    });
    await sendMessage(process.env.TELEGRAM_CHAT_ID, message, buttons.length ? inlineButtons(buttons) : undefined);
  }
  return { ok: true, message, cType: cTypeDiag, rejected, notCrawled, noClicks: clickDiag, gate, actionable };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runQualityReview({ dry: DRY, quick: QUICK })
    .then((r) => { console.log(r.message); if (DRY) console.log('\n(--dry-run: 전송·이력 저장 안 함)'); })
    .catch(async (e) => {
      console.error('[quality-review] 실패:', e.kind || 'error', e.message);
      const hint =
        e.kind === 'nokey' ? '\nautomation/secrets/gsc-key.json 이 있는지 확인하세요.'
        : e.kind === 'forbidden' ? '\nGSC 속성에 서비스 계정이 사용자로 추가돼 있는지 확인하세요.'
        : '';
      if (!DRY) { try { await sendMessage(process.env.TELEGRAM_CHAT_ID, `❌ 품질 검토 실패: ${e.message}${hint}`); } catch {} }
      process.exit(1);
    });
}
