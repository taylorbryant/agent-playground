import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_SANDBOX_TIMEOUT_MS } from "@/lib/sandbox/config";

mock.module("server-only", () => ({}));

interface TestSessionRecord {
  id: string;
  userId: string;
  lifecycleVersion: number;
  sandboxState: { type: "local" | "docker" };
  vercelProjectId: string | null;
  vercelProjectName: string | null;
  vercelTeamId: string | null;
  globalSkillRefs: Array<{ source: string; skillName: string }>;
}

interface KickCall {
  sessionId: string;
  reason: string;
}

interface ConnectConfig {
  state: {
    type: "local" | "docker";
    sandboxName?: string;
    workspacePath?: string;
    managedWorkspace?: boolean;
    source?: {
      repo?: string;
      branch?: string;
      newBranch?: string;
    };
  };
  options?: {
    githubToken?: string;
    gitUser?: {
      email?: string;
    };
    persistent?: boolean;
    resume?: boolean;
    createIfMissing?: boolean;
  };
}

const kickCalls: KickCall[] = [];
const updateCalls: Array<{
  sessionId: string;
  patch: Record<string, unknown>;
}> = [];
const connectConfigs: ConnectConfig[] = [];
const writeFileCalls: Array<{ path: string; content: string }> = [];
const execCalls: Array<{ command: string; cwd: string; timeoutMs: number }> =
  [];
const dotenvSyncCalls: Array<Record<string, unknown>> = [];

let sessionRecord: TestSessionRecord;
let currentGitHubToken: string | null;
const originalSandboxBackend = process.env.OPEN_HARNESS_SANDBOX_BACKEND;

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => ({
    user: {
      id: "user-1",
      username: "nico",
      name: "Nico",
      email: "nico@example.com",
    },
  }),
}));

mock.module("@/lib/db/accounts", () => ({
  getGitHubAccount: async () => ({
    externalUserId: "12345",
    username: "nico-gh",
    accessToken: "token",
    refreshToken: null,
    expiresAt: null,
  }),
}));

mock.module("@/lib/github/user-token", () => ({
  getUserGitHubToken: async () => currentGitHubToken,
}));

mock.module("@/lib/vercel/token", () => ({
  getUserVercelAuthInfo: async () => null,
  getUserVercelToken: async () => null,
}));

mock.module("@/lib/vercel/projects", () => ({
  buildDevelopmentDotenvFromVercelProject: async (
    input: Record<string, unknown>,
  ) => {
    dotenvSyncCalls.push(input);
    return "";
  },
}));

mock.module("@/lib/db/sessions", () => ({
  getChatsBySessionId: async () => [],
  getSessionById: async () => sessionRecord,
  updateSession: async (sessionId: string, patch: Record<string, unknown>) => {
    updateCalls.push({ sessionId, patch });
    return {
      ...sessionRecord,
      ...patch,
    };
  },
}));

mock.module("@/lib/sandbox/lifecycle-kick", () => ({
  kickSandboxLifecycleWorkflow: (input: KickCall) => {
    kickCalls.push(input);
  },
}));

mock.module("@open-harness/sandbox", () => ({
  connectSandbox: async (config: ConnectConfig) => {
    connectConfigs.push(config);

    return {
      currentBranch: "main",
      workingDirectory: "/local/sandbox",
      getState: () => ({
        type: "local" as const,
        sandboxName: config.state.sandboxName ?? "session_session-1",
        expiresAt: Date.now() + 120_000,
      }),
      exec: async (command: string, cwd: string, timeoutMs: number) => {
        execCalls.push({ command, cwd, timeoutMs });
        if (command === 'printf %s "$HOME"') {
          return {
            success: true,
            exitCode: 0,
            stdout: "/root",
            stderr: "",
            truncated: false,
          };
        }

        return {
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          truncated: false,
        };
      },
      writeFile: async (path: string, content: string) => {
        writeFileCalls.push({ path, content });
      },
      stop: async () => {},
    };
  },
}));

const routeModulePromise = import("./route");

describe("/api/sandbox lifecycle kicks", () => {
  beforeEach(() => {
    kickCalls.length = 0;
    updateCalls.length = 0;
    connectConfigs.length = 0;
    writeFileCalls.length = 0;
    execCalls.length = 0;
    dotenvSyncCalls.length = 0;
    currentGitHubToken = null;
    delete process.env.OPEN_HARNESS_SANDBOX_BACKEND;
    sessionRecord = {
      id: "session-1",
      userId: "user-1",
      lifecycleVersion: 3,
      sandboxState: { type: "local" },
      vercelProjectId: "project-1",
      vercelProjectName: "open-harness-web",
      vercelTeamId: "team-1",
      globalSkillRefs: [],
    };
  });

  test("uses session_<sessionId> as the persistent sandbox name", async () => {
    const { POST } = await routeModulePromise;
    sessionRecord.vercelProjectId = null;
    sessionRecord.vercelProjectName = null;
    sessionRecord.vercelTeamId = null;

    const request = new Request("http://localhost/api/sandbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        sandboxType: "local",
      }),
    });

    const response = await POST(request);

    expect(response.ok).toBe(true);
    expect(kickCalls).toEqual([
      {
        sessionId: "session-1",
        reason: "sandbox-created",
      },
    ]);
    expect(connectConfigs[0]).toMatchObject({
      state: {
        type: "local",
        sandboxName: "session_session-1",
      },
      options: {
        persistent: true,
        resume: true,
        createIfMissing: true,
      },
    });
    expect(dotenvSyncCalls).toHaveLength(0);
  });

  test("uses the configured docker backend when enabled", async () => {
    const { POST } = await routeModulePromise;

    process.env.OPEN_HARNESS_SANDBOX_BACKEND = "docker";
    sessionRecord.sandboxState = { type: "docker" };
    sessionRecord.vercelProjectId = null;
    sessionRecord.vercelProjectName = null;
    sessionRecord.vercelTeamId = null;

    const response = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          sandboxType: "local",
        }),
      }),
    );

    expect(response.ok).toBe(true);
    expect(connectConfigs[0]).toMatchObject({
      state: {
        type: "docker",
        sandboxName: "session_session-1",
      },
    });
  });

  test("repo sandboxes broker the user GitHub token instead of embedding it", async () => {
    const { POST } = await routeModulePromise;

    currentGitHubToken = "github-user-token";
    sessionRecord.vercelProjectId = null;
    sessionRecord.vercelProjectName = null;
    sessionRecord.vercelTeamId = null;

    const response = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/acme/private-repo",
          branch: "main",
          sandboxType: "local",
        }),
      }),
    );

    expect(response.ok).toBe(true);
    expect(connectConfigs[0]).toMatchObject({
      state: {
        type: "local",
        managedWorkspace: true,
        source: {
          repo: "https://github.com/acme/private-repo",
          branch: "main",
        },
      },
      options: {
        githubToken: "github-user-token",
      },
    });
    expect(connectConfigs[0]?.state.source).not.toHaveProperty("token");
  });

  test("new local sandbox skips Vercel auth and env syncing", async () => {
    const { POST } = await routeModulePromise;

    const request = new Request("http://localhost/api/sandbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        sandboxType: "local",
      }),
    });

    const response = await POST(request);

    expect(response.ok).toBe(true);
    expect(kickCalls).toEqual([
      {
        sessionId: "session-1",
        reason: "sandbox-created",
      },
    ]);
    expect(updateCalls.length).toBeGreaterThan(0);
    expect(connectConfigs[0]?.options?.gitUser?.email).toBe(
      "12345+nico-gh@users.noreply.github.com",
    );
    expect(dotenvSyncCalls).toHaveLength(0);
    expect(writeFileCalls).toEqual([]);

    const payload = (await response.json()) as {
      timeout: number;
      mode: string;
    };
    expect(payload.timeout).toBe(DEFAULT_SANDBOX_TIMEOUT_MS);
    expect(payload.mode).toBe("local");
  });

  test("local sandbox creation ignores legacy Vercel project metadata", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          sandboxType: "local",
        }),
      }),
    );

    expect(response.ok).toBe(true);
    expect(kickCalls).toEqual([
      {
        sessionId: "session-1",
        reason: "sandbox-created",
      },
    ]);
    expect(dotenvSyncCalls).toHaveLength(0);
    expect(writeFileCalls).toEqual([]);
  });

  test("new sandboxes install global skills", async () => {
    const { POST } = await routeModulePromise;

    sessionRecord.globalSkillRefs = [
      { source: "vercel/ai", skillName: "ai-sdk" },
    ];

    const response = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          sandboxType: "local",
        }),
      }),
    );

    expect(response.ok).toBe(true);
    expect(execCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: 'printf %s "$HOME"' }),
        expect.objectContaining({
          command:
            "HOME='/root' npx skills add 'vercel/ai' --skill 'ai-sdk' --agent amp -g -y --copy",
        }),
      ]),
    );
  });

  test("rejects unsupported sandbox types", async () => {
    const { POST } = await routeModulePromise;

    const request = new Request("http://localhost/api/sandbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        sandboxType: "invalid",
      }),
    });

    const response = await POST(request);
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Invalid sandbox type");
    expect(connectConfigs).toHaveLength(0);
    expect(kickCalls).toHaveLength(0);
  });
});

afterEach(() => {
  if (originalSandboxBackend === undefined) {
    delete process.env.OPEN_HARNESS_SANDBOX_BACKEND;
    return;
  }

  process.env.OPEN_HARNESS_SANDBOX_BACKEND = originalSandboxBackend;
});
