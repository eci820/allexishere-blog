// 🇦🇺 AU 성과 분석가 (일일) — 구조만. 아직 스케줄 등록하지 않는다(데이터 0).
//
// 역할(§8): "지금 성과가 어떤가" (상세 진단은 au-seo 의 몫). daily 는 이상이 있을 때만 말한다.
// 🔴 비용(§5): LLM 0회 — 집계·비교·정렬은 산수다.
// 🔴 데이터 성숙(§7): 성과 이력이 임계(7일) 미만이거나 GSC 접근이 없으면 '추세 제안을 끄고'
//    "근거 부족"을 명시한다. 억지 제안은 소음이다. 임계를 넘으면 자동으로 켜진다.
//
// 🔴🔴 선행조건(보완 2): au-analyst/au-seo 가 GSC 데이터를 읽으려면 한국 GSC 서비스계정을
//    Search Console 의 **au.allexishere.com 속성에 사용자로 추가**해야 한다. 그 전에는
//    gscAccessAvailable() 가 false 이고, 이 에이전트는 데이터 없이 "보류"만 보고한다.
//    스케줄 등록(launchd)은 데이터가 쌓인 뒤 사용자 지시로 한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HISTORY = path.join(HERE, '..', 'state', 'au', 'perf-history.json'); // 성과 이력(아직 없음)
const MATURITY_DAYS = 7;

function loadJson(p, d) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return d;
  }
}

// 🔴 AU GSC 서비스계정 접근 여부. 지금은 접근이 없어 항상 false(정직).
//    선행조건(위 주석) 충족 후, 여기서 실제 GSC 클라이언트 초기화 성공 시 true 를 반환하도록 교체한다.
export function gscAccessAvailable() {
  return false;
}

// 데이터 성숙 상태.
export function dataStatus() {
  const hist = loadJson(HISTORY, []);
  const days = Array.isArray(hist) ? hist.length : 0;
  const gsc = gscAccessAvailable();
  return { days, gsc, matured: days >= MATURITY_DAYS && gsc };
}

// 분석 실행 → 사람이 읽을 리포트 문자열(없으면 null = 조용히). 전송·쓰기 없음(순수).
export function analyse() {
  const s = dataStatus();
  if (!s.matured) {
    return {
      matured: false,
      report:
        `🇦🇺 Analyst — holding (insufficient data).\n` +
        `• performance history: ${s.days} day(s) (need ≥ ${MATURITY_DAYS})\n` +
        `• GSC access to au.allexishere.com: ${s.gsc ? 'yes' : 'no'}\n` +
        `No trend proposals until data matures. Prerequisite: add the KR GSC service account ` +
        `to the au.allexishere.com property, then let this run on a schedule.`,
    };
  }
  // 🔮 성숙 후: 여기서 GSC 노출/클릭 스냅샷 + 이력 비교(산수)로 이상만 보고한다.
  //    소표본 비율(노출 100 미만 CTR) 금지 · 신규글 D+7 전 판정 제외 · 색인/GSC 지연 구분.
  return { matured: true, report: null /* TODO: 성숙 후 구현 */ };
}

// dry-run: node au-analyst.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = analyse();
  console.log('=== au-analyst dry-run (LLM 0 · 전송·쓰기 없음) ===');
  console.log(r.report || '(정상 — 보고할 이상 없음)');
}
