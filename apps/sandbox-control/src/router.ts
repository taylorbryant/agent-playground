import type {
  CreateRemoteDockerSandboxRequest,
  RemoteDockerExecDetachedRequest,
  RemoteDockerExecRequest,
  RemoteDockerExtendTimeoutRequest,
  RemoteDockerMkdirRequest,
  RemoteDockerWriteFileRequest,
} from "@open-harness/sandbox";
import { sandboxControlStore } from "./store";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function textError(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

async function parseJson<T>(request: Request): Promise<T | Response> {
  try {
    return (await request.json()) as T;
  } catch {
    return textError("Invalid JSON body", 400);
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getStatusForError(error: unknown): number {
  const code = getErrorCode(error);
  const message = getErrorMessage(error).toLowerCase();

  if (
    code === "ENOENT" ||
    message.includes("enoent") ||
    message.includes("no such file") ||
    message.includes("not found")
  ) {
    return 404;
  }

  if (
    code === "EISDIR" ||
    code === "ENOTDIR" ||
    code === "EINVAL" ||
    message.includes("is a directory") ||
    message.includes("not a directory")
  ) {
    return 400;
  }

  return 500;
}

function requirePath(url: URL): string | Response {
  const requestedPath = url.searchParams.get("path")?.trim();
  if (!requestedPath) {
    return textError("Missing path", 400);
  }

  return requestedPath;
}

export async function handleSandboxControlRequest(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true });
  }

  try {
    if (
      segments.length === 1 &&
      segments[0] === "sandboxes" &&
      request.method === "POST"
    ) {
      const body = await parseJson<CreateRemoteDockerSandboxRequest>(request);
      if (body instanceof Response) {
        return body;
      }

      const sandbox = await sandboxControlStore.createOrResume(body);
      return json(sandbox, 201);
    }

    if (segments.length >= 2 && segments[0] === "sandboxes") {
      const sandboxId = decodeURIComponent(segments[1] ?? "");
      if (!sandboxId) {
        return textError("Missing sandboxId", 400);
      }

      if (segments.length === 2 && request.method === "GET") {
        const sandbox = await sandboxControlStore.get(sandboxId);
        return sandbox ? json(sandbox) : textError("Sandbox not found", 404);
      }

      if (segments.length === 2 && request.method === "DELETE") {
        const result = await sandboxControlStore.delete(sandboxId);
        return result ? json(result) : textError("Sandbox not found", 404);
      }

      if (
        segments.length === 3 &&
        segments[2] === "extend-timeout" &&
        request.method === "POST"
      ) {
        const body = await parseJson<RemoteDockerExtendTimeoutRequest>(request);
        if (body instanceof Response) {
          return body;
        }

        const result = await sandboxControlStore.extendTimeout(
          sandboxId,
          body.additionalMs,
        );
        return result ? json(result) : textError("Sandbox not found", 404);
      }

      if (
        segments.length === 4 &&
        segments[2] === "ports" &&
        request.method === "GET"
      ) {
        const port = Number(segments[3]);
        if (!Number.isFinite(port)) {
          return textError("Invalid port", 400);
        }

        const result = await sandboxControlStore.getPort(sandboxId, port);
        return result ? json(result) : textError("Port not found", 404);
      }

      if (
        segments.length === 3 &&
        segments[2] === "exec" &&
        request.method === "POST"
      ) {
        const body = await parseJson<RemoteDockerExecRequest>(request);
        if (body instanceof Response) {
          return body;
        }

        const result = await sandboxControlStore.exec(sandboxId, body);
        return result ? json(result) : textError("Sandbox not found", 404);
      }

      if (
        segments.length === 3 &&
        segments[2] === "exec-detached" &&
        request.method === "POST"
      ) {
        const body = await parseJson<RemoteDockerExecDetachedRequest>(request);
        if (body instanceof Response) {
          return body;
        }

        const result = await sandboxControlStore.execDetached(sandboxId, body);
        return result ? json(result) : textError("Sandbox not found", 404);
      }

      if (segments.length === 3 && segments[2] === "file") {
        if (request.method === "GET") {
          const filePath = requirePath(url);
          if (filePath instanceof Response) {
            return filePath;
          }

          const result = await sandboxControlStore.readFile(
            sandboxId,
            filePath,
          );
          return result ? json(result) : textError("Sandbox not found", 404);
        }

        if (request.method === "PUT") {
          const body = await parseJson<RemoteDockerWriteFileRequest>(request);
          if (body instanceof Response) {
            return body;
          }

          const ok = await sandboxControlStore.writeFile(sandboxId, body);
          return ok
            ? new Response(null, { status: 204 })
            : textError("Sandbox not found", 404);
        }
      }

      if (
        segments.length === 3 &&
        segments[2] === "stat" &&
        request.method === "GET"
      ) {
        const filePath = requirePath(url);
        if (filePath instanceof Response) {
          return filePath;
        }

        const result = await sandboxControlStore.stat(sandboxId, filePath);
        return result ? json(result) : textError("Sandbox not found", 404);
      }

      if (
        segments.length === 3 &&
        segments[2] === "mkdir" &&
        request.method === "POST"
      ) {
        const body = await parseJson<RemoteDockerMkdirRequest>(request);
        if (body instanceof Response) {
          return body;
        }

        const ok = await sandboxControlStore.mkdir(sandboxId, body);
        return ok
          ? new Response(null, { status: 204 })
          : textError("Sandbox not found", 404);
      }

      if (
        segments.length === 3 &&
        segments[2] === "readdir" &&
        request.method === "GET"
      ) {
        const dirPath = requirePath(url);
        if (dirPath instanceof Response) {
          return dirPath;
        }

        const result = await sandboxControlStore.readdir(sandboxId, dirPath);
        return result ? json(result) : textError("Sandbox not found", 404);
      }
    }

    return textError("Not found", 404);
  } catch (error) {
    console.error("[sandbox-control] request failed:", error);
    return textError(getErrorMessage(error), getStatusForError(error));
  }
}
