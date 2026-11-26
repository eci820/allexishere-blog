// 🇦🇺🔭 AU topic scout — buzz-driven but information-first topics for au.allexishere.com (2026-11-26).
//
// 사용자 지시: "호주도 마찬가지로" — 한국 lib/scout.mjs 와 같은 원칙을 영어·호주판으로.
//   · 출발점은 화제(호주 유튜브·Reddit r/australia·r/sydney 등·뉴스)지만, 글은 '검증 가능한 정보 질문'으로.
//   · 인물·가십·정치·사건 자체는 금지. 한 대상당 한 편(같은 대상 변형 금지 — 도어웨이 신호).
//   · 🔴 공식 출처 URL 이 없으면 버린다 — au-generate 는 '가져온 공식 원문에 있는 사실만' 쓰므로
//     출처가 없으면 쓸 게 없다(README 보완 1). 출처는 au-generate 가 직접 fetch·충분성 판정한다.
// 결과는 state/au/scout-pool.json 에 au-pool 후보와 같은 모양으로 쌓인다(au-autopilot 이 소비).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedSubjects } from './au-pool.mjs';
import { claudeText } from '../lib/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.resolve(HERE, '..', 'state', 'au');
const FILE = path.join(STATE, 'scout-pool.json');

export const CATS = ['money', 'consumer', 'home', 'driving', 'travel', 'digital', 'science'];
const BANNED = /\b(?:dies|died|death of|arrested|charged|scandal|affair|divorce|engaged|election|prime minister|senator|premier|murder|stabbing|celebrity|influencer|net worth|dating)\b/i;

export const loadScoutPool = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { items: [] }; } };
const saveScoutPool = (p) => { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(p, null, 1)); };
const slugKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const PROMPT = (existing, hints, want) => `You are the topic scout for an Australian (en-AU) information blog (au.allexishere.com).
Use WebSearch to find what Australians are actively asking about or getting wrong in the last 2–3 weeks — popular Australian
YouTube explainers, Reddit (r/australia, r/sydney, r/melbourne, r/AusFinance, r/brisbane), and Australian news — and turn
${want} of them into blog topics.

[A topic qualifies only if ALL are true]
1. Hooky: money people lose by not knowing, a rule/price that just changed, a widespread myth, a seasonal need coming up soon.
2. Information-first: no celebrities, gossip, politics or crime as the subject. If the buzz is an event, write about the rule, cost or how-to behind it.
3. Verifiable: list 1–3 OFFICIAL source URLs (gov.au, state transport/revenue offices, ACCC, ATO, Services Australia, BoM, operators,
   manufacturers) whose pages actually contain the facts. No blogs/forums as sources.
4. Long-tail search phrase Australians would type (3–8 words). No head terms.
5. One topic per subject — no variants of the same subject.
6. Mix categories (max 3 per category): ${CATS.join(', ')}. No medical advice, no specific investment picks.
${hints.length ? `\n[Hints from our own performance analysis — apply them]\n${hints.map((h) => '- ' + h).join('\n')}\n` : ''}
[Already covered — do not repeat]
${existing.join(' | ')}

Output ONE JSON array only (no code fence):
[{"keyword":"search phrase","title":"working title: subject + 2–3 concrete pain points, no '(2026)' tail","subject":"short unique subject","category":"money|consumer|home|driving|travel|digital|science","hook":"why people are asking now (1 line)","official":["https://..."]}]`;

export async function runAuScout(config, { want = 12, dry = false } = {}) {
  const pool = loadScoutPool();
  const { set: published } = publishedSubjects();
  const existing = [...pool.items.map((i) => i.title), ...[...published].slice(0, 80)];
  let hints = [];
  try { hints = (await import('../lib/lessons.mjs')).topicHintsForScout('au'); } catch {}
  let raw, costUsd = 0;
  try {
    const r = await claudeText(PROMPT(existing.slice(0, 120), hints, want), { model: config.cliModel, timeoutSec: 360 });
    raw = r.result; costUsd = r.costUsd;
  } catch (e) { return { added: 0, dropped: [], costUsd, note: `⚠️ AU scout failed: ${String(e.message).slice(0, 100)}` }; }
  let items;
  try {
    const t = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    items = JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
  } catch { return { added: 0, dropped: [], costUsd, note: '⚠️ AU scout: could not parse result' }; }

  const dropped = [], perCat = {}, add = [];
  const haveSubj = new Set([...pool.items.map((i) => slugKey(i.subject)), ...[...published].map((k) => slugKey(String(k).split('::')[0]))]);
  for (const it of items) {
    const subject = slugKey(it?.subject || it?.keyword);
    const official = (Array.isArray(it?.official) ? it.official : []).filter((u) => /^https?:\/\//.test(u) && !/reddit|youtube|facebook|blog|forum/i.test(u)).slice(0, 3);
    if (!it?.keyword || !it?.title || !CATS.includes(it?.category)) { dropped.push({ keyword: it?.keyword || '?', why: 'bad shape' }); continue; }
    if (BANNED.test(`${it.keyword} ${it.title}`)) { dropped.push({ keyword: it.keyword, why: 'person/gossip/politics/crime' }); continue; }
    if (!official.length) { dropped.push({ keyword: it.keyword, why: 'no official source' }); continue; }
    if (haveSubj.has(subject)) { dropped.push({ keyword: it.keyword, why: 'subject already covered' }); continue; }
    if ((perCat[it.category] = (perCat[it.category] || 0) + 1) > 3) { dropped.push({ keyword: it.keyword, why: 'category cap' }); continue; }
    haveSubj.add(subject);
    add.push({
      id: 'scout-' + subject.slice(0, 50), keyword: String(it.keyword).trim(), title: String(it.title).trim().replace(/\s*\(20\d\d\)\s*$/, ''),
      subject, group: 'info', cls: 'info', official, gmapIds: [], judgment: false, axis: 'S', priority: 5,
      tags: ['australia', it.category], hook: String(it.hook || '').slice(0, 160), addedAt: new Date().toISOString(), status: 'pending',
    });
  }
  if (!dry) { pool.items.push(...add); saveScoutPool(pool); }
  return { added: add.length, dropped, costUsd, items: dry ? add : undefined, note: `🇦🇺🔭 AU scout: ${add.length} topics added · dropped ${dropped.length}${dropped.length ? ' — ' + [...new Set(dropped.map((d) => d.why))].join(', ') : ''}` };
}

export function markScout(id, status, extra = {}) {
  const p = loadScoutPool();
  const it = p.items.find((x) => x.id === id);
  if (it) { Object.assign(it, { status, ...extra }); saveScoutPool(p); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv, loadConfig } = await import('../lib/env.mjs');
  loadEnv();
  const r = await runAuScout(loadConfig(), { dry: !process.argv.includes('--write') });
  console.log(JSON.stringify(r, null, 1));
}
