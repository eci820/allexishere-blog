// public/_redirects 생성기 — 티스토리 구 URL(숫자·모바일 permalink) → 신 URL(/entry/제목) 301.
//
// 배경: 이관글은 frontmatter의 originalPath(=/entry/제목)로 서빙되어 200이지만,
//   티스토리의 숫자 permalink(/N)·모바일(/m/N)은 라우트가 없어 404. 디렉토리명 = 티스토리 글번호이므로
//   /N → originalPath 1:1 매핑이 가능하다. (카테고리/태그 폴백은 soft-404 위험으로 의도적 제외 — 404 유지.)
//
// 목적지 인코딩: 사이트 canonical과 동일하게 new URL().pathname 으로 퍼센트 인코딩
//   (엠대시—·가운뎃점··Korean·공백 등). 서빙되는 canonical과 정확히 일치시켜 목적지 404를 방지.
//
// 재생성: node scripts/gen-redirects.mjs  → public/_redirects 덮어씀. (astro가 dist/_redirects로 복사)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOG = path.join(ROOT, 'src', 'content', 'blog');
const OUT = path.join(ROOT, 'public', '_redirects');
const SITE = 'https://allexishere.com';

const rows = [];
let special = 0;
for (const dir of fs.readdirSync(BLOG)) {
  if (!/^\d+$/.test(dir)) continue; // 숫자 디렉토리(=티스토리 글번호)만
  const f = path.join(BLOG, dir, 'index.md');
  if (!fs.existsSync(f)) continue;
  const raw = fs.readFileSync(f, 'utf8');
  const m = raw.match(/^originalPath:\s*"?(.*?)"?\s*$/m);
  if (!m || !m[1]) continue;
  const original = m[1].startsWith('/') ? m[1] : '/' + m[1];
  // canonical과 동일한 퍼센트 인코딩(—··%·공백·한글 등)
  const dest = new URL(original, SITE).pathname;
  if (/[—·%!]/.test(original)) special++;
  rows.push({ n: Number(dir), dest });
}
rows.sort((a, b) => a.n - b.n);

const lines = [
  '# 티스토리 구 permalink → 신 URL(/entry/제목) 301 리다이렉트',
  '# 자동 생성: node scripts/gen-redirects.mjs (originalPath 기반). 직접 수정 금지.',
  `# 규칙 ${rows.length * 2}개 (숫자 ${rows.length} + 모바일 ${rows.length}). Cloudflare Pages 한도 2,100 내.`,
  '# 목적지는 canonical과 동일한 퍼센트 인코딩(서빙 URL과 정확히 일치).',
  '',
];
for (const r of rows) lines.push(`/${r.n}  ${r.dest}  301`);
lines.push('');
lines.push('# 모바일 permalink(/m/N)도 동일 매핑');
for (const r of rows) lines.push(`/m/${r.n}  ${r.dest}  301`);
lines.push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'));
console.log(`생성: public/_redirects — 매핑 ${rows.length}편 × 2(숫자+모바일) = ${rows.length * 2}줄 (특수문자 목적지 ${special}편 인코딩)`);
console.log(`범위: /${rows[0]?.n} ~ /${rows[rows.length - 1]?.n}`);
