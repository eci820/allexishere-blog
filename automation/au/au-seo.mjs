// 🇦🇺 AU SEO 감시자 (주간) — 구조만. 아직 스케줄 등록하지 않는다.
//
// 역할(§8): "기존 글이 괜찮은가(유지)". 새 주제 제안은 안 한다(그건 브리핑의 몫).
// 🔴 비용(§5): LLM 0회. 🔴 데이터 성숙(§7): 성과(노출/클릭) 기반 판정은 GSC 데이터가
//    쌓인 뒤. 지금은 GSC 접근이 없어(보완 2 선행조건) 성과 신호를 끄고, 대신 데이터가
//    필요 없는 '구조 건강'만 점검한다(제목·설명·분량·출처절·dedup 메타·발행 상태).
//
// 🔴🔴 선행조건(보완 2): 성과 감시를 켜려면 한국 GSC 서비스계정을 au.allexishere.com
//    속성에 추가해야 한다(au-analyst.mjs 주석 참조). 그 전까지 성과 항목은 "not connected".
import fs from 'node:fs';
import path from 'node:path';
import { AU_BLOG } from './au-guard.mjs';
import { gscAccessAvailable } from './au-analyst.mjs';

const THIN_CHARS = 1500;

function readPost(file) {
  const raw = fs.readFileSync(path.join(AU_BLOG, file), 'utf8');
  const fm = raw.split(/^---\s*$/m)[1] || '';
  const body = raw.split(/^---\s*$/m).slice(2).join('---');
  const get = (k) => (fm.match(new RegExp(`^\\s*${k}:\\s*["']?(.*?)["']?\\s*$`, 'm')) || [])[1] || '';
  return {
    slug: file.replace(/\.md$/, ''),
    draft: /^\s*draft:\s*true\s*$/m.test(fm),
    title: get('title'),
    description: get('description'),
    subject: get('subject'),
    modifierGroup: get('modifierGroup'),
    hasSources: /^###?\s*Sources/m.test(body),
    len: body.replace(/<!--[\s\S]*?-->/g, '').trim().length,
  };
}

// 구조 건강 점검(데이터 불필요). 반환: [{slug, issues[]}]
export function structuralHealth() {
  let files = [];
  try {
    files = fs.readdirSync(AU_BLOG).filter((f) => f.endsWith('.md'));
  } catch {
    return { posts: [], published: 0 };
  }
  const posts = [];
  let published = 0;
  for (const f of files) {
    let p;
    try {
      p = readPost(f);
    } catch {
      continue;
    }
    if (p.draft) continue;
    published++;
    const issues = [];
    if (!p.title) issues.push('missing title');
    if (!p.description) issues.push('missing description');
    if (p.len < THIN_CHARS) issues.push(`thin (${p.len} chars)`);
    if (!p.hasSources) issues.push('no "Sources & last updated" section');
    if (!p.subject || !p.modifierGroup) issues.push('missing subject/modifierGroup (dedup)');
    posts.push({ slug: p.slug, title: p.title, issues });
  }
  return { posts, published };
}

// 실행 → 리포트 문자열(순수 · 전송·쓰기 없음).
export function watch() {
  const h = structuralHealth();
  const lines = [`🇦🇺 SEO watch — ${h.published} published post(s)`];
  if (!h.published) lines.push('(no published posts yet)');
  for (const p of h.posts) {
    lines.push(p.issues.length ? `⚠️ ${p.slug}: ${p.issues.join(' · ')}` : `✅ ${p.slug}: structure OK`);
  }
  lines.push(
    gscAccessAvailable()
      ? '📊 performance: (GSC connected)'
      : '📊 performance signals: not connected yet — add KR GSC service account to au.allexishere.com (see au-analyst.mjs). Holding performance checks (§7).'
  );
  return lines.join('\n');
}

// dry-run: node au-seo.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('=== au-seo dry-run (LLM 0 · 전송·쓰기 없음) ===');
  console.log(watch());
}
