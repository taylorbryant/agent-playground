import { spawn } from "node:child_process";
import type { ExecResult } from "../interface";

interface RunProcessParams {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function runProcess(
  params: RunProcessParams,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd,
      env: params.env as NodeJS.ProcessEnv | undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killedByTimeout = false;

    const finish = (result: ExecResult) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      params.signal?.removeEventListener("abort", handleAbort);
      resolve(result);
    };

    const fail = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      params.signal?.removeEventListener("abort", handleAbort);
      reject(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", fail);
    child.on("close", (code: number | null) => {
      finish({
        success: code === 0 && !killedByTimeout,
        exitCode: code,
        stdout,
        stderr: killedByTimeout
          ? `${stderr}\nCommand timed out`.trim()
          : stderr,
        truncated: false,
      });
    });

    const handleAbort = () => {
      child.kill("SIGTERM");
      finish({
        success: false,
        exitCode: null,
        stdout,
        stderr: `${stderr}\nCommand aborted`.trim(),
        truncated: false,
      });
    };

    params.signal?.addEventListener("abort", handleAbort, { once: true });

    const timeoutId = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGTERM");
    }, params.timeoutMs);
  });
}
