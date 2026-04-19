import type { Dirent } from "node:fs";
import type { ConnectOptions } from "../factory";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
} from "../interface";
import { RemoteDockerClient } from "./client";
import type {
  CreateRemoteDockerSandboxRequest,
  CreateRemoteDockerSandboxResponse,
  GetRemoteDockerSandboxResponse,
  RemoteDockerDirectoryEntry,
  RemoteDockerStatResponse,
} from "./contracts";
import type { RemoteDockerState } from "./state";

function toSandboxStats(stat: RemoteDockerStatResponse): SandboxStats {
  return {
    isDirectory: () => stat.kind === "directory",
    isFile: () => stat.kind === "file",
    get size() {
      return stat.size;
    },
    get mtimeMs() {
      return stat.mtimeMs;
    },
  };
}

function toDirent(entry: RemoteDockerDirectoryEntry): Dirent {
  return {
    name: entry.name,
    isDirectory: () => entry.kind === "directory",
    isFile: () => entry.kind === "file",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
  } as Dirent;
}

function toPortState(
  ports: Array<{ port: number; hostPort: number; url: string }>,
): Pick<RemoteDockerState, "portMappings" | "portUrls"> {
  const portMappings: Record<number, number> = {};
  const portUrls: Record<number, string> = {};

  for (const portInfo of ports) {
    portMappings[portInfo.port] = portInfo.hostPort;
    portUrls[portInfo.port] = portInfo.url;
  }

  return { portMappings, portUrls };
}

function mergeStateFromResponse(
  state: RemoteDockerState,
  response: CreateRemoteDockerSandboxResponse | GetRemoteDockerSandboxResponse,
): RemoteDockerState {
  return {
    ...state,
    sandboxId: response.sandboxId,
    sandboxHostId: response.sandboxHostId,
    workspacePath: response.workingDirectory,
    currentBranch: response.currentBranch,
    expiresAt: response.expiresAt,
    ...toPortState(response.ports),
  };
}

function toCreateRequest(
  state: RemoteDockerState,
  options?: ConnectOptions,
): CreateRemoteDockerSandboxRequest {
  return {
    sandboxName: state.sandboxName,
    source: state.source,
    workspacePath: state.workspacePath,
    managedWorkspace: state.managedWorkspace,
    ports: options?.ports,
    env: options?.env,
    githubToken: options?.githubToken,
    gitUser: options?.gitUser,
    timeoutMs: options?.timeout,
    resume: options?.resume,
    createIfMissing: options?.createIfMissing,
    skipGitWorkspaceBootstrap: options?.skipGitWorkspaceBootstrap,
  };
}

export class RemoteDockerSandbox implements Sandbox {
  readonly type = "cloud" as const;
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
  readonly hooks?: SandboxHooks;
  readonly currentBranch?: string;
  readonly environmentDetails?: string;
  readonly host?: string;
  readonly expiresAt?: number;
  readonly timeout?: number;

  constructor(
    private readonly client: RemoteDockerClient,
    private readonly state: RemoteDockerState,
    options?: ConnectOptions,
  ) {
    this.workingDirectory = state.workspacePath ?? "/workspace";
    this.env = options?.env;
    this.hooks = options?.hooks;
    this.currentBranch = state.currentBranch;
    this.expiresAt = state.expiresAt;
    this.timeout = options?.timeout;
    this.host = state.sandboxHostId;
    this.environmentDetails = `Remote Docker sandbox via ${state.sandboxHostId ?? "sandbox-control"} at ${this.workingDirectory}`;
  }

  static async connect(
    state: RemoteDockerState,
    options?: ConnectOptions,
  ): Promise<RemoteDockerSandbox> {
    const client = RemoteDockerClient.fromEnv();
    let nextState = state;

    if (state.sandboxId) {
      const existing = await client.getSandbox(state.sandboxId);
      if (existing && existing.status !== "missing") {
        nextState = mergeStateFromResponse(state, existing);
      } else if (!options?.createIfMissing && !options?.resume) {
        throw new Error(`Sandbox ${state.sandboxId} not found`);
      }
    }

    if (!nextState.sandboxId) {
      const created = await client.createSandbox(
        toCreateRequest(state, options),
      );
      nextState = mergeStateFromResponse(state, created);
    }

    const sandbox = new RemoteDockerSandbox(client, nextState, options);
    if (options?.hooks?.afterStart) {
      await options.hooks.afterStart(sandbox);
    }

    return sandbox;
  }

  private get sandboxId(): string {
    if (!this.state.sandboxId) {
      throw new Error("Remote sandbox is missing sandboxId");
    }

    return this.state.sandboxId;
  }

  async readFile(filePath: string, encoding: "utf-8"): Promise<string> {
    void encoding;
    const result = await this.client.readFile(this.sandboxId, filePath);
    return result.content;
  }

  async writeFile(
    filePath: string,
    content: string,
    encoding: "utf-8",
  ): Promise<void> {
    await this.client.writeFile(this.sandboxId, {
      path: filePath,
      content,
      encoding,
    });
  }

  async stat(filePath: string): Promise<SandboxStats> {
    const result = await this.client.stat(this.sandboxId, filePath);
    return toSandboxStats(result);
  }

  async access(filePath: string): Promise<void> {
    await this.client.stat(this.sandboxId, filePath);
  }

  async mkdir(
    dirPath: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    await this.client.mkdir(this.sandboxId, {
      path: dirPath,
      recursive: options?.recursive,
    });
  }

  async readdir(
    dirPath: string,
    options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    void options;
    const result = await this.client.readdir(this.sandboxId, dirPath);
    return result.entries.map(toDirent);
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    void options;
    return this.client.exec(this.sandboxId, {
      command,
      cwd,
      timeoutMs,
    });
  }

  async execDetached(
    command: string,
    cwd: string,
  ): Promise<{ commandId: string }> {
    return this.client.execDetached(this.sandboxId, {
      command,
      cwd,
    });
  }

  domain(port: number): string {
    return (
      this.state.portUrls?.[port] ??
      `http://${this.host ?? "127.0.0.1"}:${this.state.portMappings?.[port] ?? port}`
    );
  }

  async stop(): Promise<void> {
    if (this.hooks?.beforeStop) {
      await this.hooks.beforeStop(this);
    }

    await this.client.deleteSandbox(this.sandboxId);
  }

  async extendTimeout(additionalMs: number): Promise<{ expiresAt: number }> {
    return this.client.extendTimeout(this.sandboxId, { additionalMs });
  }

  getState(): RemoteDockerState {
    return { ...this.state };
  }
}
