import fs from "fs";
import path from "path";
import { ClaudeResult } from "./claude";

const MAX_MESSAGE_LENGTH = 2500;

// #13: Slack 특수문자 이스케이프
export function escapeSlack(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

/** 마크다운 → 일반 텍스트 변환 */
export function stripMarkdown(text: string): string {
  return text
    // 코드블록 (```lang\n...\n```) → 내용만
    .replace(/```[\w]*\n?([\s\S]*?)```/g, "$1")
    // 인라인 코드 (`code`) → 내용만
    .replace(/`([^`]+)`/g, "$1")
    // 볼드+이탤릭 (***text*** / ___text___) → 내용만
    .replace(/\*{3}(.+?)\*{3}/g, "$1")
    .replace(/_{3}(.+?)_{3}/g, "$1")
    // 볼드 (**text** / __text__) → 내용만
    .replace(/\*{2}(.+?)\*{2}/g, "$1")
    .replace(/_{2}(.+?)_{2}/g, "$1")
    // 이탤릭 (*text* / _text_) → 내용만
    .replace(/\*(.+?)\*/g, "$1")
    // 헤더 (# ~ ######) → 내용만
    .replace(/^#{1,6}\s+(.+)$/gm, "$1")
    // 링크 [text](url) → text (url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    // 이미지 ![alt](url) → (alt)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "($1)")
    // 수평선 (---, ***, ___) → 구분선
    .replace(/^[-*_]{3,}$/gm, "────────────")
    // 인용 (> text) → text
    .replace(/^>\s?/gm, "")
    // 연속 빈 줄 정리
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // 줄바꿈 기준으로 분할 시도
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx <= 0) {
      // 줄바꿈이 없으면 공백 기준
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx <= 0) {
      // 공백도 없으면 강제 분할
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

export function formatResult(result: ClaudeResult, directory: string): string[] {
  // #13: 디렉토리 경로 이스케이프
  const safeDir = escapeSlack(directory);
  const footer = `\n────────────\n📂 ${safeDir} | ⏱ ${formatDuration(result.durationMs)}${result.timedOut ? " | ⚠️ 타임아웃" : ""}`;

  const footerLen = footer.length + 10;
  const contentMax = MAX_MESSAGE_LENGTH - footerLen;

  // 마크다운 → 일반 텍스트 → 이미지 마커 제거
  const plain = stripImageMarkers(stripMarkdown(result.output));

  if (plain.length <= contentMax) {
    return [plain + footer];
  }

  // 긴 출력: 분할
  const chunks = splitMessage(plain, contentMax - 20);
  return chunks.map((chunk, i) => {
    const header = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : "";
    const foot = i === chunks.length - 1 ? footer : "";
    return header + chunk + foot;
  });
}

// 이미지 확장자
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);

/** 디렉토리 내 파일 목록 스냅샷 (수정 시간 포함) */
export function snapshotFiles(dir: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  try {
    const files = fs.readdirSync(dir, { recursive: true, encoding: "utf-8" });
    for (const file of files) {
      const fullPath = path.join(dir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          snapshot.set(fullPath, stat.mtimeMs);
        }
      } catch {
        // 접근 불가 파일 무시
      }
    }
  } catch {
    // 디렉토리 읽기 실패 무시
  }
  return snapshot;
}

/** 스냅샷 비교 후 새로 생성/수정된 이미지 파일 반환 */
export function findNewImages(before: Map<string, number>, dir: string): string[] {
  const after = snapshotFiles(dir);
  const newImages: string[] = [];

  for (const [filePath, mtime] of after) {
    const ext = path.extname(filePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;

    const prevMtime = before.get(filePath);
    // 새 파일이거나 수정된 파일
    if (prevMtime === undefined || mtime > prevMtime) {
      newImages.push(filePath);
    }
  }

  return newImages;
}

/** Claude 출력에서 이미지 파일 경로 추출 */
export function extractImagePaths(output: string): string[] {
  const found = new Set<string>();
  const imgExt = /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i;

  // 패턴 1: [Image: source: /path/to/file.png]
  const p1 = /\[Image:\s*source:\s*([^\]]+)\]/gi;
  let m;
  while ((m = p1.exec(output)) !== null) {
    found.add(m[1].trim());
  }

  // 마크다운 코드 포맷 제거 (백틱으로 감싸진 경로 감지를 위해)
  const cleaned = output
    .replace(/```[\w]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1");

  // 패턴 2: 절대 경로 이미지 파일 (공백/콜론/줄바꿈 뒤)
  const p2 = /(?:^|[\s:])(\/{1,2}[\w./-]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp))/gim;
  while ((m = p2.exec(cleaned)) !== null) {
    found.add(m[1].trim());
  }

  // 존재하는 파일만 필터
  const paths: string[] = [];
  for (const filePath of found) {
    if (!imgExt.test(filePath)) continue;
    try {
      if (fs.existsSync(filePath)) {
        paths.push(filePath);
        console.log(`[이미지 감지] 파일 존재: ${filePath}`);
      } else {
        console.log(`[이미지 감지] 파일 없음: ${filePath}`);
      }
    } catch {
      console.log(`[이미지 감지] 접근 불가: ${filePath}`);
    }
  }

  return paths;
}

/** Claude 출력에서 이미지 마커 텍스트 제거 */
export function stripImageMarkers(text: string): string {
  return text
    // [Image: source: /path/to/file] 제거
    .replace(/\[Image:\s*source:\s*[^\]]*\]/gi, "")
    // [image] 마커 제거
    .replace(/\[image\]/gi, "")
    // 정리 후 연속 공백/빈줄 축소
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}초`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}분 ${remainSecs}초`;
}
