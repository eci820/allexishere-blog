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
import { runClaude, unwrapClaudeJSON } from '../lib/claudeCli.mjs';

const MIN_SOURCE_CHARS = 600; // 이 미만이면 'JS 렌더링/빈 본문' 의심 → 내용 미확보

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

// 후보에서 fetch 검증용 키워드를 뽑는다(엉뚱한 페이지 방지).
function keywordsFor(candidate) {
  const kws = [];
  if (candidate.cls === 'toll') kws.push('toll');
  if (candidate.facility?.name) kws.push(candidate.facility.name.replace(/^the /i, ''));
  for (const w of String(candidate.subject || '').split('-')) if (w.length >= 4) kws.push(w);
  return [...new Set(kws)];
}

// ── AU PLACES(단일 소스) 로드 — gmap id 검증용 ────────────────────────────
async function loadPlaces() {
  const mod = await import(pathToFileURL(path.join(AU_ROOT, 'src', 'lib', 'mapLink.mjs')).href);
  return mod.PLACES || {};
}

// ── 프롬프트 ──────────────────────────────────────────────────────────────
function buildPrompt(candidate, sources, validGmapIds) {
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
    `- State a fact (price, rule, time, distance) ONLY if it appears in the SOURCE material below. Cite it inline with the source URL.`,
    `- For any fact NOT in the sources, write exactly: "unverified — check the official source" (do not guess).`,
    `- For any number, add the source URL and a "last updated: dd/mm/yyyy" if the source shows one.`,
    `- Australian English (colour, centre, kerb, organise). Currency AUD $ (e.g. A$49). Dates dd/mm/yyyy.`,
    ``,
    `🔴 ZERO-CLICK DEFENCE: lead with judgment/comparison the official sites don't give. Use tables and ranked options. Include a short FAQ (2–3 Q&A) and a "Sources & last updated" list at the end.`,
    ``,
    `🗺 MAP LINKS: to link a place, write a normal markdown link with target gmap:<id> — e.g. [📍 View on Google Maps](gmap:${validGmapIds[0] || 'the-gabba'}). ONLY use these verified ids: ${validGmapIds.length ? validGmapIds.join(', ') : '(none — do not add map links)'}. Never invent a gmap id.`,
    ``,
    `OUTPUT FORMAT — output these two parts and nothing else:`,
    `DESCRIPTION: <one sentence meta description, Australian English>`,
    `---BODY---`,
    `<the article body in markdown: an intro paragraph, ## H2 sections (one per pain point promised in the title), tables where useful, a ## FAQ, and a ## Sources & last updated list>`,
    ``,
    `SOURCE MATERIAL (the only facts you may state):`,
    sourceBlock,
  ].join('\n');
}

// ── 파싱 / 검증 / 쓰기 ────────────────────────────────────────────────────
function parseOutput(result) {
  const descM = result.match(/DESCRIPTION:\s*([\s\S]*?)\n-{3}BODY-{3}/i);
  const bodyM = result.split(/-{3}BODY-{3}/i)[1];
  return {
    description: (descM ? descM[1] : '').trim().replace(/\s+/g, ' '),
    body: (bodyM || result).trim(),
  };
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
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const tags = candidate.cls === 'toll'
    ? ['tolls', 'driving', 'australia']
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
  const validGmapIds = (candidate.gmapIds || []).filter((id) => places[id]);
  const droppedGmap = (candidate.gmapIds || []).filter((id) => !places[id]);

  const kws = keywordsFor(candidate);
  const fetched = await Promise.all((candidate.official || []).map((u) => fetchSource(u)));
  const sources = fetched.map((f) => assessSufficiency(f, kws));
  const sufficient = sources.filter((s) => s.sufficient);

  const prompt = buildPrompt(candidate, sources, validGmapIds);
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

  // 실제 생성 — CLI 1회(구독). 실패는 fail-loud(throw, 호출부가 카드로 통지).
  const stdout = await runClaude(prompt, { cwd: AU_ROOT, timeoutMs: 240000 });
  const { result, costUsd } = unwrapClaudeJSON(stdout);
  const { description, body } = parseOutput(result);

  const gmap = checkGmap(body, places);
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
      gmapUnknown: gmap.unknown, // 비어야 좋음(있으면 링크 안 붙음)
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
  if (r.sufficientCount === 0) console.log('\n⚠️ 충분한 공식 출처 0개 — 실제 생성 시 사실은 전부 "unverified"로 남고 카드에 경고됩니다(지어내기 방지).');
}
