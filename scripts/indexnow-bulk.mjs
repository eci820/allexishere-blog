// 기존 발행글 전체(또는 일부)를 IndexNow에 일괄 제출. ⚠️ 실행은 사용자 승인 후에만.
// 사용:
//   node scripts/indexnow-bulk.mjs --dry-run        # URL 목록만 출력(제출 안 함)
//   node scripts/indexnow-bulk.mjs                  # 전체 발행글 제출
//   node scripts/indexnow-bulk.mjs --limit 8        # 앞 8편만(단계적 관찰용)
//   node scripts/indexnow-bulk.mjs --match 재산세    # 슬러그/원본경로에 특정어 포함분만
// getPostUrl 규칙 재현: originalPath 있으면 그대로, 없으면 /entry/<dir>. canonical과 동일 인코딩(new URL().pathname).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../automation/lib/env.mjs';
import { submitIndexNowBatch } from '../automation/lib/indexnow.mjs';

loadEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOG = path.join(ROOT, 'src', 'content', 'blog');
const SITE = 'https://allexishere.com';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : Infinity;
const matchIdx = args.indexOf('--match');
const match = matchIdx >= 0 ? args[matchIdx + 1] : null;

function urlFor(dir, raw) {
  const m = raw.match(/^originalPath:\s*"?(.*?)"?\s*$/m);
  const p = m && m[1] ? (m[1].startsWith('/') ? m[1] : '/' + m[1]) : '/entry/' + dir;
  return SITE + new URL(p, SITE).pathname; // canonical과 동일 퍼센트 인코딩
}

const urls = [];
for (const dir of fs.readdirSync(BLOG)) {
  const f = path.join(BLOG, dir, 'index.md');
  if (!fs.existsSync(f)) continue;
  const raw = fs.readFileSync(f, 'utf8');
  if (/^draft:\s*true/m.test(raw)) continue; // 발행글만
  if (match && !(dir.includes(match) || raw.match(/^originalPath:.*/m)?.[0]?.includes(match))) continue;
  urls.push(urlFor(dir, raw));
}
const picked = urls.slice(0, limit);

console.log(`발행글 매칭 ${urls.length}편 → 제출 대상 ${picked.length}편${match ? ` (match="${match}")` : ''}`);
if (dry) {
  picked.forEach((u) => console.log('  ' + u));
  console.log('[dry-run] 실제 제출 안 함.');
  process.exit(0);
}
if (!process.env.INDEXNOW_KEY) { console.error('❌ INDEXNOW_KEY 미설정'); process.exit(1); }

// IndexNow 1요청 최대 10,000 URL → 119편은 단일 요청 가능. 그래도 안전하게 500개씩 청크.
const CHUNK = 500;
for (let i = 0; i < picked.length; i += CHUNK) {
  const status = await submitIndexNowBatch(picked.slice(i, i + CHUNK));
  console.log(`청크 ${i / CHUNK + 1}: 응답 ${status}`);
}
console.log('완료.');
