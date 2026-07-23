// AU 초안 생성 — 공식 출처 fetch → 내용 충분성 판정 → CLI 1회 → 검증된 AU 경로에 draft:true.
//
// 🔴 팩트 그라운딩: 요금·규정 등 사실은 '가져온 공식 원문에 있는 것만' 쓴다. 없으면
//    "unverified — check the official source". 숫자엔 출처 URL + last updated.
// 🔴 보완 1(fetch 성공 ≠ 내용 확보): HTTP 200 이어도 추출 텍스트가 얇거나(JS 렌더링)
//    핵심 키워드가 없으면 '실패'로 처리해 그 출처의 사실을 unverified 로 남긴다.
//    (근거: 네이버 요금표가 200이지만 JS 렌더링이라 없는 표를 지어낸 사고.)
// 🔴 쓰기는 guardAuRealpath 를 통과한 AU 경로에만. 구독 CLI 전용(ANTHROPIC_API_KEY 미사용).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AU_ROOT, AU_BLOG, guardAuRealpath } from './au-guard.mjs';
import { titleGuideFor, titleBodyMismatch, countPainPoints } from './au-title-rules.mjs';
import { publishedPosts } from './au-pool.mjs';
import { runClaude, unwrapClaudeJSON } from '../lib/claudeCli.mjs';

const MIN_SOURCE_CHARS = 600; // 이 미만이면 'JS 렌더링/빈 본문' 의심 → 내용 미확보

// 🔴 A-5: 유료도로 글에 도시/주 태그를 더한다(관련글 클러스터 고아화 방지 — toll 태그만으론
//    시드니·멜번·브리즈번 글이 한 덩어리로 안 묶인다). subject 에서 지역 토큰을 뽑는다.
function geoTagForToll(subject) {
  const s = String(subject || '').toLowerCase();
  for (const g of ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'nsw', 'vic', 'qld', 'wa', 'sa']) {
    if (s.includes(g)) return g;
  }
  return null;
}

// 오늘 날짜 — iso(frontmatter)·dd/mm/yyyy(accessed) 두 형태.
function todayParts() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return { iso: `${yyyy}-${mm}-${dd}`, au: `${dd}/${mm}/${yyyy}` };
}

// ── fetch + 추출 ──────────────────────────────────────────────────────────
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchSource(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (allexishere-au research bot)' },
    });
    if (!res.ok) return { url, ok: false, chars: 0, reason: `HTTP ${res.status}`, text: '' };
    const html = await res.text();
    const text = stripHtml(html);
    return { url, ok: true, chars: text.length, text };
  } catch (e) {
    return { url, ok: false, chars: 0, reason: `fetch 실패: ${e.name === 'AbortError' ? 'timeout' : e.message}`, text: '' };
  } finally {
    clearTimeout(t);
  }
}

// 🔴 보완 1: 내용 충분성 판정. keywords 중 하나라도 있어야 하고, 길이도 충분해야 한다.
export function assessSufficiency(fetched, keywords = []) {
  if (!fetched.ok) return { ...fetched, sufficient: false, reason: fetched.reason };
  const clean = String(fetched.text || '');
  if (clean.length < MIN_SOURCE_CHARS) {
    return { ...fetched, sufficient: false, reason: `추출 텍스트 ${clean.length}자 < ${MIN_SOURCE_CHARS} (JS 렌더링/빈 본문 의심)` };
  }
  const kws = keywords.map((k) => String(k).toLowerCase()).filter(Boolean);
  const low = clean.toLowerCase();
  if (kws.length && !kws.some((k) => low.includes(k))) {
    return { ...fetched, sufficient: false, reason: `핵심 키워드(${kws.join('/')}) 없음 — 엉뚱한 페이지 의심` };
  }
  return { ...fetched, sufficient: true, reason: 'ok' };
}

// 🔴 A-1: fetch 한 페이지가 '그 주제를 실제로 다루는가' 판정 키워드.
//    핵심 변경 — 시설'이름'이 아니라 '주제어'로 본다. 예전엔 홈페이지에 "the Gabba" 만
//    있어도 통과됐다(이름만 있고 알맹이 없는 페이지). 주제어(seat/roof/parking/toll…)를
//    요구하면 좌석 서브페이지·주차 서브페이지처럼 알맹이 있는 페이지만 '충분'으로 본다.
//    modifierGroup 단위로 매핑(단일 소스 — au-pool 의 group 과 짝).
// 🔴 값은 au-pool.sourcesForGroup 이 실제로 fetch 하는 페이지 기준으로 맞춘다(2026-07-23 실측).
//    seating/firsttimer 는 전용 정적 좌석페이지가 드물어 gettingHere·members 를 깊이로 쓰므로,
//    그 페이지에 있는 어휘(transport/parking/member)까지 허용한다. 목적은 '엉뚱/빈/JS 페이지
//    걸러내기'지 '문자 그대로 seat 강제'가 아니다(빈 홈페이지는 애초에 소스에 없다).
const GROUP_KEYWORDS = {
  seating: ['seat', 'bay', 'stand', 'member', 'transport', 'parking'],
  roof: ['roof'],
  access: ['parking', 'transport', 'getting here', 'train', 'tram', 'bus'],
  membership: ['member'],
  firsttimer: ['bag', 'gate', 'entry', 'getting here', 'transport', 'member'],
};

function keywordsFor(candidate) {
  if (candidate.cls === 'toll') return ['toll'];
  const g = GROUP_KEYWORDS[candidate.group];
  if (g && g.length) return [...g];
  // 그룹 매핑이 없는 예외 케이스만 시설명으로 최소 방어(엉뚱한 도메인 fetch 방지).
  return candidate.facility?.name ? [candidate.facility.name.replace(/^the /i, '')] : [];
}

// ── AU PLACES(단일 소스) 로드 — gmap id 검증용 ────────────────────────────
async function loadPlaces() {
  const mod = await import(pathToFileURL(path.join(AU_ROOT, 'src', 'lib', 'mapLink.mjs')).href);
  return mod.PLACES || {};
}

// ── 프롬프트 ──────────────────────────────────────────────────────────────
export function buildPrompt(candidate, sources, allPlaceIds, requiredGmapId, siblings = [], todayAu = '') {
  const sufficient = sources.filter((s) => s.sufficient);
  const sourceBlock = sufficient.length
    ? sufficient.map((s) => `SOURCE (${s.url}):\n${s.text.slice(0, 6000)}`).join('\n\n')
    : '(No sufficient official source text was retrieved. Do NOT invent facts.)';

  return [
    `You are writing an evergreen guide for an Australian (en-AU) blog. Write ONLY the article, no preamble.`,
    ``,
    titleGuideFor(candidate.cls),
    ``,
    `WORKING TITLE: ${candidate.title}`,
    ``,
    `🔴 FACT RULES (non-negotiable):`,
    `- State a facility-specific fact (price, rule, time, distance, exact stand/section name, capacity) ONLY if it appears in the SOURCE material below. Cite it inline with the source URL.`,
    `- For any such facility-specific fact NOT in the sources, write exactly: "unverified — check the official source" (do not guess).`,
    `- 🔴 BUT do NOT dodge physics/common-sense that needs no official source. E.g. in the Southern Hemisphere the afternoon sun sits in the west/north-west, so west-facing seats cop the late-day sun — state that plainly and turn it into practical advice ("if you burn easily, book the eastern side"). Committing to the general answer is the whole point; only the venue-specific specifics stay "unverified".`,
    `- For any number, add the source URL and a "last updated: dd/mm/yyyy" if the source shows one.`,
    `- In the final "Sources & last updated" list, give each source as: URL — last updated: <date or "unverified"> — accessed ${todayAu || 'dd/mm/yyyy'}.`,
    `- Australian English (colour, centre, kerb, organise). Currency AUD $ (e.g. A$49). Dates dd/mm/yyyy.`,
    ``,
    `🔴 ZERO-CLICK DEFENCE: lead with judgment/comparison the official sites don't give. Use tables and ranked options. Include a short FAQ (2–3 Q&A) and a "Sources & last updated" list at the end.`,
    ``,
    ...(candidate.judgment
      ? [
          `🔴 JUDGMENT/EXPLAINER TOPIC: the official sites do NOT publish this — that is exactly the value. Write the general, physics/common-sense answer with confidence (do NOT dodge it or blanket it as "unverified"). E.g. which Australian venues have retractable roofs is well-known general knowledge; state it. Mark as "unverified — check the official source" ONLY the venue-specific operating facts (exact roof-closing policy/criteria, timings, which events close it).`,
          ``,
        ]
      : []),
    `🗺 MAP LINKS — link the real places you mention (stadiums, stations, landmarks, shopping strips, car parks).`,
    `- To link a place, write a markdown link to gmap:<id> — e.g. [📍 View on Google Maps](gmap:mcg).`,
    ...(requiredGmapId
      ? [`- 🔴 REQUIRED: link the article's main subject at least once — write [📍 View on Google Maps](gmap:${requiredGmapId}) where you first introduce it.`]
      : []),
    `- 🔴 ONLY use ids from this registry: ${allPlaceIds.join(', ')}.`,
    `- 🔴 If you mention a real place that is NOT in the registry, DO NOT link it and DO NOT invent an id.`,
    `  Instead list its exact name at the very end under "LINK CANDIDATES:" (one per line) for a human to verify.`,
    `- Link generously — a reader should be able to open every venue/station/landmark on a map — but registry ids only.`,
    ``,
    ...(siblings.length
      ? [
          `🔗 INTERNAL LINKS — existing articles on THIS site. Where genuinely relevant (same city or same topic), work 1–2 of them into the body as a natural markdown link [anchor text](/entry/<slug>). Never force an irrelevant link.`,
          ...siblings.map((s) => `  - /entry/${s.slug}  — ${s.title}`),
          ``,
        ]
      : []),
    `OUTPUT FORMAT — output exactly these parts and nothing else:`,
    `DESCRIPTION: <one sentence meta description, Australian English>`,
    `---BODY---`,
    `<article body in markdown: intro paragraph, ## H2 sections (one per pain point in the title), tables where useful, a ## FAQ, and a ## Sources & last updated list. Add gmap:<id> links to registry places you mention.>`,
    `LINK CANDIDATES:`,
    `<real places you mentioned that are NOT in the registry — one exact name per line, or "none">`,
    ``,
    `SOURCE MATERIAL (the only facts you may state):`,
    sourceBlock,
  ].join('\n');
}

// ── 파싱 / 검증 / 쓰기 ────────────────────────────────────────────────────
function parseOutput(result) {
  const descM = result.match(/DESCRIPTION:\s*([\s\S]*?)\n-{3}BODY-{3}/i);
  let body = (result.split(/-{3}BODY-{3}/i)[1] || result).trim();
  // 🔴 LINK CANDIDATES: 블록을 본문에서 떼어낸다 — 발행 본문엔 안 들어가고 사람 검증용 메모로만 쓴다.
  let linkCandidates = [];
  const lcM = body.match(/\n?LINK CANDIDATES:\s*([\s\S]*)$/i);
  if (lcM) {
    body = body.slice(0, lcM.index).trim();
    linkCandidates = lcM[1]
      .split('\n')
      .map((s) => s.replace(/^[-*•\s]+/, '').trim())
      .filter((s) => s && !/^none\.?$/i.test(s));
  }
  return { description: (descM ? descM[1] : '').trim().replace(/\s+/g, ' '), body, linkCandidates };
}

function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 70) || 'post';
}
function uniqueSlug(base) {
  let slug = base, n = 2;
  while (fs.existsSync(path.join(AU_BLOG, `${slug}.md`))) slug = `${base}-${n++}`;
  return slug;
}

// gmap:<id> 를 본문에서 뽑아 PLACES 와 대조. 반환 {used, unknown}.
function checkGmap(body, places) {
  const ids = [...body.matchAll(/\]\(gmap:([a-z0-9-]+)\)/gi)].map((m) => m[1]);
  const used = [...new Set(ids)];
  const unknown = used.filter((id) => !places[id]);
  return { used, unknown };
}

function h2sOf(body) {
  return [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
}

function frontmatter(candidate, description) {
  const iso = todayParts().iso;
  const tags = candidate.cls === 'toll'
    ? [...new Set(['tolls', 'driving', 'australia', geoTagForToll(candidate.subject)].filter(Boolean))]
    : [candidate.facility?.city?.toLowerCase() || 'australia', 'stadium', 'gameday'];
  return [
    '---',
    `title: ${JSON.stringify(candidate.title)}`,
    `description: ${JSON.stringify(description || candidate.title)}`,
    `pubDate: ${iso}`,
    `category: info`,
    `tags: ${JSON.stringify(tags)}`,
    `draft: true`,
    `subject: ${candidate.subject}`,
    `modifierGroup: ${candidate.group}`,
    '---',
    '',
  ].join('\n');
}

// 메인: 후보 하나로 초안 생성. dryRun 이면 fetch·검증·가드까지만(전송·쓰기·CLI 없음).
export async function generateDraft(candidate, { dryRun = false } = {}) {
  const places = await loadPlaces();
  const allPlaceIds = Object.keys(places); // 🔴 전체 등재 장소를 프롬프트에 노출(경기장·역·랜드마크 등)
  const validGmapIds = (candidate.gmapIds || []).filter((id) => places[id]);
  const droppedGmap = (candidate.gmapIds || []).filter((id) => !places[id]);
  // 🔴 A-3: 이 글의 '주제 장소' — 본문에 반드시 1회 링크돼야 한다. 후보의 첫 유효 gmap id.
  //    (경기장 글 = 그 경기장 · 판단형 roof = marvel-stadium · 유료도로 글 = 단일 장소 없음 → 강제 안 함)
  const requiredGmapId = validGmapIds[0] || null;

  const kws = keywordsFor(candidate);
  const fetched = await Promise.all((candidate.official || []).map((u) => fetchSource(u)));
  const sources = fetched.map((f) => assessSufficiency(f, kws));
  const sufficient = sources.filter((s) => s.sufficient);

  // 🔴 A-5: 발행 형제 글 주입(내부 링크) + accessed 날짜.
  const siblings = publishedPosts().slice(0, 12);
  const today = todayParts();
  const prompt = buildPrompt(candidate, sources, allPlaceIds, requiredGmapId, siblings, today.au);
  const intendedSlug = uniqueSlug(slugify(candidate.title));
  const intendedPath = path.join(AU_BLOG, `${intendedSlug}.md`);
  guardAuRealpath(intendedPath); // 🔴 쓰기 대상이 AU 안·한국 밖인지 (dryRun 이어도 검증)

  const summary = {
    candidate: candidate.id,
    title: candidate.title,
    sources: sources.map((s) => ({ url: s.url, sufficient: s.sufficient, chars: s.chars, reason: s.reason })),
    sufficientCount: sufficient.length,
    validGmapIds,
    droppedGmap,
    intendedPath,
    promptChars: prompt.length,
  };

  if (dryRun) return { ...summary, dryRun: true, wrote: false };

  // 🔴 A-1 게이트: 주제를 실제로 다루는 공식 출처가 하나도 없으면 '생성 보류'.
  //    이름만 있고 알맹이 없는 홈페이지로 글을 만들지 않는다(Gabba(출처 4곳) vs 자동글(1곳)
  //    격차의 근본 원인). CLI 를 호출하지 않고(비용 0) held 로 돌려보내 카드가 사유를 보여준다.
  //    → 조용히 통과하지 않고 사람에게 사유를 알린다(fail-loud, safe-automation §2b).
  // 🔴 A-2/A-4 예외: judgment 토픽(물리·상식·비교 — 공식 팩트 페이지가 없는 유형)은 보류하지
  //    않는다. 출처 없이도 일반 답을 쓰되(A-4), 시설 고유 사실은 프롬프트가 unverified 로 남긴다.
  if (!candidate.judgment && sufficient.length === 0) {
    return {
      ...summary,
      held: true,
      wrote: false,
      heldReason:
        '주제를 다루는 충분한 공식 출처가 없어 생성을 보류했습니다 — 홈페이지에 주제 알맹이가 없거나(서브페이지 필요) fetch 가 JS 렌더링/빈 본문입니다.',
    };
  }

  // 실제 생성 — CLI 1회(구독). 실패는 fail-loud(throw, 호출부가 카드로 통지).
  const stdout = await runClaude(prompt, { cwd: AU_ROOT, timeoutMs: 240000 });
  const { result, costUsd } = unwrapClaudeJSON(stdout);
  const { description, body, linkCandidates } = parseOutput(result);

  const gmap = checkGmap(body, places);
  // 🔴 A-3: 주제 장소 링크가 본문에 실제로 들어갔는지 검증. 빠졌으면 카드에 경고(차단 아님 —
  //    CLI 는 이미 소모됐고 사람이 검토하므로, 조용히 넘기지 않고 눈에 띄게 알린다).
  const gmapSubjectMissing = requiredGmapId && !gmap.used.includes(requiredGmapId) ? requiredGmapId : null;
  const missingAxes = titleBodyMismatch(candidate.title, h2sOf(body), candidate.cls);
  const painPoints = countPainPoints(candidate.title, candidate.cls);

  const file = frontmatter(candidate, description) + body + '\n';
  guardAuRealpath(intendedPath); // 쓰기 직전 재검증
  fs.mkdirSync(path.dirname(intendedPath), { recursive: true });
  fs.writeFileSync(intendedPath, file, 'utf8');

  return {
    ...summary,
    wrote: true,
    slug: intendedSlug,
    costUsd,
    checks: {
      painPoints,
      titleBodyMismatch: missingAxes, // 비어야 좋음
      gmapUsed: gmap.used, // 실제로 붙은 지도 링크(등재 장소)
      gmapUnknown: gmap.unknown, // 비어야 좋음(있으면 링크 안 붙음)
      gmapSubjectMissing, // 🔴 A-3: 주제 장소 링크 누락(있으면 id, 없으면 null)
      linkCandidates, // 🔴 미등재 장소 후보 — 사람이 검증 후 PLACES 에 등재
      unverifiedSources: sources.filter((s) => !s.sufficient).map((s) => s.url),
    },
  };
}

// dry-run CLI: node au-generate.mjs <candidateId>  (전송·쓰기·CLI 없음)
if (import.meta.url === `file://${process.argv[1]}`) {
  const { buildPool } = await import('./au-pool.mjs');
  const wantId = process.argv[2];
  const pool = buildPool();
  const cand = wantId ? pool.candidates.find((c) => c.id === wantId) : pool.candidates[0];
  if (!cand) {
    console.error('후보를 찾지 못함. 사용: node au-generate.mjs <candidateId>');
    process.exit(1);
  }
  console.log(`=== au-generate dry-run (fetch+검증+가드만, CLI·쓰기 없음) ===`);
  console.log(`후보: ${cand.id} — ${cand.title}\n`);
  const r = await generateDraft(cand, { dryRun: true });
  console.log('출처 fetch/충분성 (🔴 보완 1):');
  for (const s of r.sources) console.log(`  ${s.sufficient ? '✅' : '⚠️ '} ${s.url}\n       ${s.chars}자 · ${s.reason}`);
  console.log(`\n충분한 출처: ${r.sufficientCount}/${r.sources.length}`);
  console.log(`gmap 유효 id: [${r.validGmapIds.join(', ') || '없음'}]${r.droppedGmap.length ? ` · 미등재(링크안붙음): [${r.droppedGmap.join(', ')}]` : ''}`);
  console.log(`쓰기 대상(가드 통과): ${r.intendedPath}`);
  console.log(`프롬프트 길이: ${r.promptChars}자`);
  if (r.sufficientCount === 0) {
    if (cand.judgment) console.log('\n⚖️ judgment 토픽 · 공식출처 0 — 보류하지 않고 일반 답(물리·상식)으로 생성합니다(시설 고유 사실은 unverified).');
    else console.log('\n⏸ 충분한 공식 출처 0개 — 실제 실행에서는 생성을 보류(held)합니다(CLI 호출·쓰기 없음).');
  }
}
