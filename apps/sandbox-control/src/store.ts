import { randomUUID } from "node:crypto";
import {
  DockerSandbox,
  type ConnectOptions,
  type CreateRemoteDockerSandboxRequest,
  type CreateRemoteDockerSandboxResponse,
  type DockerState,
  type GetRemoteDockerSandboxResponse,
  type RemoteDockerDeleteSandboxResponse,
  type RemoteDockerDirectoryEntry,
  type RemoteDockerExecDetachedRequest,
  type RemoteDockerExecDetachedResponse,
  type RemoteDockerExecRequest,
  type RemoteDockerExecResponse,
  type RemoteDockerExtendTimeoutResponse,
  type RemoteDockerFileResponse,
  type RemoteDockerMkdirRequest,
  type RemoteDockerPortResponse,
  type RemoteDockerReaddirResponse,
  type RemoteDockerSandboxPortInfo,
  type RemoteDockerStatResponse,
  type RemoteDockerWriteFileRequest,
} from "@open-harness/sandbox";

type ActiveDockerSandbox = Awaited<ReturnType<typeof DockerSandbox.connect>>;

interface SandboxRecord {
  sandboxId: string;
  sandboxName?: string;
  request: CreateRemoteDockerSandboxRequest;
  state: DockerState;
  currentBranch?: string;
  sandbox?: ActiveDockerSandbox;
}

function getHostId(): string {
  return process.env.OPEN_HARNESS_SANDBOX_HOST_ID?.trim() || "sandbox-host-1";
}

function getPreviewBaseUrl(): string | null {
  const configured =
    process.env.OPEN_HARNESS_SANDBOX_CONTROL_PREVIEW_BASE_URL?.trim();
  return configured && configured.length > 0
    ? configured.replace(/\/+$/, "")
    : null;
}

function toConnectOptions(
  request: CreateRemoteDockerSandboxRequest,
): ConnectOptions {
  return {
    env: request.env,
    githubToken: request.githubToken,
    gitUser: request.gitUser,
    timeout: request.timeoutMs,
    ports: request.ports,
    resume: request.resume,
    createIfMissing: request.createIfMissing,
    skipGitWorkspaceBootstrap: request.skipGitWorkspaceBootstrap,
  };
}

function toInitialState(
  request: CreateRemoteDockerSandboxRequest,
): DockerState {
  return {
    sandboxName: request.sandboxName,
    workspacePath: request.workspacePath,
    managedWorkspace: request.managedWorkspace,
    source: request.source,
  };
}

function toDirectoryEntry(entry: {
  name: string;
  isDirectory(): boolean;
}): RemoteDockerDirectoryEntry {
  return {
    name: entry.name,
    kind: entry.isDirectory() ? "directory" : "file",
  };
}

class SandboxControlStore {
  private readonly sandboxesById = new Map<string, SandboxRecord>();
  private readonly sandboxIdsByName = new Map<string, string>();

  private async connectRecord(
    record: SandboxRecord,
  ): Promise<ActiveDockerSandbox> {
    const sandbox = await DockerSandbox.connect(
      record.state,
      toConnectOptions(record.request),
    );

    record.sandbox = sandbox;
    record.currentBranch = sandbox.currentBranch;

    const nextState = sandbox.getState();
    record.state = nextState;

    return sandbox;
  }

  private async ensureConnected(
    record: SandboxRecord,
  ): Promise<ActiveDockerSandbox> {
    if (record.sandbox) {
      return record.sandbox;
    }

    return this.connectRecord(record);
  }

  private buildPortInfo(
    record: SandboxRecord,
    sandbox: ActiveDockerSandbox,
  ): RemoteDockerSandboxPortInfo[] {
    const previewBaseUrl = getPreviewBaseUrl();

    return (record.request.ports ?? []).map((port) => {
      const hostPort = record.state.portMappings?.[port] ?? port;
      const url = previewBaseUrl
        ? `${previewBaseUrl}/sandboxes/${record.sandboxId}/ports/${port}`
        : (sandbox.domain?.(port) ?? `http://127.0.0.1:${hostPort}`);

      return { port, hostPort, url };
    });
  }

  private toResponse(
    record: SandboxRecord,
    sandbox: ActiveDockerSandbox,
  ): GetRemoteDockerSandboxResponse {
    return {
      sandboxId: record.sandboxId,
      sandboxHostId: getHostId(),
      workingDirectory: record.state.workspacePath ?? sandbox.workingDirectory,
      currentBranch: record.currentBranch,
      expiresAt: record.state.expiresAt ?? sandbox.expiresAt,
      ports: this.buildPortInfo(record, sandbox),
      status: "running",
    };
  }

  async createOrResume(
    request: CreateRemoteDockerSandboxRequest,
  ): Promise<CreateRemoteDockerSandboxResponse> {
    const existingId = request.sandboxName
      ? this.sandboxIdsByName.get(request.sandboxName)
      : undefined;

    if (
      existingId &&
      (request.resume || request.createIfMissing) &&
      this.sandboxesById.has(existingId)
    ) {
      const record = this.sandboxesById.get(existingId);
      if (!record) {
        throw new Error("Sandbox lookup failed");
      }

      record.request = request;
      const sandbox = await this.ensureConnected(record);
      return this.toResponse(record, sandbox);
    }

    const record: SandboxRecord = {
      sandboxId: randomUUID(),
      sandboxName: request.sandboxName,
      request,
      state: toInitialState(request),
    };

    const sandbox = await this.connectRecord(record);

    this.sandboxesById.set(record.sandboxId, record);
    if (record.sandboxName) {
      this.sandboxIdsByName.set(record.sandboxName, record.sandboxId);
    }

    return this.toResponse(record, sandbox);
  }

  async get(sandboxId: string): Promise<GetRemoteDockerSandboxResponse | null> {
    const record = this.sandboxesById.get(sandboxId);
    if (!record) {
      return null;
    }

    const sandbox = await this.ensureConnected(record);
    return this.toResponse(record, sandbox);
  }

  async delete(
    sandboxId: string,
  ): Promise<RemoteDockerDeleteSandboxResponse | null> {
    const record = this.sandboxesById.get(sandboxId);
    if (!record) {
      return null;
    }

    const sandbox = await this.ensureConnected(record);
    await sandbox.stop();

    this.sandboxesById.delete(sandboxId);
    if (record.sandboxName) {
      this.sandboxIdsByName.delete(record.sandboxName);
    }

    return { stopped: true };
  }

  async extendTimeout(
    sandboxId: string,
    additionalMs: number,
  ): Promise<RemoteDockerExtendTimeoutResponse | null> {
    const record = this.sandboxesById.get(sandboxId);
    if (!record) {
      return null;
    }

    const sandbox = await this.ensureConnected(record);
    const result = sandbox.extendTimeout
      ? await sandbox.extendTimeout(additionalMs)
      : { expiresAt: Date.now() + additionalMs };

    record.state.expiresAt = result.expiresAt;
    return result;
  }

  async getPort(
    sandboxId: string,
    port: number,
  ): Promise<RemoteDockerPortResponse | null> {
    const record = this.sandboxesById.get(sandboxId);
    if (!record) {
      return null;
    }

    const sandbox = await this.ensureConnected(record);
    const portInfo = this.buildPortInfo(record, sandbox).find(
      (entry) => entry.port === port,
    );
    if (!portInfo) {
      return null;
    }

    return {
      url: portInfo.url,
      hostPort: portInfo.hostPort,
    };
  }

  async exec(
    sandboxId: string,
    request: RemoteDockerExecRequest,
  ): Promise<RemoteDockerExecResponse | null> {
    const record = this.sandboxesById.get(sandboxId);
    if (!record) {
      return null;
    }

    const sandbox = await this.ensureConnected(record);
    return sandbox.exec(request.command, request.cwd, request.timeoutMs);
  }

  async execDetached(
    sandboxId: string,
    request: RemoteDockerExecDetachedRequest,
  ): Promise<RemoteDockerExecDetachedResponse | null> {
    const record = this.sandboxesById.get(sandboxId);
    if (!record) {
      return null;
    }

    const sandbox = await this.ensureConnected(record);
    if (!sandbox.execDetached) {
      throw new Error("Detached exec is not supported for this sandbox");
    }

    return sandbox.execDetached(request.command, request.cwd);
  }

  async readFile(
    sandboxId: string,
    filePath: string,
  ): Promise<RemoteDockerFileResponse | null> {
    const record = this.sandboxesById.get(sandboxId);
    if (!record) {
      return null;
    }

    const sandbox = await this.ensureConnected(record);
    const content = await sandbox.readFile(filePath, "utf-8");
    return { content };
  }

  async writeFile(
    sandboxId: string,
    request: RemoteDockerWriteFileRequest,
  ): Promise<boolean> {
    const record = this.sandboxesById.get(sandboxId);
    if (!record) {
      return false;
    }

    const sandbox = await this.ensureConnected(record);
    await sandbox.writeFile(request.path, request.content, request.encoding);
    return true;
  }

  async stat(
    sandboxId: string,
    filePath: string,
  ): Promise<RemoteDockerStatResponse | null> {
    const record = this.sandboxesById.get(sandboxId);
    if (!record) {
      return null;
    }

    const sandbox = await this.ensureConnected(record);
    const stats = await sandbox.stat(filePath);
    return {
      path: filePath,
      kind: stats.isDirectory() ? "directory" : "file",
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  }

  async mkdir(
    sandboxId: string,
    request: RemoteDockerMkdirRequest,
  ): Promise<boolean> {
    const record = this.sandboxesById.get(sandboxId);
    if (!record) {
      return false;
    }

    const sandbox = await this.ensureConnected(record);
    await sandbox.mkdir(request.path, { recursive: request.recursive });
    return true;
  }

  async readdir(
    sandboxId: string,
    dirPath: string,
  ): Promise<RemoteDockerReaddirResponse | null> {
    const record = this.sandboxesById.get(sandboxId);
    if (!record) {
      return null;
    }

    const sandbox = await this.ensureConnected(record);
    const entries = await sandbox.readdir(dirPath, { withFileTypes: true });
    return {
      entries: entries.map(toDirectoryEntry),
    };
  }

  reset(): void {
    this.sandboxesById.clear();
    this.sandboxIdsByName.clear();
  }
}

export const sandboxControlStore = new SandboxControlStore();
