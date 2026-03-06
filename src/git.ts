import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function exec(
  cmd: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export async function getCurrentSha(repoPath: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], repoPath);
  return stdout.trim();
}

function validateSha(sha: string): void {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) {
    throw new Error(`Invalid git SHA: ${sha}`);
  }
}

export async function getFileDiff(
  repoPath: string,
  fromSha: string,
  filePath: string
): Promise<string> {
  validateSha(fromSha);
  try {
    const { stdout } = await exec(
      "git",
      ["diff", fromSha, "HEAD", "--", filePath],
      repoPath
    );
    return stdout;
  } catch {
    return "";
  }
}

export async function didLinesChange(
  repoPath: string,
  fromSha: string,
  filePath: string,
  startLine?: number,
  endLine?: number
): Promise<{ changed: boolean; fullFileChanged: boolean; diff: string }> {
  validateSha(fromSha);
  const diff = await getFileDiff(repoPath, fromSha, filePath);

  if (!diff) {
    return { changed: false, fullFileChanged: false, diff: "" };
  }

  if (!startLine || !endLine) {
    return { changed: true, fullFileChanged: true, diff };
  }

  // Parse unified diff to check if the specific line range was affected
  const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let match;
  while ((match = hunkRegex.exec(diff)) !== null) {
    const oldStart = parseInt(match[1]);
    const oldCount = parseInt(match[2] || "1");
    const oldEnd = oldStart + oldCount - 1;

    // Check if this hunk overlaps with the line range
    if (oldStart <= endLine && oldEnd >= startLine) {
      return { changed: true, fullFileChanged: false, diff };
    }
  }

  return { changed: false, fullFileChanged: false, diff };
}

export async function getFileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}
