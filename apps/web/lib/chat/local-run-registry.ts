const LOCAL_RUN_ID_PREFIX = "local:";

type LocalRunEntry = {
  chatId: string;
  abortController: AbortController;
};

const localRuns = new Map<string, LocalRunEntry>();

export function createLocalRunId(): string {
  return `${LOCAL_RUN_ID_PREFIX}${crypto.randomUUID()}`;
}

export function isLocalRunId(runId: string | null | undefined): boolean {
  return typeof runId === "string" && runId.startsWith(LOCAL_RUN_ID_PREFIX);
}

export function registerLocalRun(
  runId: string,
  chatId: string,
  abortController: AbortController,
): void {
  localRuns.set(runId, { chatId, abortController });
}

export function unregisterLocalRun(runId: string): void {
  localRuns.delete(runId);
}

export function hasActiveLocalRun(runId: string): boolean {
  return localRuns.has(runId);
}

export function abortLocalRun(runId: string): boolean {
  const entry = localRuns.get(runId);
  if (!entry) {
    return false;
  }

  entry.abortController.abort();
  return true;
}
