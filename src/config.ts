import fs from "fs";
import path from "path";

export interface AppConfig {
  defaultDirectory: string;
  channelDirectoryMap: Record<string, string>;
  allowedUserIds: string[];
  claudeTimeout: number;
}

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

let cachedConfig: AppConfig | null = null;

// #15: HOME 환경변수 fallback
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "/tmp";

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  // #11: config.json 파싱 실패 시 명확한 에러
  let fileConfig: Partial<AppConfig> = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    fileConfig = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ config.json 로드 실패: ${msg}`);
    console.error(`   경로: ${CONFIG_PATH}`);
    process.exit(1);
  }

  // #11: 필수 필드 검증
  if (!fileConfig.defaultDirectory || typeof fileConfig.defaultDirectory !== "string") {
    console.error("❌ config.json: defaultDirectory가 필수입니다");
    process.exit(1);
  }
  if (!Array.isArray(fileConfig.allowedUserIds)) {
    console.error("❌ config.json: allowedUserIds는 배열이어야 합니다");
    process.exit(1);
  }

  // #16: 타임아웃 범위 검증
  const MAX_TIMEOUT = 3600000; // 1시간
  let claudeTimeout = Number(process.env.CLAUDE_TIMEOUT || fileConfig.claudeTimeout || 300000);
  if (isNaN(claudeTimeout) || claudeTimeout <= 0) {
    console.warn("⚠️ claudeTimeout이 유효하지 않습니다. 기본값(300000ms) 사용");
    claudeTimeout = 300000;
  } else if (claudeTimeout > MAX_TIMEOUT) {
    console.warn(`⚠️ claudeTimeout이 최대값(${MAX_TIMEOUT}ms)을 초과합니다. 제한 적용`);
    claudeTimeout = MAX_TIMEOUT;
  }

  // #3: 디렉토리 경로 검증
  const defaultDir = path.resolve(
    process.env.DEFAULT_DIRECTORY || fileConfig.defaultDirectory
  );
  validateDirectory(defaultDir, "defaultDirectory");

  const channelMap: Record<string, string> = {};
  for (const [channelId, dir] of Object.entries(fileConfig.channelDirectoryMap || {})) {
    const resolved = path.resolve(dir);
    validateDirectory(resolved, `channelDirectoryMap[${channelId}]`);
    channelMap[channelId] = resolved;
  }

  // #9: allowedUserIds 비어있으면 경고
  if (fileConfig.allowedUserIds.length === 0) {
    console.warn("⚠️ allowedUserIds가 비어있습니다. 모든 사용자가 접근 가능합니다.");
  }

  cachedConfig = {
    defaultDirectory: defaultDir,
    channelDirectoryMap: channelMap,
    allowedUserIds: fileConfig.allowedUserIds,
    claudeTimeout,
  };

  return cachedConfig;
}

// #3: 디렉토리 존재 여부 및 경로 안전성 검증
function validateDirectory(dir: string, label: string): void {
  const resolved = path.resolve(dir);
  // 홈 디렉토리 또는 하위 경로만 허용
  if (!resolved.startsWith(HOME_DIR)) {
    console.error(`❌ ${label}: 홈 디렉토리 외부 경로 접근 불가 (${resolved})`);
    process.exit(1);
  }
  if (!fs.existsSync(resolved)) {
    console.warn(`⚠️ ${label}: 디렉토리가 존재하지 않습니다 (${resolved})`);
  }
}

export function getDirectoryForChannel(channelId: string): string {
  const config = loadConfig();
  return config.channelDirectoryMap[channelId] || config.defaultDirectory;
}

export function isUserAllowed(userId: string): boolean {
  const config = loadConfig();
  if (config.allowedUserIds.length === 0) return true;
  return config.allowedUserIds.includes(userId);
}

export function reloadConfig(): void {
  cachedConfig = null;
  loadConfig();
}
