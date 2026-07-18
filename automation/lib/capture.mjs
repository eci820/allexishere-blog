// 📷 현장 캡처 발행 — 주제 파싱 + 초안 생성.
//
// "/<주제> <정보>" + 사진(선택) → 초안(draft:true) → 기존 승인 큐.
// 게시는 여기서 절대 안 한다. 사람이 [✅승인]을 눌러야 publish.mjs 로 간다.
//
// 주제는 하드코딩하지 않는다. CAPTURE_HANDLERS 에 없는 주제는 전부 범용 템플릿으로
// 처리되므로, /맛집 /여행 /카페 /전시 같은 새 주제를 쓰려고 코드를 고칠 필요가 없다.
//
// 사진은 글 폴더 안(src/content/blog/<슬러그>/img_1.jpg)에 저장한다. 기존 546장과 같은
// 방식이고, publish.mjs 가 글 폴더를 통째로 git add 하므로 커밋 코드를 고칠 필요가 없다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, AUTO_DIR } from './env.mjs';
import { sendMessage, inlineButtons } from './telegram.mjs';
import { processPhoto, verifyNoExif, classifyPhotos, triagePhotos, scrubPII, scrubSummary, stagingDir } from './photos.mjs';
import { runClaude, unwrapClaudeJSON } from './claudeCli.mjs';

const BLOG = path.join(ROOT, 'src', 'content', 'blog');
const STATE = path.join(AUTO_DIR, 'state');
const CAPTURES = path.join(STATE, 'captures.json');

// ── 명령 파싱 ────────────────────────────────────────────────────────
// 기존 봇 명령. 이 목록에 있으면 캡처가 아니라 원래 기능으로 간다.
export const RESERVED = new Set(['/start', '/help', '/status', '/brief', '/draft', '/delete']);

// "/주차 코엑스 주차장" → { topic:'주차', info:'코엑스 주차장' }
// 예약어이거나 형식이 아니면 null.
export function parseCapture(text) {
  const t = String(text || '').trim();
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(t);
  if (!m) return null;
  const cmd = '/' + m[1];
  if (RESERVED.has(cmd.toLowerCase())) return null;
  // 텔레그램이 붙이는 @봇이름 접미사 제거
  const topic = m[1].replace(/@\w+$/, '').trim();
  if (!topic) return null;
  return { topic, info: (m[2] || '').trim() };
}

// 오타 가드 — /맛칩 같은 오타가 새 주제 글로 발행되는 걸 막는다.
// 사진도 없고 설명도 5자 미만이면 캡처로 받지 않는다.
export function isTooThin({ info, photoCount }) {
  return photoCount === 0 && info.replace(/\s/g, '').length < 5;
}

// ── 주제별 분기 ──────────────────────────────────────────────────────
// 전용 템플릿이 필요한 주제만 여기 등록. 나머지는 전부 __default__.
const PARKING_TEMPLATE = `이 글은 🅿️ 주차 정보 글입니다. 아래 구조를 따르세요:
- h2 "주차요금" — 기본요금·추가요금·1일 최대·감면 조건을 표(GFM)로. 확인 못 한 항목은 적지 말 것.
- h2 "위치·입구" — 어디로 들어가야 하는지, 헷갈리는 입구가 있으면 명시.
- h2 "근처 대안 주차장" — 만차일 때 갈 곳. 도보 시간·대략 요금.
- h2 "현장 팁" — 실제로 가 본 사람만 아는 것(혼잡 시간대·주차 난이도·정산 방식 등).
⚠️ 제목 규칙(중복 발행 방지 인덱스가 제목 단어로 판정합니다 — 반드시 지킬 것):
   시설명과 '주차'를 **띄어쓴 별개 단어로** 넣으세요. 예: "코엑스 주차 요금·입구 총정리"
   '주차장'·'주차요금'처럼 붙여 쓰면 '주차'로 인식되지 않아 같은 시설 글이 또 생성됩니다.`;

const GENERIC_TEMPLATE = `이 글은 현장에서 직접 보고 온 것을 정리하는 글입니다.
주제에 가장 잘 맞는 구조를 스스로 잡으세요(h2 3~5개). 다음을 지키세요:
- 검색해서 들어온 사람이 가장 궁금해할 것을 맨 앞 h2 로.
- 사실·수치는 내가 준 정보와 사진에서 확인된 것만. 모르면 쓰지 말 것(지어내기 금지).
- 가격·시간·조건처럼 비교할 게 2개 이상이면 표(GFM)로.
- 마지막 h2 는 "자주 묻는 질문"으로 하고 Q/A 2~3개.`;

const CAPTURE_HANDLERS = {
  '주차': { label: '🅿️ 주차', template: PARKING_TEMPLATE },
  __default__: { label: '📷 현장', template: GENERIC_TEMPLATE },
};

export function handlerFor(topic) {
  return CAPTURE_HANDLERS[topic] || CAPTURE_HANDLERS.__default__;
}

// ── 프롬프트 ─────────────────────────────────────────────────────────
function buildPrompt({ topic, info, photos, extracted, template }) {
  const photoLines = photos.length
    ? photos.map((p, i) => `- [[PHOTO_${i + 1}]] : ${p.alt || '(설명 없음)'}${p.kind === 'screen' ? ' (안내판·화면 캡처)' : ''}`).join('\n')
    : '(첨부 사진 없음)';
  const extractedBlock = extracted.length
    ? `\n[사진에서 읽어낸 정보]\n${extracted.map((e) => '- ' + e).join('\n')}\n` +
      '이 정보는 글 작성에만 쓰세요. 원본 이미지는 발행되지 않습니다.\n'
    : '';

  return `당신은 한국어 정보성 블로그의 전문 에디터입니다.
내가 현장에서 직접 보고 보내준 정보로 블로그 글 1편을 씁니다.

[주제] ${topic}
[내가 보낸 정보] ${info || '(설명 없이 사진만 보냄)'}
${extractedBlock}
[첨부 사진 ${photos.length}장]
${photoLines}

${template}

[공통 규칙]
- 한국어. 공백 포함 1,500~2,500자.
- 내가 준 정보와 사진에서 확인되지 않은 사실·수치·날짜는 절대 지어내지 마세요.
  확인 못 한 항목은 아예 쓰지 말고, 꼭 필요하면 "현장 확인 필요"로 남기세요.
- 개인정보(사람 이름·전화번호·카드번호·차량번호·적립번호)는 어떤 경우에도 본문에 쓰지 마세요.
- 사진을 넣을 자리에 [[PHOTO_1]] 같은 표시를 그 줄에 단독으로 적으세요.
  위에 나열된 표시만 쓰고, 각각 최대 1번, 내용과 어울리는 위치에 배치하세요.
  사진이 0장이면 아무 표시도 쓰지 마세요.
- 마크다운. 본문은 h2(##)로 시작(h1 금지).

아래 JSON 객체 하나만 출력하세요(코드펜스·설명 금지):
{"title":"제목(30~45자, 검색어 포함)","description":"요약 한 줄(80~120자)","body":"본문 마크다운","tags":["태그",".."],"riskNotes":"발행 전 사람이 확인해야 할 점(없으면 '없음')"}`;
}

// API 폴백에서 형식을 강제할 스키마(structured outputs). 모든 object 는
// additionalProperties:false + required 가 필요하다.
const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    body: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    riskNotes: { type: 'string' },
  },
  required: ['title', 'description', 'body', 'tags', 'riskNotes'],
  additionalProperties: false,
};

// API 실비 환산(generate.mjs 와 같은 계산식). pricing 없으면 0.
function apiCost(u, p) {
  if (!p) return 0;
  return (
    ((u.input_tokens || 0) * p.inputPerM +
      (u.cache_creation_input_tokens || 0) * p.inputPerM * p.cacheWriteMult +
      (u.cache_read_input_tokens || 0) * p.inputPerM * p.cacheReadMult +
      (u.output_tokens || 0) * p.outputPerM) / 1e6
  );
}

function parseDraftJSON(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('초안 JSON 을 찾지 못함');
  const d = JSON.parse(s.slice(start, end + 1));
  if (!d.title || !d.body) throw new Error('초안에 title/body 가 없음');
  return d;
}

// 엔진: claude-cli(구독) → 실패 시 Anthropic API 폴백.
// 프롬프트는 stdin 으로 넘긴다(명령행 인자 아님) — 사진 설명·추출 텍스트에 특수문자·줄바꿈이
// 섞여도 이스케이프 문제가 없고, 실패 메시지에 프롬프트가 통째로 실려나오지 않는다.
// 타임아웃은 captureTimeoutSeconds(기본 600초) — 사진이 붙으면 프롬프트·출력이 길어져
// 일반 초안(240초)보다 오래 걸린다. 240초로는 사진 포함 생성이 SIGTERM 으로 죽었다.
async function runLLM(prompt, config) {
  try {
    const extraArgs = config?.cliModel ? ['--model', config.cliModel] : [];
    const stdout = await runClaude(prompt, {
      cwd: os.tmpdir(),
      timeoutMs: (config?.captureTimeoutSeconds || 600) * 1000,
      extraArgs,
    });
    const { result, costUsd } = unwrapClaudeJSON(stdout);
    return { draft: parseDraftJSON(result), engine: 'claude-cli', costUsd, subscription: true };
  } catch (e1) {
    console.error('[capture] claude-cli 실패:', e1.kind || 'error', '-', e1.message);
    if (!process.env.ANTHROPIC_API_KEY) throw e1;
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    const resp = await client.messages.create({
      model: config?.model || 'claude-sonnet-5',
      // 한국어 2,000자 본문 + JSON 래핑은 토큰을 꽤 먹는다. 낮게 잡으면 본문이
      // 중간에 잘려(stop_reason: max_tokens) 파싱부터 실패한다.
      max_tokens: 16000,
      // 스키마로 형식을 강제 → 프롬프트로만 부탁할 때보다 JSON 파싱 실패가 없다.
      output_config: { format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
      messages: [{ role: 'user', content: prompt }],
    });
    if (resp.stop_reason === 'refusal') {
      throw Object.assign(new Error('API 안전 거절(재시도해도 동일)'), { kind: 'refusal' });
    }
    if (resp.stop_reason === 'max_tokens') {
      throw Object.assign(new Error('본문이 길어 응답이 잘렸습니다(max_tokens)'), { kind: 'error' });
    }
    const txt = (resp.content.find((b) => b.type === 'text') || {}).text || '';
    const usage = resp.usage || {};
    return { draft: parseDraftJSON(txt), engine: 'anthropic-api', costUsd: apiCost(usage, config?.pricing), usage, subscription: false };
  }
}

// ── 파일 헬퍼(generate.mjs 와 같은 규칙) ─────────────────────────────
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

// 🅿️ 자기잠식 방지 점검 — topicsPool.matchLive 와 같은 방식으로 제목을 토큰화한다.
// 발행 후 이 글이 "○○ 주차 종합가이드 있음"으로 인식되려면 제목에 '주차'가
// 독립 단어로 있어야 한다('주차장'·'주차요금'은 다른 토큰이라 인식 안 됨).
export function parkingDedupOk(title) {
  const toks = new Set(
    String(title).replace(/[^가-힣a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2)
  );
  return toks.has('주차');
}

// 🅿️ 제목에 등장하는 시설의 계산기 JSON 이 있으면 parkingCalc 부착(generate.mjs 와 같은 규칙).
export function parkingCalcFor(title) {
  const pdir = path.join(ROOT, 'src', 'data', 'parking');
  if (!fs.existsSync(pdir)) return null;
  for (const fn of fs.readdirSync(pdir)) {
    if (!fn.endsWith('.json')) continue;
    try {
      const facility = JSON.parse(fs.readFileSync(path.join(pdir, fn), 'utf8')).facility;
      if (facility && String(title).includes(facility)) return facility;
    } catch { /* 깨진 JSON 은 건너뜀 */ }
  }
  return null;
}

// [[PHOTO_n]] 표시를 실제 마크다운 이미지로 치환한다.
// LLM 이 안 쓴 사진은 본문 끝에 모아 붙이고, 없는 번호를 부르면 그 줄을 지운다.
export function placePhotos(body, photos) {
  let out = String(body);
  const used = new Set();
  out = out.replace(/\[\[PHOTO_(\d+)\]\]/g, (whole, n) => {
    const idx = Number(n) - 1;
    const p = photos[idx];
    if (!p || used.has(idx)) return ''; // 없는 번호·중복 호출 → 제거
    used.add(idx);
    return `![${p.alt || ''}](./${p.file})`;
  });
  const leftover = photos.filter((_, i) => !used.has(i));
  if (leftover.length) {
    out = out.trimEnd() + '\n\n' + leftover.map((p) => `![${p.alt || ''}](./${p.file})`).join('\n\n');
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function saveCapture(entry) {
  let map = {};
  try { map = JSON.parse(fs.readFileSync(CAPTURES, 'utf8')); } catch {}
  let id, i = 0;
  do { id = 'c' + Math.abs(hash(entry.slug + '#c' + i)).toString(36); i++; } while (map[id]);
  map[id] = { ...entry, ts: Date.now() };
  fs.writeFileSync(CAPTURES, JSON.stringify(map, null, 1));
  return id;
}
export function loadCaptures() {
  try { return JSON.parse(fs.readFileSync(CAPTURES, 'utf8')); } catch { return {}; }
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// ── 메인: 캡처 → 초안 ────────────────────────────────────────────────
// photoBuffers: [{buffer, order}] 내가 보낸 순서대로.
// return { ok:true, slug, captureId } | { ok:false, error }
export async function runCapture({ topic, info, photoBuffers = [], chatId, config }) {
  const handler = handlerFor(topic);
  const stageId = 'k' + Math.abs(hash(topic + info + Date.now())).toString(36);
  const stage = stagingDir(STATE, stageId);
  const notes = []; // 사람에게 보여줄 처리 내역

  // ① 사진 처리 — EXIF 제거·회전 보정·리사이즈·압축
  const staged = [];
  for (let i = 0; i < photoBuffers.length; i++) {
    const name = `p${i + 1}.jpg`;
    try {
      const r = await processPhoto(photoBuffers[i], path.join(stage, name));
      const exif = await verifyNoExif(path.join(stage, name));
      if (!exif.clean) {
        // 여기 오면 안 되지만, 왔다면 그 사진은 쓰지 않는다(위치정보 유출 방지).
        console.error('[capture] EXIF 잔존:', name, exif.found);
        notes.push(`⚠️ ${i + 1}번 사진 메타데이터 제거 실패 — 발행에서 제외`);
        continue;
      }
      staged.push({ name, order: i, ...r });
    } catch (e) {
      notes.push(`⚠️ ${i + 1}번 사진 처리 실패(${e.message.slice(0, 40)}) — 제외`);
    }
  }
  if (staged.length) {
    const kb = staged.map((s) => Math.round(s.bytes / 1024));
    notes.push(`📷 사진 ${staged.length}장 처리 (EXIF 제거 · ${Math.max(...staged.map((s) => s.width))}px · ${Math.min(...kb)}~${Math.max(...kb)}KB)`);
    if (staged.some((s) => s.overTarget)) notes.push('ℹ️ 일부 사진은 200KB를 조금 넘습니다(디테일이 많은 사진)');
  }

  // ② 비전 분류 → 발행/보류/제외
  let triage = { publishable: staged.map((s) => ({ ...s, alt: '', kind: 'scene', extractedText: '' })), held: [], excluded: [] };
  if (staged.length) {
    const { verdicts, engine, error } = await classifyPhotos(stage, staged.map((s) => s.name), config);
    triage = triagePhotos(staged, verdicts);
    if (engine === 'none') notes.push(`⚠️ 사진 분류 실패(${(error || '').slice(0, 40)}) — 안전하게 사진 없이 초안만 만들었습니다`);
  }
  for (const e of triage.excluded) notes.push(`🔒 ${e.order + 1}번 사진 ${e.reason} — 발행 제외(내용만 글에 반영)`);
  for (const h of triage.held) notes.push(`👤 ${h.order + 1}번 사진 ${h.reason} — 보류(아래 버튼으로 포함 가능)`);

  // 제외·보류된 사진에서 읽어낸 정보도 글 작성 입력으로는 쓴다.
  const extracted = [...triage.publishable, ...triage.excluded, ...triage.held]
    .map((p) => p.extractedText).filter((t) => t && t.length > 1);

  // ③ 초안 생성
  const pub = triage.publishable.sort((a, b) => a.order - b.order);
  const prompt = buildPrompt({ topic, info, photos: pub, extracted, template: handler.template });
  let res;
  try {
    res = await runLLM(prompt, config);
  } catch (e) {
    // 사유별로 무엇을 해야 할지 알려준다. 프롬프트 전문을 되뱉지 않는다.
    const hint =
      e.kind === 'timeout' ? '\n사진 장수를 줄이거나 잠시 후 다시 보내보세요.'
      : e.kind === 'limit' ? '\n구독 한도가 리셋된 뒤 다시 보내주세요.'
      : e.kind === 'auth' ? '\nclaude 로그인 상태를 확인해 주세요.'
      : '';
    // 키가 없는 건 고장이 아니라 '구독 전용' 설정이다(API 청구 원천 차단).
    // 고장으로 오해해 키를 다시 넣으면 CLI 인증까지 API 로 넘어가 전체가 유료화된다.
    const fallback = process.env.ANTHROPIC_API_KEY
      ? ''
      : '\n💳 구독 전용 모드라 API 폴백은 꺼져 있습니다(의도된 설정 — 조직 API 청구 0).';
    return { ok: false, error: `초안 생성 실패 — ${e.message}${hint}${fallback}` };
  }
  const d = res.draft;

  // ④ 개인정보 2차 방어 — 본문·제목·요약을 발행 직전에 스크럽
  const sb = scrubPII(d.body);
  const st = scrubPII(d.title);
  const sd = scrubPII(d.description || '');
  d.body = sb.text; d.title = st.text.trim(); d.description = sd.text.trim();
  const removedAll = [...sb.removed, ...st.removed, ...sd.removed].reduce((acc, r) => {
    const hit = acc.find((a) => a.label === r.label);
    hit ? (hit.count += r.count) : acc.push({ ...r });
    return acc;
  }, []);
  const piiLine = scrubSummary(removedAll);
  if (piiLine) notes.push(piiLine);

  // ⑤ 글 폴더 생성 → 사진을 글 폴더 안으로 이동(img_1.jpg …)
  const slug = uniqueSlug(slugify(d.title));
  const dir = path.join(BLOG, slug);
  fs.mkdirSync(dir, { recursive: true });
  pub.forEach((p, i) => {
    p.file = `img_${i + 1}.jpg`;
    fs.copyFileSync(path.join(stage, p.name), path.join(dir, p.file));
  });

  const body = placePhotos(d.body, pub);
  const tags = (d.tags || []).slice(0, 5);
  const calc = topic === '주차' ? parkingCalcFor(d.title) : null;
  const cover = pub[0]?.file;
  const fm =
    '---\n' +
    `title: ${dq(d.title)}\n` +
    `description: ${dq(d.description)}\n` +
    `pubDate: ${kstNow()}\n` +
    `category: info\n` +
    (tags.length ? `tags: [${tags.map(dq).join(', ')}]\n` : '') +
    (cover ? `cover: ${dq('./' + cover)}\ncoverAlt: ${dq(pub[0].alt || d.title)}\n` : '') +
    (calc ? `parkingCalc: ${dq(calc)}\n` : '') +
    `draft: true\n---\n\n`;
  const riskComment =
    `\n\n<!-- ⚠️ [사람 검수 필요] 발행 전 확인\n` +
    `경로: 현장 캡처(/${topic}) · 엔진: ${res.engine}\n` +
    `${(d.riskNotes || '특이사항 없음').trim()}\n` +
    (piiLine ? `${piiLine}\n` : '') +
    `-->\n`;
  fs.writeFileSync(path.join(dir, 'index.md'), fm + body.trim() + riskComment);

  if (calc) notes.push(`🅿️ 주차요금 계산기 자동 부착: ${calc}`);
  if (topic === '주차' && !parkingDedupOk(d.title)) {
    // 제목에 '주차'가 독립 단어로 없으면 발행해도 브리핑이 같은 시설을 또 제안한다.
    notes.push('⚠️ 제목에 \'주차\'가 독립 단어로 없습니다 — 발행해도 자동 브리핑이 같은 시설을 또 제안할 수 있습니다. [✏️수정]으로 제목에 "○○ 주차"를 넣어주세요');
  }

  // ⑥ 보류 사진은 스테이징에 남겨둔다 — [포함하기] 를 누르면 그때 글 폴더로 옮긴다.
  const captureId = saveCapture({
    slug, title: d.title, topic,
    stage: triage.held.length ? stage : null,
    held: triage.held.map((h) => ({ name: h.name, alt: h.alt, reason: h.reason, order: h.order })),
    nextIndex: pub.length + 1,
  });

  // 비용 로그(generate.mjs 와 같은 형식) — 어느 엔진으로 만들었는지 남긴다.
  // 구독으로 돌아야 할 생성이 조용히 API 청구로 새는 걸 사후에 알아채려면 이 기록이 필요하다.
  try {
    fs.appendFileSync(
      path.join(STATE, 'cost-log.jsonl'),
      JSON.stringify({
        ts: kstNow(), slug, keyword: `${topic} ${info}`.trim(), engine: res.engine,
        subscription: res.subscription, model: res.subscription ? (config?.cliModel || 'default') : (config?.model || 'claude-sonnet-5'),
        usd: +Number(res.costUsd || 0).toFixed(5),
        note: res.subscription ? '구독 포함(추가 청구 0)' : '⚠️ API 실비 청구', usage: res.usage,
        path: 'capture',
      }) + '\n'
    );
  } catch (e) { console.error('[capture] 비용 로그 실패:', e.message); }

  // ⑦ 기존 승인 큐로 — 카드·버튼·발행 로직 전부 재사용
  const { sendDraftCard } = await import('../generate.mjs');
  // API 로 넘어간 경우엔 카드에서 바로 보이게 표시한다(구독이 왜 실패했는지 확인하라는 신호).
  const costLine = res.subscription
    ? '구독 포함(추가 청구 0)'
    : `⚠️ API 실비 청구 $${Number(res.costUsd || 0).toFixed(4)} — 구독 실패로 폴백됨`;
  await sendDraftCard(chatId, slug, d.title, {
    context: `${handler.label} 현장 캡처`,
    keyword: `${topic} ${info}`.trim(),
    riskNotes: d.riskNotes,
    costLine,
    note: notes.join('\n'),
  });

  // 보류 사진이 있으면 별도로 물어본다(초상권 — 기본은 제외).
  if (triage.held.length) {
    await sendMessage(
      chatId,
      `👤 보류된 사진 ${triage.held.length}장이 있습니다.\n` +
        triage.held.map((h) => `• ${h.order + 1}번: ${h.reason}`).join('\n') +
        `\n\n기본은 '제외'입니다. 발행에 포함하려면 아래를 누르세요.`,
      inlineButtons([[
        { text: '👤 사진 포함하기', callback_data: 'face:' + captureId },
        { text: '🔒 제외 유지', callback_data: 'cancel:x' },
      ]])
    );
  }

  return { ok: true, slug, captureId };
}

// 보류 사진을 글에 포함시킨다([👤 사진 포함하기] 콜백).
export async function includeHeldPhotos(captureId, chatId) {
  const map = loadCaptures();
  const c = map[captureId];
  if (!c || !c.held?.length || !c.stage) return { ok: false, error: '만료된 요청입니다.' };
  const f = path.join(BLOG, c.slug, 'index.md');
  if (!fs.existsSync(f)) return { ok: false, error: `글이 없습니다: ${c.slug}` };
  const raw = fs.readFileSync(f, 'utf8');
  if (/^draft:\s*false/m.test(raw)) return { ok: false, error: '이미 발행된 글입니다(편집기에서 수정하세요).' };

  const added = [];
  let idx = c.nextIndex || 1;
  for (const h of c.held) {
    const src = path.join(c.stage, h.name);
    if (!fs.existsSync(src)) continue;
    const file = `img_${idx++}.jpg`;
    fs.copyFileSync(src, path.join(BLOG, c.slug, file));
    added.push({ file, alt: h.alt || '' });
  }
  if (!added.length) return { ok: false, error: '보류 사진 파일이 남아있지 않습니다(봇 재시작됨).' };

  // 본문 끝(검수 주석 앞)에 이어 붙인다.
  const cut = raw.indexOf('\n\n<!-- ⚠️ [사람 검수 필요]');
  const bodyPart = cut === -1 ? raw : raw.slice(0, cut);
  const tail = cut === -1 ? '' : raw.slice(cut);
  const imgs = added.map((a) => `![${a.alt}](./${a.file})`).join('\n\n');
  fs.writeFileSync(f, bodyPart.trimEnd() + '\n\n' + imgs + tail);

  map[captureId] = { ...c, held: [], nextIndex: idx };
  fs.writeFileSync(CAPTURES, JSON.stringify(map, null, 1));

  if (chatId) {
    const { sendDraftCard } = await import('../generate.mjs');
    await sendMessage(chatId, `👤 사진 ${added.length}장을 글에 포함했습니다. 다시 확인하세요.`);
    await sendDraftCard(chatId, c.slug, c.title, {
      context: '현장 캡처(보류 사진 포함됨)',
      note: `📷 보류 사진 ${added.length}장 추가됨 — 초상권 확인 후 승인하세요`,
    });
  }
  return { ok: true, added: added.length };
}
