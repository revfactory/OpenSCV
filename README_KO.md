# OpenSCV (Slack-ClaudeCode Vanguard)

슬랙에서 일하는 당신의 전천후 AI 건설 로봇

Slack에서 @멘션이나 DM으로 Claude Code CLI를 원격 실행하고, 결과를 Slack 스레드에 반환하는 봇.
Socket Mode를 사용하므로 공인 IP나 ngrok이 필요 없다.

> **⚠️ 실험용 베타 버전**
> 이 프로젝트는 초기 베타 단계입니다. 기능이 예고 없이 변경될 수 있으며, 예상치 못한 동작이 발생할 수 있습니다. 프로덕션 환경에서의 사용은 권장하지 않습니다. 사용에 따른 책임은 사용자에게 있습니다.

## 아키텍처

![Slack-Claude Bot 아키텍처](./docs/architecture_ko.png)

## 기술 스택

- @slack/bolt v4 (Socket Mode)
- TypeScript + tsx (개발 핫리로드)
- Claude Code CLI (native 바이너리 우선 탐색)
- child_process.spawn — 쉘 인젝션 방지

## 프로젝트 구조

```
OpenSCV/
├── package.json
├── tsconfig.json
├── config.json          # 채널-디렉토리 매핑, 권한, 타임아웃
├── .env.example         # 환경변수 템플릿
├── docs/
│   ├── bot.txt          # 봇 구현 계획서
│   └── slack-conf.txt   # Slack App 설정 가이드
└── src/
    ├── index.ts         # Bolt 앱 진입점, 이벤트 핸들러
    ├── claude.ts        # Claude CLI 실행 엔진
    ├── config.ts        # 설정 로딩, 채널 매핑, 권한 체크
    └── slack-helpers.ts # 메시지 분할, 마크다운 변환, 포맷팅
```

## 사전 준비

### 1. Slack App 생성

1. https://api.slack.com/apps 에서 Create New App > From scratch
2. App 이름(예: Claude Bot)과 Workspace 선택

### 2. Socket Mode 활성화

1. 좌측 메뉴 Socket Mode > Enable Socket Mode 활성화
2. Token Name 입력 > scope: connections:write > Generate
3. xapp- 으로 시작하는 App-Level Token 복사

### 3. Bot Token Scopes 설정

좌측 OAuth & Permissions > Bot Token Scopes에 추가:

| Scope | 용도 |
|---|---|
| app_mentions:read | @멘션 읽기 |
| chat:write | 메시지 전송 |
| files:write | 파일/이미지 업로드 |
| im:history | DM 히스토리 읽기 |
| im:read | DM 읽기 |
| im:write | DM 전송 |

### 4. Event Subscriptions 설정

좌측 Event Subscriptions > Enable Events 활성화

Subscribe to bot events에 추가:
- app_mention
- message.im

### 5. App 설치

좌측 Install App > Install to Workspace > 권한 승인
xoxb- 으로 시작하는 Bot Token 복사

### 6. DM 탭 활성화 (선택)

좌측 App Home > Messages Tab 체크
"Allow users to send Slash commands and messages from the messages tab" 체크

## 설치 및 실행

### Claude Code CLI 필요

이 봇은 로컬에 설치된 Claude Code CLI를 호출한다.
~/.local/bin/claude 에 native 바이너리가 있으면 우선 사용하고, 없으면 PATH에서 탐색한다.

### 설치

```bash
npm install
cp .env.example .env
```

.env 파일에 토큰 입력:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-level-token
```

### config.json 설정

```json
{
  "defaultDirectory": "/path/to/default/project",
  "channelDirectoryMap": {
    "C0123456789": "/path/to/project-a",
    "C9876543210": "/path/to/project-b"
  },
  "allowedUserIds": [],
  "claudeTimeout": 600000
}
```

| 필드 | 설명 |
|---|---|
| defaultDirectory | 매핑되지 않은 채널에서 사용할 기본 디렉토리 |
| channelDirectoryMap | 채널 ID > 프로젝트 경로 매핑 |
| allowedUserIds | 허용 사용자 ID 목록 (빈 배열 = 전원 허용) |
| claudeTimeout | Claude CLI 타임아웃 ms (기본 600000 = 10분) |

채널 ID 찾는 법: Slack에서 채널 이름 클릭 > 팝업 하단에 C로 시작하는 ID 표시

### 실행

```bash
# 개발 모드 (핫리로드)
npm run dev

# 프로덕션
npm run build
npm start
```

## 사용법

### 채널에서 @멘션

```
@bot 이 프로젝트의 구조를 설명해줘
@bot src/index.ts 파일의 버그를 찾아줘
```

### DM

봇에게 직접 메시지를 보내면 defaultDirectory 기준으로 실행된다.

```
package.json의 의존성을 분석해줘
```

## 동작 흐름

1. 사용자가 @멘션 또는 DM 전송
2. 봇이 진행 상태 메시지 표시 (5초마다 순환)
   - 🤔 생각 중...
   - 📖 자료 분석 중...
   - 🔍 정보 수집 중...
   - ✍️ 답변 작성 중...
   - 🧠 내용 정리 중...
   - 📝 최종 검토 중...
3. 해당 채널에 매핑된 디렉토리에서 Claude CLI 실행
4. 마크다운 출력을 일반 텍스트로 변환
5. 결과를 스레드에 응답 (2500자 초과 시 분할, 4000자 초과 시 자동 truncate)

## 주요 기능

### Claude CLI 실행 (claude.ts)

- ~/.local/bin/claude (native 바이너리) 우선 탐색
- CLAUDE 관련 환경변수 자동 제거 (중첩 세션 감지 방지)
- 실행 플래그: -p, --output-format text, --add-dir, --dangerously-skip-permissions
- 이중 타임아웃: spawn 옵션 + 수동 setTimeout (SIGTERM > SIGKILL)
- 30초마다 진행 상태 heartbeat 로그

### 메시지 처리 (slack-helpers.ts)

- 마크다운 > 일반 텍스트 변환 (Slack은 마크다운 미지원)
  - 코드블록, 인라인 코드, 볼드, 이탤릭, 헤더, 링크, 이미지, 인용 처리
- 2500자 기준 메시지 분할 (줄바꿈 > 공백 > 강제 분할)
- 메타데이터 footer (작업 디렉토리, 소요시간, 타임아웃 여부)

### 안전장치 (index.ts)

- safeSend: msg_too_long 에러 시 자동 truncate 후 재시도
- 중복 이벤트 방지 (Set 기반 deduplication, 5분 후 자동 정리)
- 사용자 권한 체크
- 봇 메시지 무시 (무한 루프 방지)

## 로그

봇 실행 시 각 단계별 상세 로그가 출력된다:

```
[Native Claude] 경로: /Users/robin/.local/bin/claude
[Native Claude] 버전: 2.1.50 (Claude Code)
⚡ Slack-Claude bot is running (Socket Mode)
[멘션 수신] channel=C0AG9T8BWDU, user=U0AG5GD9E9H, ts=...
[멘션 처리] user=..., prompt="...", directory=...
[Claude 호출] prompt="..."
[Claude 프로세스] PID=12345
[Claude stdout] +1234자
[Claude 종료] exitCode=0, 소요=5000ms
[멘션 응답] 분할 메시지 수: 1
[멘션 완료] channel=..., user=...
```

## 저작자

Minho Hwang (revfactory@gmail.com)

## 라이선스

[MIT](./LICENSE)
