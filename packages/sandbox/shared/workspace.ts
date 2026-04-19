import { promises as fs } from "node:fs";
import path from "node:path";
import type { ConnectOptions } from "../factory";
import type { ExecResult } from "../interface";
import type { Source } from "../types";
import { runProcess } from "./process";

interface WorkspaceState {
  source?: Source;
}

export function buildGitEnv(
  env: Record<string, string>,
  gitUser?: { name: string; email: string },
): Record<string, string> {
  if (!gitUser) {
    return env;
  }

  return {
    ...env,
    GIT_AUTHOR_NAME: gitUser.name,
    GIT_AUTHOR_EMAIL: gitUser.email,
    GIT_COMMITTER_NAME: gitUser.name,
    GIT_COMMITTER_EMAIL: gitUser.email,
  };
}

export function toGitHubCloneUrl(repoUrl: string, token?: string): string {
  if (!token) {
    return repoUrl;
  }

  try {
    const parsed = new URL(repoUrl);
    if (parsed.hostname !== "github.com") {
      return repoUrl;
    }

    parsed.username = "x-access-token";
    parsed.password = token;
    return parsed.toString();
  } catch {
    return repoUrl;
  }
}

export async function execShellCommand(params: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ExecResult> {
  return runProcess({
    command: "bash",
    args: ["-lc", params.command],
    cwd: params.cwd,
    env: params.env,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
}

export async function ensureDirectory(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function initializeGitWorkspace(params: {
  workspacePath: string;
  state: WorkspaceState;
  options?: ConnectOptions;
  env: Record<string, string>;
}): Promise<void> {
  const { workspacePath, state, options, env } = params;

  if (state.source?.repo) {
    await fs.rm(workspacePath, { recursive: true, force: true });
    await ensureDirectory(path.dirname(workspacePath));

    const cloneUrl = toGitHubCloneUrl(state.source.repo, options?.githubToken);
    const cloneResult = await execShellCommand({
      command: `git clone ${JSON.stringify(cloneUrl)} ${JSON.stringify(workspacePath)}`,
      cwd: path.dirname(workspacePath),
      env,
      timeoutMs: 10 * 60 * 1000,
    });

    if (!cloneResult.success) {
      throw new Error(
        cloneResult.stderr || cloneResult.stdout || "git clone failed",
      );
    }

    if (state.source.branch) {
      const checkoutResult = await execShellCommand({
        command: `git checkout ${JSON.stringify(state.source.branch)}`,
        cwd: workspacePath,
        env,
        timeoutMs: 60_000,
      });
      if (!checkoutResult.success) {
        throw new Error(
          checkoutResult.stderr ||
            checkoutResult.stdout ||
            "git checkout failed",
        );
      }
    }

    if (state.source.newBranch) {
      const branchResult = await execShellCommand({
        command: `git checkout -b ${JSON.stringify(state.source.newBranch)}`,
        cwd: workspacePath,
        env,
        timeoutMs: 60_000,
      });
      if (!branchResult.success) {
        throw new Error(
          branchResult.stderr ||
            branchResult.stdout ||
            "git checkout -b failed",
        );
      }
    }

    return;
  }

  await ensureDirectory(workspacePath);

  if (options?.skipGitWorkspaceBootstrap) {
    return;
  }

  const gitDir = path.join(workspacePath, ".git");
  if (await pathExists(gitDir)) {
    return;
  }

  const initResult = await execShellCommand({
    command: "git init",
    cwd: workspacePath,
    env,
    timeoutMs: 60_000,
  });

  if (!initResult.success) {
    throw new Error(
      initResult.stderr || initResult.stdout || "git init failed",
    );
  }
}

export async function resolveCurrentBranch(
  workspacePath: string,
  env: Record<string, string>,
): Promise<string | undefined> {
  const gitDir = path.join(workspacePath, ".git");
  if (!(await pathExists(gitDir))) {
    return undefined;
  }

  const result = await execShellCommand({
    command: "git rev-parse --abbrev-ref HEAD",
    cwd: workspacePath,
    env,
    timeoutMs: 30_000,
  });

  if (!result.success) {
    return undefined;
  }

  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : undefined;
}
