// 초안 생성 엔진.
// 엔진 스위치: engine=claude-cli(기본, 구독 헤드리스) | anthropic-api(폴백/직접).
// mode 스위치: briefing(기본, 브리핑→탭 생성) | batch(과거 일괄 생성 보존).
// 게시는 절대 여기서 하지 않음 — 초안(draft:true)만 만들고 텔레그램 승인으로 넘김.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { ROOT, AUTO_DIR, loadConfig, requireSecrets } from './lib/env.mjs';
import { selectKeywords } from './keywords.mjs';
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
  return t
    .trim()
    .replace(/[^0-9A-Za-z가-힣\s-]/g, '') // 한글·영숫자·공백·하이픈만(쉼표·마침표 등 제거)
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}
function uniqueSlug(base) {
  let s = base || '글-' + kstDate();
  let i = 2;
  while (fs.existsSync(path.join(BLOG, s))) s = `${base}-${i++}`;
  return s;
}
const dq = (s) => '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

function relatedLink(keyword) {
  if (!fs.existsSync(BLOG)) return null;
  const words = keyword.replace(/[^가-힣a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
  let best = null;
  for (const d of fs.readdirSync(BLOG)) {
    const f = path.join(BLOG, d, 'index.md');
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, 'utf8');
    if (/^draft:\s*true/m.test(raw)) continue;
    const title = (raw.match(/^title:\s*"?(.*?)"?\s*$/m) || [])[1] || '';
    const orig = (raw.match(/^originalPath:\s*"?(.*?)"?\s*$/m) || [])[1] || '/entry/' + d;
    const score = words.filter((w) => title.includes(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { title, url: orig, score };
  }
  return best;
}

// ── 프롬프트 규칙(엔진 공통) ──────────────────────────────
const RULES = `당신은 한국어 정보성 블로그의 전문 에디터입니다. 주어진 키워드로 검색 유입에 강한 '정보 정리' 글 1편을 작성합니다.

[최우선 안전 규칙 — 실시간 검색어는 실존 인물이 많음]
- 인물의 사망·범죄·열애·결혼·불륜·질병 등 민감/미확인 사실을 절대 단정하지 마세요.
- 루머·추측·'~카더라'·SNS발 미확인 정보 배제. 확인된 공식 보도/공공기관 자료 기반 사실만.
- 필요하면 WebSearch로 사실과 기준일을 확인하세요. 확인 불가한 민감 주제는 정보 위주로 우회하거나 다루지 마세요.
- 특정인 명예를 훼손할 소지가 조금이라도 있으면 riskNotes 에 반드시 명시.

[SEO 구조]
- 제목: 앞부분에 핵심 키워드, 낚시·과장 금지.
- 첫 문단: 두괄식 — 독자가 가장 궁금한 핵심 답 먼저.
- 본문: h2(##)·h3(###) 구조화, 키워드 자연 반복.
- 분량: 공백 포함 1,800~2,200자.
- meta description: 검색 스니펫용 한 문장(150자 이내).

[품질/문체]
- 여러 출처 종합한 '독자적 정리물'. 특정 기사 복붙·요약 금지.
- 존댓말, 담백·정확. 과장·이모지 남발 금지.
- 글 끝에 기준일과 고지문: "본 글은 {오늘 날짜} 기준 정보이며, 요금·일정 등은 변동될 수 있으니 공식 출처를 확인하세요."
- 제공된 '관련 글'이 있으면 본문에 자연스러운 마크다운 링크 1개.`;

function task(keyword, opts, related) {
  return (
    `키워드: ${keyword}\n오늘 날짜: ${kstDate()}\n` +
    (related ? `관련 글(본문에 링크 1개로 자연스럽게): [${related.title}](${related.url})\n` : '') +
    (opts.gossip ? `주의: 연예/가십성일 수 있음 — 정보성으로 우회하고 안전규칙 특히 엄수.\n` : '')
  );
}

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'tags', 'body', 'riskNotes'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    body: { type: 'string' },
    riskNotes: { type: 'string' },
  },
};

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
  return o;
}

// ── 엔진 1: Claude Code 헤드리스(구독) ──────────────────────
async function viaCLI(keyword, opts, related, config) {
  const prompt =
    RULES + '\n\n' + task(keyword, opts, related) +
    '\n\n반드시 아래 형태의 JSON 객체 하나만 출력하세요(코드펜스·다른 설명 금지):\n' +
    '{"title":"...","description":"...","tags":["..."],"body":"...(마크다운 본문, frontmatter 제외)","riskNotes":"..."}';
  const args = ['-p', prompt, '--output-format', 'json', '--allowedTools', 'WebSearch'];
  if (config.cliModel) args.push('--model', config.cliModel);
  const { stdout } = await execFileP('claude', args, {
    cwd: os.tmpdir(), // 프로젝트 CLAUDE.md/MCP 미로딩(단, --bare 미사용 → OAuth 구독 유지)
    maxBuffer: 20 * 1024 * 1024,
    timeout: (config.cliTimeoutSeconds || 240) * 1000,
    env: { ...process.env },
  });
  let j;
  try { j = JSON.parse(stdout); } catch { throw new Error('claude 출력 JSON 파싱 실패'); }
  if (j.is_error || !j.result) throw new Error('claude 실패: ' + (j.subtype || j.result || 'unknown'));
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
async function viaAPI(keyword, opts, related, config) {
  requireSecrets(['ANTHROPIC_API_KEY']);
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: config.model,
    max_tokens: 4000,
    system: [{ type: 'text', text: RULES, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: task(keyword, opts, related) }],
    output_config: { format: { type: 'json_schema', schema: JSON_SCHEMA } },
  });
  if (resp.stop_reason === 'refusal') throw Object.assign(new Error('API 안전 거절'), { refusal: true });
  const txt = (resp.content.find((b) => b.type === 'text') || {}).text || '';
  return { draft: parseDraftJSON(txt), costUsd: apiCost(resp.usage || {}, config.pricing), usage: resp.usage, engine: 'anthropic-api', subscription: false };
}

function saveDraftMapEntry(id, entry) {
  const f = path.join(STATE, 'drafts.json');
  let map = {};
  try { map = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  map[id] = entry;
  fs.writeFileSync(f, JSON.stringify(map, null, 1));
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// ── 초안 1편 생성(엔진 선택 + 폴백 + 파일 + 승인메시지 + 비용로그) ──
// return: { ok, slug } | { ok:false, reason:'limit'|'refusal'|'error', message }
export async function generateOne(keyword, opts, config, chatId) {
  config = config || loadConfig();
  opts = opts || {};
  fs.mkdirSync(STATE, { recursive: true });
  const related = relatedLink(keyword);

  let res;
  try {
    if (config.engine === 'anthropic-api') {
      res = await viaAPI(keyword, opts, related, config);
    } else {
      try {
        res = await viaCLI(keyword, opts, related, config);
      } catch (e) {
        // CLI 실패(한도·오류) → API 키 있으면 폴백, 없으면 재시도 안내
        if (process.env.ANTHROPIC_API_KEY) {
          if (chatId) await sendMessage(chatId, `↪️ "${keyword}" 구독 생성 실패(${e.message.slice(0, 80)}) → API 폴백`);
          res = await viaAPI(keyword, opts, related, config);
        } else {
          return { ok: false, reason: 'limit', message: e.message };
        }
      }
    }
  } catch (e) {
    return { ok: false, reason: e.refusal ? 'refusal' : 'error', message: e.message };
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
      note: res.subscription ? '구독 포함(추가 청구 0)' : 'API 실비',
      usage: res.usage,
    }) + '\n'
  );
  console.log(`[cost] ${slug} (${res.engine}): ${costLine}`);

  // 텔레그램 승인 메시지
  if (chatId) {
    const id = slug.slice(0, 36) + '_' + Math.abs(hash(slug)).toString(36);
    saveDraftMapEntry(id, { slug, title: d.title });
    const summary = (d.description || d.body).replace(/\s+/g, ' ').slice(0, 150);
    const msg =
      `📝 ${d.title}\n🔑 ${keyword}\n📄 ${summary}…\n` +
      (d.riskNotes && !/없음|없습니다/.test(d.riskNotes) ? `⚠️ 검수: ${d.riskNotes.slice(0, 200)}\n` : '') +
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

// ── 일괄/직접 생성(batch 모드 또는 /draft <키워드>) ──
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
    if (!r.ok) {
      if (r.reason === 'limit' && chatId) await sendMessage(chatId, `⏳ "${it.keyword}" 한도/오류 — 나중에 재시도하세요.`);
      else if (r.reason === 'refusal' && chatId) await sendMessage(chatId, `⛔ "${it.keyword}" 안전상 생성 거절(건너뜀).`);
      else if (chatId) await sendMessage(chatId, `❌ "${it.keyword}" 실패: ${r.message}`);
      continue;
    }
    made++;
  }
  if (chatId && made) await sendMessage(chatId, `✅ 초안 ${made}편 생성. 위에서 승인/반려하세요. 비용 상세는 cost-log.jsonl.`);
  return made;
}

// launchd/CLI 직접 실행: batch 모드 일괄 생성
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv } = await import('./lib/env.mjs');
  loadEnv();
  await runGenerate({ chatId: process.env.TELEGRAM_CHAT_ID, config: loadConfig() });
}
