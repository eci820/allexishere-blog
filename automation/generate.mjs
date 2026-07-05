// 초안 생성 엔진 (v2.3).
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

[품질/문체]
- 여러 출처 종합한 '독자적 정리물'. 특정 기사 복붙·요약 금지. 존댓말, 담백·정확, 이모지 남발 금지.
- 글 끝에 기준일·고지문: "본 글은 {오늘 날짜} 기준 정보이며, 요금·일정 등은 변동될 수 있으니 공식 출처를 확인하세요."
- 제공된 '관련 글'이 있으면 본문에 자연스러운 마크다운 링크 1개.`;

function task(keyword, opts, ctx) {
  const { related, hints } = ctx || {};
  const hintTxt =
    hints && hints.length
      ? `\n검색량 높은 조합(제목 앞부분에 활용): ${hints.map((h) => `${h.k}(${h.vol.toLocaleString('en-US')})`).join(', ')}`
      : '';
  return (
    `키워드: ${keyword}\n오늘 날짜: ${kstDate()}` + hintTxt + '\n' +
    (related ? `관련 글(본문에 링크 1개로 자연스럽게): [${related.title}](${related.url})\n` : '') +
    (opts.gossip ? `주의: 연예/가십성일 수 있음 — 정보성으로 우회하고 안전규칙 특히 엄수.\n` : '')
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
      env: { ...process.env },
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
const saveDraft = (slug, title) => mapUpsert('drafts.json', (i) => 'd' + Math.abs(hash(slug + '#' + i)).toString(36), { slug, title });
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
  const ctx = { related: existingMatch(keyword), hints: await titleHints(keyword) };

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
  const slug = uniqueSlug(slugify(d.title));
  const dir = path.join(BLOG, slug);
  fs.mkdirSync(dir, { recursive: true });
  const tags = (d.tags || []).slice(0, 5);
  const fm =
    '---\n' +
    `title: ${dq(d.title)}\n` +
    `description: ${dq(d.description)}\n` +
    `pubDate: ${kstNow()}\n` +
    `category: info\n` +
    (tags.length ? `tags: [${tags.map(dq).join(', ')}]\n` : '') +
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

  // 텔레그램 초안 카드(개선)
  if (chatId) {
    const id = saveDraft(slug, d.title);
    const toc = extractToc(d.body);
    const feats = bodyFeatures(d.body);
    const tissues = feats.hasTable ? validateTables(d.body) : [];
    const badge = hasExistingPost(keyword);
    const richLine = [feats.hasTable ? '표 포함' : '', feats.hasList ? '목록 포함' : ''].filter(Boolean).join(' · ');
    const msg =
      `📝 ${d.title}\n` +
      (d.context ? `🧭 ${d.context}\n` : '') +
      `🔑 ${keyword}\n` +
      (badge ? `📂 유사 발행글 보유: "${badge.title}"\n   → 새로 만들지 말고 그 글 '갱신'을 지시하세요\n` : '') +
      (toc.length ? `📑 목차: ${toc.join(' · ')}\n` : '') +
      (richLine ? `🧩 ${richLine}\n` : '') +
      (tissues.length ? `⚠️ 표 문법 점검: ${tissues.join(', ')}\n` : '') +
      (d.riskNotes && !/없음|없습니다/.test(d.riskNotes) ? `⚠️ 검수: ${d.riskNotes.slice(0, 180)}\n` : '') +
      `💰 ${costLine}\n\n승인하면 게시됩니다.`;
    await sendMessage(chatId, msg, inlineButtons([[
      { text: '📖 전문보기', callback_data: 'view:' + id },
      { text: '✅ 승인', callback_data: 'ok:' + id },
      { text: '❌ 반려', callback_data: 'no:' + id },
    ]]));
  }
  fs.writeFileSync(path.join(STATE, 'last-run.json'), JSON.stringify({ ts: Date.now() }));
  return { ok: true, slug };
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
