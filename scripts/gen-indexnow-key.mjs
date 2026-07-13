// IndexNow 키 파일 생성기 — public/<INDEXNOW_KEY>.txt (내용 = 키 문자열).
// 키는 automation/.env 의 INDEXNOW_KEY 에서만 읽는다(소스 하드코딩 금지). 재발급 시 env만 바꾸고 재실행.
// 사용: node scripts/gen-indexnow-key.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../automation/lib/env.mjs';

loadEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = (process.env.INDEXNOW_KEY || '').trim();

if (!key) {
  console.error('❌ INDEXNOW_KEY 미설정(automation/.env). 키를 넣고 다시 실행하세요.');
  process.exit(1);
}
if (!/^[a-zA-Z0-9-]{8,128}$/.test(key)) {
  console.error('❌ INDEXNOW_KEY 형식 이상(영숫자·하이픈 8~128자):', key);
  process.exit(1);
}

const pub = path.join(ROOT, 'public');
fs.mkdirSync(pub, { recursive: true });

// 이전 IndexNow 키 파일(형식상 32자 hex .txt)이 있으면 정리 — 키 교체 시 옛 파일 잔존 방지.
for (const f of fs.readdirSync(pub)) {
  if (/^[a-f0-9]{32}\.txt$/i.test(f) && f !== `${key}.txt`) {
    fs.rmSync(path.join(pub, f));
    console.log('🗑  옛 키 파일 제거:', f);
  }
}

const file = path.join(pub, `${key}.txt`);
fs.writeFileSync(file, key); // IndexNow 규격: 파일명=키, 내용=키
console.log('✅ 생성:', path.relative(ROOT, file), '(내용=키)');
