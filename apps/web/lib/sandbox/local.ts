import path from "node:path";

export function getLocalWorkspacePath(): string {
  if (process.env.OPEN_HARNESS_LOCAL_WORKSPACE_PATH) {
    return path.resolve(process.env.OPEN_HARNESS_LOCAL_WORKSPACE_PATH);
  }

  return path.resolve(process.cwd(), "../..");
}

export function isLocalSandboxType(value: unknown): value is "local" {
  return value === "local";
}
