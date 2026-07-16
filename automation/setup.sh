#!/usr/bin/env bash
# 자동화 상주 세팅: launchd 3종(봇·생성·워치독) 을 만들고 로그인 시 자동 실행되게 등록합니다.
# 맥미니 이전 시에도 이 스크립트 하나로 동일하게 세팅됩니다.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="$(pwd)"
NODE="$(command -v node)"
UID_NUM="$(id -u)"
LA="$HOME/Library/LaunchAgents"
NODEDIR="$(dirname "$NODE")"
mkdir -p "$LA" automation/logs automation/state

if [ ! -f automation/.env ]; then
  echo "❌ automation/.env 가 없습니다. automation/.env.example 를 복사해 채우세요."; exit 1
fi

echo "node=$NODE  project=$PROJECT  uid=$UID_NUM"

write_plist () {
  local label="$1"; local file="$LA/$label.plist"; shift
  cat > "$file"
  echo "  작성: $file"
}

# 1) 상주 봇 (부팅/로그인 시 실행 + 죽으면 자동 재시작)
write_plist com.allexishere.bot <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.allexishere.bot</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$PROJECT/automation/bot.mjs</string></array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$NODEDIR:/usr/bin:/bin:/usr/sbin</string></dict>
  <key>StandardOutPath</key><string>$PROJECT/automation/logs/bot.out.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/automation/logs/bot.err.log</string>
</dict></plist>
PLIST

# 2) 키워드 브리핑 (하루 1회: 10:00 — 오전에 골라 [✅승인] 시 즉시 게시. 예약·상한 없음)
write_plist com.allexishere.briefing <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.allexishere.briefing</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$PROJECT/automation/briefing.mjs</string></array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$NODEDIR:/usr/bin:/bin:/usr/sbin</string></dict>
  <key>StandardOutPath</key><string>$PROJECT/automation/logs/briefing.out.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/automation/logs/briefing.err.log</string>
</dict></plist>
PLIST

# 3) 워치독 (5분마다)
write_plist com.allexishere.watchdog <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.allexishere.watchdog</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$PROJECT/automation/watchdog.mjs</string></array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$NODEDIR:/usr/bin:/bin:/usr/sbin</string></dict>
  <key>StandardOutPath</key><string>$PROJECT/automation/logs/watchdog.out.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/automation/logs/watchdog.err.log</string>
</dict></plist>
PLIST

# 구버전(com.allexishere.generate) 정리
launchctl bootout "gui/$UID_NUM/com.allexishere.generate" 2>/dev/null || true
rm -f "$LA/com.allexishere.generate.plist"

echo "── launchd 등록(재적용) ──"
for L in com.allexishere.bot com.allexishere.briefing com.allexishere.watchdog; do
  launchctl bootout "gui/$UID_NUM/$L" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$LA/$L.plist"
  launchctl enable "gui/$UID_NUM/$L" || true
  echo "  ✅ $L 등록"
done

echo ""
echo "✅ 완료. 봇이 곧 시작 메시지를 보냅니다. 상태: launchctl print gui/$UID_NUM/com.allexishere.bot | grep state"
echo ""
echo "⚠️ 절전 방지(상주 필수) — sudo 필요, 아래를 직접 실행하세요:"
echo "   bash automation/pmset-check.sh    # 현재 상태 점검"
