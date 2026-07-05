#!/usr/bin/env bash
# 24시간 상주에 적합한 절전 설정인지 점검하고, 아니면 적용 명령을 안내합니다.
echo "=== 현재 전원/절전 설정 (pmset -g custom) ==="
pmset -g custom 2>/dev/null | sed -n '1,40p'

echo ""
echo "=== 상주 적합성 판정 (전원 연결 = AC 기준) ==="
# AC 블록만 파싱
AC="$(pmset -g custom 2>/dev/null | awk '/^AC Power:/{f=1;next}/^Battery Power:/{f=0}f')"
get() { echo "$AC" | grep -iE "^[[:space:]]*$1[[:space:]]" | awk '{print $2}' | head -1; }
SLEEP="$(get sleep)"; DISABLE="$(get disablesleep)"; DISP="$(get displaysleep)"

ok=1
if [ "${DISABLE:-0}" = "1" ]; then
  echo "✅ disablesleep=1 → 시스템 잠자기 완전 차단(상주 OK)"
elif [ "${SLEEP:-1}" = "0" ]; then
  echo "✅ sleep=0 → 전원 연결 시 시스템 잠자기 안 함(상주 OK)"
else
  echo "❌ sleep=${SLEEP:-?} → 유휴 시 잠자기함. 상주 중 봇이 멈출 수 있습니다."
  ok=0
fi
echo "ℹ️ displaysleep=${DISP:-?} (0=화면도 안꺼짐 / 10 등=화면만 끔 — 화면만 끄는 건 상주에 문제 없음)"

echo ""
if [ "$ok" = "0" ]; then
  echo "=== 적용 명령 (sudo 필요 — 직접 실행) ==="
  echo "  sudo pmset -c sleep 0          # 전원 연결 시 시스템 잠자기 끔(가장 중요)"
  echo "  sudo pmset -c displaysleep 10  # 화면만 10분 뒤 끄기(전기·수명 절약, 상주엔 무해)"
  echo "  sudo pmset -c disablesleep 1   # (선택) 잠자기 완전 차단 — 뚜껑 닫아도 안 잠"
else
  echo "현재 설정은 상주에 적합합니다. 추가 조치 불필요."
fi

echo ""
echo "=== ⚠️ 노트북(맥북) 뚜껑(클램셸) 주의 ==="
echo "• 뚜껑을 닫으면 기본적으로 잠자기(클램셸 슬립)합니다. 상주하려면 셋 중 하나:"
echo "   1) 뚜껑을 열어둔다(가장 간단·안전)"
echo "   2) sudo pmset -c disablesleep 1  로 잠자기 자체를 차단"
echo "   3) 외부 전원+외부 디스플레이+키보드/마우스 연결 상태로 뚜껑 닫기(클램셸 모드)"
echo "• 맥미니는 뚜껑이 없어 이 문제 없음(전원만 연결하면 됨)."
echo ""
echo "=== 재부팅 후 자동 복구 ==="
echo "• launchd 는 '로그인 시' 실행됩니다. 재부팅 후 무인 복구하려면 '자동 로그인'을 켜세요:"
echo "   시스템 설정 → 사용자 및 그룹 → 자동 로그인 → 본인 계정."
echo "• 자동 로그인을 안 켜면, 재부팅 후 한 번 로그인해야 봇이 다시 뜹니다."
