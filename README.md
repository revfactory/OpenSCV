# OpenSCV (Slack-ClaudeCode Vanguard)

Your versatile AI construction bot working in Slack

A Slack bot that remotely executes Claude Code CLI via @mentions or DMs and returns results in Slack threads.
Uses Socket Mode — no public IP or ngrok required.

### Highlights

- **Slack as Interface** — Run Claude Code from any Slack channel or DM via @mention
- **Per-Channel Project Mapping** — Each channel maps to a different project directory
- **Socket Mode** — No public IP or ngrok needed
- **Shell Injection Safe** — Uses `child_process.spawn`, not shell execution
- **Smart Message Handling** — Auto-splits long responses, markdown-to-text conversion
- **Built-in Safety** — Dual timeout, deduplication, user permission control, infinite loop prevention

> **⚠️ Experimental Beta**
> This project is in early beta. Features may change without notice, and unexpected behavior may occur. Not recommended for production use. Use at your own risk.

[한국어 문서](./README_KO.md)

## Architecture

![Slack-Claude Bot Architecture](./docs/architecture.png)

## Tech Stack

- @slack/bolt v4 (Socket Mode)
- TypeScript + tsx (dev hot-reload)
- Claude Code CLI (native binary preferred)
- child_process.spawn — prevents shell injection

## Project Structure

```
OpenSCV/
├── package.json
├── tsconfig.json
├── config.json          # Channel-directory mapping, permissions, timeout
├── .env.example         # Environment variable template
├── docs/
│   ├── bot.txt          # Bot implementation plan
│   └── slack-conf.txt   # Slack App setup guide
└── src/
    ├── index.ts         # Bolt app entry point, event handlers
    ├── claude.ts        # Claude CLI execution engine
    ├── config.ts        # Config loading, channel mapping, permission check
    └── slack-helpers.ts # Message splitting, markdown conversion, formatting
```

## Prerequisites

### 1. Create Slack App

1. Go to https://api.slack.com/apps > Create New App > From scratch
2. Choose an app name (e.g., Claude Bot) and select your workspace

### 2. Enable Socket Mode

1. Left menu: Socket Mode > Enable Socket Mode
2. Enter a Token Name > scope: connections:write > Generate
3. Copy the App-Level Token starting with xapp-

### 3. Bot Token Scopes

Left menu: OAuth & Permissions > Add these Bot Token Scopes:

| Scope | Purpose |
|---|---|
| app_mentions:read | Read @mentions |
| chat:write | Send messages |
| files:write | Upload files/images |
| im:history | Read DM history |
| im:read | Read DMs |
| im:write | Send DMs |

### 4. Event Subscriptions

Left menu: Event Subscriptions > Enable Events

Subscribe to bot events:
- app_mention
- message.im

### 5. Install App

Left menu: Install App > Install to Workspace > Approve permissions
Copy the Bot Token starting with xoxb-

### 6. Enable DM Tab (Optional)

Left menu: App Home > Check Messages Tab
Check "Allow users to send Slash commands and messages from the messages tab"

## Installation

### Claude Code CLI Required

This bot invokes the locally installed Claude Code CLI.
It prefers the native binary at ~/.local/bin/claude, falling back to PATH lookup.

### Setup

```bash
npm install
cp .env.example .env
```

Edit .env with your tokens:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-level-token
```

### config.json

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

| Field | Description |
|---|---|
| defaultDirectory | Default directory for unmapped channels |
| channelDirectoryMap | Channel ID to project path mapping |
| allowedUserIds | Allowed user IDs (empty array = allow all) |
| claudeTimeout | Claude CLI timeout in ms (default 600000 = 10 min) |

Finding Channel ID: Click a channel name in Slack > ID starting with C is shown at the bottom of the popup

### Run

```bash
# Development (hot-reload)
npm run dev

# Production
npm run build
npm start
```

## Screenshots

### @Mention & Progress Indicator
![OpenSCV @mention and progress](./docs/OpenSCV_01.png)

### Thread Response Streaming
![OpenSCV thread response](./docs/OpenSCV_02.png)

### Full Channel View
![OpenSCV full channel view](./docs/OpenSCV_03.png)

### Source Links & Image Generation Request
![OpenSCV source links and image generation](./docs/OpenSCV_04.png)

### Image Generation Result
![OpenSCV image generation result](./docs/OpenSCV_05.png)

## Usage

### @Mention in a Channel

```
@bot explain the project structure
@bot find bugs in src/index.ts
```

### Direct Message

Send a message directly to the bot. It runs against the defaultDirectory.

```
analyze the dependencies in package.json
```

## How It Works

1. User sends an @mention or DM
2. Bot shows a rotating progress indicator (every 5 seconds)
   - 🤔 Thinking...
   - 📖 Analyzing...
   - 🔍 Gathering info...
   - ✍️ Writing response...
   - 🧠 Organizing...
   - 📝 Final review...
3. Executes Claude CLI in the directory mapped to the channel
4. Converts markdown output to plain text
5. Replies in thread (splits at 2500 chars, auto-truncates at 4000 chars)

## Key Features

### Claude CLI Execution (claude.ts)

- Prefers native binary at ~/.local/bin/claude
- Strips all CLAUDE* environment variables (prevents nested session detection)
- CLI flags: -p, --output-format text, --add-dir, --dangerously-skip-permissions
- Dual timeout: spawn option + manual setTimeout (SIGTERM then SIGKILL)
- Heartbeat log every 30 seconds during execution

### Message Handling (slack-helpers.ts)

- Markdown to plain text conversion (Slack does not render markdown)
  - Strips code blocks, inline code, bold, italic, headers, links, images, blockquotes
- Splits messages at 2500 chars (by newline > space > forced split)
- Metadata footer (working directory, duration, timeout status)

### Safety (index.ts)

- safeSend: auto-truncates and retries on msg_too_long errors
- Deduplication via Set (channel-ts key, auto-cleanup after 5 min)
- User permission check
- Ignores bot messages (prevents infinite loops)

## Logs

Detailed logs are printed at each step:

```
[Native Claude] path: /Users/robin/.local/bin/claude
[Native Claude] version: 2.1.50 (Claude Code)
⚡ Slack-Claude bot is running (Socket Mode)
[mention received] channel=C0AG9T8BWDU, user=U0AG5GD9E9H, ts=...
[mention process] user=..., prompt="...", directory=...
[Claude call] prompt="..."
[Claude process] PID=12345
[Claude stdout] +1234 chars
[Claude exit] exitCode=0, duration=5000ms
[mention response] split messages: 1
[mention done] channel=..., user=...
```

## Author

Minho Hwang (revfactory@gmail.com)

## License

[MIT](./LICENSE)
