// 🔴 au-guard negative test (safe-automation-ops §2b).
// "실패할 수 없는 assert 는 무의미하다" — 그래서 한국 경로를 '일부러' 넣어
// 가드가 실제로 throw 하는지 확인한다. 하나라도 어긋나면 exit 1.
//
// 실행: node automation/au/test-au-guard.mjs
import fs from 'node:fs';
import path from 'node:path';
import {
  AU_ROOT,
  KR_ROOT,
  AU_BLOG,
  assertInsideAu,
  assertNotKr,
  guardAuPath,
  guardAuRealpath,
} from './au-guard.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const nothrows = (fn) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

// 테스트 경로들 (실제 존재 여부와 무관 — 가드는 순수 경로 판정)
const auPost = path.join(AU_BLOG, 'the-gabba-parking.md'); // AU 글
const auAny = path.join(AU_ROOT, 'src', 'pages', 'x.astro'); // AU 임의
const krPost = path.join(KR_ROOT, 'src', 'content', 'blog', '킨텍스', 'index.md'); // 한국 글 🔴
const krConf = path.join(KR_ROOT, 'automation', 'config.json'); // 한국 설정 🔴
const krRootItself = KR_ROOT; // 한국 root 자신 🔴
const traversal = path.join(AU_ROOT, '..', 'allexishere-blog', 'src', 'content', 'blog', 'x.md'); // .. 로 한국 진입 🔴
const sibling = AU_ROOT + '-evil' + path.sep + 'x.md'; // 형제 접두사 공격 🔴

console.log('=== au-guard negative test ===');
console.log('KR_ROOT =', KR_ROOT);
console.log('AU_ROOT =', AU_ROOT);
console.log('');

console.log('[assertInsideAu] AU 안은 통과, 그 외는 throw:');
ok('AU 글 경로 통과', nothrows(() => assertInsideAu(auPost)));
ok('AU 임의 경로 통과', nothrows(() => assertInsideAu(auAny)));
ok('🔴 한국 글 경로 차단(throw)', throws(() => assertInsideAu(krPost)));
ok('🔴 한국 설정 경로 차단(throw)', throws(() => assertInsideAu(krConf)));
ok('🔴 .. 트래버설로 한국 진입 차단(throw)', throws(() => assertInsideAu(traversal)));
ok('🔴 형제 접두사(-evil) 차단(throw)', throws(() => assertInsideAu(sibling)));

console.log('\n[assertNotKr] 한국 안이면 throw:');
ok('AU 경로는 통과', nothrows(() => assertNotKr(auPost)));
ok('🔴 한국 글 경로 차단(throw)', throws(() => assertNotKr(krPost)));
ok('🔴 한국 root 자신 차단(throw)', throws(() => assertNotKr(krRootItself)));

console.log('\n[guardAuPath] 결합(AU 안 + 한국 밖):');
ok('AU 글 통과', nothrows(() => guardAuPath(auPost)));
ok('🔴 한국 글 차단(throw)', throws(() => guardAuPath(krPost)));
ok('🔴 .. 트래버설 차단(throw)', throws(() => guardAuPath(traversal)));

console.log('\n[guardAuRealpath] 🔴 실제 심볼릭 링크(AU→KR)로 쓰기 시도:');
// AU 안에 한국을 가리키는 진짜 심볼릭 링크를 만들어, 쓰기 직전 가드가 잡는지 증명한다.
// (테스트 후 반드시 제거 — finally)
const linkPath = path.join(AU_ROOT, '.guardtest-symlink-tmp');
try {
  try {
    fs.unlinkSync(linkPath);
  } catch {}
  fs.symlinkSync(KR_ROOT, linkPath); // .guardtest-symlink-tmp → allexishere-blog
  const through = path.join(linkPath, 'src', 'content', 'blog', 'evil.md');
  ok(
    'lexical 가드는 이 링크를 통과시킨다 (= realpath 가 필요한 이유)',
    nothrows(() => guardAuPath(through))
  );
  ok(
    '🔴 realpath 가드가 AU→KR 심볼릭 링크를 차단(throw)',
    throws(() => guardAuRealpath(through))
  );
  ok(
    '정상 AU 경로는 realpath 가드도 통과',
    nothrows(() => guardAuRealpath(path.join(AU_BLOG, 'ok-post.md')))
  );
} catch (e) {
  fail++;
  console.log(`  ❌ 심볼릭 테스트 셋업 실패: ${e.message}`);
} finally {
  try {
    fs.unlinkSync(linkPath); // 🔴 링크 반드시 제거 (링크만 지움 — 대상 KR 은 안 건드림)
  } catch {}
}
const leftover = fs.existsSync(linkPath);
ok('테스트용 심볼릭 링크 정리됨', !leftover);

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail === 0) {
  console.log('✅ 가드 negative test 통과 — AU 작업은 한국 저장소를 건드릴 수 없다.');
  process.exit(0);
} else {
  console.log('❌ 가드가 예상대로 동작하지 않음 — 다음 단계로 진행 금지.');
  process.exit(1);
}
