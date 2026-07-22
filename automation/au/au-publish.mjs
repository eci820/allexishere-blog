// AU 발행 — 한국 publish.mjs 의 안전막을 AU 저장소용으로 '별도' 구현.
//
// 왜 별도인가: 한국 publish() 는 ROOT(=allexishere-blog)에 고정돼 AU 에 쓸 수 없다.
// 그래서 AU 는 동일한 안전막(파일 락 · draft 게이트 · 명시적 git add · 경로 가드)을
// '자체'로 갖춘다. 기존 방어를 우회하는 게 아니라, 다른 저장소에 같은 방어를 두는 것.
//
// 🔴 모든 경로는 guardAuRealpath 통과. git 은 항상 cwd:AU_ROOT. `git add -A` 금지.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AU_ROOT, AU_BLOG, guardAuRealpath } from './au-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // automation/au
const STATE_DIR = path.resolve(HERE, '..', 'state', 'au'); // automation/state/au (봇 상태 — gitignore)
const LOCK = path.join(STATE_DIR, 'publish.lock');
const LOCK_STALE_MS = 90000;

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

// 파일 뮤텍스 — 한국 publish.mjs 와 같은 방식(atomic wx + stale 회수).
function withLock(fn) {
  ensureStateDir();
  let fd;
  try {
    fd = fs.openSync(LOCK, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') {
      const age = Date.now() - (fs.statSync(LOCK).mtimeMs || 0);
      if (age > LOCK_STALE_MS) {
        fs.rmSync(LOCK, { force: true });
        return withLock(fn);
      }
      throw new Error('AU 발행이 이미 진행 중입니다(락 존재).');
    }
    throw e;
  }
  try {
    fs.writeSync(fd, String(process.pid));
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(LOCK, { force: true });
  }
}

function git(args) {
  // 🔴 git 은 항상 AU 저장소에서만. cwd 를 가드로 재확인.
  guardAuRealpath(AU_ROOT);
  return execFileSync('git', args, { cwd: AU_ROOT, stdio: 'pipe', encoding: 'utf8' });
}

/**
 * 발행: draft:true → false, 명시적 git add → commit → push (cwd:AU_ROOT).
 * @param {string} slug  AU_BLOG 안의 파일 슬러그(확장자 제외)
 * @returns {{url:string, slug:string}}
 */
export function publish(slug) {
  const file = path.join(AU_BLOG, `${slug}.md`);
  guardAuRealpath(file); // 🔴 AU 안·한국 밖 확인

  return withLock(() => {
    if (!fs.existsSync(file)) throw new Error(`발행할 글이 없습니다: ${slug}.md`);
    let txt = fs.readFileSync(file, 'utf8');
    if (/^\s*draft:\s*false\s*$/m.test(txt)) throw new Error(`이미 발행된 글입니다: ${slug}`);
    if (!/^\s*draft:\s*true\s*$/m.test(txt)) throw new Error(`draft 플래그를 찾지 못했습니다: ${slug}`);

    // draft 해제
    txt = txt.replace(/^(\s*draft:\s*)true(\s*)$/m, '$1false$2');
    guardAuRealpath(file);
    fs.writeFileSync(file, txt, 'utf8');

    // 🔴 명시적 add — 그 글 하나만. `git add -A` 절대 금지.
    const rel = path.relative(AU_ROOT, file);
    git(['add', '--', rel]);
    try {
      git(['commit', '-m', `content: publish "${slug}"`]);
    } catch (e) {
      if (!/nothing to commit/i.test(e.stdout || e.message || '')) throw e;
    }
    // push (rebase 재시도 1회)
    try {
      git(['push']);
    } catch {
      git(['pull', '--rebase']);
      git(['push']);
    }

    // AU 는 IndexNow 키가 없다 → 색인 통보 생략(추후 키 생기면 추가). URL 만 돌려준다.
    const url = `https://au.allexishere.com/entry/${slug}`;
    return { url, slug };
  });
}

// smoke: node au-publish.mjs  — 로드·가드 배선만 확인(실제 발행 안 함).
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('=== au-publish smoke (로드·가드 배선 확인, 발행 안 함) ===');
  console.log('AU_ROOT :', AU_ROOT);
  console.log('AU_BLOG :', AU_BLOG);
  console.log('LOCK    :', LOCK);
  try {
    guardAuRealpath(path.join(AU_BLOG, 'sample.md'));
    console.log('✅ guardAuRealpath(AU 글 경로) 통과');
  } catch (e) {
    console.log('❌', e.message);
  }
  try {
    // 🔴 한국 경로로 발행 시도가 막히는지(이론상 불가하지만 배선 확인)
    guardAuRealpath(path.join(AU_ROOT, '..', 'allexishere-blog', 'src', 'content', 'blog', 'x.md'));
    console.log('❌ 한국 경로가 통과됨 — 가드 배선 오류!');
    process.exit(1);
  } catch {
    console.log('✅ 한국 경로는 가드에서 차단됨');
  }
  console.log('git cwd 는 항상 AU_ROOT 고정, `git add -A` 미사용.');
}
