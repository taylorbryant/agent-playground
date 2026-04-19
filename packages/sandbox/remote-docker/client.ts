import type {
  CreateRemoteDockerSandboxRequest,
  CreateRemoteDockerSandboxResponse,
  GetRemoteDockerSandboxResponse,
  RemoteDockerDeleteSandboxResponse,
  RemoteDockerExecDetachedRequest,
  RemoteDockerExecDetachedResponse,
  RemoteDockerExecRequest,
  RemoteDockerExecResponse,
  RemoteDockerExtendTimeoutRequest,
  RemoteDockerExtendTimeoutResponse,
  RemoteDockerFileResponse,
  RemoteDockerMkdirRequest,
  RemoteDockerPortResponse,
  RemoteDockerReaddirResponse,
  RemoteDockerStatResponse,
  RemoteDockerWriteFileRequest,
} from "./contracts";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export class RemoteDockerClient {
  constructor(private readonly baseUrl: string) {}

  static fromEnv(): RemoteDockerClient {
    const baseUrl = process.env.OPEN_HARNESS_SANDBOX_CONTROL_URL?.trim();
    if (!baseUrl) {
      throw new Error(
        "OPEN_HARNESS_SANDBOX_CONTROL_URL must be set when OPEN_HARNESS_SANDBOX_BACKEND=remote-docker",
      );
    }

    return new RemoteDockerClient(trimTrailingSlash(baseUrl));
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
    expectedStatuses: number[] = [200],
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });

    if (!expectedStatuses.includes(response.status)) {
      const body = await response.text().catch(() => "");
      throw new Error(
        body || `${response.status} ${response.statusText}`.trim(),
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  async createSandbox(
    body: CreateRemoteDockerSandboxRequest,
  ): Promise<CreateRemoteDockerSandboxResponse> {
    return this.request<CreateRemoteDockerSandboxResponse>("/sandboxes", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getSandbox(
    sandboxId: string,
  ): Promise<GetRemoteDockerSandboxResponse | null> {
    try {
      return await this.request<GetRemoteDockerSandboxResponse>(
        `/sandboxes/${encodeURIComponent(sandboxId)}`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        return null;
      }

      throw error;
    }
  }

  async exec(
    sandboxId: string,
    body: RemoteDockerExecRequest,
  ): Promise<RemoteDockerExecResponse> {
    return this.request<RemoteDockerExecResponse>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/exec`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }

  async execDetached(
    sandboxId: string,
    body: RemoteDockerExecDetachedRequest,
  ): Promise<RemoteDockerExecDetachedResponse> {
    return this.request<RemoteDockerExecDetachedResponse>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/exec-detached`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }

  async readFile(
    sandboxId: string,
    filePath: string,
  ): Promise<RemoteDockerFileResponse> {
    const params = new URLSearchParams({ path: filePath });
    return this.request<RemoteDockerFileResponse>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/file?${params.toString()}`,
    );
  }

  async writeFile(
    sandboxId: string,
    body: RemoteDockerWriteFileRequest,
  ): Promise<void> {
    await this.request<null>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/file`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
      [200, 204],
    );
  }

  async stat(
    sandboxId: string,
    filePath: string,
  ): Promise<RemoteDockerStatResponse> {
    const params = new URLSearchParams({ path: filePath });
    return this.request<RemoteDockerStatResponse>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/stat?${params.toString()}`,
    );
  }

  async mkdir(
    sandboxId: string,
    body: RemoteDockerMkdirRequest,
  ): Promise<void> {
    await this.request<null>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/mkdir`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      [200, 204],
    );
  }

  async readdir(
    sandboxId: string,
    filePath: string,
  ): Promise<RemoteDockerReaddirResponse> {
    const params = new URLSearchParams({ path: filePath });
    return this.request<RemoteDockerReaddirResponse>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/readdir?${params.toString()}`,
    );
  }

  async extendTimeout(
    sandboxId: string,
    body: RemoteDockerExtendTimeoutRequest,
  ): Promise<RemoteDockerExtendTimeoutResponse> {
    return this.request<RemoteDockerExtendTimeoutResponse>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/extend-timeout`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }

  async getPort(
    sandboxId: string,
    port: number,
  ): Promise<RemoteDockerPortResponse> {
    return this.request<RemoteDockerPortResponse>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/ports/${port}`,
    );
  }

  async deleteSandbox(
    sandboxId: string,
  ): Promise<RemoteDockerDeleteSandboxResponse> {
    return this.request<RemoteDockerDeleteSandboxResponse>(
      `/sandboxes/${encodeURIComponent(sandboxId)}`,
      {
        method: "DELETE",
      },
    );
  }
}
