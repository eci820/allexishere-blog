#!/usr/bin/env node
// 🗺 기존 발행글에 네이버 지도 링크를 소급 삽입 — 한 편씩, 사람 승인으로.
//
// 🔴 refreshPublished(전면 재작성)를 쓰지 않는다. 목적이 '링크 한 줄 추가'인데
//    LLM 재작성은 본문 전체를 바꾼다. 여기는 외과적 삽입이다 — LLM 0회, 본문 불변,
//    링크 한 줄만 추가. 주소·슬러그도 당연히 그대로다.
//
// 승인 경로는 새로 만들지 않는다. 기존 갱신 트랙을 그대로 탄다:
//   이 스크립트가 파일 수정 + 백업 → state/updates.json 등록 → 카드 전송
//     → 사람이 [✅ 갱신 반영] → bot 의 upok 핸들러가 commitUpdate() 로 커밋·푸시
//     → [❌ 취소(복원)] 를 누르면 백업에서 원본 복원
//   즉 bot.mjs 를 고칠 필요가 없다(새 콜백 0개).
//
// ⚠️ 알아둘 부작용: upok 은 recordUpdated(slug) 로 90일 갱신 쿨다운을 찍는다.
//    링크 한 줄 때문에 그 글이 90일간 '갱신 트랙' 후보에서 빠진다. 감수할 만하지만
//    모르고 당하면 안 되므로 카드에 명시한다.
//
// 사용:
//   node automation/map-backfill.mjs --list            # 대상 목록만(수정·전송 없음)
//   node automation/map-backfill.mjs --slug <슬러그> --dry-run
//   node automation/map-backfill.mjs --slug <슬러그>   # 파일 수정 + 승인 카드 전송
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT, AUTO_DIR } from './lib/env.mjs';
import { sendMessage, inlineButtons } from './lib/telegram.mjs';
import { facilityFromTitle, naverMapUrl, insertMapLink } from './lib/mapLink.mjs';

loadEnv();

const BLOG = path.join(ROOT, 'src', 'content', 'blog');
const STATE = path.join(AUTO_DIR, 'state');
const UPDATES = path.join(STATE, 'updates.json');
const BACKUPS = path.join(STATE, 'backups');

const arg = (k) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? null : process.argv[i + 1];
};
const DRY = process.argv.includes('--dry-run');
const LIST = process.argv.includes('--list');

function readPost(slug) {
  const f = path.join(BLOG, slug, 'index.md');
  if (!fs.existsSync(f)) return null;
  const raw = fs.readFileSync(f, 'utf8');
  if (/^draft:\s*true/m.test(raw)) return null;
  const parts = raw.split(/^---\s*$/m);
  return {
    f, raw,
    title: (raw.match(/^title:\s*"?(.*?)"?\s*$/m) || [])[1] || '',
    body: parts.slice(2).join('---'),
    head: parts.slice(0, 2).join('---') + '---',
  };
}

// 대상: 발행된 주차 글 중 지도 링크가 없고 시설이 인식되는 것.
export function candidates() {
  const out = [];
  for (const slug of fs.readdirSync(BLOG)) {
    const p = readPost(slug);
    if (!p || !/주차/.test(p.title)) continue;
    if (/map\.naver\.com/.test(p.body)) continue;
    const facility = facilityFromTitle(p.title);
    out.push({ slug, title: p.title, facility, linkable: !!facility });
  }
  return out;
}

// bot.mjs 의 registerUpdate 와 같은 파일·같은 형식. 접두사만 'm' 으로 구분한다.
function registerUpdate(entry) {
  fs.mkdirSync(STATE, { recursive: true });
  let map = {};
  try { map = JSON.parse(fs.readFileSync(UPDATES, 'utf8')); } catch {}
  const h = (s) => Math.abs([...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0)).toString(36);
  let id, i = 0;
  do { id = 'm' + h(entry.slug + '#m' + i); i++; } while (map[id]);
  map[id] = { ...entry, ts: Date.now(), source: 'map-backfill' };
  fs.writeFileSync(UPDATES, JSON.stringify(map, null, 1));
  return id;
}

async function run() {
  if (LIST) {
    const c = candidates();
    console.log(`대상 ${c.length}편 (지도 링크 없는 주차 발행글)`);
    for (const x of c) {
      console.log(` ${x.linkable ? '✅' : '⚠️ '} ${(x.facility || '시설 미인식').padEnd(14)} ${x.slug.slice(0, 42)}`);
    }
    return;
  }

  const slug = arg('--slug');
  if (!slug) throw new Error('--slug <슬러그> 가 필요합니다 (--list 로 목록 확인)');
  const p = readPost(slug);
  if (!p) throw new Error(`발행글을 찾지 못했습니다: ${slug}`);
  if (/map\.naver\.com/.test(p.body)) throw new Error('이미 지도 링크가 있습니다');

  const facility = facilityFromTitle(p.title);
  if (!facility) {
    throw new Error(
      `시설을 인식하지 못했습니다: "${p.title}"\n` +
      `→ 브라우저로 검색 결과를 확인한 뒤 lib/mapLink.mjs 의 LINKABLE_FACILITIES 에 추가하세요.`
    );
  }

  const r = insertMapLink(p.body, facility);
  if (!r.inserted) throw new Error(`삽입 실패: ${r.reason}`);

  const url = naverMapUrl(facility);
  const before = p.body.split('\n');
  const after = r.body.split('\n');
  const at = after.findIndex((l) => l.includes('map.naver.com'));
  const ctx = after.slice(Math.max(0, at - 3), at + 2).map((l) => (l.includes('map.naver.com') ? '+ ' + l : '  ' + l));

  const L = [
    `🗺 지도 링크 소급 삽입 — 승인 대기`,
    `📝 ${p.title}`,
    '',
    `시설: ${facility}`,
    `링크: ${decodeURIComponent(url)}`,
    `삽입 위치: ${r.where}`,
    '',
    `방식: 외과적 삽입(재작성 아님) · LLM 0회`,
    `변경: ${before.length}줄 → ${after.length}줄 (링크 1줄만 추가)`,
    `주소·슬러그·본문: 그대로`,
    '',
    '── 삽입 지점 ──',
    ...ctx.map((l) => l.slice(0, 78)),
    '',
    '⚠️ [✅ 갱신 반영]을 누르면 90일 갱신 쿨다운이 찍힙니다',
    '   (그동안 이 글이 갱신 트랙 후보에서 빠집니다)',
    '',
    '[❌ 취소(복원)]을 누르면 원본으로 되돌립니다.',
  ];
  const message = L.join('\n');

  if (DRY) {
    console.log(message);
    console.log('\n(--dry-run: 파일 수정·전송 안 함)');
    return;
  }

  // 백업 → 파일 수정 → 등록 → 카드
  fs.mkdirSync(BACKUPS, { recursive: true });
  const backup = path.join(BACKUPS, `${slug}.maplink.${Date.now()}.bak`);
  fs.copyFileSync(p.f, backup);
  fs.writeFileSync(p.f, p.head + r.body);

  const id = registerUpdate({ slug, title: p.title, backup });
  await sendMessage(process.env.TELEGRAM_CHAT_ID, message, inlineButtons([[
    { text: '📖 전문', callback_data: 'upview:' + id },
    { text: '✅ 갱신 반영', callback_data: 'upok:' + id },
    { text: '❌ 취소(복원)', callback_data: 'upno:' + id },
  ]]));
  console.log(`[map-backfill] 카드 전송됨: ${slug} (${facility}) · 백업 ${path.basename(backup)}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run().catch((e) => { console.error('[map-backfill] 실패:', e.message); process.exit(1); });
}
