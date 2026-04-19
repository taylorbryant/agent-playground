import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const connectCalls: Array<Record<string, unknown>> = [];
const execCalls: Array<Record<string, unknown>> = [];
const fileWrites: Array<Record<string, unknown>> = [];
const mkdirCalls: Array<Record<string, unknown>> = [];

const sandbox = {
  workingDirectory: "/workspace/project",
  currentBranch: "feature/remote-docker",
  expiresAt: 123_456,
  exec: async (command: string, cwd: string, timeoutMs: number) => {
    execCalls.push({ command, cwd, timeoutMs });
    return {
      success: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      truncated: false,
    };
  },
  execDetached: async (command: string, cwd: string) => ({
    commandId: `detached:${cwd}:${command}`,
  }),
  readFile: async (filePath: string) => `file:${filePath}`,
  writeFile: async (filePath: string, content: string, encoding: string) => {
    fileWrites.push({ filePath, content, encoding });
  },
  stat: async (filePath: string) => ({
    path: filePath,
    isDirectory: () => filePath.endsWith("/"),
    isFile: () => !filePath.endsWith("/"),
    size: 42,
    mtimeMs: 999,
  }),
  mkdir: async (filePath: string, options?: { recursive?: boolean }) => {
    mkdirCalls.push({ filePath, options });
  },
  readdir: async () => [
    {
      name: "src",
      isDirectory: () => true,
    },
    {
      name: "package.json",
      isDirectory: () => false,
    },
  ],
  domain: (port: number) => `http://127.0.0.1:${30_000 + port}`,
  stop: async () => {},
  extendTimeout: async (additionalMs: number) => ({
    expiresAt: 123_456 + additionalMs,
  }),
  getState: () => ({
    sandboxName: "session_session-1",
    workspacePath: "/workspace/project",
    expiresAt: 123_456,
    containerName: "open-harness-session_session-1",
    portMappings: {
      3000: 33_000,
    },
  }),
};

mock.module("@open-harness/sandbox", () => ({
  DockerSandbox: {
    connect: async (state: unknown, options: unknown) => {
      connectCalls.push({ state, options });
      return sandbox;
    },
  },
}));

const routeModulePromise = import("./router");
const storeModulePromise = import("./store");

describe("sandbox-control router", () => {
  beforeEach(async () => {
    connectCalls.length = 0;
    execCalls.length = 0;
    fileWrites.length = 0;
    mkdirCalls.length = 0;

    const { sandboxControlStore } = await storeModulePromise;
    sandboxControlStore.reset();
  });

  afterEach(() => {
    delete process.env.OPEN_HARNESS_SANDBOX_CONTROL_PREVIEW_BASE_URL;
    delete process.env.OPEN_HARNESS_SANDBOX_HOST_ID;
  });

  test("creates sandboxes and preserves connect options", async () => {
    const { handleSandboxControlRequest } = await routeModulePromise;

    const response = await handleSandboxControlRequest(
      new Request("http://localhost/sandboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxName: "session_session-1",
          workspacePath: "/workspace/project",
          ports: [3000],
          timeoutMs: 60_000,
          githubToken: "ghs_test",
          gitUser: {
            name: "Taylor",
            email: "taylor@example.com",
          },
        }),
      }),
    );

    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      sandboxId: string;
      sandboxHostId: string;
      ports: Array<{ port: number; hostPort: number; url: string }>;
    };

    expect(body.sandboxId).toBeString();
    expect(body.sandboxHostId).toBe("sandbox-host-1");
    expect(body.ports).toEqual([
      {
        port: 3000,
        hostPort: 33_000,
        url: "http://127.0.0.1:33000",
      },
    ]);
    expect(connectCalls[0]).toMatchObject({
      state: {
        sandboxName: "session_session-1",
        workspacePath: "/workspace/project",
      },
      options: {
        ports: [3000],
        timeout: 60_000,
        githubToken: "ghs_test",
        gitUser: {
          name: "Taylor",
          email: "taylor@example.com",
        },
      },
    });
  });

  test("executes commands and exposes file APIs", async () => {
    const { handleSandboxControlRequest } = await routeModulePromise;

    const createResponse = await handleSandboxControlRequest(
      new Request("http://localhost/sandboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxName: "session_session-1",
          workspacePath: "/workspace/project",
          ports: [3000],
        }),
      }),
    );
    const created = (await createResponse.json()) as { sandboxId: string };

    const execResponse = await handleSandboxControlRequest(
      new Request(`http://localhost/sandboxes/${created.sandboxId}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "bun test",
          cwd: "/workspace/project",
          timeoutMs: 30_000,
        }),
      }),
    );

    expect(execResponse.status).toBe(200);
    expect(await execResponse.json()).toMatchObject({
      success: true,
      stdout: "ok",
    });
    expect(execCalls).toEqual([
      {
        command: "bun test",
        cwd: "/workspace/project",
        timeoutMs: 30_000,
      },
    ]);

    const fileResponse = await handleSandboxControlRequest(
      new Request(
        `http://localhost/sandboxes/${created.sandboxId}/file?path=/workspace/project/README.md`,
      ),
    );
    expect(fileResponse.status).toBe(200);
    expect(await fileResponse.json()).toEqual({
      content: "file:/workspace/project/README.md",
    });

    const statResponse = await handleSandboxControlRequest(
      new Request(
        `http://localhost/sandboxes/${created.sandboxId}/stat?path=/workspace/project/package.json`,
      ),
    );
    expect(statResponse.status).toBe(200);
    expect(await statResponse.json()).toEqual({
      path: "/workspace/project/package.json",
      kind: "file",
      size: 42,
      mtimeMs: 999,
    });

    const readdirResponse = await handleSandboxControlRequest(
      new Request(
        `http://localhost/sandboxes/${created.sandboxId}/readdir?path=/workspace/project`,
      ),
    );
    expect(readdirResponse.status).toBe(200);
    expect(await readdirResponse.json()).toEqual({
      entries: [
        { name: "src", kind: "directory" },
        { name: "package.json", kind: "file" },
      ],
    });
  });

  test("supports writes, mkdir, and preview-base URLs", async () => {
    process.env.OPEN_HARNESS_SANDBOX_CONTROL_PREVIEW_BASE_URL =
      "https://preview.internal";

    const { handleSandboxControlRequest } = await routeModulePromise;

    const createResponse = await handleSandboxControlRequest(
      new Request("http://localhost/sandboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxName: "session_session-1",
          workspacePath: "/workspace/project",
          ports: [3000],
        }),
      }),
    );
    const created = (await createResponse.json()) as { sandboxId: string };

    const writeResponse = await handleSandboxControlRequest(
      new Request(`http://localhost/sandboxes/${created.sandboxId}/file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/workspace/project/notes.txt",
          content: "hello",
          encoding: "utf-8",
        }),
      }),
    );
    expect(writeResponse.status).toBe(204);
    expect(fileWrites).toEqual([
      {
        filePath: "/workspace/project/notes.txt",
        content: "hello",
        encoding: "utf-8",
      },
    ]);

    const mkdirResponse = await handleSandboxControlRequest(
      new Request(`http://localhost/sandboxes/${created.sandboxId}/mkdir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/workspace/project/src/generated",
          recursive: true,
        }),
      }),
    );
    expect(mkdirResponse.status).toBe(204);
    expect(mkdirCalls).toEqual([
      {
        filePath: "/workspace/project/src/generated",
        options: { recursive: true },
      },
    ]);

    const portResponse = await handleSandboxControlRequest(
      new Request(`http://localhost/sandboxes/${created.sandboxId}/ports/3000`),
    );
    expect(portResponse.status).toBe(200);
    expect(await portResponse.json()).toEqual({
      url: `https://preview.internal/sandboxes/${created.sandboxId}/ports/3000`,
      hostPort: 33_000,
    });
  });
});
