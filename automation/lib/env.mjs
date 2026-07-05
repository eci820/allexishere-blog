// automation/.env(비밀) 와 config.json(설정) 을 불러옵니다. 외부 의존성 없음.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AUTO_DIR = path.resolve(HERE, '..');
export const ROOT = path.resolve(AUTO_DIR, '..');

// .env 파싱해서 process.env 에 주입(이미 설정된 값은 덮어쓰지 않음)
export function loadEnv() {
  const envPath = path.join(AUTO_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(AUTO_DIR, 'config.json'), 'utf8'));
}

// 필수 비밀이 채워졌는지 확인
export function requireSecrets(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(
      `[env] 누락된 값: ${missing.join(', ')}\n` +
        `→ automation/.env 를 만들고 채우세요 (automation/.env.example 참고).`
    );
    process.exit(1);
  }
}
