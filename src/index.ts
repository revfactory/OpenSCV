import "dotenv/config";
import { App, LogLevel } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { loadConfig, getDirectoryForChannel, isUserAllowed } from "./config";
import { runClaudeStream, validatePrompt, getToolLabel } from "./claude";
import type { ClaudeStreamEvent } from "./claude";
import fs from "fs";
import path from "path";
import { stripMention, formatResult, snapshotFiles, findNewImages, extractImagePaths } from "./slack-helpers";

// #4: 환경변수 필수 검증
const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;

if (!botToken || !appToken) {
  console.error("❌ SLACK_BOT_TOKEN 또는 SLACK_APP_TOKEN이 설정되지 않았습니다");
  console.error("   .env 파일을 확인하세요.");
  process.exit(1);
}

const config = loadConfig();

// #17: 로그 레벨 환경별 설정
const isDev = process.env.NODE_ENV !== "production";
const logLevel = isDev ? LogLevel.INFO : LogLevel.WARN;

const app = new App({
  token: botToken,
  appToken: appToken,
  socketMode: true,
  logLevel,
});

// #6: 전역 에러 핸들러
process.on("unhandledRejection", (reason) => {
  console.error("[전역] Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[전역] Uncaught Exception:", error.message);
});

// Slack 메시지 전송 (#5: 에러 정보 노출 방지)
async function safeSend(
  client: WebClient,
  channel: string,
  text: string,
  opts: { thread_ts?: string; update_ts?: string } = {}
): Promise<void> {
  const MAX = 3900;
  const truncated = text.length > MAX
    ? text.substring(0, MAX) + "\n...(truncated)"
    : text;

  try {
    if (opts.update_ts) {
      await client.chat.update({ channel, ts: opts.update_ts, text: truncated });
    } else {
      await client.chat.postMessage({ channel, thread_ts: opts.thread_ts, text: truncated });
    }
  } catch (err: unknown) {
    const slackErr = err as { data?: { error?: string } };
    if (slackErr?.data?.error === "msg_too_long") {
      console.warn(`[Slack] msg_too_long, 재시도`);
      const shorter = truncated.substring(0, 2000) + "\n...(메시지가 너무 길어 잘렸습니다)";
      if (opts.update_ts) {
        await client.chat.update({ channel, ts: opts.update_ts, text: shorter });
      } else {
        await client.chat.postMessage({ channel, thread_ts: opts.thread_ts, text: shorter });
      }
    } else {
      console.error(`[Slack] 메시지 전송 실패: ${err instanceof Error ? err.message : "알 수 없는 오류"}`);
    }
  }
}

// 이미지 파일 업로드
async function uploadImages(
  client: WebClient,
  channel: string,
  threadTs: string,
  imagePaths: string[]
): Promise<number> {
  let uploaded = 0;
  for (const imgPath of imagePaths) {
    try {
      const fileData = fs.readFileSync(imgPath);
      const filename = path.basename(imgPath);
      console.log(`[파일 업로드 시도] ${filename} (${fileData.length} bytes)`);
      await client.files.uploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file: fileData,
        filename,
        title: filename,
      });
      uploaded++;
      console.log(`[파일 업로드 성공] ${filename}`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "알 수 없는 오류";
      console.error(`[파일 업로드 실패] ${imgPath}: ${errMsg}`);
      if (errMsg.includes("missing_scope") || errMsg.includes("not_allowed")) {
        try {
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `⚠️ 파일 업로드 권한이 없습니다. Slack App에 files:write scope를 추가하세요.`,
          });
        } catch { /* 무시 */ }
        break;
      }
    }
  }
  return uploaded;
}

// ────────────────────────────────────────────────
// 스트리밍 Slack 업데이터 (고정 인터벌 방식)
// ────────────────────────────────────────────────
const FLUSH_INTERVAL_MS = 2000; // 2초마다 Slack 업데이트
const MAX_PREVIEW_LEN = 3500;

interface StreamUpdater {
  onEvent: (event: ClaudeStreamEvent) => void;
  cleanup: () => void;
}

function createStreamUpdater(
  client: WebClient,
  channel: string,
  messageTs: string
): StreamUpdater {
  let accumulatedText = "";
  let statusLine = "🤔 생각 중...";
  const toolHistory: string[] = [];
  let dirty = true; // 변경 발생 플래그
  let flushing = false;
  let stopped = false;

  function buildMessage(): string {
    const parts: string[] = [];

    // 도구 사용 이력 (상단)
    if (toolHistory.length > 0) {
      parts.push(toolHistory.join("\n"));
    }

    // 현재 상태 라인
    parts.push(statusLine);

    // 텍스트 미리보기 (하단)
    if (accumulatedText) {
      const preview = accumulatedText.length > MAX_PREVIEW_LEN
        ? "...\n" + accumulatedText.slice(-MAX_PREVIEW_LEN)
        : accumulatedText;
      parts.push("────────────");
      parts.push(preview);
    }

    return parts.join("\n").substring(0, 3900);
  }

  // 고정 인터벌: 2초마다 dirty 체크 후 flush
  const intervalTimer = setInterval(async () => {
    if (stopped || !dirty || flushing) return;
    dirty = false;
    flushing = true;
    try {
      const msg = buildMessage();
      console.log(`[스트림 업데이트] 텍스트=${accumulatedText.length}자, 도구이력=${toolHistory.length}건, 상태="${statusLine}"`);
      await client.chat.update({ channel, ts: messageTs, text: msg });
    } catch (err) {
      console.log(`[스트림 업데이트 실패] ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      flushing = false;
    }
  }, FLUSH_INTERVAL_MS);

  return {
    onEvent(event: ClaudeStreamEvent): void {
      if (stopped) return;
      switch (event.type) {
        case "thinking":
          statusLine = "🧠 생각 중...";
          dirty = true;
          break;
        case "tool_use": {
          const label = getToolLabel(event.toolName);
          statusLine = `🔧 ${label} 중...`;
          dirty = true;
          break;
        }
        case "tool_result": {
          const label = getToolLabel(event.toolName);
          const dur = event.durationSec ? ` (${Math.round(event.durationSec)}초)` : "";
          toolHistory.push(`✅ ${label} 완료${dur}`);
          statusLine = "🤔 분석 중...";
          dirty = true;
          break;
        }
        case "text_delta":
          accumulatedText = event.accumulated;
          statusLine = "✍️ 답변 작성 중...";
          dirty = true;
          break;
        case "complete":
          stopped = true;
          break;
      }
    },

    cleanup(): void {
      stopped = true;
      clearInterval(intervalTimer);
    },
  };
}

// #10: 중복 이벤트 방지 (크기 제한 + Map으로 개선)
const MAX_CACHE_SIZE = 10000;
const processed = new Map<string, number>();

function isDuplicate(key: string): boolean {
  if (processed.has(key)) return true;
  processed.set(key, Date.now());

  if (processed.size > MAX_CACHE_SIZE) {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [k, ts] of processed) {
      if (ts < cutoff) processed.delete(k);
    }
  }

  setTimeout(() => processed.delete(key), 5 * 60 * 1000);
  return false;
}

// #7: 프롬프트 마스킹 (로그용)
function maskPrompt(prompt: string, len = 20): string {
  if (!isDev) return `[${prompt.length}자]`;
  if (prompt.length <= len) return prompt;
  return prompt.substring(0, len) + "...";
}

// ────────────────────────────────────────────────
// 공통 핸들러: 멘션 & DM 모두 사용
// ────────────────────────────────────────────────
async function handleClaudeRequest(
  client: WebClient,
  channel: string,
  threadTs: string,
  prompt: string,
  directory: string,
  label: string
): Promise<void> {
  // 이미지 감지용 스냅샷
  const filesBefore = snapshotFiles(directory);

  // 초기 메시지 전송
  const thinking = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "🤔 생각 중...",
  });

  if (!thinking.ts) {
    console.error(`[${label}] 초기 메시지 ts 없음`);
    return;
  }

  // 스트리밍 업데이터 생성
  const updater = createStreamUpdater(client, channel, thinking.ts);

  try {
    const result = await runClaudeStream(
      prompt,
      directory,
      config.claudeTimeout,
      (event) => updater.onEvent(event)
    );

    updater.cleanup();

    console.log(`[Claude 응답] 소요=${result.durationMs}ms, 길이=${result.output.length}, 타임아웃=${result.timedOut}, 비용=$${result.costUsd?.toFixed(4) || "N/A"}, 턴=${result.numTurns || "N/A"}`);

    // 최종 결과 포맷팅
    const messages = formatResult(result, directory);

    // 첫 번째 메시지로 기존 "생각 중" 메시지 업데이트
    await safeSend(client, channel, messages[0], { update_ts: thinking.ts });

    // 나머지 메시지는 스레드에 추가
    for (let i = 1; i < messages.length; i++) {
      await safeSend(client, channel, messages[i], { thread_ts: threadTs });
    }

    // 새로 생성된 이미지 파일 업로드
    const newImages = findNewImages(filesBefore, directory);
    const outputImages = extractImagePaths(result.output);
    const allImages = [...new Set([...newImages, ...outputImages])];
    console.log(`[${label} 이미지] 디렉토리: ${newImages.length}개, 출력파싱: ${outputImages.length}개, 총: ${allImages.length}개`);
    if (allImages.length > 0) {
      const uploaded = await uploadImages(client, channel, threadTs, allImages);
      console.log(`[${label} 이미지 업로드] ${uploaded}/${allImages.length}개 성공`);
    }

    console.log(`[${label} 완료] 메시지 ${messages.length}건, 이미지 ${allImages.length}건`);
  } catch (error) {
    updater.cleanup();
    throw error;
  }
}

// @멘션 이벤트 처리
app.event("app_mention", async ({ event, client }) => {
  console.log(`[멘션 수신] channel=${event.channel}, user=${event.user}`);

  const key = `${event.channel}-${event.ts}`;
  if (isDuplicate(key)) {
    console.log(`[멘션 무시] 중복 이벤트`);
    return;
  }

  const userId = event.user;
  if (!userId) return;

  try {
    if (!isUserAllowed(userId)) {
      console.log(`[멘션 차단] 권한 없음: ${userId}`);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "⛔ 권한이 없습니다. config.json의 allowedUserIds를 확인하세요.",
      });
      return;
    }

    const prompt = stripMention(event.text);
    if (!prompt) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "프롬프트를 입력해주세요. 예: `@bot 이 프로젝트의 구조를 설명해줘`",
      });
      return;
    }

    const validationError = validatePrompt(prompt);
    if (validationError) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `⚠️ ${validationError}`,
      });
      return;
    }

    const directory = getDirectoryForChannel(event.channel);
    console.log(`[멘션 처리] user=${userId}, prompt=${maskPrompt(prompt)}, dir=${directory}`);

    await handleClaudeRequest(client, event.channel, event.ts, prompt, directory, "멘션");
  } catch (error: unknown) {
    console.error(`[멘션 에러] ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    try {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "⚠️ 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
      });
    } catch {
      // 무시
    }
  }
});

// DM 이벤트 처리
app.event("message", async ({ event, client }) => {
  if (
    !("channel_type" in event) ||
    event.channel_type !== "im" ||
    event.subtype === "bot_message" ||
    "bot_id" in event
  ) {
    return;
  }

  console.log(`[DM 수신] channel=${event.channel}`);

  const key = `${event.channel}-${event.ts}`;
  if (isDuplicate(key)) {
    console.log(`[DM 무시] 중복 이벤트`);
    return;
  }

  const userId = "user" in event ? event.user : undefined;
  if (!userId) return;

  try {
    if (!isUserAllowed(userId)) {
      console.log(`[DM 차단] 권한 없음: ${userId}`);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "⛔ 권한이 없습니다.",
      });
      return;
    }

    const prompt = "text" in event ? (event.text || "") : "";
    if (!prompt.trim()) return;

    const validationError = validatePrompt(prompt);
    if (validationError) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `⚠️ ${validationError}`,
      });
      return;
    }

    const directory = getDirectoryForChannel(event.channel);
    console.log(`[DM 처리] user=${userId}, prompt=${maskPrompt(prompt)}, dir=${directory}`);

    await handleClaudeRequest(client, event.channel, event.ts, prompt, directory, "DM");
  } catch (error: unknown) {
    console.error(`[DM 에러] ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    try {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "⚠️ 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
      });
    } catch {
      // 무시
    }
  }
});

(async () => {
  await app.start();
  console.log("⚡ Slack-Claude bot is running (Socket Mode) [Stream Mode]");
  console.log(`📂 Default directory: ${config.defaultDirectory}`);
  console.log(`🔗 Channel mappings: ${Object.keys(config.channelDirectoryMap).length}`);
  console.log(`👤 Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.length + "명"}`);
  console.log(`🔧 Environment: ${isDev ? "development" : "production"}`);
})();
