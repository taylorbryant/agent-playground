import type { Source } from "../types";

export type RemoteDockerSandboxStatus = "running" | "stopped" | "missing";

export interface RemoteDockerSandboxPortInfo {
  port: number;
  hostPort: number;
  url: string;
}

export interface CreateRemoteDockerSandboxRequest {
  sandboxName?: string;
  source?: Source;
  workspacePath?: string;
  managedWorkspace?: boolean;
  ports?: number[];
  env?: Record<string, string>;
  githubToken?: string;
  gitUser?: {
    name: string;
    email: string;
  };
  timeoutMs?: number;
  resume?: boolean;
  createIfMissing?: boolean;
  skipGitWorkspaceBootstrap?: boolean;
}

export interface CreateRemoteDockerSandboxResponse {
  sandboxId: string;
  sandboxHostId: string;
  workingDirectory: string;
  currentBranch?: string;
  expiresAt?: number;
  ports: RemoteDockerSandboxPortInfo[];
}

export interface GetRemoteDockerSandboxResponse extends CreateRemoteDockerSandboxResponse {
  status: RemoteDockerSandboxStatus;
}

export interface RemoteDockerExecRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
}

export interface RemoteDockerExecResponse {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface RemoteDockerExecDetachedRequest {
  command: string;
  cwd: string;
}

export interface RemoteDockerExecDetachedResponse {
  commandId: string;
}

export interface RemoteDockerFileResponse {
  content: string;
}

export interface RemoteDockerWriteFileRequest {
  path: string;
  content: string;
  encoding: "utf-8";
}

export interface RemoteDockerStatResponse {
  path: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
}

export interface RemoteDockerMkdirRequest {
  path: string;
  recursive?: boolean;
}

export interface RemoteDockerDirectoryEntry {
  name: string;
  kind: "file" | "directory";
}

export interface RemoteDockerReaddirResponse {
  entries: RemoteDockerDirectoryEntry[];
}

export interface RemoteDockerExtendTimeoutRequest {
  additionalMs: number;
}

export interface RemoteDockerExtendTimeoutResponse {
  expiresAt: number;
}

export interface RemoteDockerPortResponse {
  url: string;
  hostPort: number;
}

export interface RemoteDockerDeleteSandboxResponse {
  stopped: boolean;
}
