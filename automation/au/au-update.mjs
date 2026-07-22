// 📂 AU 갱신 후보 — 한국 lib/updateTrack.mjs 의 '상시 계산' 철학 이식(영어·AU).
//
// 🔴 순수 산수(LLM 0). 신호: 제목의 낡은 연도 / 본문 과거연도 다수 / 얇은 글.
// 🔴 GSC 하락 기반 판정은 '데이터 성숙 후'(계약 §7). AU 는 지금 GSC 데이터가 0 이므로
//    아래 신호(연도·분량)만 쓴다. 데이터가 쌓이면 여기에 성과 하락 신호를 더한다.
// 🔴 탭 시 즉시 생성하지 않는다 — 진단(diagnose) 먼저(au-bot). 한국과 동일.
// 90일 쿨다운(state/au/update-cooldown.json). 읽기 전용 — 여기서 파일을 고치지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AU_BLOG } from './au-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CD = path.join(HERE, '..', 'state', 'au', 'update-cooldown.json');
const DAY = 24 * 3600 * 1000;
const COOLDOWN = 90 * DAY;
const THIN_CHARS = 1500; // 영어 기준 '얇은 글' 임계(한국 800자 대비 상향 — 영어가 더 길다)

const curYear = () => new Date().getUTCFullYear();

export function loadCooldown() {
  try {
    return JSON.parse(fs.readFileSync(CD, 'utf8'));
  } catch {
    return { _note: '갱신 쿨다운(90일). slug→마지막 갱신 ISO.', slugs: {} };
  }
}
export function recordUpdated(slug) {
  const cd = loadCooldown();
  cd.slugs[slug] = new Date().toISOString();
  fs.mkdirSync(path.dirname(CD), { recursive: true });
  fs.writeFileSync(CD, JSON.stringify(cd, null, 2));
}
function inCooldown(slug, cd) {
  const t = cd.slugs[slug];
  return t && Date.now() - Date.parse(t) < COOLDOWN;
}

// 발행글(초안 아님) 1편 읽기. AU 는 flat .md (folder/index.md 아님).
function readPost(file) {
  const raw = fs.readFileSync(path.join(AU_BLOG, file), 'utf8');
  if (/^\s*draft:\s*true\s*$/m.test(raw)) return null; // 초안 제외
  const title = (raw.match(/^title:\s*["']?(.*?)["']?\s*$/m) || [])[1] || '';
  const body = raw.split(/^---\s*$/m).slice(2).join('---').split(/^###?\s*Sources/m)[0].trim();
  return { slug: file.replace(/\.md$/, ''), title, body, len: body.length };
}

// 한 글의 갱신 신호 → {score, reasons[]}
function evaluate(post, year) {
  const reasons = [];
  let score = 0;

  const titleYears = [...post.title.matchAll(/20(1\d|2\d)/g)].map((m) => +m[0]).filter((y) => y < year);
  if (titleYears.length) {
    score += 3;
    reasons.push(`stale year in title (${[...new Set(titleYears)].join(', ')})`);
  }
  const bodyPast = [...post.body.matchAll(/20(1\d|2\d)/g)].map((m) => +m[0]).filter((y) => y < year);
  if (!titleYears.length && bodyPast.length >= 5) {
    score += 1;
    reasons.push(`many past-year mentions in body (${bodyPast.length}) — verify figures`);
  }
  if (post.len < THIN_CHARS) {
    score += 2;
    reasons.push(`thin post (${post.len} chars < ${THIN_CHARS})`);
  }
  // 🔮 데이터 성숙 후 추가: GSC 노출/클릭 하락, 색인 이탈 등 성과 신호(§7 — 지금은 없음).
  return { score, reasons };
}

// 갱신 후보 상위 limit개(쿨다운 제외). 반환: [{slug,title,url,score,reasons}]
export function updateCandidates(limit = 2) {
  let files = [];
  try {
    files = fs.readdirSync(AU_BLOG).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const cd = loadCooldown();
  const year = curYear();
  const out = [];
  for (const f of files) {
    const slug = f.replace(/\.md$/, '');
    if (inCooldown(slug, cd)) continue;
    let post;
    try {
      post = readPost(f);
    } catch {
      continue;
    }
    if (!post) continue;
    const ev = evaluate(post, year);
    if (ev.score <= 0) continue;
    out.push({ slug, title: post.title, url: `/entry/${slug}`, score: ev.score, reasons: ev.reasons });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// 진단(탭 시): 무엇이 낡았는지 상세 + 마지막 갱신일.
export function diagnose(slug) {
  let post;
  try {
    post = readPost(`${slug}.md`);
  } catch {
    return { ok: false, error: `post not found: ${slug}` };
  }
  if (!post) return { ok: false, error: `not a published post: ${slug}` };
  const ev = evaluate(post, curYear());
  const cd = loadCooldown();
  return { ok: true, slug, title: post.title, len: post.len, score: ev.score, reasons: ev.reasons, lastUpdated: cd.slugs[slug] || null };
}

// dry-run: node au-update.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const c = updateCandidates(5);
  console.log('=== AU update candidates (dry-run) ===');
  if (!c.length) console.log('📋 no update candidates yet (site is new / no stale content) — 정직 표시');
  else c.forEach((x) => console.log(`  [score ${x.score}] ${x.title}\n     ${x.reasons.join(' · ')}`));
}
