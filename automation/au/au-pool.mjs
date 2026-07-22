// AU 주제 풀 — 한국 lib/parking.mjs 의 '고정 목록 + 수식어 조합' 철학을 호주에 이식.
//
// 축 A(경기장): 시설 9곳 × '해당되는' 수식어. 시설 속성(roof/members/hardParking)으로
//   해당 없는 수식어를 자동 제외한다(지붕 없는 곳에 roof, 회원제 없는 곳에 membership 등).
// 축 B(유료도로): 확정된 7개 토픽을 우선순위 순 고정 리스트로.
//
// 🔴 자기잠식 방지 = subject(시설/주제) + modifierGroup 단위 판정. 발행된 (subject,group)
//    조합만 제외한다. The Gabba × access(주차/교통)는 발행됐으므로 제외하되,
//    The Gabba × seating(best seats) 같은 '다른 group' 은 허용. 토큰 겹침으로 막지 않는다.
//
// 🔴 이 파일의 속성표는 '제안 게이팅'에만 쓰인다(빠지면 그 토픽이 안 뜰 뿐, 틀린 사실을
//    발행하지 않는다). 실제 요금·규정 등 사실은 생성 시 공식 출처로 검증한다(au-generate).
//    gmapId 는 AU repo 의 src/lib/mapLink.mjs PLACES 에 '검증 후' 등재돼야 링크가 붙는다.
import fs from 'node:fs';
import path from 'node:path';
import { AU_BLOG } from './au-guard.mjs';

// ── 축 A: 시설 속성표 (best-effort — 생성 시 공식 재확인) ──────────────────
// roof: 개폐식 지붕 있음 · members: 눈에 띄는 회원 전용석 있음 · hardParking: 이벤트일 주차난
export const FACILITIES = [
  { id: 'marvel-stadium', name: 'Marvel Stadium', city: 'Melbourne', official: 'https://www.marvelstadium.com.au', roof: true, members: false, hardParking: true },
  { id: 'mcg', name: 'the MCG', city: 'Melbourne', official: 'https://www.mcg.org.au', roof: false, members: true, hardParking: true },
  { id: 'adelaide-oval', name: 'Adelaide Oval', city: 'Adelaide', official: 'https://www.adelaideoval.com.au', roof: false, members: true, hardParking: true },
  { id: 'scg', name: 'the SCG', city: 'Sydney', official: 'https://www.sydneycricketground.com.au', roof: false, members: true, hardParking: true },
  { id: 'the-gabba', name: 'the Gabba', city: 'Brisbane', official: 'https://thegabba.com.au', roof: false, members: true, hardParking: true },
  { id: 'optus-stadium', name: 'Optus Stadium', city: 'Perth', official: 'https://www.optusstadium.com.au', roof: false, members: false, hardParking: true },
  { id: 'suncorp-stadium', name: 'Suncorp Stadium', city: 'Brisbane', official: 'https://www.suncorpstadium.com.au', roof: false, members: false, hardParking: true },
  { id: 'accor-stadium', name: 'Accor Stadium', city: 'Sydney', official: 'https://www.accorstadium.com.au', roof: false, members: false, hardParking: true },
  { id: 'aami-park', name: 'AAMI Park', city: 'Melbourne', official: 'https://www.aamipark.com.au', roof: false, members: false, hardParking: true },
];

// ── 축 A: 수식어 (각자 고유 modifierGroup) ────────────────────────────────
// 🔴 seats + shade 는 한 글(group 'seating')로 묶는다 — 발행 순서 #3(Suncorp)·#5(Optus)가
//    "best seats & 오후 햇빛 피하기"를 한 편으로 잡았기 때문. 지붕 있는 곳은 shade 부분 생략.
// 🔴 제외 수식어(bag policy·parking rules·transport 안내·betting/odds)는 아예 없음.
export const STADIUM_MODIFIERS = [
  { id: 'roof', group: 'roof', priority: 1, cls: 'stadium', applies: (f) => f.roof,
    title: (f) => `${f.name}: how to check if the roof will be open, and what decides it` },
  { id: 'seating', group: 'seating', priority: 1, cls: 'stadium', applies: () => true,
    title: (f) => f.roof
      ? `${f.name}: best seats and where to sit for footy and concerts`
      : `${f.name}: best seats and which side to sit to avoid the afternoon sun` },
  { id: 'membership', group: 'membership', priority: 2, cls: 'stadium', applies: (f) => f.members,
    title: (f) => `${f.name}: members vs general admission, and the best GA seats` },
  { id: 'access', group: 'access', priority: 2, cls: 'stadium', applies: (f) => f.hardParking,
    title: (f) => `${f.name}: getting there when there's no parking` },
  { id: 'firsttimer', group: 'firsttimer', priority: 3, cls: 'stadium', applies: () => true,
    title: (f) => `${f.name}: a first-timer's guide to gameday` },
];

// ── 축 B: 유료도로·차량 비용 (확정 7개, 우선순위 순) ─────────────────────
// officialUrls = 생성 시 fetch 대상(내용 충분성 검증 — au-generate). 각 URL 은 조사에서 실재 확인분 우선.
export const AXIS_B = [
  { id: 'sydney-avoid-tolls', subject: 'sydney-tolls', group: 'avoid', priority: 1, cls: 'toll',
    title: 'Sydney tolls: how to actually avoid them (and when it’s worth it)',
    gmapIds: [], officialUrls: ['https://www.nsw.gov.au/driving-boating-and-transport/tolling/toll-costs-by-road', 'https://www.linkt.com.au/using-toll-roads/toll-calculator/sydney'] },
  { id: 'melbourne-citylink-vs-eastlink', subject: 'melbourne-tolls', group: 'pay-no-account', priority: 2, cls: 'toll',
    title: 'CityLink vs EastLink: paying Melbourne tolls without an account',
    gmapIds: [], officialUrls: ['https://www.eastlink.com.au/tolling-how-to-pay', 'https://www.linkt.com.au/using-toll-roads/toll-calculator/melbourne', 'https://www.transport.vic.gov.au/getting-around/driving/travelling-on-toll-roads'] },
  { id: 'sydney-who-owns-what', subject: 'sydney-tolls', group: 'explainer', priority: 3, cls: 'toll',
    title: 'Sydney toll roads: who owns each one and what a real trip actually costs',
    gmapIds: [], officialUrls: ['https://www.nsw.gov.au/driving-boating-and-transport/tolling/toll-costs-by-road'] },
  { id: 'nsw-toll-relief-cap', subject: 'nsw-toll-relief', group: 'eligibility', priority: 4, cls: 'toll', timeSensitive: true,
    title: 'NSW toll relief: the weekly cap — who’s eligible and how to claim',
    gmapIds: [], officialUrls: ['https://www.service.nsw.gov.au/services/toll-relief', 'https://www.linkt.com.au/help/cashback-and-rebates/toll-relief-rebate/sydney'] },
  { id: 'visitors-rental-tolls', subject: 'aus-tolls-visitors', group: 'visitor', priority: 5, cls: 'toll',
    title: 'Driving a toll road in a rental or as a visitor: what happens and how to pay',
    gmapIds: [], officialUrls: ['https://www.linkt.com.au/using-toll-roads/casual-use', 'https://www.eastlink.com.au/buy-trip-pass'] },
  { id: 'brisbane-tolls', subject: 'brisbane-tolls', group: 'explainer', priority: 6, cls: 'toll',
    title: 'Brisbane tolls explained: Gateway, Logan and AirportlinkM7',
    gmapIds: [], officialUrls: ['https://www.linkt.com.au/using-toll-roads/toll-calculator/brisbane'] },
  { id: 'toll-notices-disputes', subject: 'toll-notices', group: 'disputes', priority: 7, cls: 'toll',
    title: 'Toll notices and disputes: what to do if you get an unpaid toll notice',
    gmapIds: [], officialUrls: ['https://www.linkt.com.au/help/tolls-and-payments'] },
];

// ── 발행 seed 순서 (상위 5, 두 축 교대) ───────────────────────────────────
export const PUBLISH_SEED = [
  { subject: 'marvel-stadium', group: 'roof' },
  { subject: 'sydney-tolls', group: 'avoid' },
  { subject: 'suncorp-stadium', group: 'seating' },
  { subject: 'melbourne-tolls', group: 'pay-no-account' },
  { subject: 'optus-stadium', group: 'seating' },
];

const LOW_STOCK_THRESHOLD = 6; // 미발행 후보가 이하로 떨어지면 브리핑이 '풀 보충 필요' 경고

// key = "subject::group"
const key = (subject, group) => `${subject}::${group}`;

// AU 발행글의 (subject, group) 집합. frontmatter 의 subject/modifierGroup 을 읽는다.
// 🔴 AU_BLOG 만 읽는다(한국 경로 안 봄). 필드가 없는 옛 글은 경고하고 건너뛴다(dedup 불가).
export function publishedSubjects() {
  const set = new Set();
  const warnings = [];
  let files = [];
  try {
    files = fs.readdirSync(AU_BLOG).filter((f) => f.endsWith('.md'));
  } catch {
    return { set, warnings: ['AU_BLOG 를 읽지 못함'] };
  }
  for (const f of files) {
    let txt = '';
    try {
      txt = fs.readFileSync(path.join(AU_BLOG, f), 'utf8');
    } catch {
      continue;
    }
    const fm = txt.split(/^---\s*$/m)[1] || '';
    const draft = /^\s*draft:\s*true\s*$/m.test(fm);
    if (draft) continue; // 초안은 발행으로 치지 않음
    const subj = (fm.match(/^\s*subject:\s*["']?([^"'\n]+)/m) || [])[1]?.trim();
    const grp = (fm.match(/^\s*modifierGroup:\s*["']?([^"'\n]+)/m) || [])[1]?.trim();
    if (subj && grp) set.add(key(subj, grp));
    else warnings.push(`${f}: subject/modifierGroup 없음 — dedup 대상에서 누락`);
  }
  return { set, warnings };
}

// 축 A 후보 전개: 시설 × 해당되는 수식어.
export function stadiumCandidates() {
  const out = [];
  for (const f of FACILITIES) {
    for (const m of STADIUM_MODIFIERS) {
      if (!m.applies(f)) continue;
      out.push({
        id: `${f.id}__${m.id}`,
        axis: 'A',
        cls: m.cls,
        subject: f.id,
        group: m.group,
        priority: m.priority,
        title: m.title(f),
        official: [f.official],
        gmapIds: [f.id],
        facility: f,
        timeSensitive: false,
      });
    }
  }
  return out;
}

// 축 B 후보.
export function tollCandidates() {
  return AXIS_B.map((t) => ({
    id: t.id,
    axis: 'B',
    cls: t.cls,
    subject: t.subject,
    group: t.group,
    priority: t.priority,
    title: t.title,
    official: t.officialUrls,
    gmapIds: t.gmapIds || [],
    timeSensitive: !!t.timeSensitive,
  }));
}

// 전체 후보를 dedup·정렬해 돌려준다.
// 반환: { candidates:[…], excluded:[{subject,group,title,reason}], warnings, lowStock }
export function buildPool() {
  const { set: published, warnings } = publishedSubjects();
  const all = [...stadiumCandidates(), ...tollCandidates()];

  const candidates = [];
  const excluded = [];
  for (const c of all) {
    if (published.has(key(c.subject, c.group))) {
      excluded.push({ subject: c.subject, group: c.group, title: c.title, reason: `이미 발행됨 (${c.subject}·${c.group})` });
    } else {
      candidates.push(c);
    }
  }

  // seed 순서를 맨 앞으로, 그다음 (priority → 축A 먼저 → id) 정렬.
  const seedRank = new Map(PUBLISH_SEED.map((s, i) => [key(s.subject, s.group), i]));
  candidates.sort((a, b) => {
    const ra = seedRank.has(key(a.subject, a.group)) ? seedRank.get(key(a.subject, a.group)) : 1e6;
    const rb = seedRank.has(key(b.subject, b.group)) ? seedRank.get(key(b.subject, b.group)) : 1e6;
    if (ra !== rb) return ra - rb;
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.axis !== b.axis) return a.axis < b.axis ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });

  return {
    candidates,
    excluded,
    warnings,
    lowStock: candidates.length <= LOW_STOCK_THRESHOLD,
    counts: { total: all.length, available: candidates.length, published: published.size, excluded: excluded.length },
  };
}

// 브리핑이 뽑을 상위 n개(기본 2). exclude = 이미 오늘 제안됐거나 카드에 있는 id.
export function pickForBriefing(n = 2, exclude = new Set()) {
  const { candidates } = buildPool();
  return candidates.filter((c) => !exclude.has(c.id)).slice(0, n);
}

// dry-run: node au-pool.mjs — 전송·쓰기 없이 후보/제외/경고만 출력.
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = buildPool();
  console.log('=== AU pool dry-run (전송·쓰기 없음) ===');
  console.log('counts:', p.counts, '| lowStock:', p.lowStock);
  if (p.warnings.length) console.log('\n⚠️ warnings:\n  ' + p.warnings.join('\n  '));
  console.log(`\n제외(이미 발행) ${p.excluded.length}개:`);
  p.excluded.forEach((e) => console.log(`  - ${e.title}  [${e.reason}]`));
  console.log(`\n제안 가능 ${p.candidates.length}개 (상위 12):`);
  p.candidates.slice(0, 12).forEach((c, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. [${c.axis}] ${c.title}  (${c.subject}·${c.group}${c.timeSensitive ? ' ⏳시한성' : ''})`)
  );
}
