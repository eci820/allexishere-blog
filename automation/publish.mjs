// 공유 게시 함수: 봇 [✅승인] 과 편집기 [발행하기] 가 모두 이걸 씁니다.
// 파일 락으로 직렬화(동시 발행 충돌 방지). draft 해제 → 그 글만 commit → push(실패 시 rebase 재시도 1회).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, AUTO_DIR } from './lib/env.mjs';
// ⚠️ 네임스페이스로 가져온다(이름별 import 아님). 봇은 24시간 상주 데몬이라
//    lib 모듈은 프로세스 시작 시점 버전이 메모리에 남고, publish.mjs 는 승인 때
//    비로소 동적 import 된다. 코드를 고친 뒤 봇을 재시작하지 않으면 '새 publish +
//    옛 topicsPool' 조합이 생기는데, 이름별 import 는 이때 링크 단계에서
//    SyntaxError 로 죽어 발행 자체가 막힌다(2026-07-18 실제 사고).
//    네임스페이스 import 는 없는 함수가 undefined 가 될 뿐이라 발행은 계속된다.
import * as pool from './lib/topicsPool.mjs';
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

// 실패 사유 추출 — 절대 빈 문자열을 반환하지 않는다.
// ⚠️ execFileSync 의 e.stderr/e.stdout 은 Buffer 다. 빈 Buffer 는 truthy 라서
//    (e.stderr || e.message) 로 쓰면 stderr 가 비었을 때 ''(빈 사유)가 새어나간다.
//    git commit 은 실패 메시지를 주로 stdout 으로 내보내므로 이 경로에 정확히 걸린다.
function errText(e) {
  const pick = (v) => (v == null ? '' : v.toString().trim());
  const parts = [pick(e?.stderr), pick(e?.stdout), pick(e?.message)].filter(Boolean);
  const text = parts.join(' | ').slice(0, 300);
  if (text) return text;
  // 여기까지 왔으면 아무 출력도 없는 실패 — 그래도 사유 없이 보내지 않는다.
  const code = e?.status ?? e?.code;
  return `알 수 없는 오류${code != null ? `(exit ${code})` : ''}${e?.syscall ? ` [${e.syscall}]` : ''}`;
}

// 사유 분류 — 원문 앞에 사람이 읽을 라벨을 붙여 무엇을 해야 할지 즉시 알게 한다.
function classify(raw, stage) {
  const s = String(raw);
  const label =
    /Authentication failed|could not read Username|Permission denied|403 Forbidden|Invalid username or password|Bad credentials|(token[^\n]{0,20}(expired|invalid|revoked))|((expired|invalid|revoked)[^\n]{0,20}token)/i.test(s) ? '🔐 인증 토큰 만료·권한 없음'
    : /non-fast-forward|rejected|fetch first|Updates were rejected|CONFLICT|Automatic merge failed|need to resolve/i.test(s) ? '🔀 GitHub push 충돌'
    : /Could not resolve host|Connection timed out|Network is unreachable|Failed to connect|unable to access|ECONNRESET|ETIMEDOUT/i.test(s) ? '🌐 네트워크 오류'
    : /nothing to commit|no changes added/i.test(s) ? '📄 커밋할 변경 없음'
    : /pre-commit|hook declined|hook failed/i.test(s) ? '🪝 git 훅 거부'
    : /index\.lock|another git process/i.test(s) ? '🔒 git 잠김(다른 프로세스)'
    : '⚠️ ' + stage;
  return `${label} — ${s}`;
}

export async function publish({ slug, title, keyword }) {
  return withLock(async () => {
    const dir = path.join(BLOG, slug);
    const f = path.join(dir, 'index.md');
    if (!fs.existsSync(f)) return { ok: false, error: `📄 글 없음 — ${slug} (초안 파일이 삭제됐거나 슬러그가 바뀜)` };

    let raw = fs.readFileSync(f, 'utf8');
    if (/^draft:\s*false/m.test(raw)) return { ok: false, error: `📄 이미 발행된 슬러그 — ${slug} (중복 발행 시도)` };
    raw = raw.replace(/^draft:\s*true\s*$/m, 'draft: false');
    if (!/^draft:/m.test(raw)) raw = raw.replace(/^---\r?\n/, '---\ndraft: false\n');
    fs.writeFileSync(f, raw);

    // 축2 소진: 재고 주제를 published + slug 기록. 키워드 알면 직접, 모르면 제목 매칭.
    try {
      if (keyword) pool.markPublished(keyword, slug);
      else pool.soakPublished(slug, title || '');
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
          return { ok: false, error: classify(errText(e2), 'push 실패') };
        }
      }
    } catch (e) {
      return { ok: false, error: classify(errText(e), 'git add·commit 실패') };
    }

    // 방금 발행글이 하나 늘었다 → 중복방어 인덱스 다시 읽게.
    // ?. 는 봇 재시작 전(옛 topicsPool 메모리 상주) 상황에서도 발행이 멈추지 않게 하는 안전장치.
    pool.invalidateLive?.();
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
    if (!fs.existsSync(f)) return { ok: false, error: `📄 글 없음 — ${slug}` };
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
      catch { try { git(['pull', '--rebase']); git(['push']); } catch (e2) { return { ok: false, error: classify(errText(e2), 'push 실패') }; } }
    } catch (e) {
      return { ok: false, error: classify(errText(e), 'git add·commit 실패') };
    }
    pool.invalidateLive?.(); // 제목·태그가 바뀌었을 수 있다 → 인덱스 재구축
    const orig = readOriginalPath(fs.readFileSync(f, 'utf8'));
    const url = orig ? 'https://allexishere.com' + encodeURI(orig) : 'https://allexishere.com/entry/' + encodeURIComponent(slug);
    submitIndexNow(url); // 갱신도 동일하게 IndexNow 통보(fire-and-forget)
    return { ok: true, url };
  });
}

// 테스트 전용 export(프로덕션 경로엔 영향 없음)
export { errText, classify };
