Summary: Replace the current host-shell local sandbox with a Docker-backed internal sandbox service while keeping the existing web app, chat flow, and `@open-harness/sandbox` abstraction intact. Deploy the web app on AWS with PostgreSQL, and run per-session Docker sandboxes on dedicated internal hosts that expose preview URLs through an internal reverse proxy.

Context:
- `apps/web/app/api/chat/route.ts` already has a local-only execution path that runs the agent inline when `isLocalModeEnabled()` is true. That means AWS phase 1 does not need a workflow replacement.
- `apps/web/app/api/sandbox/route.ts` provisions sandboxes through `connectSandbox(...)` and persists returned state back to the session record. This is the main server entrypoint for sandbox lifecycle.
- `packages/sandbox/factory.ts` is the correct backend seam. It already dispatches by `SandboxState.type`, and can absorb a new Docker backend without disturbing the web app API.
- `packages/sandbox/interface.ts` defines the exact contract the agent and API layer need: file ops, shell exec, detached commands, `domain(port)`, stop, and state persistence.
- `packages/sandbox/local/sandbox.ts` is a host-shell implementation that clones repos, runs bash, and uses the host filesystem. It is the right behavioral reference, but not the right deployment model for multiple internal users on AWS.
- The current app still assumes PostgreSQL (`README.md`, `apps/web/package.json`). SQLite is not a good fit for multi-user AWS deployment.
- The current preview model is compatible with a Docker design because sandboxes already expose `domain(port)` and the UI already expects preview URLs from sandbox/dev-server flows.

System Impact:
- Source of truth for sandbox lifecycle remains the `sessions.sandboxState` record in Postgres. The change is the backend represented by that state, not the owner of the state.
- The web app remains the control plane for auth, chat, sessions, and sandbox lifecycle. Sandboxes move from "host filesystem + host shell" to "Docker container + dedicated workspace + proxy-routed preview."
- New invariants:
  - each active session maps to one sandbox container
  - each sandbox container has one workspace root
  - preview URLs are internal-only and derived from container/session routing metadata
  - sandbox hosts are never shared through the Docker socket with user containers
- Dependent flows:
  - sandbox create/resume/stop
  - repo clone + branch creation
  - dev server start and preview routing
  - chat tool exec/file ops
  - optional auto-commit/PR flows
- Adjacent simplifications:
  - phase 1 can keep inline local chat execution
  - AWS migration does not need a workflow migration first
  - Vercel sandbox runtime can be deleted later without blocking Docker sandbox work

Approach:
- Recommended implementation: add a new Docker-backed sandbox backend and make it the default production/internal backend, while keeping the current local backend for laptop development.
- Do not run sandboxes inside the web app container.
- Do not start with ECS/Fargate-per-sandbox orchestration. It adds scheduling, routing, and persistence complexity too early.
- Start with:
  - web app on ECS or EC2 container
  - PostgreSQL on RDS
  - one or more dedicated internal EC2 sandbox hosts running Docker + reverse proxy
  - internal wildcard DNS for preview URLs
- The smallest coherent solution is:
  - preserve `connectSandbox` and session state ownership
  - add a `docker` sandbox type
  - route preview URLs through a sandbox-host proxy
  - keep chat inline for now

Changes:
- `packages/sandbox/factory.ts` - add a third backend discriminator (`docker`) and dispatch to a Docker sandbox implementation.
- `packages/sandbox/index.ts` - export the Docker backend types and implementation.
- `packages/sandbox/interface.ts` - keep the interface stable if possible; only widen it if Docker needs explicit metadata that cannot stay inside backend-specific state.
- `packages/sandbox/docker/state.ts` - define persisted Docker sandbox state: container id, host id/address, workspace path/volume, preview routing metadata, current branch, expiry.
- `packages/sandbox/docker/sandbox.ts` - implement the sandbox contract using Docker CLI or Docker Engine API. This should mirror `packages/sandbox/local/sandbox.ts` behavior for clone/init, file ops, exec, detached processes, `domain(port)`, and stop.
- `packages/sandbox/docker/preview.ts` - encapsulate preview URL derivation and any proxy label/routing conventions.
- `apps/web/app/api/sandbox/route.ts` - choose Docker sandbox mode for internal AWS/runtime environments instead of host-local mode, while preserving the current request/response shape.
- `apps/web/lib/runtime-mode.ts` - separate "inline chat execution" from "sandbox backend selection" so AWS can stay inline-chat but use Docker sandboxes.
- `apps/web/lib/sandbox/config.ts` - add Docker-specific defaults: image name, default exposed ports, host selection inputs, preview base domain.
- `apps/web/lib/sandbox/utils.ts` - update lifecycle helpers if they assume only `local` or `vercel` states.
- `apps/web/lib/db/schema.ts` - only if needed; prefer storing Docker metadata inside `sandboxState` JSON rather than adding new top-level DB columns.
- `apps/web/app/api/chat/route.ts` - keep the current inline local path, but rename/refactor the mode checks so "internal deployment" does not imply "host filesystem sandbox."
- `apps/web/app/sessions/[sessionId]/chats/[chatId]/session-chat-content.tsx` and dev-server related client hooks - ensure preview links come from sandbox/domain data and remain internal-only.
- `apps/web/.env.example` and `README.md` - add the AWS/internal env model:
  - `POSTGRES_URL`
  - `JWE_SECRET`
  - `ENCRYPTION_KEY`
  - `OPEN_HARNESS_SANDBOX_BACKEND=docker`
  - `OPEN_HARNESS_SANDBOX_IMAGE=...`
  - `OPEN_HARNESS_PREVIEW_BASE_DOMAIN=preview.company.internal`
  - `OPEN_HARNESS_SANDBOX_HOSTS=...` or equivalent host-selection config
- `infra/` or deployment docs (new) - document:
  - web app container build/deploy
  - sandbox host bootstrap
  - reverse proxy + wildcard DNS
  - RDS wiring
  - secret management

Verification:
- Unit tests:
  - Docker sandbox state serialization/deserialization
  - clone/init behavior
  - file read/write/exec behavior
  - detached dev-server process tracking
  - preview URL generation
- Integration tests:
  - create session from repo -> sandbox starts in Docker -> file edit works
  - start `bun run dev` in the sandbox -> preview URL resolves through internal proxy
  - stop sandbox -> container is removed and preview route stops responding
  - reconnect to an existing session -> Docker sandbox state resumes correctly
- Commands:
  - `bun run ci`
  - targeted tests for new sandbox package files
- Manual end-to-end checks:
  - monorepo Next.js app boots inside a sandbox container
  - non-technical user can create a session and open a preview URL without local tooling
  - concurrent sessions do not share workspace state
  - killing the web app process does not corrupt an active sandbox

Phased rollout:
- Phase 1: AWS web app + RDS + keep current local backend for development only.
- Phase 2: Add Docker sandbox backend and internal preview proxy on sandbox hosts.
- Phase 3: Make Docker the default internal deployment backend.
- Phase 4: Delete remaining Vercel sandbox/runtime codepaths after Docker is proven.
