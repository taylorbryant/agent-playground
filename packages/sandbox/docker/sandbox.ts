import { randomUUID } from "node:crypto";
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
import { runProcess } from "../shared/process";
import {
  buildGitEnv,
  ensureDirectory,
  initializeGitWorkspace,
  pathExists,
  resolveCurrentBranch,
} from "../shared/workspace";
import {
  containerExists,
  getPublishedPort,
  isContainerRunning,
  removeContainer,
  runContainer,
  startContainer,
} from "./docker-cli";
import type { DockerState } from "./state";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 60 * 1000;
const DEFAULT_PREVIEW_HOST = "127.0.0.1";
const DEFAULT_CONTAINER_WORKSPACE = "/workspace";

function getDockerSandboxRoot(): string {
  return path.join(os.tmpdir(), "open-harness-docker-sandboxes");
}

function getDockerImage(): string {
  const image = process.env.OPEN_HARNESS_DOCKER_IMAGE?.trim();
  if (image) {
    return image;
  }

  throw new Error(
    "OPEN_HARNESS_DOCKER_IMAGE must be set when OPEN_HARNESS_SANDBOX_BACKEND=docker",
  );
}

function getPreviewHost(): string {
  return (
    process.env.OPEN_HARNESS_DOCKER_PREVIEW_HOST?.trim() || DEFAULT_PREVIEW_HOST
  );
}

function sanitizeContainerName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "open-harness-sandbox";
}

function resolveContainerName(state: DockerState): string {
  if (state.containerName) {
    return state.containerName;
  }

  if (state.sandboxName) {
    return sanitizeContainerName(`open-harness-${state.sandboxName}`);
  }

  return sanitizeContainerName(
    `open-harness-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
  );
}

function toContainerPath(workspacePath: string, cwd: string): string {
  const absoluteCwd = path.resolve(cwd);
  const relative = path.relative(workspacePath, absoluteCwd);

  if (!relative || relative === "") {
    return DEFAULT_CONTAINER_WORKSPACE;
  }

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return DEFAULT_CONTAINER_WORKSPACE;
  }

  return path.posix.join(
    DEFAULT_CONTAINER_WORKSPACE,
    relative.split(path.sep).join(path.posix.sep),
  );
}

async function resolvePortMappings(
  containerName: string,
  ports: number[],
): Promise<Record<number, number>> {
  const mappings: Record<number, number> = {};

  for (const port of ports) {
    const publishedPort = await getPublishedPort(containerName, port);
    if (publishedPort !== null) {
      mappings[port] = publishedPort;
    }
  }

  return mappings;
}

export class DockerSandbox implements Sandbox {
  readonly type = "cloud" as const;
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
  readonly hooks?: SandboxHooks;
  readonly currentBranch?: string;
  readonly environmentDetails?: string;
  readonly host: string;
  readonly timeout?: number;
  readonly expiresAt?: number;

  constructor(
    private readonly state: DockerState,
    private readonly containerName: string,
    options: ConnectOptions | undefined,
    currentBranch: string | undefined,
  ) {
    this.workingDirectory = state.workspacePath ?? process.cwd();
    this.env = buildGitEnv(options?.env ?? {}, options?.gitUser);
    this.hooks = options?.hooks;
    this.currentBranch = currentBranch;
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    this.expiresAt = state.expiresAt;
    this.host = getPreviewHost();
    this.environmentDetails = `Docker sandbox using image ${getDockerImage()} with workspace mounted at ${this.workingDirectory}`;
  }

  static async connect(
    state: DockerState,
    options?: ConnectOptions,
  ): Promise<DockerSandbox> {
    await ensureDirectory(getDockerSandboxRoot());

    const resolvedWorkspacePath =
      state.workspacePath ??
      (state.sandboxName
        ? path.join(getDockerSandboxRoot(), state.sandboxName)
        : await fs.mkdtemp(path.join(getDockerSandboxRoot(), "sandbox-")));

    const containerName = resolveContainerName(state);
    const nextState: DockerState = {
      ...state,
      workspacePath: resolvedWorkspacePath,
      containerName,
      expiresAt: Date.now() + (options?.timeout ?? DEFAULT_TIMEOUT_MS),
    };

    const workspaceEnv = buildGitEnv(
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
        env: workspaceEnv,
      });
    }

    const ports = options?.ports ?? [];
    const existingContainer = await containerExists(containerName);

    if (existingContainer) {
      const running = await isContainerRunning(containerName);
      if (!running) {
        await startContainer(containerName);
      }
    } else {
      await runContainer({
        containerName,
        image: getDockerImage(),
        workspacePath: resolvedWorkspacePath,
        ports,
      });
    }

    nextState.portMappings = await resolvePortMappings(containerName, ports);

    const currentBranch = await resolveCurrentBranch(
      resolvedWorkspacePath,
      workspaceEnv,
    );
    const sandbox = new DockerSandbox(
      nextState,
      containerName,
      options,
      currentBranch,
    );

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
    const envArgs = Object.entries(this.env ?? {}).flatMap(([key, value]) => [
      "-e",
      `${key}=${value}`,
    ]);

    return runProcess({
      command: "docker",
      args: [
        "exec",
        ...envArgs,
        "-w",
        toContainerPath(this.workingDirectory, cwd),
        this.containerName,
        "sh",
        "-lc",
        command,
      ],
      cwd: this.workingDirectory,
      timeoutMs,
      signal: options?.signal,
    });
  }

  async execDetached(
    command: string,
    cwd: string,
  ): Promise<{ commandId: string }> {
    const envArgs = Object.entries(this.env ?? {}).flatMap(([key, value]) => [
      "-e",
      `${key}=${value}`,
    ]);

    const result = await runProcess({
      command: "docker",
      args: [
        "exec",
        "-d",
        ...envArgs,
        "-w",
        toContainerPath(this.workingDirectory, cwd),
        this.containerName,
        "sh",
        "-lc",
        command,
      ],
      cwd: this.workingDirectory,
      timeoutMs: 30_000,
    });

    if (!result.success) {
      throw new Error(
        result.stderr || result.stdout || "docker exec -d failed",
      );
    }

    return {
      commandId: `docker:${this.containerName}:${Date.now()}`,
    };
  }

  domain(port: number): string {
    const mappedPort = this.state.portMappings?.[port] ?? port;
    return `http://${this.host}:${mappedPort}`;
  }

  async stop(): Promise<void> {
    if (this.hooks?.beforeStop) {
      await this.hooks.beforeStop(this);
    }

    await removeContainer(this.containerName);
  }

  async extendTimeout(additionalMs: number): Promise<{ expiresAt: number }> {
    const expiresAt = Date.now() + additionalMs;
    this.state.expiresAt = expiresAt;
    return { expiresAt };
  }

  getState(): DockerState {
    return {
      ...this.state,
      workspacePath: this.workingDirectory,
      containerName: this.containerName,
    };
  }
}
