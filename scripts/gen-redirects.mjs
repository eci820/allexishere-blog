// public/_redirects 생성기 — 티스토리 구 URL(숫자·모바일 permalink) → 신 URL(/entry/제목) 301.
//
// 배경: 이관글은 frontmatter의 originalPath(=/entry/제목)로 서빙되어 200이지만,
//   티스토리의 숫자 permalink(/N)·모바일(/m/N)은 라우트가 없어 404. 디렉토리명 = 티스토리 글번호이므로
//   /N → originalPath 1:1 매핑이 가능하다. (카테고리/태그 폴백은 soft-404 위험으로 의도적 제외 — 404 유지.)
//
// 목적지 인코딩: 사이트 canonical과 동일하게 new URL().pathname 으로 퍼센트 인코딩
//   (엠대시—·가운뎃점··Korean·공백 등). 서빙되는 canonical과 정확히 일치시켜 목적지 404를 방지.
//
// 🔴 초안(draft:true)에는 규칙을 만들지 않는다 — 만들면 301 → 404 가 된다.
//   운영 빌드는 초안의 페이지를 아예 만들지 않는다(src/pages/entry/[...slug].astro 와
//   src/utils/posts.ts 가 둘 다 `data.draft !== true` 로 거른다). 그런데 규칙은 originalPath 만
//   보고 생겼으므로, 옛 주소가 존재하지 않는 목적지로 301 하는 깨진 체인이 됐다.
//   깨진 리다이렉트는 그냥 404 보다 나쁘다 — 구글이 리다이렉트 자체를 불신하게 된다.
//   홈·상위 폴백도 쓰지 않는다: 관련 없는 목적지는 soft-404 로 처리돼 이득이 없고,
//   위 5행의 '카테고리/태그 폴백 제외' 와 같은 이유다. 초안은 404 로 두는 게 정직하다.
//   (실측 2026-07-25: /11·/m/11 이 301 → 404. 11번이 이관 시점부터 draft:true 였다.)
//
// ⚠️ 이 스크립트는 빌드에 물려 있지 않다(수동 실행). 초안을 발행하거나 글을 내리면
//   여기를 다시 돌려야 규칙이 맞춰진다. 제외된 초안은 실행 로그와 파일 헤더에 남긴다.
//
// 재생성: node scripts/gen-redirects.mjs  → public/_redirects 덮어씀. (astro가 dist/_redirects로 복사)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOG = path.join(ROOT, 'src', 'content', 'blog');
const OUT = path.join(ROOT, 'public', '_redirects');
const SITE = 'https://allexishere.com';

// frontmatter 블록만 본다 — 본문에 'draft: true' 같은 줄이 있어도 오판하지 않게.
const frontmatter = (raw) => raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
const field = (fm, key) => fm.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, 'm'))?.[1] ?? '';

const rows = [];
const skipped = []; // 초안이라 규칙을 만들지 않은 글 — 조용히 빠지면 안 되므로 남긴다
let special = 0;
for (const dir of fs.readdirSync(BLOG)) {
  if (!/^\d+$/.test(dir)) continue; // 숫자 디렉토리(=티스토리 글번호)만
  const f = path.join(BLOG, dir, 'index.md');
  if (!fs.existsSync(f)) continue;
  const fm = frontmatter(fs.readFileSync(f, 'utf8'));
  const original0 = field(fm, 'originalPath');
  if (!original0) continue;
  const original = original0.startsWith('/') ? original0 : '/' + original0;
  // canonical과 동일한 퍼센트 인코딩(—··%·공백·한글 등)
  const dest = new URL(original, SITE).pathname;
  // 운영 빌드의 판정과 같게: draft 가 명시적으로 true 일 때만 초안.
  // 스키마 기본값이 false 라(src/content.config.ts) 'draft:' 가 없으면 발행글이다.
  if (/^draft:\s*true\s*$/m.test(fm)) {
    skipped.push({ n: Number(dir), original, title: field(fm, 'title') });
    continue;
  }
  if (/[—·%!]/.test(original)) special++;
  rows.push({ n: Number(dir), dest });
}
rows.sort((a, b) => a.n - b.n);
skipped.sort((a, b) => a.n - b.n);

const lines = [
  '# 티스토리 구 permalink → 신 URL(/entry/제목) 301 리다이렉트',
  '# 자동 생성: node scripts/gen-redirects.mjs (originalPath 기반). 직접 수정 금지.',
  `# 규칙 ${rows.length * 2}개 (숫자 ${rows.length} + 모바일 ${rows.length}). Cloudflare Pages 한도 2,100 내.`,
  '# 목적지는 canonical과 동일한 퍼센트 인코딩(서빙 URL과 정확히 일치).',
  ...(skipped.length
    ? [
        `# 초안(draft:true) ${skipped.length}편은 규칙 제외 — 목적지 페이지가 없어 301→404 가 되기 때문.`,
        '# 발행하면 이 스크립트를 다시 돌려야 규칙이 생긴다.',
        ...skipped.map((s) => `#   /${s.n} · /m/${s.n}  →  ${s.original}  (${s.title})`),
      ]
    : []),
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
for (const s of skipped) {
  console.log(`제외(초안): /${s.n} · /m/${s.n} → ${s.original} — "${s.title}". 발행하면 이 스크립트를 다시 실행할 것.`);
}
