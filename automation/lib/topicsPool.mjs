// 주제 재고 DB (축2) — data/topics-pool.json.
// "무궁무진 + 게시한 글 제외 + 다시 게시할 필요 있는 글"을 위한 재고·소진·중복차단.
//  · status: pending(제안 가능) | published(소진) | skipped(반려, 되살림 가능)
//  · 3중 중복 방어: ① 발행글 매칭(제목·슬러그·태그) ② status ③ lastProposedAt 30일 쿨다운
//  · metrics: 네이버 지표·별점 24h 캐시(보충 시 채움).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.mjs';
import { STOP } from './topics.mjs';

const DB = path.join(ROOT, 'data', 'topics-pool.json');
const DAY = 24 * 3600 * 1000;
const PROPOSE_COOLDOWN = 30 * DAY;

// ── 초기 시드(하드코딩 시드풀 이전본). {keyword, tier, series, angle} ──
// tier: science(🔬)/health(💪)/evergreen(🌲). series: 계열. angle: 돈 드는 판단 각도.
export const SEED_TOPICS = [
  // 🔬 과학·생활원리 — life(생활원리형·고단가)
  { keyword: '에어컨 제습 냉방 전기요금', tier: 'science', series: 'life', angle: '제습 vs 냉방 요금 비교' },
  { keyword: '제습기 전기요금', tier: 'science', series: 'life', angle: '하루 요금·에어컨 대비' },
  { keyword: '공기청정기 필터 교체 주기', tier: 'science', series: 'life', angle: '필터 비용·교체 시기' },
  { keyword: '공기청정기 전기요금', tier: 'science', series: 'life', angle: '24시간 가동 요금' },
  { keyword: '전기장판 전기요금', tier: 'science', series: 'life', angle: '한 달 요금·보일러 대비' },
  { keyword: '보일러 외출모드 전기요금', tier: 'science', series: 'life', angle: '외출 vs 계속난방' },
  { keyword: '인덕션 하이라이트 차이', tier: 'science', series: 'life', angle: '설치·전기요금 선택' },
  { keyword: '건조기 전기요금', tier: 'science', series: 'life', angle: '회당 요금·가스식 비교' },
  { keyword: '정수기 렌탈 자가관리 비교', tier: 'science', series: 'life', angle: '렌탈 vs 직수 비용' },
  // 🔬 과학·생활원리 — knowledge(자연·과학 원리)
  { keyword: '유성우 보는 법', tier: 'science', series: 'knowledge', angle: '관측 시기·장소 선택' },
  { keyword: '일식 월식 차이', tier: 'science', series: 'knowledge', angle: '관측 준비' },
  { keyword: '오로라 발생 원리', tier: 'science', series: 'knowledge', angle: '관측 여행 시기' },
  { keyword: '정전기 없애는 법', tier: 'science', series: 'knowledge', angle: '생활 대처' },
  { keyword: '태풍 발생 원리', tier: 'science', series: 'knowledge', angle: '대비 우선순위' },
  { keyword: '발효 원리', tier: 'science', series: 'knowledge', angle: '김장·보관 판단' },
  // 💪 건강 — (A) 검진·의료제도
  { keyword: '국가건강검진 항목', tier: 'health', series: 'A', angle: '대상·주기 확인, 연말 몰림 회피' },
  { keyword: '위내시경 주기', tier: 'health', series: 'A', angle: '권장 주기·비용 판단' },
  { keyword: '대장내시경 비용', tier: 'health', series: 'A', angle: '주기·비급여 비용 판단' },
  { keyword: '임플란트 건강보험 적용 조건', tier: 'health', series: 'A', angle: '보험 적용 나이·개수 판단' },
  { keyword: '4세대 실손보험 전환 조건', tier: 'health', series: 'A', angle: '전환 유불리 판단' },
  { keyword: '비급여 진료비 확인 방법', tier: 'health', series: 'A', angle: '비용 비교·병원 선택' },
  // 💪 건강 — (B) 영양제 원리
  { keyword: '유산균 냉장보관 이유', tier: 'health', series: 'B', angle: '보관·구매 형태 선택' },
  { keyword: '프로바이오틱스 프리바이오틱스 차이', tier: 'health', series: 'B', angle: '목적별 선택' },
  { keyword: '오메가3 rTG TG 차이', tier: 'health', series: 'B', angle: '형태별 가격·흡수 판단' },
  { keyword: '마그네슘 종류별 흡수율', tier: 'health', series: 'B', angle: '목적별 형태·비용 선택' },
  { keyword: '영양제 공복 식후', tier: 'health', series: 'B', angle: '복용 시점 선택' },
  { keyword: '영양제 병용 금기', tier: 'health', series: 'B', angle: '병용 조합 판단' },
  // 💪 건강 — (C) 헬스·운동
  { keyword: '단백질 하루 필요량 계산', tier: 'health', series: 'C', angle: '체중별 섭취량·보충제 필요성' },
  { keyword: 'WPI WPC 차이', tier: 'health', series: 'C', angle: '유당불내증 시 선택' },
  { keyword: '점진적 과부하 원리', tier: 'health', series: 'C', angle: '루틴·증량 판단' },
  { keyword: '근손실 진실', tier: 'health', series: 'C', angle: '단식·유산소 시 판단' },
  // 💪 건강 — (D) 수면·회복
  { keyword: '수면 사이클 렘수면', tier: 'health', series: 'D', angle: '기상 타이밍 판단' },
  { keyword: '카페인 반감기', tier: 'health', series: 'D', angle: '커피 마시는 시간 판단' },
  { keyword: '매트리스 경도 선택', tier: 'health', series: 'D', angle: '체형별 경도·비용 선택' },
  // 💪 건강 — (E) 대사·식단
  { keyword: '혈당 스파이크 원리', tier: 'health', series: 'E', angle: '식사 순서·식품 선택' },
  { keyword: '간헐적 단식 과학', tier: 'health', series: 'E', angle: '시간대·적용 판단' },
  { keyword: '기초대사량 계산', tier: 'health', series: 'E', angle: '감량 칼로리 설정' },
  // 🌲 에버그린 — parking
  { keyword: '공영주차장 요금', tier: 'evergreen', series: 'parking', angle: '요금·할인 비교' },
  { keyword: '무료 주차장 찾기', tier: 'evergreen', series: 'parking', angle: '위치·시간 판단' },
  { keyword: '주차위반 과태료', tier: 'evergreen', series: 'parking', angle: '과태료·이의 판단' },
  { keyword: '거주자 우선주차', tier: 'evergreen', series: 'parking', angle: '신청·비용' },
  { keyword: '대형마트 주차', tier: 'evergreen', series: 'parking', angle: '무료시간·정산' },
  // 🌲 에버그린 — tax
  { keyword: '연말정산 환급', tier: 'evergreen', series: 'tax', angle: '공제 항목 챙기기' },
  { keyword: '자동차세 연납', tier: 'evergreen', series: 'tax', angle: '연납 할인 판단' },
  { keyword: '재산세 조회', tier: 'evergreen', series: 'tax', angle: '납부·카드 혜택' },
  { keyword: '종합소득세 신고', tier: 'evergreen', series: 'tax', angle: '대상·신고 판단' },
  { keyword: '근로장려금 신청', tier: 'evergreen', series: 'tax', angle: '자격·신청 시기' },

  // 💰 금융·재테크·세금(최고 CPC) — 신생 사이트 원칙: 롱테일 판단형 각도. 투자 권유·수익 보장 금지(YMYL).
  // (pension) 연금·절세계좌
  { keyword: 'ISA 연금저축 IRP 차이', tier: 'finance', series: 'pension', angle: '세액공제 우선순위 판단' },
  { keyword: '연금저축 IRP 세액공제 한도', tier: 'finance', series: 'pension', angle: '900만원 채우는 순서' },
  { keyword: 'ISA 만기 연금계좌 이전', tier: 'finance', series: 'pension', angle: '60일·300만원 추가공제 판단' },
  { keyword: '국민연금 예상수령액 조회', tier: 'finance', series: 'pension', angle: '수령 시기·조기연금 판단' },
  { keyword: '퇴직연금 DB DC 차이', tier: 'finance', series: 'pension', angle: '운용 선택 판단' },
  { keyword: '청년도약계좌 조건', tier: 'finance', series: 'pension', angle: '가입 유불리 판단' },
  { keyword: '주택청약통장 소득공제', tier: 'finance', series: 'pension', angle: '납입액·연말정산 판단' },
  // (tax) 금융 세금
  { keyword: '배당소득 분리과세 신청', tier: 'finance', series: 'tax', angle: '고배당주 신청 유불리(2026)' },
  { keyword: '금융소득종합과세 기준', tier: 'finance', series: 'tax', angle: '2천만원 초과 대비' },
  { keyword: '해외주식 양도소득세 신고', tier: 'finance', series: 'tax', angle: '250만원 공제·환율 판단' },
  { keyword: '주식 양도세 대주주 기준', tier: 'finance', series: 'tax', angle: '연말 매도 판단' },
  // (save) 예적금·금리
  { keyword: '파킹통장 금리 비교', tier: 'finance', series: 'save', angle: 'CMA vs 파킹 선택' },
  { keyword: '예금자보호 한도', tier: 'finance', series: 'save', angle: '은행 분산 판단' },
  // (invest) 투자 원리
  { keyword: 'ETF 분배금 세금', tier: 'finance', series: 'invest', angle: '국내 해외 ETF 세금 판단' },
  { keyword: '달러 환테크 방법', tier: 'finance', series: 'invest', angle: '환전 시점·수수료 판단' },
  { keyword: '금 투자 방법 비교', tier: 'finance', series: 'invest', angle: 'KRX금 vs 골드뱅킹 판단' },

  // 🏠 대출·부동산(고 CPC) — 조건·한도·세금은 기준일 병기·공식 출처(주택도시기금·국세청·금융위).
  // (loan) 정책·주담대
  { keyword: '신생아 특례대출 조건', tier: 'realestate', series: 'loan', angle: '소득기준·한도 판단' },
  { keyword: '디딤돌대출 소득기준', tier: 'realestate', series: 'loan', angle: '자격·금리 판단' },
  { keyword: '보금자리론 조건', tier: 'realestate', series: 'loan', angle: '대상·한도 판단' },
  { keyword: '주택담보대출 갈아타기', tier: 'realestate', series: 'loan', angle: '중도상환수수료·시점 판단' },
  { keyword: '중도상환수수료 면제 조건', tier: 'realestate', series: 'loan', angle: '3년·연 10% 면제 활용' },
  { keyword: '신용점수 올리는 법', tier: 'realestate', series: 'loan', angle: '대환 전 점수 관리' },
  { keyword: '전세자금대출 조건', tier: 'realestate', series: 'loan', angle: '버팀목·한도 판단' },
  // (lease) 전월세
  { keyword: '전세사기 예방 방법', tier: 'realestate', series: 'lease', angle: '확정일자·전세보증 판단' },
  { keyword: '전세보증금 반환보증', tier: 'realestate', series: 'lease', angle: '가입 비용·조건 판단' },
  { keyword: '전월세 신고제 대상', tier: 'realestate', series: 'lease', angle: '신고 의무·과태료' },
  { keyword: '부동산 중개보수 계산', tier: 'realestate', series: 'lease', angle: '상한요율 확인' },
  // (tax) 부동산 세금
  { keyword: '취득세 세율 계산', tier: 'realestate', series: 'tax', angle: '생애최초·조정지역 판단' },
  { keyword: '1주택 양도세 비과세 조건', tier: 'realestate', series: 'tax', angle: '2년 보유·거주 판단' },
  { keyword: '재산세 종부세 차이', tier: 'realestate', series: 'tax', angle: '과세 기준일 판단' },
  // (subscribe) 청약
  { keyword: '청약 가점 계산', tier: 'realestate', series: 'subscribe', angle: '무주택·부양가족 점수' },
  { keyword: '청약통장 예치금 기준', tier: 'realestate', series: 'subscribe', angle: '지역·면적별 판단' },

  // 💪 건강 — (A) 의료·보험 고CPC 보강
  { keyword: '라식 라섹 차이 비용', tier: 'health', series: 'A', angle: '회복·비용 판단' },
  { keyword: '백내장 다초점렌즈 실비', tier: 'health', series: 'A', angle: '급여·비급여 판단' },
  { keyword: '도수치료 실손보험 청구', tier: 'health', series: 'A', angle: '횟수·한도 판단' },
  { keyword: '운전자보험 필요성', tier: 'health', series: 'A', angle: '특약 선택 판단' },
  { keyword: '암보험 갱신형 비갱신형', tier: 'health', series: 'A', angle: '형태 선택 판단' },
  { keyword: '건강보험료 산정 기준', tier: 'health', series: 'A', angle: '지역·직장 판단' },

  // 🔬 과학·생활원리 — life 에너지 고단가 보강
  { keyword: '태양광 설치 지원금', tier: 'science', series: 'life', angle: '설치비·회수기간 판단' },
  { keyword: '전기차 충전요금 완속 급속', tier: 'science', series: 'life', angle: '충전 방식 선택' },
];

const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h).toString(36); };
export const topicId = (kw) => 't' + hash(kw);

export function loadPool() {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return null; }
}
export function savePool(pool) {
  pool.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  const tmp = DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(pool, null, 2));
  fs.renameSync(tmp, DB); // 원자적 교체
}

// 파일이 없거나 비어 있으면 시드로 초기화(멱등). 반환: pool
export function seedPoolIfEmpty() {
  let pool = loadPool();
  if (pool && Array.isArray(pool.topics) && pool.topics.length) return pool;
  const now = new Date().toISOString();
  pool = {
    _note: '주제 재고 DB(축2). status=pending|published|skipped. lastProposedAt=제안 쿨다운(30일). metrics=네이버 지표·별점 24h 캐시. 발행 시 publish.mjs가 status=published+slug 기록.',
    updatedAt: now,
    topics: SEED_TOPICS.map((t) => ({
      id: topicId(t.keyword),
      keyword: t.keyword,
      tier: t.tier,
      series: t.series,
      angle: t.angle,
      status: 'pending',
      slug: null,
      addedAt: now,
      lastProposedAt: null,
      metrics: null,
    })),
  };
  savePool(pool);
  return pool;
}

// ── 발행글 라이브 인덱스(제목·슬러그·태그 토큰) — 중복 방어 ① ──
const tokens = (s) =>
  String(s || '').replace(/[^가-힣a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w));

let _liveCache = null;
export function liveIndex(force = false) {
  if (_liveCache && !force) return _liveCache;
  const BLOG = path.join(ROOT, 'src', 'content', 'blog');
  const posts = [];
  if (fs.existsSync(BLOG)) {
    for (const d of fs.readdirSync(BLOG)) {
      const f = path.join(BLOG, d, 'index.md');
      if (!fs.existsSync(f)) continue;
      const raw = fs.readFileSync(f, 'utf8');
      if (/^draft:\s*true/m.test(raw)) continue; // 발행글만
      const title = (raw.match(/^title:\s*"?(.*?)"?\s*$/m) || [])[1] || '';
      const tags = (raw.match(/^tags:\s*\[(.*?)\]/m) || [])[1] || '';
      const orig = (raw.match(/^originalPath:\s*"?(.*?)"?\s*$/m) || [])[1] || '';
      posts.push({ slug: d, title, orig, toks: new Set([...tokens(title), ...tokens(tags), ...tokens(d)]) });
    }
  }
  _liveCache = posts;
  return posts;
}

// 발행글이 늘어나면 캐시를 버린다. 봇은 24시간 상주 데몬이라 이걸 안 하면
// _liveCache 가 프로세스 시작 시점에 고정돼, 오늘 발행한 글이 중복방어 인덱스에
// 안 잡히고 다음 브리핑에 같은 주제가 또 제안된다. publish 성공 시 호출.
export function invalidateLive() {
  _liveCache = null;
}

// 키워드가 발행글과 얼마나 겹치나 → 가장 겹치는 글 {slug,title,score} 또는 null
export function matchLive(keyword) {
  const kw = tokens(keyword);
  if (!kw.length) return null;
  let best = null;
  for (const p of liveIndex()) {
    const score = kw.filter((w) => p.toks.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { slug: p.slug, title: p.title, score };
  }
  return best;
}

// ── 3중 방어로 브리핑 후보 픽 ──
// tier별 pending 중 (② status·③ 30일 쿨다운·① 발행글 강매칭) 통과분을 count개. 강매칭은 published로 자동 소진.
// 반환: [{id, keyword, source, angle, series}] + 부수효과로 pool 갱신(markProposed·auto-published) 후 savePool.
export function pickForBrief(pool, tier, count, extraExclude = new Set()) {
  const now = Date.now();
  const out = [];
  let dirty = false;
  const eligible = pool.topics.filter((t) => t.tier === tier && t.status === 'pending');
  // 정렬: 별점 높은 것 → 한 번도 제안 안 한 것 → 오래된 것
  eligible.sort((a, b) =>
    ((b.metrics?.stars || 0) - (a.metrics?.stars || 0)) ||
    ((a.lastProposedAt ? Date.parse(a.lastProposedAt) : 0) - (b.lastProposedAt ? Date.parse(b.lastProposedAt) : 0))
  );
  for (const t of eligible) {
    if (out.length >= count) break;
    if (extraExclude.has(t.keyword)) continue;
    // ③ 제안 쿨다운
    if (t.lastProposedAt && now - Date.parse(t.lastProposedAt) < PROPOSE_COOLDOWN) continue;
    // ① 발행글 강매칭 → 소진 처리(published) 후 제외
    const m = matchLive(t.keyword);
    if (m && m.score >= 2) {
      t.status = 'published'; t.slug = m.slug; t.publishedNote = 'live-match'; dirty = true;
      continue;
    }
    t.lastProposedAt = new Date(now).toISOString(); // 제안 기록
    dirty = true;
    out.push({ id: t.id, keyword: t.keyword, source: t.tier, angle: t.angle, series: t.series });
  }
  if (dirty) savePool(pool);
  return out;
}

export function pendingCount(pool, tier) {
  return pool.topics.filter((t) => t.status === 'pending' && (!tier || t.tier === tier)).length;
}

// 지금 '제안 가능한'(pending & 30일 쿨다운 아닌) 수 — 보충 트리거 판단용(신선 재고가 마르기 전에 채움).
export function eligibleCount(pool, tier) {
  const now = Date.now();
  return pool.topics.filter((t) =>
    t.status === 'pending' && (!tier || t.tier === tier) &&
    (!t.lastProposedAt || now - Date.parse(t.lastProposedAt) >= PROPOSE_COOLDOWN)
  ).length;
}

// 발행 소진: 키워드/슬러그로 pending → published (publish.mjs에서 호출)
export function markPublished(keyword, slug) {
  const pool = loadPool();
  if (!pool) return false;
  const id = topicId(keyword);
  let t = pool.topics.find((x) => x.id === id) || pool.topics.find((x) => x.keyword === keyword);
  if (!t) {
    const m = matchLive(keyword); // 재고에 없던 수동/실검 발행도 참고 기록
    if (!m) return false;
  }
  if (t && t.status !== 'published') { t.status = 'published'; t.slug = slug || t.slug; savePool(pool); return true; }
  return false;
}

// 키워드를 모를 때(수동·실검 발행 등) 제목 토큰으로 재고 pending 강매칭 → published 소진.
// 반환: 소진된 keyword 또는 null.
export function soakPublished(slug, title) {
  const pool = loadPool();
  if (!pool) return null;
  const tt = new Set(tokens(title));
  let best = null;
  for (const t of pool.topics) {
    if (t.status !== 'pending') continue;
    const score = tokens(t.keyword).filter((w) => tt.has(w)).length;
    if (score >= 2 && (!best || score > best.score)) best = { t, score };
  }
  if (best) { best.t.status = 'published'; best.t.slug = slug; savePool(pool); return best.t.keyword; }
  return null;
}

// 반려 소진: pending → skipped (되살림용 skippedAt 플래그). bot.mjs [❌반려]에서 호출.
export function markSkipped(keyword) {
  const pool = loadPool();
  if (!pool) return false;
  const t = pool.topics.find((x) => x.keyword === keyword) || pool.topics.find((x) => x.id === topicId(keyword));
  if (t && t.status === 'pending') { t.status = 'skipped'; t.skippedAt = new Date().toISOString(); savePool(pool); return true; }
  return false;
}

// 되살리기: skipped → pending (나중에 되살릴 수 있게)
export function reviveSkipped(keyword) {
  const pool = loadPool();
  if (!pool) return false;
  const t = pool.topics.find((x) => x.keyword === keyword);
  if (t && t.status === 'skipped') { t.status = 'pending'; delete t.skippedAt; t.lastProposedAt = null; savePool(pool); return true; }
  return false;
}

// 발행 취소(/unpublish) 되돌림: published → pending. 슬러그로 찾는다.
// 이걸 안 하면 그 주제가 영영 published 로 묶여 다시는 제안되지 않는다
// (오발행을 내렸는데 나중에 제대로 쓸 기회까지 사라지는 셈).
// 반환: 되살린 키워드 | null
export function restorePending(slug) {
  const pool = loadPool();
  if (!pool || !slug) return null;
  const t = pool.topics.find((x) => x.slug === slug && x.status === 'published');
  if (!t) return null;
  t.status = 'pending';
  t.slug = null;
  t.lastProposedAt = null; // 쿨다운 초기화 — 바로 다시 후보가 될 수 있게
  savePool(pool);
  return t.keyword;
}

// 보충분 적재(중복 제거). items: [{keyword,tier,series,angle,metrics?,status?}]. 반환: 추가된 수.
export function addTopics(pool, items) {
  const have = new Set(pool.topics.map((t) => t.keyword));
  const now = new Date().toISOString();
  let added = 0;
  for (const it of items) {
    if (!it.keyword || have.has(it.keyword)) continue;
    const lm = matchLive(it.keyword);
    if (lm && lm.score >= 2) continue; // 발행글과 '강매칭'(2토큰↑)일 때만 제외 — 단일 공통어 오탐 방지
    pool.topics.push({
      id: topicId(it.keyword), keyword: it.keyword, tier: it.tier || 'evergreen',
      series: it.series || '', angle: it.angle || '', status: it.status || 'pending',
      slug: null, addedAt: now, lastProposedAt: null, metrics: it.metrics || null,
    });
    have.add(it.keyword); added++;
  }
  return added;
}
