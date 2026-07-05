// 공유 게시 함수: 봇 [✅승인] 과 편집기 [발행하기] 가 모두 이걸 씁니다.
// 파일 락으로 직렬화(동시 발행 충돌 방지). draft 해제 → 그 글만 commit → push(실패 시 rebase 재시도 1회).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, AUTO_DIR } from './lib/env.mjs';

const BLOG = path.join(ROOT, 'src', 'content', 'blog');
const LOCK = path.join(AUTO_DIR, 'state', 'publish.lock');

async function withLock(fn, waitMs = 30000) {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(LOCK, 'wx'); // 원자적 생성 = 뮤텍스
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch {
      // 오래된(죽은) 락이면 회수
      try {
        const st = fs.statSync(LOCK);
        if (Date.now() - st.mtimeMs > 90000) fs.rmSync(LOCK, { force: true });
      } catch {}
      if (Date.now() - start > waitMs) throw new Error('발행 락 획득 실패(다른 발행 진행 중)');
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.rmSync(LOCK, { force: true });
    } catch {}
  }
}

function readOriginalPath(md) {
  const m = md.match(/^originalPath:\s*"?(.*?)"?\s*$/m);
  return m ? m[1] : '';
}

export async function publish({ slug, title }) {
  return withLock(async () => {
    const dir = path.join(BLOG, slug);
    const f = path.join(dir, 'index.md');
    if (!fs.existsSync(f)) return { ok: false, error: '글 없음: ' + slug };

    let raw = fs.readFileSync(f, 'utf8');
    raw = raw.replace(/^draft:\s*true\s*$/m, 'draft: false');
    if (!/^draft:/m.test(raw)) raw = raw.replace(/^---\r?\n/, '---\ndraft: false\n');
    fs.writeFileSync(f, raw);

    const rel = path.relative(ROOT, dir);
    const git = (args) => execFileSync('git', args, { cwd: ROOT, stdio: 'pipe' });
    try {
      git(['add', '--', rel]);
      try {
        git(['commit', '-m', `content: 발행 "${title || slug}"`]);
      } catch (e) {
        const out = ((e.stdout || '') + (e.stderr || '')).toString();
        if (!/nothing to commit/.test(out)) throw e; // 변경 없으면 그냥 진행
      }
      try {
        git(['push']);
      } catch {
        // 원격이 앞서 있으면 rebase 후 1회 재시도
        try {
          git(['pull', '--rebase']);
          git(['push']);
        } catch (e2) {
          return { ok: false, error: 'push 실패: ' + (e2.stderr || e2.message || '').toString().slice(0, 300) };
        }
      }
    } catch (e) {
      return { ok: false, error: (e.stderr || e.message || '').toString().slice(0, 300) };
    }

    const orig = readOriginalPath(raw);
    const url = orig
      ? 'https://allexishere.com' + encodeURI(orig)
      : 'https://allexishere.com/entry/' + encodeURIComponent(slug);
    return { ok: true, url };
  });
}
