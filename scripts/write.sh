#!/usr/bin/env bash
# 로컬 글쓰기 편집기를 엽니다: 개발 서버를 켜고 브라우저로 /write 를 엽니다.
# 사용법:  npm run write
set -e
cd "$(dirname "$0")/.."

# 개발 서버가 안 떠 있으면 백그라운드로 시작
npx astro dev --background >/dev/null 2>&1 || true

# 서버가 뜰 때까지 잠깐 대기(최대 ~15초)
URL="http://localhost:4321/write"
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:4321/"; then break; fi
  sleep 0.5
done

echo "✍  글쓰기 편집기: $URL"
# 브라우저 열기 (macOS: open, 리눅스: xdg-open)
if command -v open >/dev/null 2>&1; then open "$URL";
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL";
else echo "브라우저에서 $URL 을 여세요."; fi
