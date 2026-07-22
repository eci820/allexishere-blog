// 🔴 크로스 저장소 하드가드 — AU 작업이 한국 저장소를 절대 건드리지 못하게 한다.
//
// 철학(safe-automation-ops §2a, choke-point): 나가는 출구를 하나씩 막지 않고,
// '경로(자산)' 하나의 좁은 길목에서 끊는다. 모든 AU 파일 쓰기·git 은 이 파일의
// 가드를 통과해야 한다. 가드는 한국 경로를 만나면 '조용히 지나가지 않고' throw 한다
// (fail-loud, §2b). 통과 여부는 test-au-guard.mjs 의 negative test 로 증명한다.
//
// 두 저장소 root 는 '이 모듈 파일 위치'에서 파생한다(한국 lib/env.mjs 와 같은 방식).
// 하드코딩 절대경로를 쓰지 않으므로 폴더를 옮겨도 상대관계가 유지된다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../allexishere-blog/automation/au
export const KR_ROOT = path.resolve(HERE, '..', '..'); // .../allexishere-blog  (한국 = 봇·콘텐츠)
export const AU_ROOT = path.resolve(KR_ROOT, '..', 'allexishere-au'); // 형제 폴더 = 호주 콘텐츠
export const AU_BLOG = path.join(AU_ROOT, 'src', 'content', 'blog'); // AU 글이 쓰이는 유일한 위치

// 경로를 절대·정규화한다(.. 트래버설을 여기서 접는다).
function norm(p) {
  return path.resolve(String(p || ''));
}

// abs 가 root 안(또는 root 자신)인가. 경계에 path.sep 을 요구해
// '형제 접두사'(예: allexishere-au-evil)가 allexishere-au 로 오인되지 않게 한다.
function isInside(root, abs) {
  return abs === root || abs.startsWith(root + path.sep);
}

/** 🔴 AU 저장소 '안'이 아니면 throw. (AU 쓰기 전 필수) */
export function assertInsideAu(p) {
  const abs = norm(p);
  if (!isInside(AU_ROOT, abs)) {
    throw new Error(
      `[au-guard] 경로가 AU 저장소 밖입니다 — 쓰기 거부: ${abs}\n           AU_ROOT=${AU_ROOT}`
    );
  }
  return abs;
}

/** 🔴 한국 저장소 '안'이면 throw. (이중 방어 — AU 작업이 한국을 건드리는지) */
export function assertNotKr(p) {
  const abs = norm(p);
  if (isInside(KR_ROOT, abs)) {
    throw new Error(
      `[au-guard] 🔴 한국 저장소 경로를 건드리려 했습니다 — 즉시 중단: ${abs}\n           KR_ROOT=${KR_ROOT}`
    );
  }
  return abs;
}

/** 두 가드를 함께 — AU 안 + 한국 밖. (순수 문자열 판정 — 값싼 조기거부) */
export function guardAuPath(p) {
  const abs = assertInsideAu(p);
  assertNotKr(abs);
  return abs;
}

// 존재하는 가장 깊은 조상 경로를 찾는다. (새 글 경로는 아직 없을 수 있으므로,
// 그 위에서 실재하는 지점을 realpath 대상으로 삼는다. AU_ROOT 는 항상 존재해 바닥이 된다.)
function deepestExisting(abs) {
  let cur = abs;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break; // 파일시스템 루트 도달
    cur = parent;
  }
  return cur;
}

/**
 * 🔴 실제 파일 쓰기/디렉토리 생성/ git cwd 직전에 쓰는 강화 가드.
 *
 * lexical 가드(guardAuPath)는 심볼릭 링크를 따라가지 않는다 — AU 안에 한국을 가리키는
 * 링크가 있으면 문자열상 통과하고도 한국에 쓰일 수 있다. 그래서 '존재하는 가장 깊은 조상'을
 * fs.realpathSync 로 실제 경로로 해제한 뒤, 그 실경로가 AU 안 + 한국 밖인지 다시 본다.
 *
 * 한계(정직): 검사 직후~쓰기 직전에 링크를 바꿔치기하는 TOCTOU 는 막지 않는다. 그건
 * 공격자가 있어야 성립하며(여긴 단일 사용자 로컬) O_NOFOLLOW 까지 다는 건 과하다 — 안 한다.
 */
export function guardAuRealpath(p) {
  const abs = guardAuPath(p); // ① 값싼 문자열 조기거부 먼저
  const anchor = deepestExisting(abs); // ② 실재하는 가장 깊은 조상
  let real;
  try {
    real = fs.realpathSync(anchor);
  } catch (e) {
    throw new Error(`[au-guard] realpath 실패 — 쓰기 거부: ${anchor} (${e.message})`);
  }
  // ③ 두 root 도 실경로로 (root 자체가 링크여도 real-vs-real 비교가 되도록)
  const auReal = fs.realpathSync(AU_ROOT);
  let krReal;
  try {
    krReal = fs.realpathSync(KR_ROOT);
  } catch {
    krReal = KR_ROOT;
  }
  if (!isInside(auReal, real)) {
    throw new Error(
      `[au-guard] 🔴 심볼릭 링크가 AU 저장소 밖(실경로=${real})을 가리킵니다 — 쓰기 거부.\n           lexical=${abs}`
    );
  }
  if (isInside(krReal, real)) {
    throw new Error(
      `[au-guard] 🔴 심볼릭 링크가 한국 저장소(실경로=${real})를 가리킵니다 — 즉시 중단.\n           lexical=${abs}`
    );
  }
  return abs;
}
