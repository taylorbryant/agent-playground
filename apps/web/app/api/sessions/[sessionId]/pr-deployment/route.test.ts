import { beforeEach, describe, expect, mock, test } from "bun:test";

const currentSessionRecord = {
  userId: "user-1",
  repoOwner: "vercel",
  repoName: "open-harness",
  prNumber: null as number | null,
};

let currentPullRequestDeploymentResult: {
  success: boolean;
  deploymentUrl?: string | null;
} = {
  success: false,
};
let currentGitHubToken: string | null = "repo-token";

const getUserGitHubTokenMock = mock(async () => currentGitHubToken);
const findLatestVercelDeploymentUrlForPullRequestMock = mock(
  async () => currentPullRequestDeploymentResult,
);

mock.module("@/app/api/sessions/_lib/session-context", () => ({
  requireAuthenticatedUser: async () => ({
    ok: true,
    userId: "user-1",
  }),
  requireOwnedSession: async () => ({
    ok: true,
    sessionRecord: currentSessionRecord,
  }),
}));

mock.module("@/lib/github/user-token", () => ({
  getUserGitHubToken: getUserGitHubTokenMock,
}));

mock.module("@/lib/github/client", () => ({
  findLatestVercelDeploymentUrlForPullRequest:
    findLatestVercelDeploymentUrlForPullRequestMock,
}));

const routeModulePromise = import("./route");

function createRouteContext(sessionId = "session-1") {
  return {
    params: Promise.resolve({ sessionId }),
  };
}

describe("/api/sessions/[sessionId]/pr-deployment", () => {
  beforeEach(() => {
    currentSessionRecord.repoOwner = "vercel";
    currentSessionRecord.repoName = "open-harness";
    currentSessionRecord.prNumber = null;
    currentGitHubToken = "repo-token";
    currentPullRequestDeploymentResult = { success: false };
    getUserGitHubTokenMock.mockClear();
    findLatestVercelDeploymentUrlForPullRequestMock.mockClear();
  });

  test("returns null when the session has no pull request yet", async () => {
    const { GET } = await routeModulePromise;

    const response = await GET(
      new Request("http://localhost/api/sessions/session-1/pr-deployment"),
      createRouteContext(),
    );
    const body = (await response.json()) as { deploymentUrl: string | null };

    expect(response.status).toBe(200);
    expect(body.deploymentUrl).toBeNull();
    expect(getUserGitHubTokenMock).toHaveBeenCalledTimes(0);
    expect(
      findLatestVercelDeploymentUrlForPullRequestMock,
    ).toHaveBeenCalledTimes(0);
  });

  test("returns null when the requested PR number does not match the session", async () => {
    const { GET } = await routeModulePromise;

    currentSessionRecord.prNumber = 42;

    const response = await GET(
      new Request(
        "http://localhost/api/sessions/session-1/pr-deployment?prNumber=43",
      ),
      createRouteContext(),
    );
    const body = (await response.json()) as { deploymentUrl: string | null };

    expect(response.status).toBe(200);
    expect(body.deploymentUrl).toBeNull();
    expect(getUserGitHubTokenMock).toHaveBeenCalledTimes(0);
  });

  test("returns null when no GitHub token is available", async () => {
    const { GET } = await routeModulePromise;

    currentSessionRecord.prNumber = 42;
    currentGitHubToken = null;

    const response = await GET(
      new Request(
        "http://localhost/api/sessions/session-1/pr-deployment?prNumber=42",
      ),
      createRouteContext(),
    );
    const body = (await response.json()) as { deploymentUrl: string | null };

    expect(response.status).toBe(200);
    expect(body.deploymentUrl).toBeNull();
    expect(getUserGitHubTokenMock).toHaveBeenCalledTimes(1);
    expect(
      findLatestVercelDeploymentUrlForPullRequestMock,
    ).toHaveBeenCalledTimes(0);
  });

  test("returns the latest deployment URL for the current pull request", async () => {
    const { GET } = await routeModulePromise;

    currentSessionRecord.prNumber = 42;
    currentPullRequestDeploymentResult = {
      success: true,
      deploymentUrl: "https://pr-preview.vercel.app",
    };

    const response = await GET(
      new Request(
        "http://localhost/api/sessions/session-1/pr-deployment?prNumber=42",
      ),
      createRouteContext(),
    );
    const body = (await response.json()) as { deploymentUrl: string | null };

    expect(response.status).toBe(200);
    expect(body.deploymentUrl).toBe("https://pr-preview.vercel.app");
    expect(
      findLatestVercelDeploymentUrlForPullRequestMock,
    ).toHaveBeenCalledWith({
      owner: "vercel",
      repo: "open-harness",
      prNumber: 42,
      token: "repo-token",
    });
  });
});
