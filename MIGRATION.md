# 자동화 파이프라인 이전 가이드 (맥북 → 맥미니)

이 문서는 상주형 트렌드 초안 파이프라인(텔레그램 봇 + 자동 생성 + 워치독)을 새 맥으로 옮길 때의 순서입니다. 코드는 저장소에 있으니, **비밀값(.env)만 안전하게 옮기면** 됩니다.

## 0. 준비물 (새 맥)
- Node (현재 맥과 같은 계열 권장; `node -v` 로 확인)
- git, Xcode Command Line Tools (`xcode-select --install`)
- 이 저장소 클론: `git clone <repo> ~/Projects/allexishere-blog`

## 1. 저장소 + 의존성
```bash
cd ~/Projects/allexishere-blog
npm install
```

## 2. 비밀값 옮기기 (유일하게 git 에 없는 것)
`automation/.env` 는 저장소에 올라가지 않습니다. 기존 맥에서 새 맥으로 **직접 복사**하세요(에어드롭/USB/scp 등). 내용:
```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
ANTHROPIC_API_KEY=...
```
> 봇 토큰은 그대로 재사용하면 됩니다(봇은 하나). 두 맥에서 **동시에** 봇을 켜지 마세요(텔레그램 롱폴링이 충돌). 이전이 끝나면 기존 맥의 launchd 봇을 내리세요:
> `launchctl bootout gui/$(id -u)/com.allexishere.bot`

## 3. 상주 등록 (launchd 3종)
```bash
bash automation/setup.sh
```
- `com.allexishere.bot` (RunAtLoad + KeepAlive: 로그인 시 실행, 죽으면 자동 재시작)
- `com.allexishere.generate` (평일 08:00 자동 초안)
- `com.allexishere.watchdog` (5분마다 하트비트 점검)

경로(node·프로젝트·uid)는 스크립트가 현재 머신 기준으로 자동 계산합니다 — 맥미니에서도 그대로 동작.

## 4. 절전 방지 (상주 필수)
```bash
bash automation/pmset-check.sh
```
안내되는 `sudo pmset -c ...` 명령을 직접 실행하세요. 맥미니는 뚜껑이 없어 클램셸 이슈가 없습니다(전원만 연결).

## 5. 재부팅 무인 복구
- 시스템 설정 → 사용자 및 그룹 → **자동 로그인** 켜기 (안 켜면 재부팅 후 1회 로그인 필요).

## 6. 확인
- 텔레그램에 "🤖 봇 시작됨" 수신 → `/status` 응답 확인.
- 로그: `automation/logs/bot.err.log`, `.../generate.err.log`, `.../watchdog.err.log`
- launchd 상태: `launchctl print gui/$(id -u)/com.allexishere.bot | grep state`

## 참고: 운영 명령
| 작업 | 명령 |
|---|---|
| 봇 수동 재시작 | `launchctl kickstart -k gui/$(id -u)/com.allexishere.bot` |
| 봇 내리기 | `launchctl bootout gui/$(id -u)/com.allexishere.bot` |
| 즉시 초안 생성 테스트 | `node automation/generate.mjs` (또는 텔레그램 `/draft`) |
| chat id 재확인 | `node automation/getchatid.mjs` |
| 비용 로그 | `automation/state/cost-log.jsonl` |

## 대원칙 (변경 금지)
- 생성 = AI, **게시 = 사람 승인**(텔레그램 [✅승인] 또는 편집기 [발행하기])만.
- 승인 없는 자동 게시 경로는 존재하지 않습니다(게시는 오직 `automation/publish.mjs` 한 경로, 파일 락으로 직렬화).
