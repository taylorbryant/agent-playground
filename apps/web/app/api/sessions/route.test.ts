import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let currentSession: {
  authProvider?: "vercel" | "github";
  user: {
    id: string;
    username: string;
    name: string;
    email?: string;
  };
} | null = {
  user: {
    id: "user-1",
    username: "nico",
    name: "Nico",
  },
};
let existingSessionCount = 0;
const createCalls: Array<Record<string, unknown>> = [];
const originalSandboxBackend = process.env.OPEN_HARNESS_SANDBOX_BACKEND;

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => currentSession,
}));

mock.module("@/lib/random-city", () => ({
  getRandomCityName: () => "Oslo",
}));

mock.module("@/lib/db/user-preferences", () => ({
  getUserPreferences: async () => ({
    defaultModelId: "anthropic/claude-haiku-4.5",
    defaultSubagentModelId: null,
    defaultSandboxType: "local",
    defaultDiffMode: "unified",
    autoCommitPush: false,
    autoCreatePr: false,
    alertsEnabled: true,
    alertSoundEnabled: true,
    publicUsageEnabled: false,
    globalSkillRefs: [{ source: "vercel/ai", skillName: "ai-sdk" }],
    modelVariants: [],
    enabledModelIds: [],
  }),
}));

mock.module("@/lib/db/sessions", () => ({
  countSessionsByUserId: async () => existingSessionCount,
  createSessionWithInitialChat: async (input: {
    session: Record<string, unknown>;
    initialChat: Record<string, unknown>;
  }) => {
    createCalls.push(input.session);
    return {
      session: {
        ...input.session,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      chat: {
        id: String(input.initialChat.id),
        sessionId: String(input.session.id),
        title: String(input.initialChat.title),
        modelId: String(input.initialChat.modelId),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
  },
  getArchivedSessionCountByUserId: async () => 0,
  getSessionsWithUnreadByUserId: async () => [],
  getUsedSessionTitles: async () => new Set<string>(),
}));

const routeModulePromise = import("./route");

function createJsonRequest(
  body: unknown,
  url = "http://localhost/api/sessions",
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/sessions POST", () => {
  beforeEach(() => {
    currentSession = {
      user: {
        id: "user-1",
        username: "nico",
        name: "Nico",
      },
    };
    existingSessionCount = 0;
    createCalls.length = 0;
    delete process.env.OPEN_HARNESS_SANDBOX_BACKEND;
  });

  test("blocks additional sessions for non-Vercel trial users on the managed deployment", async () => {
    const { POST } = await routeModulePromise;

    currentSession = {
      authProvider: "vercel",
      user: {
        id: "user-1",
        username: "nico",
        name: "Nico",
        email: "person@example.com",
      },
    };
    existingSessionCount = 1;

    const response = await POST(
      createJsonRequest(
        {
          branch: "main",
          cloneUrl: "https://github.com/vercel/open-harness",
          repoOwner: "vercel",
          repoName: "open-harness",
        },
        "https://open-agents.dev/api/sessions",
      ),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      "This hosted deployment includes 1 trial session for non-Vercel accounts. Deploy your own copy to start more.",
    );
    expect(createCalls).toHaveLength(0);
  });

  test("creates a local session and clears stored Vercel project metadata", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      createJsonRequest({
        repoOwner: "Vercel",
        repoName: "Open-Harness",
        branch: "main",
        cloneUrl: "https://github.com/Vercel/Open-Harness",
        sandboxType: "local",
      }),
    );
    const body = (await response.json()) as {
      session: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(createCalls[0]).toMatchObject({
      repoOwner: "Vercel",
      repoName: "Open-Harness",
      sandboxState: { type: "local" },
      vercelProjectId: null,
      vercelProjectName: null,
      vercelTeamId: null,
      vercelTeamSlug: null,
    });
    expect(body.session.vercelProjectId).toBeNull();
    expect(body.session.vercelProjectName).toBeNull();
  });

  test("rejects unsupported sandbox types", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      createJsonRequest({
        repoOwner: "vercel",
        repoName: "open-harness",
        branch: "main",
        cloneUrl: "https://github.com/vercel/open-harness",
        sandboxType: "vercel",
      }),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid sandbox type");
    expect(createCalls).toHaveLength(0);
  });

  test("new sessions snapshot the user global skill refs", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      createJsonRequest({
        repoOwner: "vercel",
        repoName: "open-harness",
        branch: "main",
        cloneUrl: "https://github.com/vercel/open-harness",
      }),
    );

    expect(response.status).toBe(200);
    expect(createCalls[0]).toMatchObject({
      globalSkillRefs: [{ source: "vercel/ai", skillName: "ai-sdk" }],
    });
  });

  test("persists the configured docker backend in new sessions", async () => {
    const { POST } = await routeModulePromise;

    process.env.OPEN_HARNESS_SANDBOX_BACKEND = "docker";

    const response = await POST(
      createJsonRequest({
        repoOwner: "vercel",
        repoName: "open-harness",
        branch: "main",
        cloneUrl: "https://github.com/vercel/open-harness",
        sandboxType: "local",
      }),
    );

    expect(response.status).toBe(200);
    expect(createCalls[0]).toMatchObject({
      sandboxState: { type: "docker" },
    });
  });

  test("rejects invalid repository owners", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      createJsonRequest({
        repoOwner: 'vercel" && echo nope && "',
        repoName: "open-harness",
        branch: "main",
        cloneUrl: "https://github.com/vercel/open-harness",
      }),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid repository owner");
    expect(createCalls).toHaveLength(0);
  });

  test("persists autoCreatePr when autoCommitPush is enabled", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      createJsonRequest({
        repoOwner: "vercel",
        repoName: "open-harness",
        branch: "feature/auto-pr",
        cloneUrl: "https://github.com/vercel/open-harness",
        autoCommitPush: true,
        autoCreatePr: true,
      }),
    );

    expect(response.status).toBe(200);
    expect(createCalls[0]).toMatchObject({
      autoCommitPushOverride: true,
      autoCreatePrOverride: true,
    });
  });
});

afterEach(() => {
  if (originalSandboxBackend === undefined) {
    delete process.env.OPEN_HARNESS_SANDBOX_BACKEND;
    return;
  }

  process.env.OPEN_HARNESS_SANDBOX_BACKEND = originalSandboxBackend;
});
