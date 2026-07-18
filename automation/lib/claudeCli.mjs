// claude CLI(구독 헤드리스) 공용 실행기.
//
// 왜 따로 뺐나 — 2026-07-18 파일럿 3 사고:
//  · 프롬프트를 명령행 인자로 넘기면 실패 메시지가 "Command failed: claude -p <프롬프트 전문>"
//    이 되어 진짜 사유(stderr)가 파묻힌다. 사진 설명·추출 텍스트가 붙으면 프롬프트가
//    수 KB가 되어 로그도 오염된다.
//  · 사진이 붙은 초안 생성이 240초를 넘겨 SIGTERM(코드 143)으로 죽었는데,
//    메시지만 봐서는 '시간 초과'인지 알 수 없었다.
//
// 그래서 이 실행기는:
//  ① 프롬프트를 stdin 으로 넘긴다 → 이스케이프·따옴표·ARG_MAX 문제가 원리적으로 사라진다.
//     (claude 는 인자 없이 -p 만 주면 stdin 전체를 프롬프트로 읽는다. 즉시 닫아
//      "no stdin data received" 경고도 피한다.)
//  ② 실패 사유를 분류해 사람이 읽을 수 있게 돌려준다 — 프롬프트를 다시 뱉지 않는다.
//  ③ maxBuffer 제한 없이 출력을 모은다(spawn 직접 사용).
import { spawn } from 'node:child_process';

// 🔴 구독 우선 — claude CLI 에 API 키를 물려주지 않는다.
//
// claude CLI 는 ANTHROPIC_API_KEY(또는 ANTHROPIC_AUTH_TOKEN)가 환경에 있으면
// claude.ai 로그인(구독)보다 그걸 우선한다. CLI 자신도 이렇게 경고한다:
//   "ANTHROPIC_API_KEY or another auth source is set and takes precedence
//    over your claude.ai login"
// 즉 .env 에 키를 넣는 순간, 원래 구독으로 공짜로 돌던 모든 생성이 조용히
// 조직 API 크레딧 청구로 바뀐다(2026-07-18 실제 발생 — 키를 넣은 직후 발행분부터).
//
// 그래서 CLI 를 띄울 때는 이 두 변수를 지운 환경을 넘긴다. API 폴백은 SDK 가
// process.env 를 직접 읽으므로 영향을 받지 않는다 — 폴백은 그대로 살아있다.
const SUBSCRIPTION_SHADOWING_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export function subscriptionEnv(base = process.env) {
  const env = { ...base };
  for (const k of SUBSCRIPTION_SHADOWING_VARS) delete env[k];
  return env;
}

// 실패 종류 — 호출부가 무엇을 해야 할지 바로 알 수 있게.
export function classifyCliError(text) {
  const s = String(text || '');
  if (/usage limit|rate limit|too many requests|quota/i.test(s)) return 'limit';
  if (/not logged in|authentication|unauthorized|invalid api key|login/i.test(s)) return 'auth';
  if (/ENOENT/.test(s)) return 'notfound';
  return 'error';
}

const FRIENDLY = {
  timeout: (sec) => `claude 응답이 ${sec}초 안에 오지 않았습니다(시간 초과)`,
  limit: () => '구독 사용 한도에 걸렸습니다(리셋 후 재시도)',
  auth: () => 'claude 로그인·인증 문제입니다(claude 로그인 상태 확인 필요)',
  notfound: () => 'claude 명령을 찾을 수 없습니다(PATH 확인 필요)',
  error: (_, detail) => `claude 실행 실패${detail ? ': ' + detail : ''}`,
};

// 프롬프트를 stdin 으로 넘겨 claude 를 실행하고 stdout 문자열을 돌려준다.
// 실패 시 { kind, message } 가 붙은 Error 를 던진다(kind: timeout|limit|auth|notfound|error).
export function runClaude(prompt, { cwd, timeoutMs = 240000, extraArgs = [], env } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', ...extraArgs];
    // 구독으로 돌리기 위해 API 키를 뺀 환경을 넘긴다(위 주석 참고).
    const child = spawn('claude', args, { cwd, env: subscriptionEnv(env || process.env) });

    let out = '', err = '', settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };

    const timer = setTimeout(() => {
      const sec = Math.round(timeoutMs / 1000);
      try { child.kill('SIGTERM'); } catch {}
      // 얌전히 안 죽으면 확실히 정리(좀비 프로세스 방지)
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000).unref?.();
      finish(reject, Object.assign(new Error(FRIENDLY.timeout(sec)), { kind: 'timeout', timeoutSec: sec }));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    child.on('error', (e) => {
      const kind = classifyCliError(e.message);
      finish(reject, Object.assign(new Error(FRIENDLY[kind](0, e.message.slice(0, 150))), { kind }));
    });

    child.on('close', (code) => {
      if (settled) return;
      if (code === 0) return finish(resolve, out);
      const detail = err.trim().slice(0, 200);
      const kind = classifyCliError(detail);
      // 프롬프트는 절대 메시지에 넣지 않는다 — 로그·텔레그램이 오염된다.
      finish(reject, Object.assign(
        new Error(`${FRIENDLY[kind](0, detail || `종료코드 ${code}`)}`),
        { kind, exitCode: code, stderr: detail }
      ));
    });

    // 즉시 써서 닫는다 → CLI 의 stdin 대기(3초 경고) 없음
    child.stdin.on('error', () => { /* 자식이 먼저 죽은 경우 무시 */ });
    child.stdin.end(prompt);
  });
}

// claude 의 --output-format json 응답을 검사해 result 문자열을 돌려준다.
export function unwrapClaudeJSON(stdout) {
  let j;
  try { j = JSON.parse(stdout); } catch { throw Object.assign(new Error('claude 출력을 해석하지 못했습니다'), { kind: 'error' }); }
  if (j.is_error || !j.result) {
    const detail = `${j.subtype || ''} ${j.result || ''}`.trim();
    throw Object.assign(new Error(`claude 실패${detail ? ': ' + detail.slice(0, 150) : ''}`), { kind: classifyCliError(detail) });
  }
  return { result: j.result, costUsd: j.total_cost_usd || 0 };
}
