import { handleSandboxControlRequest } from "./router";

const port = Number(process.env.PORT ?? "3020");

export const sandboxControlServer = Bun.serve({
  port,
  fetch(request) {
    return handleSandboxControlRequest(request);
  },
});

if (import.meta.main) {
  console.log(
    `[sandbox-control] listening on http://127.0.0.1:${sandboxControlServer.port}`,
  );
}
