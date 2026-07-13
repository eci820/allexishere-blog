// 공유 게시 함수: 봇 [✅승인] 과 편집기 [발행하기] 가 모두 이걸 씁니다.
// 파일 락으로 직렬화(동시 발행 충돌 방지). draft 해제 → 그 글만 commit → push(실패 시 rebase 재시도 1회).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, AUTO_DIR } from './lib/env.mjs';
import { markPublished, soakPublished } from './lib/topicsPool.mjs';
import { submitIndexNow } from './lib/indexnow.mjs';

const BLOG = path.join(ROOT, 'src', 'content', 'blog');
const LOCK = path.join(AUTO_DIR, 'state', 'publish.lock');
const POOL_FILES = ['data/topics-pool.json', 'data/update-cooldown.json']; // 재고 상태 영속화(커밋 동승)

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

export async function publish({ slug, title, keyword }) {
  return withLock(async () => {
    const dir = path.join(BLOG, slug);
    const f = path.join(dir, 'index.md');
    if (!fs.existsSync(f)) return { ok: false, error: '글 없음: ' + slug };

    let raw = fs.readFileSync(f, 'utf8');
    raw = raw.replace(/^draft:\s*true\s*$/m, 'draft: false');
    if (!/^draft:/m.test(raw)) raw = raw.replace(/^---\r?\n/, '---\ndraft: false\n');
    fs.writeFileSync(f, raw);

    // 축2 소진: 재고 주제를 published + slug 기록. 키워드 알면 직접, 모르면 제목 매칭.
    try {
      if (keyword) markPublished(keyword, slug);
      else soakPublished(slug, title || '');
    } catch (e) { console.error('[publish] 재고 소진 실패:', e.message); }

    const rel = path.relative(ROOT, dir);
    const git = (args) => execFileSync('git', args, { cwd: ROOT, stdio: 'pipe' });
    // 재고 상태 파일도 커밋에 동승(존재 시)
    const extraAdds = POOL_FILES.filter((p) => fs.existsSync(path.join(ROOT, p)));
    try {
      git(['add', '--', rel, ...extraAdds]);
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
    submitIndexNow(url); // IndexNow 통보(90초 지연·fire-and-forget, 실패는 로그만)
    return { ok: true, url };
  });
}

// 📂 갱신 반영: 이미 발행된(draft:false) 글의 로컬 변경을 커밋·배포(주소 불변). 오직 사람 [✅]로만 도달.
export async function commitUpdate({ slug, title }) {
  return withLock(async () => {
    const dir = path.join(BLOG, slug);
    const f = path.join(dir, 'index.md');
    if (!fs.existsSync(f)) return { ok: false, error: '글 없음: ' + slug };
    const rel = path.relative(ROOT, dir);
    const git = (args) => execFileSync('git', args, { cwd: ROOT, stdio: 'pipe' });
    const extraAdds = POOL_FILES.filter((p) => fs.existsSync(path.join(ROOT, p)));
    try {
      git(['add', '--', rel, ...extraAdds]);
      try {
        git(['commit', '-m', `갱신: "${title || slug}"`]);
      } catch (e) {
        const out = ((e.stdout || '') + (e.stderr || '')).toString();
        if (!/nothing to commit/.test(out)) throw e;
      }
      try { git(['push']); }
      catch { try { git(['pull', '--rebase']); git(['push']); } catch (e2) { return { ok: false, error: 'push 실패: ' + (e2.stderr || e2.message || '').toString().slice(0, 300) }; } }
    } catch (e) {
      return { ok: false, error: (e.stderr || e.message || '').toString().slice(0, 300) };
    }
    const orig = readOriginalPath(fs.readFileSync(f, 'utf8'));
    const url = orig ? 'https://allexishere.com' + encodeURI(orig) : 'https://allexishere.com/entry/' + encodeURIComponent(slug);
    submitIndexNow(url); // 갱신도 동일하게 IndexNow 통보(fire-and-forget)
    return { ok: true, url };
  });
}
