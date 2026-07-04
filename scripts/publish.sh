#!/usr/bin/env bash
# 글을 발행합니다: 변경사항을 모아 커밋하고 GitHub 로 올립니다(→ Cloudflare 자동 재배포).
# 사용법:  npm run publish
set -euo pipefail
cd "$(dirname "$0")/.."

# 1) 변경사항 스테이징
git add -A

# 2) 변경이 없으면 조용히 종료
if git diff --cached --quiet; then
  echo "✅ 바뀐 내용이 없습니다. 올릴 것이 없어요."
  exit 0
fi

# 3) 무엇이 바뀌는지 잠깐 보여주기
echo "── 이번에 올라갈 변경 ──"
git diff --cached --stat
echo "───────────────────────"

# 4) 커밋 + 푸시
STAMP="$(date '+%Y-%m-%d %H:%M')"
git commit -m "content: 글 업데이트 (${STAMP})"
git push

echo ""
echo "🚀 발행 완료! Cloudflare Pages 가 잠시 뒤 자동으로 새로 배포합니다(보통 1~3분)."
