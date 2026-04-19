import { afterEach, describe, expect, test } from "bun:test";
import {
  getConfiguredSandboxBackend,
  isSupportedRuntimeSandboxBackend,
} from "./backend";

const originalBackend = process.env.OPEN_HARNESS_SANDBOX_BACKEND;

afterEach(() => {
  if (originalBackend === undefined) {
    delete process.env.OPEN_HARNESS_SANDBOX_BACKEND;
    return;
  }

  process.env.OPEN_HARNESS_SANDBOX_BACKEND = originalBackend;
});

describe("sandbox backend config", () => {
  test("defaults to local when unset", () => {
    delete process.env.OPEN_HARNESS_SANDBOX_BACKEND;

    expect(getConfiguredSandboxBackend()).toBe("local");
  });

  test("uses docker when configured", () => {
    process.env.OPEN_HARNESS_SANDBOX_BACKEND = "docker";

    expect(getConfiguredSandboxBackend()).toBe("docker");
  });

  test("uses remote-docker when configured", () => {
    process.env.OPEN_HARNESS_SANDBOX_BACKEND = "remote-docker";

    expect(getConfiguredSandboxBackend()).toBe("remote-docker");
  });

  test("treats unsupported values as local", () => {
    process.env.OPEN_HARNESS_SANDBOX_BACKEND = "invalid";

    expect(getConfiguredSandboxBackend()).toBe("local");
  });

  test("validates supported backend names", () => {
    expect(isSupportedRuntimeSandboxBackend("local")).toBe(true);
    expect(isSupportedRuntimeSandboxBackend("docker")).toBe(true);
    expect(isSupportedRuntimeSandboxBackend("remote-docker")).toBe(true);
    expect(isSupportedRuntimeSandboxBackend("vercel")).toBe(false);
  });
});
