import { spawn, ChildProcess, execSync } from "child_process";
import { createInterface } from "readline";

export interface ClaudeResult {
  success: boolean;
  output: string;
  timedOut: boolean;
  exitCode: number | null;
  durationMs: number;
  costUsd?: number;
  numTurns?: number;
}

// 스트림 이벤트 타입
export type ClaudeStreamEvent =
  | { type: "thinking" }
  | { type: "text_delta"; text: string; accumulated: string }
  | { type: "tool_use"; toolName: string }
  | { type: "tool_result"; toolName: string; durationSec?: number }
  | { type: "complete"; result: ClaudeResult };

// #2: 프롬프트 입력 검증
const MAX_PROMPT_LENGTH = 10000;
const FORBIDDEN_PATTERNS = /--dangerously|--system-prompt|--unsafe|--allowedTools|--disallowedTools/gi;

export function sanitizePrompt(prompt: string): string {
  let sanitized = prompt.substring(0, MAX_PROMPT_LENGTH);
  sanitized = sanitized.replace(/(?:^|\s)--[\w-]+/g, (match) => match.replace(/--/, ""));
  return sanitized.trim();
}

export function validatePrompt(prompt: string): string | null {
  if (FORBIDDEN_PATTERNS.test(prompt)) {
    return "프롬프트에 금지된 패턴이 포함되어 있습니다";
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return `프롬프트가 너무 깁니다 (최대 ${MAX_PROMPT_LENGTH}자)`;
  }
  return null;
}

// #15: HOME 환경변수 fallback
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "/tmp";

// native claude 바이너리 우선 탐색
const CLAUDE_PATH = (() => {
  const nativePath = `${HOME_DIR}/.local/bin/claude`;
  try {
    const ver = execSync(`${nativePath} --version 2>&1`, { encoding: "utf-8" }).trim();
    console.log(`[Native Claude] 경로: ${nativePath}`);
    console.log(`[Native Claude] 버전: ${ver}`);
    return nativePath;
  } catch {
    try {
      const p = execSync("which claude", { encoding: "utf-8" }).trim();
      const ver = execSync(`${p} --version 2>&1`, { encoding: "utf-8" }).trim();
      console.warn(`[Claude CLI] native 없음, fallback 경로: ${p}`);
      console.warn(`[Claude CLI] 버전: ${ver}`);
      return p;
    } catch {
      console.warn(`[Claude CLI] 경로 탐색 실패, 기본값 "claude" 사용`);
      return "claude";
    }
  }
})();

// 도구 이름 → 한글 설명 매핑
const TOOL_LABELS: Record<string, string> = {
  WebSearch: "웹 검색",
  WebFetch: "웹 페이지 읽기",
  Read: "파일 읽기",
  Edit: "파일 수정",
  Write: "파일 생성",
  Bash: "명령어 실행",
  Glob: "파일 탐색",
  Grep: "코드 검색",
  Task: "에이전트 작업",
  NotebookEdit: "노트북 수정",
};

function getToolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] || toolName;
}

// 스트림 JSON 라인 파서
function parseStreamLine(
  line: string,
  state: { accumulatedText: string; currentToolName: string | null; isThinking: boolean },
  onEvent: (event: ClaudeStreamEvent) => void
): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }

  const type = parsed.type as string;

  // stream_event 처리
  if (type === "stream_event") {
    const event = parsed.event as Record<string, unknown>;
    if (!event) return;
    const eventType = event.type as string;

    if (eventType === "content_block_start") {
      const block = event.content_block as Record<string, unknown>;
      if (!block) return;

      if (block.type === "thinking" && !state.isThinking) {
        state.isThinking = true;
        console.log(`[스트림 파서] thinking 시작`);
        onEvent({ type: "thinking" });
      } else if (block.type === "tool_use") {
        const toolName = (block.name as string) || "unknown_tool";
        state.currentToolName = toolName;
        console.log(`[스트림 파서] 도구 사용: ${toolName} → ${getToolLabel(toolName)}`);
        onEvent({ type: "tool_use", toolName });
      } else if (block.type === "text") {
        state.isThinking = false;
        console.log(`[스트림 파서] 텍스트 블록 시작`);
      }
    } else if (eventType === "content_block_delta") {
      const delta = event.delta as Record<string, unknown>;
      if (!delta) return;

      if (delta.type === "text_delta") {
        const text = delta.text as string;
        const waEmpty = state.accumulatedText.length === 0;
        state.accumulatedText += text;
        state.isThinking = false;
        if (waEmpty) {
          console.log(`[스트림 파서] 첫 text_delta 수신: "${text.substring(0, 30)}..."`);
        }
        onEvent({ type: "text_delta", text, accumulated: state.accumulatedText });
      }
    }
  }

  // assistant 메시지에서 tool_use 감지 (stream_event에서 못 잡은 경우 보완)
  if (type === "assistant") {
    const message = parsed.message as Record<string, unknown>;
    if (message) {
      const content = message.content as Array<Record<string, unknown>>;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" && block.name) {
            const toolName = block.name as string;
            // stream_event에서 이미 감지한 경우 중복 방지
            if (state.currentToolName !== toolName) {
              state.currentToolName = toolName;
              console.log(`[스트림 파서] assistant 도구 감지: ${toolName} → ${getToolLabel(toolName)}`);
              onEvent({ type: "tool_use", toolName });
            }
          }
        }
      }
    }
  }

  // tool result (user 타입 - 도구 결과 반환)
  if (type === "user") {
    const message = parsed.message as Record<string, unknown>;
    if (message) {
      const content = message.content as Array<Record<string, unknown>>;
      if (Array.isArray(content) && content.length > 0 && content[0].type === "tool_result") {
        const toolResult = parsed.tool_use_result as Record<string, unknown>;
        const durationSec = toolResult?.durationSeconds as number | undefined;
        const toolName = state.currentToolName || "도구";
        console.log(`[스트림 파서] 도구 결과: ${toolName} → ${getToolLabel(toolName)}, 소요=${durationSec ? Math.round(durationSec) + "초" : "N/A"}`);
        onEvent({
          type: "tool_result",
          toolName,
          durationSec,
        });
        state.currentToolName = null;
      }
    }
  }

  // 최종 결과
  if (type === "result") {
    const resultText = (parsed.result as string) || state.accumulatedText || "(빈 응답)";
    const durationMs = (parsed.duration_ms as number) || 0;
    const costUsd = parsed.total_cost_usd as number | undefined;
    const numTurns = parsed.num_turns as number | undefined;
    const isError = parsed.is_error as boolean;

    console.log(`[스트림 파서] 최종 결과: 길이=${resultText.length}, 소요=${durationMs}ms, 비용=$${costUsd?.toFixed(4) || "N/A"}, 턴=${numTurns || "N/A"}`);

    onEvent({
      type: "complete",
      result: {
        success: !isError,
        output: resultText,
        timedOut: false,
        exitCode: 0,
        durationMs,
        costUsd,
        numTurns,
      },
    });
  }
}

export function runClaudeStream(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  onEvent: (event: ClaudeStreamEvent) => void
): Promise<ClaudeResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    let killed = false;
    let child: ChildProcess;
    let resultResolved = false;

    // 스트림 파서 상태
    const state = {
      accumulatedText: "",
      currentToolName: null as string | null,
      isThinking: false,
    };

    // 중첩 세션 감지 방지: CLAUDE 관련 환경변수 모두 제거
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDE")) {
        delete env[key];
      }
    }

    // #2: 프롬프트 sanitize
    const safePrompt = sanitizePrompt(prompt);

    try {
      const args = [
        "-p", safePrompt,
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--add-dir", cwd,
        "--continue",
        "--dangerously-skip-permissions",
      ];
      child = spawn(CLAUDE_PATH, args, {
        cwd,
        env,
        timeout: timeoutMs + 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      const result: ClaudeResult = {
        success: false,
        output: `Claude CLI 실행 실패: ${err instanceof Error ? err.message : "알 수 없는 오류"}`,
        timedOut: false,
        exitCode: null,
        durationMs: Date.now() - startTime,
      };
      onEvent({ type: "complete", result });
      resolve(result);
      return;
    }

    console.log(`[Claude 스트림] PID=${child.pid}, cwd=${cwd}, prompt_length=${safePrompt.length}`);

    // NDJSON 라인 단위 파싱
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      parseStreamLine(line, state, (event) => {
        onEvent(event);
        if (event.type === "complete" && !resultResolved) {
          resultResolved = true;
          resolve(event.result);
        }
      });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      console.log(`[Claude stderr] ${text.trimEnd()}`);
    });

    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[Claude 대기중] ${elapsed}초 경과, 텍스트=${state.accumulatedText.length}자`);
    }, 30000);

    // 타임아웃
    let killAttempted = false;
    const timer = setTimeout(() => {
      killed = true;
      if (!killAttempted) {
        killAttempted = true;
        console.log(`[Claude 타임아웃] ${timeoutMs}ms 초과, SIGTERM 전송`);
        child.kill("SIGTERM");

        const killTimer = setTimeout(() => {
          console.log(`[Claude 타임아웃] SIGKILL 전송`);
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            // 이미 종료된 경우
          }
        }, 5000);

        child.on("exit", () => clearTimeout(killTimer));
      }
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      rl.close();
      const durationMs = Date.now() - startTime;

      console.log(`[Claude 종료] exitCode=${code}, killed=${killed}, 소요=${durationMs}ms, 텍스트=${state.accumulatedText.length}자`);

      if (!resultResolved) {
        const output = state.accumulatedText.trim() || "(빈 응답)";
        const result: ClaudeResult = {
          success: !killed && code === 0,
          output,
          timedOut: killed,
          exitCode: code,
          durationMs,
        };
        onEvent({ type: "complete", result });
        resolve(result);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      console.error(`[Claude 오류] 프로세스 실행 실패`);
      if (!resultResolved) {
        const result: ClaudeResult = {
          success: false,
          output: `프로세스 오류: ${err.message}`,
          timedOut: false,
          exitCode: null,
          durationMs: Date.now() - startTime,
        };
        onEvent({ type: "complete", result });
        resolve(result);
      }
    });
  });
}

// 하위 호환: 기존 runClaude도 유지 (스트리밍 없이 결과만 반환)
export function runClaude(
  prompt: string,
  cwd: string,
  timeoutMs: number
): Promise<ClaudeResult> {
  return runClaudeStream(prompt, cwd, timeoutMs, () => {});
}

export { getToolLabel };
