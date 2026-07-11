// 키워드 수집 — 스위치식(trend:5 / trend:3+evergreen:2 / evergreen:5).
// 기본: signal.bz 실시간 검색어 → (실패)구글 트렌드 KR → (실패)에버그린.
// v2.7: 브리핑은 계급 균형(🔥실검·🔬과학·💪건강·🌲에버그린 각 2)으로 후보를 뽑는다.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/env.mjs';
import { INFO, RISK } from './lib/suitability.mjs';

const BLOG = path.join(ROOT, 'src', 'content', 'blog');

// 가십/연예성 신호(정보형 우선을 위해 후순위로 밀 때 사용)
const GOSSIP =
  /열애|결혼|이혼|사망|별세|부고|불륜|폭행|음주운전|마약|성추행|성폭행|논란|저격|디스|하차|복귀|임신|출산|열애설|파경|고백|폭로|사과|입장문|재판|구속|피소|고소/;

function existingTitles() {
  const set = [];
  if (!fs.existsSync(BLOG)) return set;
  for (const d of fs.readdirSync(BLOG)) {
    const f = path.join(BLOG, d, 'index.md');
    if (fs.existsSync(f)) {
      const m = fs.readFileSync(f, 'utf8').match(/^title:\s*"?(.*?)"?\s*$/m);
      if (m) set.push(m[1]);
    }
  }
  return set;
}

async function fetchSignalBz() {
  const res = await fetch('https://api.signal.bz/news/realtime', {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error('signal.bz HTTP ' + res.status);
  const data = await res.json();
  const kws = (data.top10 || []).map((x) => x.keyword).filter(Boolean);
  if (!kws.length) throw new Error('signal.bz 파싱 결과 없음');
  return kws;
}

async function fetchGoogleTrendsKR() {
  const res = await fetch('https://trends.google.com/trending/rss?geo=KR');
  if (!res.ok) throw new Error('google-trends HTTP ' + res.status);
  const xml = await res.text();
  const titles = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)]
    .map((m) => m[1].trim())
    .filter((t) => t && t !== 'Daily Search Trends');
  // 영문 중복(예: 한글 다음 줄의 romanization) 제거
  const kws = titles.filter((t) => /[가-힣]/.test(t));
  if (!kws.length) throw new Error('google-trends 파싱 결과 없음');
  return kws;
}

export async function collectTrend() {
  const errs = [];
  for (const [name, fn] of [
    ['signal.bz', fetchSignalBz],
    ['google-trends-KR', fetchGoogleTrendsKR],
  ]) {
    try {
      const kws = await fn();
      return { keywords: kws, source: name };
    } catch (e) {
      errs.push(`${name}: ${e.message}`);
    }
  }
  throw new Error('실시간 트렌드 수집 실패 — ' + errs.join(' | '));
}

// 에버그린 시드(주차·세금 등 생활정보). 기존 글과 겹치면 건너뜀.
// 검색량이 실제로 잡히도록 '검색어 형태'(짧은 실검형)로. 생성 시드로도 충분.
// health 풀은 v2.7에서 💪 계급(HEALTH_SEEDS)으로 분리 — 에버그린 tier에는 넣지 않음.
const EVERGREEN = {
  parking: ['공영주차장 요금', '무료 주차장 찾기', '주차위반 과태료', '거주자 우선주차', '대형마트 주차'],
  tax: ['연말정산 환급', '자동차세 연납', '재산세 조회', '종합소득세 신고', '근로장려금 신청'],
};

// 🔬 과학·생활원리 시드 — angle 태그: 'life'(생활원리형·고단가 우선) / 'knowledge'(자연·과학 원리).
// 콘텐츠 도그마: 원리 설명 → 돈이 드는 실생활 판단(요금·선택·시기). life는 가전 요금/선택 결합, 롱테일 각도로 좁힘.
const SCIENCE_SEEDS = [
  // (b) 생활원리형(고단가·우선) — 가전 원리 + 전기요금/선택 판단
  { keyword: '에어컨 제습 냉방 전기요금', angle: 'life' },
  { keyword: '제습기 전기요금', angle: 'life' },
  { keyword: '공기청정기 필터 교체 주기', angle: 'life' },
  { keyword: '공기청정기 전기요금', angle: 'life' },
  { keyword: '전기장판 전기요금', angle: 'life' },
  { keyword: '보일러 외출모드 전기요금', angle: 'life' },
  { keyword: '인덕션 하이라이트 차이', angle: 'life' },
  { keyword: '건조기 전기요금', angle: 'life' },
  { keyword: '정수기 렌탈 자가관리 비교', angle: 'life' },
  // (a) 지식형 — 자연/과학 원리
  { keyword: '유성우 보는 법', angle: 'knowledge' },
  { keyword: '일식 월식 차이', angle: 'knowledge' },
  { keyword: '오로라 발생 원리', angle: 'knowledge' },
  { keyword: '정전기 없애는 법', angle: 'knowledge' },
  { keyword: '태풍 발생 원리', angle: 'knowledge' },
  { keyword: '발효 원리', angle: 'knowledge' },
];

// 💪 건강·영양·헬스 시드(고단가 우선순위 순, 전원 +1.25). 신생 사이트 원칙: 대형 키워드 정면 승부 금지 →
// 롱테일 정보형 각도로 좁힘(예: '실손보험'(X) → '4세대 실손보험 전환 조건'(O)).
const HEALTH_SEEDS = [
  // (A) 의료제도·검진
  '국가건강검진 항목',
  '위내시경 주기',
  '대장내시경 비용',
  '임플란트 건강보험 적용 조건',
  '4세대 실손보험 전환 조건',
  '비급여 진료비 확인 방법',
  // (B) 영양제 원리
  '유산균 냉장보관 이유',
  '프로바이오틱스 프리바이오틱스 차이',
  '오메가3 rTG TG 차이',
  '마그네슘 종류별 흡수율',
  '영양제 공복 식후',
  '영양제 병용 금기',
  // (C) 헬스·운동
  '단백질 하루 필요량 계산',
  'WPI WPC 차이',
  '점진적 과부하 원리',
  '근손실 진실',
  // (D) 수면·회복
  '수면 사이클 렘수면',
  '카페인 반감기',
  '매트리스 경도 선택',
  // (E) 대사·식단
  '혈당 스파이크 원리',
  '간헐적 단식 과학',
  '기초대사량 계산',
];

// 롱테일 시드 균형 픽: exclude(기존글·발행·이미 뽑음) 제외하고 앞에서부터 count개.
// 30일 briefed 제외가 회전(rotation)을 담당하므로 별도 셔플 없이 순서 픽으로 충분.
function pickSeeds(pool, count, exclude, keyOf = (x) => x) {
  const out = [];
  for (const item of pool) {
    if (out.length >= count) break;
    if (!exclude.has(keyOf(item))) out.push(item);
  }
  return out;
}

function pickEvergreen(count, mix, exclude) {
  const out = [];
  const cats = Object.entries(mix); // [['parking',3],...]
  let i = 0;
  while (out.length < count && i < 50) {
    for (const [cat, weight] of cats) {
      const pool = (EVERGREEN[cat] || []).filter(
        (k) => !exclude.has(k) && !out.includes(k)
      );
      const take = Math.min(weight, pool.length);
      for (let j = 0; j < take && out.length < count; j++) {
        out.push(pool[(i + j) % pool.length]);
      }
    }
    i++;
  }
  return out.slice(0, count);
}

// config.source 스위치 → 최종 키워드 목록 + 메모(텔레그램 알림용)
export async function selectKeywords(config) {
  const spec = config.source || 'trend:5';
  const parts = { trend: 0, evergreen: 0 };
  for (const p of spec.split('+')) {
    const [k, v] = p.split(':');
    if (k && parts[k.trim()] !== undefined) parts[k.trim()] = parseInt(v) || 0;
  }
  const titles = existingTitles();
  const chosen = [];
  const seen = new Set();
  const notes = [];

  if (parts.trend > 0) {
    let trend = [];
    try {
      const t = await collectTrend();
      trend = t.keywords;
      notes.push(`실시간 소스: ${t.source} (${trend.length}개 수집)`);
    } catch (e) {
      notes.push('⚠️ ' + e.message + ' → 에버그린으로 대체');
      parts.evergreen += parts.trend;
      parts.trend = 0;
    }
    // 기존 글과 중복 배제
    trend = trend.filter((k) => {
      const dup = titles.some((t) => t.includes(k) || (k.length >= 4 && k.includes(t.slice(0, 5))));
      return !seen.has(k) && !dup;
    });
    // 정보형 우선(가십은 뒤로)
    trend.sort((a, b) => (GOSSIP.test(a) ? 1 : 0) - (GOSSIP.test(b) ? 1 : 0));
    for (const k of trend.slice(0, parts.trend)) {
      chosen.push({ keyword: k, source: 'trend', gossip: GOSSIP.test(k) });
      seen.add(k);
    }
  }

  if (parts.evergreen > 0) {
    const ev = pickEvergreen(parts.evergreen, config.evergreenMix || { parking: 3, tax: 2 }, new Set(titles));
    for (const k of ev) {
      chosen.push({ keyword: k, source: 'evergreen', gossip: false });
      seen.add(k);
    }
  }

  return { keywords: chosen.slice(0, config.draftsPerRun || 5), notes };
}

// 브리핑용 후보 — v2.7 계급 균형: 🔥실검(정보형만)·🔬과학·💪건강·🌲에버그린을 tierCounts대로.
// (📅캘린더는 briefing.mjs에서 별도로 앞에 붙는다.) 발행/기출(exclude) 제외.
export async function briefingCandidates(config, exclude = new Set()) {
  const titles = existingTitles();
  const isDup = (k) =>
    exclude.has(k) || titles.some((t) => t.includes(k) || (k.length >= 4 && k.includes(t.slice(0, 5))));
  const counts = config.tierCounts || { trend: 2, science: 2, health: 2, evergreen: 2 };
  const out = [];
  const seen = new Set();
  const add = (keyword, srcTier, extra = {}) => {
    if (seen.has(keyword) || isDup(keyword)) return false;
    out.push({ keyword, source: srcTier, gossip: false, ...extra });
    seen.add(keyword);
    return true;
  };
  // 지금까지 뽑힌 것 + 기존글 + exclude 를 합친 '건너뛸 집합'(시드 픽 사전 필터용)
  const skipSet = () => new Set([...titles, ...exclude, ...seen]);

  let source = null, note = '';

  // 🔥 실검 — '정보형만'. 가십·인물 신변·정치(위험) 신호 완전 제외 후, 정보형 신호 우선.
  try {
    const t = await collectTrend();
    source = t.source;
    let trend = t.keywords.filter((k) => !isDup(k) && !seen.has(k) && !GOSSIP.test(k) && !RISK.test(k));
    trend.sort((a, b) => (INFO.test(b) ? 1 : 0) - (INFO.test(a) ? 1 : 0));
    for (const k of trend) {
      if (out.filter((o) => o.source === 'trend').length >= counts.trend) break;
      add(k, 'trend');
    }
  } catch (e) {
    note = e.message;
  }

  // 🔬 과학·생활원리(life/knowledge angle 유지)
  for (const s of pickSeeds(SCIENCE_SEEDS, counts.science, skipSet(), (x) => x.keyword)) {
    add(s.keyword, 'science', { angle: s.angle });
  }

  // 💪 건강·영양·헬스
  for (const k of pickSeeds(HEALTH_SEEDS, counts.health, skipSet())) {
    add(k, 'health');
  }

  // 🌲 에버그린(주차·세금 등 일반 생활정보)
  for (const k of pickEvergreen(counts.evergreen, config.evergreenMix || { parking: 3, tax: 2 }, skipSet())) {
    add(k, 'evergreen');
  }

  return { candidates: out, source, note };
}
