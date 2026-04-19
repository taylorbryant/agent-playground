import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  spawn,
} from "node:child_process";
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConnectOptions } from "../factory";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
} from "../interface";
import type { LocalState } from "./state";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 60 * 1000;
const DETACHED_PIDS_DIR = ".open-harness";
const DETACHED_PIDS_FILE = "detached-pids.json";

function getLocalSandboxRoot(): string {
  return path.join(os.tmpdir(), "open-harness-local-sandboxes");
}

function buildGitEnv(
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

function toGitHubCloneUrl(repoUrl: string, token?: string): string {
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

async function execCommand(params: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn("bash", ["-lc", params.command], {
      cwd: params.cwd,
      env: params.env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as ChildProcessWithoutNullStreams;

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killedByTimeout = false;

    const finish = (result: ExecResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      params.signal?.removeEventListener("abort", handleAbort);
      resolve(result);
    };

    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      params.signal?.removeEventListener("abort", handleAbort);
      reject(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", fail);
    child.on("close", (code: number | null) => {
      finish({
        success: code === 0 && !killedByTimeout,
        exitCode: code,
        stdout,
        stderr: killedByTimeout
          ? `${stderr}\nCommand timed out`.trim()
          : stderr,
        truncated: false,
      });
    });

    const handleAbort = () => {
      child.kill("SIGTERM");
      finish({
        success: false,
        exitCode: null,
        stdout,
        stderr: `${stderr}\nCommand aborted`.trim(),
        truncated: false,
      });
    };

    params.signal?.addEventListener("abort", handleAbort, { once: true });

    const timeoutId = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGTERM");
    }, params.timeoutMs);
  });
}

async function ensureDirectory(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function initializeGitWorkspace(params: {
  workspacePath: string;
  state: LocalState;
  options?: ConnectOptions;
  env: Record<string, string>;
}): Promise<void> {
  const { workspacePath, state, options, env } = params;

  if (state.source?.repo) {
    await fs.rm(workspacePath, { recursive: true, force: true });
    await ensureDirectory(path.dirname(workspacePath));

    const cloneUrl = toGitHubCloneUrl(state.source.repo, options?.githubToken);
    const cloneResult = await execCommand({
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
      const checkoutResult = await execCommand({
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
      const branchResult = await execCommand({
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

  const initResult = await execCommand({
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

async function readDetachedPids(workspacePath: string): Promise<number[]> {
  const filePath = path.join(
    workspacePath,
    DETACHED_PIDS_DIR,
    DETACHED_PIDS_FILE,
  );
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is number => typeof value === "number")
      : [];
  } catch {
    return [];
  }
}

async function writeDetachedPids(
  workspacePath: string,
  pids: number[],
): Promise<void> {
  const dirPath = path.join(workspacePath, DETACHED_PIDS_DIR);
  await ensureDirectory(dirPath);
  await fs.writeFile(
    path.join(dirPath, DETACHED_PIDS_FILE),
    JSON.stringify(pids, null, 2),
    "utf-8",
  );
}

async function appendDetachedPid(
  workspacePath: string,
  pid: number,
): Promise<void> {
  const current = await readDetachedPids(workspacePath);
  if (current.includes(pid)) {
    return;
  }
  await writeDetachedPids(workspacePath, [...current, pid]);
}

export class LocalSandbox implements Sandbox {
  readonly type = "cloud" as const;
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
  readonly hooks?: SandboxHooks;
  readonly currentBranch?: string;
  readonly environmentDetails?: string;
  readonly host = "127.0.0.1";
  readonly timeout?: number;
  readonly expiresAt?: number;

  constructor(
    private readonly state: LocalState,
    options: ConnectOptions | undefined,
    currentBranch: string | undefined,
  ) {
    this.workingDirectory = state.workspacePath ?? process.cwd();
    this.env = options?.env;
    this.hooks = options?.hooks;
    this.currentBranch = currentBranch;
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    this.expiresAt = state.expiresAt;
    this.environmentDetails = `Local sandbox on host filesystem at ${this.workingDirectory}`;
  }

  static async connect(
    state: LocalState,
    options?: ConnectOptions,
  ): Promise<LocalSandbox> {
    await ensureDirectory(getLocalSandboxRoot());

    const resolvedWorkspacePath =
      state.workspacePath ??
      (state.sandboxName
        ? path.join(getLocalSandboxRoot(), state.sandboxName)
        : await fs.mkdtemp(path.join(getLocalSandboxRoot(), "sandbox-")));

    const nextState: LocalState = {
      ...state,
      workspacePath: resolvedWorkspacePath,
      expiresAt: Date.now() + (options?.timeout ?? DEFAULT_TIMEOUT_MS),
    };

    const env = buildGitEnv(
      {
        ...process.env,
        ...options?.env,
      } as Record<string, string>,
      options?.gitUser,
    );

    const exists = await pathExists(resolvedWorkspacePath);
    if (!exists) {
      await initializeGitWorkspace({
        workspacePath: resolvedWorkspacePath,
        state: nextState,
        options,
        env,
      });
    }

    const currentBranch = await resolveCurrentBranch(
      resolvedWorkspacePath,
      env,
    );
    const sandbox = new LocalSandbox(nextState, options, currentBranch);

    if (options?.hooks?.afterStart) {
      await options.hooks.afterStart(sandbox);
    }

    return sandbox;
  }

  async readFile(filePath: string, encoding: "utf-8"): Promise<string> {
    return fs.readFile(filePath, encoding);
  }

  async writeFile(
    filePath: string,
    content: string,
    encoding: "utf-8",
  ): Promise<void> {
    await ensureDirectory(path.dirname(filePath));
    await fs.writeFile(filePath, content, encoding);
  }

  async stat(filePath: string): Promise<SandboxStats> {
    return fs.stat(filePath);
  }

  async access(filePath: string): Promise<void> {
    await fs.access(filePath);
  }

  async mkdir(
    dirPath: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    await fs.mkdir(dirPath, { recursive: options?.recursive });
  }

  async readdir(
    dirPath: string,
    options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    return fs.readdir(dirPath, options);
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    return execCommand({
      command,
      cwd,
      env: {
        ...process.env,
        ...this.env,
      } as Record<string, string>,
      timeoutMs,
      signal: options?.signal,
    });
  }

  async execDetached(
    command: string,
    cwd: string,
  ): Promise<{ commandId: string }> {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: {
        ...process.env,
        ...this.env,
      } as NodeJS.ProcessEnv,
      detached: true,
      stdio: "ignore",
    }) as ChildProcess;

    child.unref();

    if (child.pid) {
      await appendDetachedPid(this.workingDirectory, child.pid);
      return { commandId: `local:${child.pid}` };
    }

    return { commandId: `local:${Date.now()}` };
  }

  domain(port: number): string {
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (this.hooks?.beforeStop) {
      await this.hooks.beforeStop(this);
    }

    const pids = await readDetachedPids(this.workingDirectory);
    await Promise.all(
      pids.map(async (pid) => {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Ignore already-exited processes.
        }
      }),
    );
    await writeDetachedPids(this.workingDirectory, []);
  }

  async extendTimeout(additionalMs: number): Promise<{ expiresAt: number }> {
    const expiresAt = Date.now() + additionalMs;
    this.state.expiresAt = expiresAt;
    return { expiresAt };
  }

  getState(): LocalState {
    return {
      ...this.state,
      workspacePath: this.workingDirectory,
    };
  }
}

async function resolveCurrentBranch(
  workspacePath: string,
  env: Record<string, string>,
): Promise<string | undefined> {
  const gitDir = path.join(workspacePath, ".git");
  if (!(await pathExists(gitDir))) {
    return undefined;
  }

  const result = await execCommand({
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
