# launchd 스케줄 (버전관리 사본)

이 디렉터리의 `*.plist` 는 실제 동작하는 `~/Library/LaunchAgents/com.allexishere.*.plist`
의 **사본**이다. 목적은 재현성 — 맥 고장·기기 이전 시 스케줄을 그대로 복구하기 위함.

> 🔴 **이 사본만으로는 활성화되지 않는다.** launchd 는 `~/Library/LaunchAgents/` 만 읽는다.
> 아래 절차로 복사(또는 심볼릭 링크) 후 `launchctl bootstrap` 해야 실제로 돈다.

## 활성화 (새 기기·재설치 시)

```sh
# 1) 사본을 LaunchAgents 로 (복사 또는 심볼릭 링크 중 택1)
cp automation/launchd/com.allexishere.*.plist ~/Library/LaunchAgents/
#   또는: for f in automation/launchd/com.allexishere.*.plist; do ln -sf "$PWD/$f" ~/Library/LaunchAgents/; done

# 2) launchd 에 등록
for f in ~/Library/LaunchAgents/com.allexishere.*.plist; do
  launchctl bootstrap gui/$(id -u) "$f"
done

# 3) 확인
launchctl list | grep allexishere
```

재시작은 `launchctl kickstart -k gui/$(id -u)/com.allexishere.<job>`.
제거는 `launchctl bootout gui/$(id -u)/com.allexishere.<job>`.

## ⚠️ 경로가 하드코딩돼 있다 — 기기 이전 시 확인

plist 는 launchd 특성상 절대경로를 쓴다. 아래가 새 기기와 다르면 **plist 를 수정**해야 한다:

- 사용자 홈: `/Users/jeonghunoh/...` (사용자명이 다르면 전부 치환)
- Node 경로: `/opt/homebrew/bin/node` (Intel 맥·다른 설치는 `which node` 로 확인)

## 비밀은 없다

plist 에는 토큰·API 키가 **없다**(환경변수는 `PATH` 뿐). 비밀은 실행 시
`automation/.env` · `automation/secrets/` 에서 로드되며 둘 다 `.gitignore` 대상이다.
→ 이 디렉터리를 커밋해도 크리덴셜은 새지 않는다.

## 스케줄 표

| Job | Label | 주기 |
|---|---|---|
| 성과 분석가 | `com.allexishere.analyst` | 매일 08:00 |
| SEO 감시자 | `com.allexishere.seo` | 매주 월 09:00 |
| 브리핑 | `com.allexishere.briefing` | 매일 10:00 |
| 큐레이터 | `com.allexishere.curator` | 매주 월 10:30 |
| 품질 검토 | `com.allexishere.quality` | 매주 목 09:00 |
| 봇(폴링 데몬) | `com.allexishere.bot` | 상주(RunAtLoad+KeepAlive) |
| 워치독 | `com.allexishere.watchdog` | 5분마다(StartInterval 300) |

> 사본 갱신: `~/Library/LaunchAgents/` 의 plist 를 바꾸면 이 디렉터리로도 다시 복사해 커밋한다.
