#!/usr/bin/env node
// 📂🧪 발행글 하네스 보강 배치 (2026-11-26 신설, 사용자 지시: "니치 밖 noindex 글 16편도 하네스로 보강").
//
// 흐름(기존 경로 재사용 — 계약 §3):
//   refreshPublished(brief=전면 재작성 지시) → runHarness(검증·수정·재채점) → passesGate
//     · 통과 → noindex 해제(검색 재노출) + commitUpdate
//     · 불통과 → 보강된 본문만 반영, noindex 유지 + commitUpdate
//     · 하네스 검증 자체가 실패 → 백업 복원(검증 안 된 재작성은 반영하지 않는다)
//   주소(URL)는 절대 바꾸지 않는다 — originalPath/폴더명 그대로(§7).
//   사람 승인 카드는 건너뛴다(사용자 지시). 대신 편마다 텔레그램으로 결과를 알린다.
//
// 사용: node automation/harness-refresh.mjs --plan plan.json [--dry-run]
//   plan.json = [{ "slug": "14", "keyword": "옥수수 요리", "brief": "추가 지시(선택)" }, ...]
// 구독 한도에 걸리면 즉시 멈춘다(autopilot 슬롯을 굶기지 않기 위해).
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, loadConfig, ROOT, AUTO_DIR } from './lib/env.mjs';

loadEnv();
const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : undefined; };
const DRY = process.argv.includes('--dry-run');
const BLOG = path.join(ROOT, 'src', 'content', 'blog');
const STATE = path.join(AUTO_DIR, 'state');
const ME = process.env.TELEGRAM_CHAT_ID; // 🇰🇷 한국 봇

const BRIEF = (kw) => `이 글은 얇고 AI 티가 나서 검색 노출에서 제외(noindex)됐던 글입니다. 같은 주제·같은 주소로 '전면 재작성'하세요 — 구조를 갈아엎어도 됩니다.
- 검색어: ${kw}. 첫 문단 1~2문장에 검색어의 직접 답. 소제목(h2) 3~6개는 사람들이 실제로 묻는 하위 질문으로.
- 공식 출처(기관명·기준 연월)로 확인된 사실만 쓰세요. 확인 못 한 수치는 쓰지 않습니다. 체험담·'많은 사람들의 경험' 지어내기 금지.
- 사람 문체: 문장 길이 섞기, 같은 어미 3연속 금지, 한 문장 쉼표 1개 이하, 상투 표현(이 글에서는·알아보겠습니다·결론적으로·도움이 되셨길) 금지.
- 낚시성 문구("이 글 하나로 고민 끝", "돈 된다", "놀라운") 금지. 이모지·과도한 굵게 금지. 특정 제품 구매 권유 금지.
- 분량은 검색 의도에 맞게(공백 포함 1,500~3,000자). 물타기 금지. 기존 본문의 내부 링크는 유지.`;

const dq = (s) => '"' + String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
function split(raw) {
  const m = raw.match(/^(---[\s\S]*?---\n+)([\s\S]*)$/);
  const fm = m[1], rest = m[2];
  const i = rest.indexOf('<!--');
  return { fm, body: (i >= 0 ? rest.slice(0, i) : rest).trim(), tail: i >= 0 ? rest.slice(i) : '' };
}
const fmField = (fm, k) => (fm.match(new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, 'm')) || [])[1] || '';

const plan = JSON.parse(fs.readFileSync(arg('--plan'), 'utf8'));
const cfg = loadConfig();
const { refreshPublished } = await import('./generate.mjs');
const { runHarness, passesGate, harnessCardLine, logHarness } = await import('./lib/harness.mjs');
const { commitUpdate } = await import('./publish.mjs');
const { sendMessage } = await import('./lib/telegram.mjs');
const say = async (t) => { console.log(t); if (ME && !DRY) await sendMessage(ME, t).catch(() => {}); };

const summary = { reindexed: [], keptNoindex: [], reverted: [], failed: [] };
await say(`📂🧪 noindex 글 하네스 보강 시작 — ${plan.length}편(한 편 약 10~15분). 통과한 글만 noindex 해제합니다.`);

for (const [i, item] of plan.entries()) {
  const f = path.join(BLOG, item.slug, 'index.md');
  if (!fs.existsSync(f)) { summary.failed.push(`${item.slug}(없음)`); continue; }
  const before = fs.readFileSync(f, 'utf8');
  if (/^draft:\s*true/m.test(before)) { summary.failed.push(`${item.slug}(초안)`); continue; }
  const oldTitle = fmField(split(before).fm, 'title');
  console.log(`\n[${i + 1}/${plan.length}] ${item.slug} · ${oldTitle} · 검색어 "${item.keyword}"`);
  if (DRY) continue;

  const r = await refreshPublished(item.slug, cfg, null, { brief: BRIEF(item.keyword) + (item.brief ? '\n- ' + item.brief : ''), timeoutSeconds: 420 });
  if (!r.ok) {
    summary.failed.push(`${oldTitle}: ${r.error}`);
    if (/한도|limit/i.test(r.error || '')) { await say(`⏳ 구독 한도 — 보강 배치를 여기서 멈춥니다(${i}/${plan.length} 처리). 자동 발행 슬롯 보호.`); break; }
    continue;
  }
  const { fm, body, tail } = split(fs.readFileSync(f, 'utf8'));
  const h = await runHarness(
    { title: fmField(fm, 'title'), description: fmField(fm, 'description'), body },
    { keyword: item.keyword, opts: { source: 'evergreen' }, config: cfg, minChars: 1500 }
  );
  if (!h.report.verify) {
    // 검증 단계를 못 거친 재작성은 반영하지 않는다 — 지어낸 수치가 섞였는지 아무도 안 봤다.
    fs.copyFileSync(r.backup, f);
    summary.reverted.push(oldTitle);
    await say(`↩️ 보강 취소(원본 복원): ${oldTitle}\n   ↳ ${h.report.errors.join(' / ')}`);
    if (h.report.errors.some((e) => /limit|한도/i.test(e))) { await say('⏳ 구독 한도 — 배치 중단.'); break; }
    continue;
  }
  const gate = passesGate(h.report, {}, cfg.harness || {});
  let nfm = fm;
  if (h.draft.title && h.draft.title !== fmField(fm, 'title')) nfm = nfm.replace(/^title:.*$/m, `title: ${dq(h.draft.title)}`);
  if (h.draft.description && h.draft.description !== fmField(fm, 'description')) {
    nfm = /^description:/m.test(nfm) ? nfm.replace(/^description:.*$/m, `description: ${dq(h.draft.description)}`) : nfm.replace(/^title:.*$/m, (t) => `${t}\ndescription: ${dq(h.draft.description)}`);
  }
  if (gate.pass) nfm = nfm.replace(/^noindex:\s*true\s*\n/m, '');
  fs.writeFileSync(f, nfm + h.draft.body.trim() + '\n' + (tail ? '\n' + tail : ''));
  logHarness(STATE, item.slug, h.report, gate);

  const title = h.draft.title || oldTitle;
  const c = await commitUpdate({ slug: item.slug, title });
  if (!c.ok) { summary.failed.push(`${title}: 커밋 실패 ${c.error}`); await say(`❌ 보강 커밋 실패: ${title}\n${c.error}`); continue; }
  (gate.pass ? summary.reindexed : summary.keptNoindex).push(title);
  await say(
    `📂🧪 보강 반영 (${i + 1}/${plan.length})\n📝 ${title}${title !== oldTitle ? `\n   (이전 제목: ${oldTitle})` : ''}\n${harnessCardLine(h.report)}\n` +
    (gate.pass ? '✅ 관문 통과 → noindex 해제(검색 재노출)' : `⏸ 관문 불통과 → 본문만 보강, noindex 유지\n   ↳ ${gate.why.join('\n   ↳ ')}`)
  );
}

await say(
  `📂🧪 보강 배치 끝\n✅ 재노출 ${summary.reindexed.length} · ⏸ noindex 유지 ${summary.keptNoindex.length} · ↩️ 원본 복원 ${summary.reverted.length} · ❌ 실패 ${summary.failed.length}` +
  (summary.failed.length ? `\n실패: ${summary.failed.join(' / ').slice(0, 300)}` : '')
);
fs.writeFileSync(path.join(STATE, 'harness-refresh-last.json'), JSON.stringify({ ts: new Date().toISOString(), ...summary }, null, 1));
