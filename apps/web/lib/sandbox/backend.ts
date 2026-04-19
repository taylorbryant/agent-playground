import type { SandboxState } from "@open-harness/sandbox";

export type RuntimeSandboxBackend = Extract<
  SandboxState["type"],
  "local" | "docker" | "remote-docker"
>;

const VALID_SANDBOX_BACKENDS = ["local", "docker", "remote-docker"] as const;

export function isSupportedRuntimeSandboxBackend(
  value: unknown,
): value is RuntimeSandboxBackend {
  return (
    typeof value === "string" &&
    VALID_SANDBOX_BACKENDS.includes(value as RuntimeSandboxBackend)
  );
}

export function getConfiguredSandboxBackend(): RuntimeSandboxBackend {
  const configured = process.env.OPEN_HARNESS_SANDBOX_BACKEND;
  if (isSupportedRuntimeSandboxBackend(configured)) {
    return configured;
  }

  return "local";
}
