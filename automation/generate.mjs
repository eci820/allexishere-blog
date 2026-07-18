// 초안 생성 엔진 (v2.7).
// 엔진: engine=claude-cli(기본, 구독 헤드리스) | anthropic-api(폴백/직접).
// 게시는 절대 여기서 안 함 — 초안(draft:true)만 만들고 텔레그램 승인으로 넘김.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { ROOT, AUTO_DIR, loadConfig, requireSecrets } from './lib/env.mjs';
import { selectKeywords } from './keywords.mjs';
import { existingMatch, hasExistingPost } from './lib/topics.mjs';
import { sendMessage, inlineButtons } from './lib/telegram.mjs';
import { subscriptionEnv } from './lib/claudeCli.mjs';

const execFileP = promisify(execFile);
const BLOG = path.join(ROOT, 'src', 'content', 'blog');
const STATE = path.join(AUTO_DIR, 'state');

function kstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+09:00`;
}
const kstDate = () => kstNow().slice(0, 10).replace(/-/g, '.');
function slugify(t) {
  return t.trim().replace(/[^0-9A-Za-z가-힣\s-]/g, '').replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
}
function uniqueSlug(base) {
  let s = base || '글-' + kstDate();
  let i = 2;
  while (fs.existsSync(path.join(BLOG, s))) s = `${base}-${i++}`;
  return s;
}
const dq = (s) => '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// ── 프롬프트 규칙(엔진 공통) ──────────────────────────────
const RULES = `당신은 한국어 정보성 블로그의 전문 에디터입니다. 주어진 키워드로 검색 유입에 강한 '정보 정리' 글 1편을 작성합니다.

[최우선 안전 규칙 — 실시간 검색어는 실존 인물이 많음]
- 인물의 사망·범죄·열애·결혼·불륜·질병 등 민감/미확인 사실을 절대 단정하지 마세요.
- 루머·추측·'~카더라'·SNS발 미확인 정보 배제. 확인된 공식 보도/공공기관 자료 기반 사실만.
- 필요하면 WebSearch로 사실과 기준일을 확인하세요. 확인 불가한 민감 주제는 정보 위주로 우회하거나 다루지 마세요.
- 특정인 명예를 훼손할 소지가 조금이라도 있으면 riskNotes 에 반드시 명시.

[제목 설계 — SEO 4단계]
1) (WebSearch로) 이 키워드가 '왜 지금 검색되는지 / 사람들이 뭘 궁금해하는지'를 먼저 파악하세요.
2) 핵심 키워드 + 검색량 높은 보조어(근황·이유·일정·방법·총정리 등)를 제목 '앞부분'에 배치.
3) 약속어(총정리·N가지·방법·기준 중 1개) + 시의성(2026, 필요 시 7월)을 넣어 25~35자.
4) 낚시 금지 — 제목이 약속한 내용을 본문이 100% 이행. 미확인 단정 금지.
   예) "이휘재"(X) → "이휘재 ○○ 논란 사실관계 총정리 (2026)"(O)

[SEO 구조]
- 첫 문단: 두괄식 — 독자가 가장 궁금한 핵심 답 먼저.
- 본문: h2(##)·h3(###) 구조화, 키워드 자연 반복. 표로 정리하면 좋은 내용은 GFM 표 사용.
- 분량: 공백 포함 1,800~2,200자.
- context: 이 글이 '왜 지금 유용한지/무엇을 답하는지' 1줄(카드 표시용).
- meta description: 검색 스니펫용 한 문장(150자 이내).

[GFM 표 규칙 — 게시 화면 깨짐 방지]
- 표 위·아래에 빈 줄. 헤더행 바로 아래 구분행(|---|---|). 행 사이에 빈 줄 절대 금지. 모든 행 열 수 동일.

[저품질·복제 방지 — 필수]
- 웹에서 찾은 문장을 그대로 옮기지 말고 반드시 '자기 문장'으로 재서술하세요. 직접 인용이 꼭 필요하면 1문장 이내 + 출처 명시로만.
- 제공된 '관련 글'과 핵심 문단·표 구성이 겹치지 않게(겹치면 다른 각도로 접근).
- 키워드 남용 금지: 핵심 키워드는 제목·첫 문단·소제목에 자연스럽게만. 본문에서 기계적으로 반복하거나 키워드를 나열하는 문장 금지.
- 상투 도입·맺음 금지: "오늘은 ~에 대해 알아보겠습니다", "지금까지 ~에 대해 살펴봤습니다" 류 금지.

[YMYL 단정어 금지]
- "무조건, 100%, 반드시 ~됩니다, 절대" 같은 단정 표현 금지 → "일반적으로, ~일 수 있습니다, 공식 확인이 필요합니다"로 완화.
- 세금·건강 등 민감 주제는 기준일·고지문·출처 규칙을 반드시 지킬 것.

[자기검증 — 출력 전 1회]
- h2들이 이 검색어의 '하위 질문'을 빠짐없이 답하는지 스스로 점검하고, 빠진 게 있으면 h2를 보강해 분량 하한을 채우세요. 단, 불필요한 반복(물 타기)으로 늘리지 말 것.

[품질/문체]
- 여러 출처 종합한 '독자적 정리물'. 특정 기사 복붙·요약 금지. 존댓말, 담백·정확, 이모지 남발 금지.
- 글 끝에 기준일·고지문: "본 글은 {오늘 날짜} 기준 정보이며, 요금·일정 등은 변동될 수 있으니 공식 출처를 확인하세요."
- 제공된 '관련 글'이 있으면 본문에 자연스러운 마크다운 링크 1개.`;

// 최근 발행글 컨텍스트(서두·약속어 로테이션용)
const PROMISE_WORDS = ['총정리', '방법', '가이드', '핵심', '정리', '기준', '비교', '완벽', '한눈에', '팁'];
function recentContext(n = 5) {
  if (!fs.existsSync(BLOG)) return { intros: [], usedPromise: [] };
  const posts = [];
  for (const d of fs.readdirSync(BLOG)) {
    const f = path.join(BLOG, d, 'index.md');
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, 'utf8');
    if (/^draft:\s*true/m.test(raw)) continue;
    const title = (raw.match(/^title:\s*"?(.*?)"?\s*$/m) || [])[1] || '';
    const pub = (raw.match(/^pubDate:\s*(.*)$/m) || [])[1] || '';
    const body = raw.split(/^---\s*$/m).slice(2).join('---').split('<!--')[0].trim();
    const firstLine = (body.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('|')) || '').trim();
    posts.push({ title, pub, firstLine });
  }
  posts.sort((a, b) => b.pub.localeCompare(a.pub));
  const recent = posts.slice(0, n);
  return {
    intros: recent.map((p) => p.firstLine.slice(0, 50)).filter(Boolean),
    usedPromise: [...new Set(recent.slice(0, 2).flatMap((p) => PROMISE_WORDS.filter((w) => p.title.includes(w))))],
  };
}

// ── v2.7 계급별 생성 규격(🔬 과학·생활원리 / 💪 건강·영양·헬스) ──
// 도그마: 원리를 설명하고, 돈이 드는 실생활 판단(선택·비용·시기)으로 연결. 단순 나열·추천 금지.
function tierGuide(opts) {
  const src = opts && opts.source;
  if (src === 'science') {
    const life = opts.angle !== 'knowledge'; // life=생활원리형(가전 요금/선택), knowledge=자연·과학 원리
    return (
      `\n\n[🔬 과학·생활원리 — 이 구조를 반드시 따르세요]\n` +
      `- 구성: ① 현상/질문(왜 이런가 · 무엇을 골라야 하나) → ② 원리(작동 방식을 '비유 1개'로 반드시 쉽게 설명) ` +
      `→ ③ 실생활 판단(비교·비용·시기를 담은 GFM 표 1개 필수) → ④ 자주 묻는 질문(FAQ) 3개.\n` +
      (life
        ? `- 이 주제는 '생활원리형'입니다: 가전의 작동 원리를 설명한 뒤 전기요금(누진구간 포함)·선택·사용 시기의 '돈이 드는 판단'으로 연결하세요. 판단 표는 요금/비용 비교로.\n`
        : `- 이 주제는 '자연·과학 원리형'입니다: 현상의 원리를 비유로 풀고, 관측·대비·준비의 실용 판단(시기·장소·장비 선택)으로 연결하세요.\n`) +
      `- 콘텐츠 도그마: 단순 나열·추천이 아니라 '이해 → 판단' 구조. 원리 없이 결론만 나열하지 마세요.\n` +
      `- 분량(위 SEO 구조의 분량 규칙을 이 값으로 대체): 공백 포함 2,500~3,500자.\n` +
      `- 출처: 공식·학술 우선(기상청·한국천문연구원·한국에너지공단·식약처 등). 요금·수치는 기준일을 병기하세요.`
    );
  }
  if (src === 'finance' || src === 'realestate') {
    const label = src === 'finance' ? '💰 금융·재테크·세금' : '🏠 대출·부동산';
    const sources = src === 'finance'
      ? '국세청·기획재정부·금융위원회·금융감독원·국민연금공단·금융투자협회'
      : '국토교통부·주택도시기금·한국주택금융공사(HF)·HUG·국세청·금융위원회';
    return (
      `\n\n[${label} — 이 구조를 반드시 따르세요]\n` +
      `- 구성: ① 현상/질문(무엇을 골라야 하나·언제·얼마) → ② 원리(제도·상품 작동 방식을 '비유 1개'로 쉽게) ` +
      `→ ③ 실생활 판단(조건·비용/세율·시기를 담은 GFM 표 1개 필수) → ④ 자주 묻는 질문(FAQ) 3개.\n` +
      `- 콘텐츠 도그마: 단순 나열·추천이 아니라 '제도 원리 이해 → 돈이 드는 판단(선택·비용·시기)'.\n` +
      `- 분량(위 SEO 분량 규칙 대체): 공백 포함 2,500~3,500자.\n` +
      `\n[YMYL 강화 — 금융/부동산 계급 필수(어기면 riskNotes에 명시)]\n` +
      `- 금지: 특정 종목·상품·지역·매물·금융사(은행·증권사) 매수/가입 권유, 수익률·시세 전망 단정("무조건 오른다/이득/손해 없음"), 원금 보장 표현.\n` +
      `- 투자 관련 내용은 '원금 손실 가능성'을 함께 안내. 세율·한도·소득기준·금리·조건은 반드시 기준일(오늘 날짜)을 병기하고 "정책·요율은 변동되니 공식 확인" 문구.\n` +
      `- 공식·공신력 있는 출처를 본문에 2개 이상 명시(${sources})하고 기준일 병기.\n` +
      `- 글 하단 면책 문구 필수: "이 글은 일반적인 정보이며 투자·세무·법률 자문이 아닙니다. 개별 상황은 세무사·금융전문가 등과 상담하세요."`
    );
  }
  if (src === 'health') {
    return (
      `\n\n[💪 건강·영양·헬스 — 이 구조를 반드시 따르세요]\n` +
      `- 구성: ① 현상/질문 → ② 원리(작동 방식을 '비유 1개'로 반드시 쉽게) → ③ 실생활 판단(비교·비용·시기를 담은 GFM 표 1개 필수) → ④ 자주 묻는 질문(FAQ) 3개.\n` +
      `- 콘텐츠 도그마: 단순 나열·추천이 아니라 '원리 이해 → 돈이 드는 판단(선택·비용·시기)'으로 연결.\n` +
      `- 분량(위 SEO 구조의 분량 규칙을 이 값으로 대체): 공백 포함 2,500~3,500자.\n` +
      `\n[YMYL 강화 — 건강 계급 필수(어기면 riskNotes에 명시)]\n` +
      `- 금지: 진단·치료 조언, 효능 단정('~에 좋습니다/낫습니다/효과가 있습니다' 류), 특정 제품·병원 추천, 용량(복용량) 처방.\n` +
      `- 연구·수치 인용은 절제된 표현으로: '~와 연관이 보고되었습니다', '연구에 따르면 ~인 경향이 있습니다'. 단정하지 마세요.\n` +
      `- 공식·학술 기관 출처를 본문에 2개 이상 명시(식약처·질병관리청·국민건강보험공단·대한의학회 등)하고 기준일을 병기.\n` +
      `- 건강기능식품·의료 광고 관련 표현은 식약처 표시·광고 기준을 준수하는 절제된 톤(과장·오인 유발 금지).\n` +
      `- 글 하단에 면책 문구 필수: "이 글은 일반적인 정보이며 의학적 조언이 아닙니다. 증상·복용은 의사·약사와 상담하세요."`
    );
  }
  return '';
}

function task(keyword, opts, ctx) {
  const { related, hints, recent } = ctx || {};
  const hintTxt =
    hints && hints.length
      ? `\n검색량 높은 조합(제목 앞부분에 활용): ${hints.map((h) => `${h.k}(${h.vol.toLocaleString('en-US')})`).join(', ')}`
      : '';
  let rot = '';
  if (recent && recent.intros.length)
    rot += `\n최근 발행 도입부(아래와 겹치지 않는 '다른 방식'으로 시작 — 질문형/상황형/숫자형/뉴스형 중 최근에 안 쓴 것):\n` +
      recent.intros.map((s) => `  · ${s}…`).join('\n');
  if (recent && recent.usedPromise.length)
    rot += `\n최근 제목이 쓴 약속어(연속 사용 금지): ${recent.usedPromise.join(', ')} → 이번엔 다른 약속어(가이드/기준/비교 등) 또는 약속어 없이.`;
  return (
    `키워드: ${keyword}\n오늘 날짜: ${kstDate()}` + hintTxt + rot + '\n' +
    (related ? `관련 글(본문에 링크 1개로 자연스럽게): [${related.title}](${related.url})\n` : '') +
    (opts.gossip ? `주의: 연예/가십성일 수 있음 — 정보성으로 우회하고 안전규칙 특히 엄수.\n` : '') +
    tierGuide(opts)
  );
}

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'context', 'description', 'tags', 'body', 'riskNotes'],
  properties: {
    title: { type: 'string' },
    context: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    body: { type: 'string' },
    riskNotes: { type: 'string' },
  },
};
const CLI_JSON_TEMPLATE =
  '{"title":"...","context":"왜 지금 유용한지 1줄","description":"...","tags":["..."],"body":"...(마크다운 본문, frontmatter 제외)","riskNotes":"..."}';

function parseDraftJSON(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('JSON 없음');
  const o = JSON.parse(t.slice(s, e + 1));
  for (const k of ['title', 'description', 'body']) if (!o[k]) throw new Error('필드 누락: ' + k);
  o.tags = Array.isArray(o.tags) ? o.tags : [];
  o.riskNotes = o.riskNotes || '';
  o.context = o.context || '';
  return o;
}

// ── 제목 엔진: 보조어 조합의 검색량 비교(최다 조합 채택 힌트) ──
async function titleHints(keyword) {
  try {
    const { enrichKeywords } = await import('./lib/naver.mjs');
    const helpers = ['총정리', '근황', '이유', '논란', '방법', '일정', '뜻', '조회', '후기', '가격'];
    const combos = helpers.map((h) => `${keyword} ${h}`);
    const stats = await enrichKeywords([keyword, ...combos]);
    return [keyword, ...combos]
      .map((k) => ({ k, vol: stats[k]?.vol ?? 0, lt: stats[k]?.volLt }))
      .filter((x) => x.vol > 0 && !x.lt)
      .sort((a, b) => b.vol - a.vol)
      .slice(0, 3);
  } catch {
    return [];
  }
}

// ── 카드 메타: 목차·표/목록·표 문법 검증 ──
const extractToc = (body) => [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 8);
function bodyFeatures(body) {
  const hasTable = /^\s*\|.*\|\s*$/m.test(body) && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/m.test(body);
  const hasList = /^\s*(?:[-*]|\d+\.)\s+/m.test(body);
  return { hasTable, hasList };
}
function validateTables(body) {
  const L = body.split('\n');
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-') && l.includes('|');
  const ncols = (l) => l.trim().replace(/^\||\|$/g, '').split('|').length;
  const issues = [];
  for (let i = 0; i < L.length - 1; i++) {
    if (isRow(L[i]) && isSep(L[i + 1])) {
      if (ncols(L[i]) !== ncols(L[i + 1])) issues.push('헤더-구분행 열 수 불일치');
      if (i > 0 && L[i - 1].trim() !== '' && !isRow(L[i - 1])) issues.push('표 위 빈 줄 필요');
      for (let j = i + 2; j < L.length; j++) {
        if (L[j].trim() === '') { if (isRow(L[j + 1] || '')) issues.push('표 행 사이 빈 줄(렌더 깨짐)'); break; }
        if (!isRow(L[j])) break;
        if (ncols(L[j]) !== ncols(L[i])) issues.push('데이터행 열 수 불일치');
      }
    }
  }
  return [...new Set(issues)];
}

// ── 엔진 1: Claude Code 헤드리스(구독) — 구분형 오류(kind) ──
function classifyCli(s) {
  s = (s || '').toLowerCase();
  if (/limit|quota|too many|rate.?limit|usage|reset|429|5.?hour|exceed|cap reached/.test(s)) return 'limit';
  if (/auth|unauthor|401|403|\blogin\b|credential|keychain|oauth|token|not.?allowed|expired|forbidden/.test(s)) return 'auth';
  return 'error';
}
async function viaCLI(keyword, opts, ctx, config) {
  const prompt =
    RULES + '\n\n' + task(keyword, opts, ctx) +
    '\n\n반드시 아래 형태의 JSON 객체 하나만 출력하세요(코드펜스·다른 설명 금지):\n' + CLI_JSON_TEMPLATE;
  const args = ['-p', prompt, '--output-format', 'json', '--allowedTools', 'WebSearch'];
  if (config.cliModel) args.push('--model', config.cliModel);
  let stdout;
  try {
    ({ stdout } = await execFileP('claude', args, {
      cwd: os.tmpdir(),
      maxBuffer: 20 * 1024 * 1024,
      timeout: (config.cliTimeoutSeconds || 240) * 1000,
      env: subscriptionEnv(),
    }));
  } catch (e) {
    const detail = ((e.stderr || '') + ' ' + (e.message || '')).trim();
    const kind = classifyCli(detail);
    console.error(`[claude-cli] 실패(${kind}):`, detail.slice(0, 400)); // stderr 로깅(사후 진단용)
    throw Object.assign(new Error('claude 실행 실패: ' + detail.slice(0, 120)), { kind });
  }
  let j;
  try { j = JSON.parse(stdout); } catch { throw Object.assign(new Error('claude 출력 파싱 실패'), { kind: 'error' }); }
  if (j.is_error || !j.result) {
    const detail = (j.subtype || '') + ' ' + (j.result || '');
    const kind = classifyCli(detail);
    console.error(`[claude-cli] is_error(${kind}):`, detail.slice(0, 300));
    throw Object.assign(new Error('claude 실패: ' + (j.subtype || 'unknown')), { kind });
  }
  return { draft: parseDraftJSON(j.result), costUsd: j.total_cost_usd || 0, engine: 'claude-cli', subscription: true };
}

// ── 엔진 2: Anthropic API(폴백/직접) ───────────────────────
function apiCost(u, p) {
  return (
    ((u.input_tokens || 0) * p.inputPerM +
      (u.cache_creation_input_tokens || 0) * p.inputPerM * p.cacheWriteMult +
      (u.cache_read_input_tokens || 0) * p.inputPerM * p.cacheReadMult +
      (u.output_tokens || 0) * p.outputPerM) / 1e6
  );
}
async function viaAPI(keyword, opts, ctx, config) {
  requireSecrets(['ANTHROPIC_API_KEY']);
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: config.model,
    max_tokens: 4000,
    system: [{ type: 'text', text: RULES, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: task(keyword, opts, ctx) }],
    output_config: { format: { type: 'json_schema', schema: JSON_SCHEMA } },
  });
  if (resp.stop_reason === 'refusal') throw Object.assign(new Error('API 안전 거절'), { refusal: true });
  const txt = (resp.content.find((b) => b.type === 'text') || {}).text || '';
  return { draft: parseDraftJSON(txt), costUsd: apiCost(resp.usage || {}, config.pricing), usage: resp.usage, engine: 'anthropic-api', subscription: false };
}

// ── 상태 파일 헬퍼 ──
function mapUpsert(file, keyFn, entry) {
  const f = path.join(STATE, file);
  let map = {};
  try { map = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  let id, i = 0;
  do { id = keyFn(i); i++; } while (map[id]);
  map[id] = entry;
  fs.writeFileSync(f, JSON.stringify(map, null, 1));
  return id;
}
const saveDraft = (slug, title, keyword) => mapUpsert('drafts.json', (i) => 'd' + Math.abs(hash(slug + '#' + i)).toString(36), { slug, title, keyword: keyword || '' });
const saveRetryKw = (item) =>
  mapUpsert('kwmap.json', (i) => 'k' + Math.abs(hash(item.keyword + '#r' + i)).toString(36), {
    keyword: item.keyword, source: item.source || 'manual', gossip: !!item.gossip,
  });

// 구분형 실패 메시지 + [🔄재시도] 버튼(반려는 재시도 무의미 → 버튼 없음)
export async function sendFailure(chatId, item, r) {
  if (!chatId) return;
  const kw = item.keyword;
  if (r.reason === 'refusal') return void (await sendMessage(chatId, `⛔ "${kw}" 안전상 생성 거절(재시도해도 동일).`));
  const head =
    r.reason === 'limit' ? `⏳ 구독 한도 — 리셋 후 재시도\n🔑 "${kw}"`
    : r.reason === 'auth' ? `🔐 인증 오류 — 점검 필요 (claude 로그인/키체인)\n🔑 "${kw}"\n${(r.message || '').slice(0, 100)}`
    : `❌ "${kw}" 생성 실패: ${(r.message || '').slice(0, 120)}`;
  const id = saveRetryKw(item);
  await sendMessage(chatId, head, inlineButtons([[{ text: '🔄 재시도', callback_data: 'gen:' + id }]]));
}

// ── 초안 1편 생성(엔진 선택 + 폴백 + 파일 + 카드 + 비용로그) ──
// return: { ok, slug } | { ok:false, reason:'limit'|'auth'|'refusal'|'error', message }
export async function generateOne(keyword, opts, config, chatId) {
  config = config || loadConfig();
  opts = opts || {};
  fs.mkdirSync(STATE, { recursive: true });
  const ctx = { related: existingMatch(keyword), hints: await titleHints(keyword), recent: recentContext() };

  let res;
  try {
    if (config.engine === 'anthropic-api') {
      res = await viaAPI(keyword, opts, ctx, config);
    } else {
      try {
        res = await viaCLI(keyword, opts, ctx, config);
      } catch (e) {
        if (process.env.ANTHROPIC_API_KEY) {
          if (chatId) await sendMessage(chatId, `↪️ "${keyword}" 구독 생성 실패(${e.kind || 'error'}) → API 폴백`);
          res = await viaAPI(keyword, opts, ctx, config);
        } else {
          return { ok: false, reason: e.kind || 'error', message: e.message };
        }
      }
    }
  } catch (e) {
    return { ok: false, reason: e.refusal ? 'refusal' : e.kind || 'error', message: e.message };
  }

  const d = res.draft;
  // D-5 얇음 방지: 계급별 분량 하한의 90% 미만이면 claude-cli 로 1회 보강
  const tierMin = (config.charMinByTier && config.charMinByTier[opts.source]) || config.charTarget?.min || 1800;
  if (res.engine === 'claude-cli' && d.body.length < tierMin * 0.9) {
    try {
      const bp =
        `아래 블로그 본문이 짧습니다(현재 약 ${d.body.length}자, 목표 공백포함 ${tierMin}자 이상). ` +
        `h2별 '하위 질문'을 빠짐없이 답하도록 실질 정보를 보강·확장하세요. 기존 내용·구조·표·링크·문체는 유지하고 ` +
        `불필요한 반복(물 타기) 없이. frontmatter·코드펜스·설명 없이 수정된 전체 본문 마크다운만 출력.\n\n[현재 본문]\n${d.body}`;
      const ba = ['-p', bp, '--output-format', 'json', '--allowedTools', 'WebSearch'];
      if (config.cliModel) ba.push('--model', config.cliModel);
      const { stdout } = await execFileP('claude', ba, { cwd: os.tmpdir(), maxBuffer: 20 * 1024 * 1024, timeout: (config.cliTimeoutSeconds || 240) * 1000, env: subscriptionEnv() });
      const bj = JSON.parse(stdout);
      if (!bj.is_error && bj.result) {
        const nb = bj.result.trim().replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/, '').trim();
        if (nb.length > d.body.length) { d.body = nb; res.costUsd = (res.costUsd || 0) + (bj.total_cost_usd || 0); }
      }
    } catch { /* 보강 실패 시 원본 유지 */ }
  }

  // ── v2.7 YMYL 가드(💪 건강 계급): 면책 문구 주입 + 단정어/효능 단정 린트 ──
  if (opts.source === 'health') {
    if (!/의학적 조언이 아닙니다/.test(d.body)) {
      d.body =
        d.body.trimEnd() +
        '\n\n> 이 글은 일반적인 정보이며 의학적 조언이 아닙니다. 증상·복용은 의사·약사와 상담하세요.';
    }
    const banned = d.body.match(/에 좋습니다|에 좋아요|낫습니다|효과가 있습니다|효과가 좋습니다|완치|만병통치|무조건|100% ?(?:효과|완치)/g);
    if (banned && banned.length) {
      const uniq = [...new Set(banned)].join(', ');
      d.riskNotes =
        (d.riskNotes && !/없음|없습니다/.test(d.riskNotes) ? d.riskNotes + ' / ' : '') +
        `⚠️ YMYL 단정어 의심(${uniq}) — 절제 표현으로 검수 필요`;
    }
  }

  // ── v2.7 YMYL 가드(💰 금융·🏠 부동산): 면책 주입 + 투자 단정어 린트 ──
  if (opts.source === 'finance' || opts.source === 'realestate') {
    if (!/자문이 아닙니다/.test(d.body)) {
      d.body =
        d.body.trimEnd() +
        '\n\n> 이 글은 일반적인 정보이며 투자·세무·법률 자문이 아닙니다. 개별 상황은 세무사·금융전문가 등과 상담하세요.';
    }
    const banned = d.body.match(/무조건|반드시 (?:오릅|이득|수익|벌)|원금 ?보장|손해( 볼 일)? ?없|수익률?[을이]? ?보장|대박|급등 ?확실|100% ?수익/g);
    if (banned && banned.length) {
      const uniq = [...new Set(banned)].join(', ');
      d.riskNotes =
        (d.riskNotes && !/없음|없습니다/.test(d.riskNotes) ? d.riskNotes + ' / ' : '') +
        `⚠️ 금융 YMYL 단정어 의심(${uniq}) — 절제·원금손실 고지 검수 필요`;
    }
  }

  const slug = uniqueSlug(slugify(d.title));
  const dir = path.join(BLOG, slug);
  fs.mkdirSync(dir, { recursive: true });
  const tags = (d.tags || []).slice(0, 5);
  // 🅿️ v2.8 [변경6]: M1 '○○ 주차요금' 이고 시설 JSON 있으면 계산기 자동 부착.
  //    현재 잠실만 JSON 이나 잠실은 확장 제외 → 당분간 미발동(킨텍스 등 JSON 추가 시 발동).
  let parkingCalcLine = '';
  try {
    const { m1Facility } = await import('./lib/parking.mjs');
    const facility = m1Facility(keyword);
    if (facility) {
      const pdir = path.join(ROOT, 'src', 'data', 'parking');
      const has = fs.existsSync(pdir) && fs.readdirSync(pdir).some((fn) => {
        if (!fn.endsWith('.json')) return false;
        try { return JSON.parse(fs.readFileSync(path.join(pdir, fn), 'utf8')).facility === facility; } catch { return false; }
      });
      if (has) parkingCalcLine = `parkingCalc: ${dq(facility)}\n`;
    }
  } catch (e) { console.error('[generate] parkingCalc 판정 실패:', e.message); }
  const fm =
    '---\n' +
    `title: ${dq(d.title)}\n` +
    `description: ${dq(d.description)}\n` +
    `pubDate: ${kstNow()}\n` +
    `category: info\n` +
    (tags.length ? `tags: [${tags.map(dq).join(', ')}]\n` : '') +
    parkingCalcLine +
    `draft: true\n---\n\n`;
  const riskComment = `\n\n<!-- ⚠️ [사람 검수 필요] 발행 전 확인\n엔진: ${res.engine}\n${(d.riskNotes || '특이사항 없음').trim()}\n-->\n`;
  fs.writeFileSync(path.join(dir, 'index.md'), fm + d.body.trim() + riskComment);

  // 비용 로그
  const costLine = res.subscription
    ? `구독 포함(추가 청구 0) · 환산 $${Number(res.costUsd).toFixed(4)}`
    : `$${Number(res.costUsd).toFixed(4)}`;
  fs.appendFileSync(
    path.join(STATE, 'cost-log.jsonl'),
    JSON.stringify({
      ts: kstNow(), slug, keyword, engine: res.engine, subscription: res.subscription,
      model: res.subscription ? config.cliModel || 'default' : config.model,
      usd: +Number(res.costUsd).toFixed(5),
      note: res.subscription ? '구독 포함(추가 청구 0)' : 'API 실비', usage: res.usage,
    }) + '\n'
  );
  console.log(`[cost] ${slug} (${res.engine}): ${costLine}`);

  // 텔레그램 초안 카드
  if (chatId) {
    await sendDraftCard(chatId, slug, d.title, { context: d.context, keyword, riskNotes: d.riskNotes, costLine });
  }
  fs.writeFileSync(path.join(STATE, 'last-run.json'), JSON.stringify({ ts: Date.now() }));
  return { ok: true, slug };
}

// 초안 카드 전송(생성·수정 공용). 본문은 파일에서 읽어 목차·표·배지 계산.
export async function sendDraftCard(chatId, slug, title, opts = {}) {
  if (!chatId) return;
  const f = path.join(BLOG, slug, 'index.md');
  const raw = fs.readFileSync(f, 'utf8');
  const body = raw.split(/^---\s*$/m).slice(2).join('---').split('<!--')[0];
  const id = saveDraft(slug, title, opts.keyword);
  const toc = extractToc(body);
  const feats = bodyFeatures(body);
  const tissues = feats.hasTable ? validateTables(body) : [];
  const badge = hasExistingPost(opts.keyword || title);
  const richLine = [feats.hasTable ? '표 포함' : '', feats.hasList ? '목록 포함' : ''].filter(Boolean).join(' · ');
  const rn = opts.riskNotes;
  const msg =
    `📝 ${title}\n` +
    (opts.context ? `🧭 ${opts.context}\n` : '') +
    (opts.keyword ? `🔑 ${opts.keyword}\n` : '') +
    (badge ? `📂 유사 발행글 보유: "${badge.title}"\n   → 새로 만들지 말고 그 글 '갱신'을 지시하세요\n` : '') +
    (toc.length ? `📑 목차: ${toc.join(' · ')}\n` : '') +
    (richLine ? `🧩 ${richLine}\n` : '') +
    (tissues.length ? `⚠️ 표 문법 점검: ${tissues.join(', ')}\n` : '') +
    (rn && !/없음|없습니다/.test(rn) ? `⚠️ 검수: ${rn.slice(0, 180)}\n` : '') +
    (opts.note ? `${opts.note}\n` : '') +
    (opts.costLine ? `💰 ${opts.costLine}\n` : '') +
    `\n승인하면 게시됩니다. (수정은 발행 전에만)`;
  await sendMessage(chatId, msg, inlineButtons([[
    { text: '📖 전문', callback_data: 'view:' + id },
    { text: '✏️ 수정', callback_data: 'edit:' + id },
    { text: '✅ 승인', callback_data: 'ok:' + id },
    { text: '❌ 반려', callback_data: 'no:' + id },
  ]]));
}

// 초안 수정(발행 전만). instruction '제목:'→제목·슬러그 교체 / 그 외→claude-cli 부분수정.
export async function editDraft(slug, instruction, config, chatId) {
  config = config || loadConfig();
  const f = path.join(BLOG, slug, 'index.md');
  if (!fs.existsSync(f)) return { ok: false, error: '초안 없음' };
  const raw = fs.readFileSync(f, 'utf8');
  if (!/^draft:\s*true/m.test(raw)) return { ok: false, error: 'published' }; // 발행글 차단

  const m = raw.match(/^(---[\s\S]*?---\n+)([\s\S]*)$/);
  const fm = m[1];
  const rest = m[2];
  const riskIdx = rest.indexOf('<!--');
  const body = (riskIdx >= 0 ? rest.slice(0, riskIdx) : rest).trim();
  const riskComment = riskIdx >= 0 ? rest.slice(riskIdx) : '';

  // 백업(state, git 밖)
  const bakDir = path.join(STATE, 'backups');
  fs.mkdirSync(bakDir, { recursive: true });
  fs.writeFileSync(path.join(bakDir, slug + '.' + Date.now() + '.bak'), raw);

  // (a) 제목 교체 → 제목·슬러그(발행 전이므로) 변경
  const t = instruction.trim();
  if (/^제목\s*[:：]/.test(t)) {
    const newTitle = t.replace(/^제목\s*[:：]\s*/, '').trim();
    if (!newTitle) return { ok: false, error: '새 제목이 비어 있습니다' };
    const nfm = fm.replace(/^title:\s*.*$/m, `title: ${dq(newTitle)}`);
    fs.writeFileSync(f, nfm + rest);
    let finalSlug = slug;
    const newSlug = uniqueSlug(slugify(newTitle));
    if (newSlug !== slug) {
      fs.renameSync(path.join(BLOG, slug), path.join(BLOG, newSlug));
      finalSlug = newSlug;
    }
    if (chatId) await sendDraftCard(chatId, finalSlug, newTitle, { note: '✏️ 제목·주소 교체됨' });
    return { ok: true, slug: finalSlug, kind: 'title' };
  }

  // (b) AI 부분 수정(claude-cli 구독)
  const prompt =
    `아래는 발행 전 블로그 초안의 본문 마크다운입니다. 다음 '수정 지시'대로 지정된 부분만 고치고, ` +
    `나머지 본문은 한 글자도 바꾸지 마세요. GFM 표·목록 구조는 그대로 유지하세요. ` +
    `frontmatter·코드펜스·설명 없이 '수정된 전체 본문 마크다운'만 출력하세요.\n\n` +
    `[수정 지시]\n${instruction}\n\n[현재 본문]\n${body}`;
  const args = ['-p', prompt, '--output-format', 'json', '--allowedTools', 'WebSearch'];
  if (config.cliModel) args.push('--model', config.cliModel);
  let newBody, costUsd = 0;
  try {
    const { stdout } = await execFileP('claude', args, {
      cwd: os.tmpdir(), maxBuffer: 20 * 1024 * 1024, timeout: (config.cliTimeoutSeconds || 240) * 1000, env: subscriptionEnv(),
    });
    const j = JSON.parse(stdout);
    if (j.is_error || !j.result) throw new Error(j.subtype || 'claude 실패');
    newBody = j.result.trim().replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/, '').trim();
    costUsd = j.total_cost_usd || 0;
  } catch (e) {
    return { ok: false, error: 'AI 수정 실패: ' + ((e.stderr || e.message || '') + '').slice(0, 120) };
  }
  if (!newBody || newBody.length < 50) return { ok: false, error: 'AI 수정 결과가 비었습니다(원본 유지).' };

  // 안전: 길이 급변 감지(지시 범위 이탈 의심)
  const oldLen = body.length, newLen = newBody.length;
  const ratio = Math.abs(newLen - oldLen) / oldLen;
  const bigChange = ratio > 0.4;

  fs.writeFileSync(f, fm + newBody + (riskComment ? '\n\n' + riskComment : '\n'));
  fs.appendFileSync(
    path.join(STATE, 'cost-log.jsonl'),
    JSON.stringify({ ts: kstNow(), slug, action: 'edit', engine: 'claude-cli', subscription: true, usd: +Number(costUsd).toFixed(5), note: '구독 포함(추가 청구 0)' }) + '\n'
  );

  const title = (fm.match(/^title:\s*"?(.*?)"?\s*$/m) || [])[1] || slug;
  if (chatId) {
    if (bigChange)
      await sendMessage(chatId, `⚠️ 수정 후 길이가 크게 변했습니다(${oldLen}→${newLen}자, ${Math.round(ratio * 100)}%). 지시 범위를 벗어났을 수 있으니 [전문]으로 꼭 확인하세요. (원본 백업됨: state/backups/)`);
    await sendDraftCard(chatId, slug, title, {
      costLine: `구독 포함(추가 청구 0) · 환산 $${Number(costUsd).toFixed(4)}`,
      note: bigChange ? '⚠️ 큰 변경 감지 — 확인 요망' : '✏️ 부분 수정됨',
    });
  }
  return { ok: true, slug, kind: 'ai', bigChange };
}

// ── 📂 갱신(축2 [4]): 발행글을 '갱신 표준'으로 제자리 최신화. 백업 후 본문 교체(주소·draft:false 유지). ──
// 커밋(=발행 반영)은 하지 않음 — bot 이 승인 카드([✅갱신 반영]) 받은 뒤에만 커밋. 취소 시 백업 복원.
export async function refreshPublished(slug, config, chatId) {
  config = config || loadConfig();
  const f = path.join(BLOG, slug, 'index.md');
  if (!fs.existsSync(f)) return { ok: false, error: '발행글 없음: ' + slug };
  const raw = fs.readFileSync(f, 'utf8');
  if (/^draft:\s*true/m.test(raw)) return { ok: false, error: '이 글은 아직 발행 전(초안)입니다 — /draft 흐름으로.' };

  const m = raw.match(/^(---[\s\S]*?---\n+)([\s\S]*)$/);
  const fm = m[1], rest = m[2];
  const riskIdx = rest.indexOf('<!--');
  const body = (riskIdx >= 0 ? rest.slice(0, riskIdx) : rest).trim();
  const tail = riskIdx >= 0 ? rest.slice(riskIdx) : '';
  const title = (fm.match(/^title:\s*"?(.*?)"?\s*$/m) || [])[1] || slug;

  // 백업(state, git 밖)
  const bakDir = path.join(STATE, 'backups');
  fs.mkdirSync(bakDir, { recursive: true });
  const backup = path.join(bakDir, slug + '.update.' + Date.now() + '.bak');
  fs.writeFileSync(backup, raw);

  const prompt =
    `아래는 이미 발행된 한국어 블로그 글의 본문입니다. '갱신 표준'에 따라 낡은 부분만 최신화하세요.\n\n` +
    `[갱신 표준(1차 스프린트 표준 준수)]\n` +
    `- 주소(URL)·제목의 핵심 키워드는 유지. 구조(h2/h3·표·내부링크)는 보존하고 낡은 내용만 교체.\n` +
    `- 낡은 연도·수치·일정·제도를 오늘(${kstDate()}) 기준으로 갱신. 확인 불가한 수치는 단정하지 말고 '공식 출처 확인' 안내로.\n` +
    `- 공식·공공기관 출처 우선, 기준일 병기. 종료·변경된 제도는 과거 시제로 표기하고 후속 제도로 안내([D]가드).\n` +
    `- 자주 묻는 질문(FAQ) 2~3개를 신설 또는 보강.\n` +
    `- YMYL(건강·세금) 단정어 금지("무조건/100%/반드시 ~됩니다" → 완화).\n` +
    `frontmatter·코드펜스·설명 없이 '갱신된 전체 본문 마크다운'만 출력.\n\n[현재 본문]\n${body}`;
  const args = ['-p', prompt, '--output-format', 'json', '--allowedTools', 'WebSearch'];
  if (config.cliModel) args.push('--model', config.cliModel);
  let newBody, costUsd = 0;
  try {
    const { stdout } = await execFileP('claude', args, { cwd: os.tmpdir(), maxBuffer: 20 * 1024 * 1024, timeout: (config.cliTimeoutSeconds || 240) * 1000, env: subscriptionEnv() });
    const j = JSON.parse(stdout);
    if (j.is_error || !j.result) throw new Error(j.subtype || 'claude 실패');
    newBody = j.result.trim().replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/, '').trim();
    costUsd = j.total_cost_usd || 0;
  } catch (e) {
    return { ok: false, error: '갱신 생성 실패: ' + ((e.stderr || e.message || '') + '').slice(0, 120), backup };
  }
  if (!newBody || newBody.length < 100) return { ok: false, error: '갱신 결과가 비었습니다(원본 유지).', backup };

  const oldLen = body.length, newLen = newBody.length;
  fs.writeFileSync(f, fm + newBody + (tail ? '\n\n' + tail : '\n'));
  fs.appendFileSync(path.join(STATE, 'cost-log.jsonl'),
    JSON.stringify({ ts: kstNow(), slug, action: 'refresh', engine: 'claude-cli', subscription: true, usd: +Number(costUsd).toFixed(5), note: '구독 포함(추가 청구 0)' }) + '\n');
  return { ok: true, slug, title, backup, oldLen, newLen, costUsd };
}

// ── 일괄/직접 생성(batch 모드) ──
export async function runGenerate({ keyword, chatId, config } = {}) {
  config = config || loadConfig();
  fs.mkdirSync(STATE, { recursive: true });

  let items;
  if (keyword) {
    items = [{ keyword, source: 'manual', gossip: false }];
  } else {
    const sel = await selectKeywords(config);
    items = sel.keywords;
    if (sel.notes.length && chatId) await sendMessage(chatId, '🔎 ' + sel.notes.join('\n'));
  }
  if (!items.length) {
    if (chatId) await sendMessage(chatId, '⚠️ 생성할 키워드가 없습니다.');
    return 0;
  }

  let made = 0;
  for (const it of items) {
    const r = await generateOne(it.keyword, it, config, chatId);
    if (!r.ok) { await sendFailure(chatId, it, r); continue; }
    made++;
  }
  if (chatId && made) await sendMessage(chatId, `✅ 초안 ${made}편 생성. 위에서 승인/반려하세요. 비용은 cost-log.jsonl.`);
  return made;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv } = await import('./lib/env.mjs');
  loadEnv();
  await runGenerate({ chatId: process.env.TELEGRAM_CHAT_ID, config: loadConfig() });
}
