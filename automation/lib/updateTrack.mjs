// 📂 갱신 후보 트랙(축2 [4]) — "다시 게시할 필요가 있는 글"을 상시 계산.
//  신호: 낡은 연도(제목·본문) / 계절 도래(D-14~D-3) / 얇은 글(<800자) / 상록 수요.
//  이미 갱신한 글은 90일 쿨다운(data/update-cooldown.json). 브리핑에 사유 1줄과 함께 1~2개 노출.
//  ⚠️ 탭 시 즉시 생성 금지 — '갱신 진단' 먼저(bot.mjs), [갱신 초안 생성]을 눌러야 생성.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.mjs';
import { STOP } from './topics.mjs';
import { calendarRadar } from './calendar.mjs';

const BLOG = path.join(ROOT, 'src', 'content', 'blog');
const CD = path.join(ROOT, 'data', 'update-cooldown.json');
const DAY = 24 * 3600 * 1000;
const COOLDOWN = 90 * DAY;

const kstYear = () => new Date(Date.now() + 9 * 3600 * 1000).getUTCFullYear();
const tokens = (s) =>
  String(s || '').replace(/[^가-힣a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w));

export function loadCooldown() {
  try { return JSON.parse(fs.readFileSync(CD, 'utf8')); } catch { return { _note: '갱신 쿨다운(90일). slug→마지막 갱신 ISO. 갱신 커밋 시 recordUpdated로 기록.', slugs: {} }; }
}
export function saveCooldown(cd) {
  fs.mkdirSync(path.dirname(CD), { recursive: true });
  fs.writeFileSync(CD, JSON.stringify(cd, null, 2));
}
export function recordUpdated(slug) {
  const cd = loadCooldown();
  cd.slugs[slug] = new Date().toISOString();
  saveCooldown(cd);
}
function inCooldown(slug, cd) {
  const t = cd.slugs[slug];
  return t && Date.now() - Date.parse(t) < COOLDOWN;
}

// 발행글 1편 읽기 → {slug,title,tags,orig,body,len}
function readPost(slug) {
  const f = path.join(BLOG, slug, 'index.md');
  if (!fs.existsSync(f)) return null;
  const raw = fs.readFileSync(f, 'utf8');
  if (/^draft:\s*true/m.test(raw)) return null;
  const title = (raw.match(/^title:\s*"?(.*?)"?\s*$/m) || [])[1] || '';
  const tags = (raw.match(/^tags:\s*\[(.*?)\]/m) || [])[1] || '';
  const orig = (raw.match(/^originalPath:\s*"?(.*?)"?\s*$/m) || [])[1] || '';
  const body = raw.split(/^---\s*$/m).slice(2).join('---').split('<!--')[0].trim();
  return { slug, title, tags, orig, body, len: body.length };
}

// 한 글의 갱신 신호 계산 → {score, reasons[], top}
function evaluate(post, seasonEvents, curYear) {
  const reasons = [];
  let score = 0;

  // 1) 낡은 연도 — 제목(강)
  const titleYears = [...post.title.matchAll(/20(1\d|2[0-5])/g)].map((m) => +m[0]).filter((y) => y < curYear);
  if (titleYears.length) { score += 3; reasons.push({ w: 3, s: `제목의 낡은 연도(${[...new Set(titleYears)].join('·')})` }); }

  // 2) 낡은 연도 — 본문 다수
  const bodyPast = [...post.body.matchAll(/20(1\d|2[0-5])/g)].map((m) => +m[0]).filter((y) => y < curYear);
  if (!titleYears.length && bodyPast.length >= 5) { score += 1; reasons.push({ w: 1, s: `본문 과거연도 다수(${bodyPast.length}회) — 수치 확인 권장` }); }

  // 3) 계절 도래(D-14~D-3) — 캘린더 이벤트의 '특정어'(3자 이상: 부가가치세·재산세·제습기 등)와 제목/태그 매칭.
  //    2자 공통어(신고·납부·예방)로 인한 오탐 방지.
  const ptoks = new Set([...tokens(post.title), ...tokens(post.tags)]);
  for (const ev of seasonEvents) {
    const et = tokens(ev.keyword).filter((w) => w.length >= 3);
    if (et.length && et.some((w) => ptoks.has(w))) { score += 3; reasons.push({ w: 3, s: `계절 도래: ${ev.label} (D-${ev.daysUntil})` }); break; }
  }

  // 4) 얇은 글
  if (post.len < 800) { score += 2; reasons.push({ w: 2, s: `얇은 글(${post.len}자)` }); }

  reasons.sort((a, b) => b.w - a.w);
  return { score, reasons: reasons.map((r) => r.s), top: reasons[0]?.s || '' };
}

// 갱신 후보 상위 limit개(쿨다운 제외). 반환: [{slug,title,url,score,reasons,top}]
export function updateCandidates(limit = 2) {
  if (!fs.existsSync(BLOG)) return [];
  const cd = loadCooldown();
  const curYear = kstYear();
  const seasonEvents = calendarRadar(20, 3, 14); // 현재 D-14~D-3 이벤트 전부
  const cands = [];
  for (const d of fs.readdirSync(BLOG)) {
    if (inCooldown(d, cd)) continue;
    const post = readPost(d);
    if (!post) continue;
    const ev = evaluate(post, seasonEvents, curYear);
    if (ev.score <= 0) continue;
    const url = post.orig || '/entry/' + d;
    cands.push({ slug: d, title: post.title, url, score: ev.score, reasons: ev.reasons, top: ev.top });
  }
  cands.sort((a, b) => b.score - a.score);
  return cands.slice(0, limit);
}

// 갱신 진단(탭 시): 무엇이 낡았는지 상세 + 갱신 표준 안내 문구.
export function diagnose(slug) {
  const post = readPost(slug);
  if (!post) return { ok: false, error: '발행글 없음: ' + slug };
  const seasonEvents = calendarRadar(20, 3, 14);
  const ev = evaluate(post, seasonEvents, kstYear());
  const cd = loadCooldown();
  return {
    ok: true, slug, title: post.title, url: post.orig || '/entry/' + slug, len: post.len,
    reasons: ev.reasons, lastUpdated: cd.slugs[slug] || null, score: ev.score,
  };
}
