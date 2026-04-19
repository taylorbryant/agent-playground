const isExplicitlyDisabled =
  process.env.OPEN_HARNESS_LOCAL_MODE === "0" ||
  process.env.NEXT_PUBLIC_OPEN_HARNESS_LOCAL_MODE === "0";
const isExplicitlyEnabled =
  process.env.OPEN_HARNESS_LOCAL_MODE === "1" ||
  process.env.NEXT_PUBLIC_OPEN_HARNESS_LOCAL_MODE === "1";
const isTestEnvironment = process.env.NODE_ENV === "test";

export const CLIENT_LOCAL_MODE =
  !isExplicitlyDisabled && (isExplicitlyEnabled || !isTestEnvironment);

export function isLocalModeEnabled(): boolean {
  return CLIENT_LOCAL_MODE;
}

export function getPrimaryAuthProvider(): "local" {
  return "local";
}
