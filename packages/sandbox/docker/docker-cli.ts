import { runProcess } from "../shared/process";

const DOCKER_COMMAND_TIMEOUT_MS = 60_000;

function isMissingContainerMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("no such container") ||
    normalized.includes("no such object")
  );
}

export async function containerExists(containerName: string): Promise<boolean> {
  const result = await runProcess({
    command: "docker",
    args: ["inspect", containerName],
    cwd: process.cwd(),
    timeoutMs: DOCKER_COMMAND_TIMEOUT_MS,
  });

  if (result.success) {
    return true;
  }

  if (isMissingContainerMessage(result.stderr)) {
    return false;
  }

  throw new Error(result.stderr || result.stdout || "docker inspect failed");
}

export async function isContainerRunning(
  containerName: string,
): Promise<boolean> {
  const result = await runProcess({
    command: "docker",
    args: ["inspect", "--format", "{{.State.Running}}", containerName],
    cwd: process.cwd(),
    timeoutMs: DOCKER_COMMAND_TIMEOUT_MS,
  });

  if (!result.success) {
    if (isMissingContainerMessage(result.stderr)) {
      return false;
    }

    throw new Error(result.stderr || result.stdout || "docker inspect failed");
  }

  return result.stdout.trim() === "true";
}

export async function startContainer(containerName: string): Promise<void> {
  const result = await runProcess({
    command: "docker",
    args: ["start", containerName],
    cwd: process.cwd(),
    timeoutMs: DOCKER_COMMAND_TIMEOUT_MS,
  });

  if (!result.success) {
    throw new Error(result.stderr || result.stdout || "docker start failed");
  }
}

export async function removeContainer(containerName: string): Promise<void> {
  const result = await runProcess({
    command: "docker",
    args: ["rm", "-f", containerName],
    cwd: process.cwd(),
    timeoutMs: DOCKER_COMMAND_TIMEOUT_MS,
  });

  if (!result.success && !isMissingContainerMessage(result.stderr)) {
    throw new Error(result.stderr || result.stdout || "docker rm failed");
  }
}

export async function runContainer(params: {
  containerName: string;
  image: string;
  workspacePath: string;
  ports: number[];
}): Promise<void> {
  const args = [
    "run",
    "-d",
    "--init",
    "--name",
    params.containerName,
    "-w",
    "/workspace",
    "-v",
    `${params.workspacePath}:/workspace`,
    "-e",
    "HOME=/tmp/open-harness-home",
  ];

  for (const port of params.ports) {
    args.push("-p", `127.0.0.1::${port}`);
  }

  args.push(
    params.image,
    "sh",
    "-lc",
    "trap exit TERM INT; while :; do sleep 3600; done",
  );

  const result = await runProcess({
    command: "docker",
    args,
    cwd: process.cwd(),
    timeoutMs: DOCKER_COMMAND_TIMEOUT_MS,
  });

  if (!result.success) {
    throw new Error(result.stderr || result.stdout || "docker run failed");
  }
}

export async function getPublishedPort(
  containerName: string,
  containerPort: number,
): Promise<number | null> {
  const result = await runProcess({
    command: "docker",
    args: ["port", containerName, `${containerPort}/tcp`],
    cwd: process.cwd(),
    timeoutMs: DOCKER_COMMAND_TIMEOUT_MS,
  });

  if (!result.success) {
    if (isMissingContainerMessage(result.stderr)) {
      return null;
    }

    throw new Error(result.stderr || result.stdout || "docker port failed");
  }

  const firstLine = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return null;
  }

  const parts = firstLine.split(":");
  const hostPort = Number(parts.at(-1));
  return Number.isFinite(hostPort) ? hostPort : null;
}
