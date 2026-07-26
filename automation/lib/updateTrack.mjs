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

// 발행글 1편 읽기 → {slug,title,tags,orig,body,len,noindex}
//
// 🔴 noindex 는 '읽기만' 하고 여기서 return null 하지 않는다.
//    이 함수는 diagnose() 도 쓰는데, 거기서 null 을 주면 글이 멀쩡히 있는데도
//    "발행글 없음"이라는 거짓 메시지가 뜬다. 제외는 후보 선정(updateCandidates)에서만 한다.
function readPost(slug) {
  const f = path.join(BLOG, slug, 'index.md');
  if (!fs.existsSync(f)) return null;
  const raw = fs.readFileSync(f, 'utf8');
  if (/^draft:\s*true/m.test(raw)) return null;
  const title = (raw.match(/^title:\s*"?(.*?)"?\s*$/m) || [])[1] || '';
  const tags = (raw.match(/^tags:\s*\[(.*?)\]/m) || [])[1] || '';
  const orig = (raw.match(/^originalPath:\s*"?(.*?)"?\s*$/m) || [])[1] || '';
  const noindex = /^noindex:\s*true/m.test(raw);
  const pub = (raw.match(/^pubDate:\s*(.*)$/m) || [])[1] || '';
  const ageDays = pub ? Math.floor((Date.now() - Date.parse(pub)) / DAY) : 0;
  const body = raw.split(/^---\s*$/m).slice(2).join('---').split('<!--')[0].trim();
  return { slug, title, tags, orig, body, len: body.length, noindex, ageDays };
}

// 연도 표기 추출 — 🔴 하드코딩 범위를 쓰지 않는다.
//    옛 정규식 /20(1\d|2[0-5])/ 은 2020~2025 까지만 잡아 2026 을 구조적으로 놓쳤다.
//    제목에 2026 이 든 글이 76편(53%)이라, 2027년이 오면 갱신 트랙이 통째로
//    먹통이 되는 시한폭탄이었다. 이제 20XX 를 전부 뽑고 '현재연도보다 과거'만 낡은
//    것으로 본다 — 매년 자동으로 기준이 따라간다.
//    (?<!\d)…(?!\d) 는 '20250원' 같은 긴 숫자 안에서 연도를 잘못 뽑는 걸 막는다.
const pastYears = (s, curYear) =>
  [...String(s || '').matchAll(/(?<!\d)20\d{2}(?!\d)/g)].map((m) => +m[0]).filter((y) => y < curYear);

// 한 글의 갱신 신호 계산 → {score, reasons[], top}
// everUpdated: 갱신 이력이 한 번이라도 있는가(update-cooldown.json 등재 여부).
//   90일 쿨다운(inCooldown)과는 다른 개념이다 — 쿨다운은 '최근에 했나', 이건 '한 번이라도 했나'.
function evaluate(post, seasonEvents, curYear, everUpdated = false) {
  const reasons = [];
  let score = 0;

  // 1) 낡은 연도 — 제목(강)
  const titleYears = pastYears(post.title, curYear);
  if (titleYears.length) { score += 3; reasons.push({ w: 3, s: `제목의 낡은 연도(${[...new Set(titleYears)].join('·')})` }); }

  // 2) 낡은 연도 — 본문 다수
  const bodyPast = pastYears(post.body, curYear);
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

  // 5) [H] 요금 정보 노후 — 요금·비용은 시간이 지나면 반드시 낡는다(콘텐츠 도그마의 핵심 축).
  //    180일을 넘긴 요금성 글은 수치가 현행인지 확인할 가치가 있다.
  if (/요금|비용|가격|세율|수수료/.test(post.title) && post.ageDays >= 180) {
    score += 2; reasons.push({ w: 2, s: `요금 정보 노후(발행 ${post.ageDays}일 경과) — 현행 수치 확인 권장` });
  }

  // 6) [I] 장기 미갱신 — 볼륨 확보용. 🔴 점수를 일부러 +1 로 낮춘다.
  //    해당 글이 33편이라 +2 를 주면 동률 덩어리가 상위를 밀어내 정렬이 폴더 순서로
  //    무너진다(설계 시뮬에서 score2 가 37편이었다). [H](+2)보다 아래에 둬서
  //    '진짜 갱신 가치 높은 것'이 위로 오게 한다.
  if (post.ageDays >= 365 && !everUpdated) {
    score += 1; reasons.push({ w: 1, s: `365일+ 미갱신(발행 ${post.ageDays}일, 갱신 이력 없음)` });
  }

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
    // 🔴 색인에서 뺀 글은 갱신할 이유가 없다 — 갱신해도 검색에 안 나온다.
    //    실측(2026-07-25): 갱신 후보 9편 중 5편(56%)이 noindex 글이라 정상 글의
    //    갱신 기회를 절반 넘게 잠식하고 있었다(SKT 유출 글이 후보 1위였다).
    if (post.noindex) continue;
    const ev = evaluate(post, seasonEvents, curYear, !!cd.slugs[d]);
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
  const cd = loadCooldown();
  const ev = evaluate(post, seasonEvents, kstYear(), !!cd.slugs[slug]);
  // noindex 글은 후보에서 빠지지만, 지난 카드의 버튼으로 여기 도달할 수 있다.
  // 그때 "발행글 없음"으로 속이지 않고 상태를 그대로 알린다(ops §6 정직한 한계).
  // 🔴 경고를 reasons 맨 앞에 넣는 이유: bot.mjs 가 dg.reasons 만 화면에 뿌린다.
  //    별도 필드로만 두면 사람 눈에 안 보여 없느니만 못하다.
  const reasons = post.noindex
    ? ['⚠️ 이 글은 noindex 상태입니다 — 검색 색인에서 빠져 있어 갱신해도 유입이 늘지 않습니다. 되살리려면 frontmatter 의 noindex 를 먼저 false 로 바꾸세요.', ...ev.reasons]
    : ev.reasons;
  return {
    ok: true, slug, title: post.title, url: post.orig || '/entry/' + slug, len: post.len,
    reasons, noindex: post.noindex, lastUpdated: cd.slugs[slug] || null, score: ev.score,
  };
}
