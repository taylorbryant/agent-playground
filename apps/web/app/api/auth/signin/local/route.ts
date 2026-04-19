import { cookies } from "next/headers";
import { type NextRequest } from "next/server";
import { upsertUser } from "@/lib/db/users";
import { encryptJWE } from "@/lib/jwe/encrypt";
import { SESSION_COOKIE_NAME } from "@/lib/session/constants";

function resolveLocalProfile() {
  const email =
    process.env.OPEN_HARNESS_LOCAL_AUTH_EMAIL ?? "local@open-harness.dev";
  const username =
    process.env.OPEN_HARNESS_LOCAL_AUTH_USERNAME ??
    email.split("@")[0] ??
    "local";
  const name = process.env.OPEN_HARNESS_LOCAL_AUTH_NAME ?? "Local User";
  const avatar =
    process.env.OPEN_HARNESS_LOCAL_AUTH_AVATAR_URL ??
    "https://avatar.vercel.sh/local-user";

  return {
    externalId: process.env.OPEN_HARNESS_LOCAL_AUTH_ID ?? email,
    email,
    username,
    name,
    avatar,
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const redirectTo = req.nextUrl.searchParams.get("next") ?? "/";
  const safeRedirectTo =
    redirectTo.startsWith("/") && !redirectTo.startsWith("//")
      ? redirectTo
      : "/";

  const profile = resolveLocalProfile();

  const userId = await upsertUser({
    provider: "local",
    externalId: profile.externalId,
    accessToken: "local-auth",
    username: profile.username,
    email: profile.email,
    name: profile.name,
    avatarUrl: profile.avatar,
  });

  const session = {
    created: Date.now(),
    authProvider: "local" as const,
    user: {
      id: userId,
      username: profile.username,
      email: profile.email,
      name: profile.name,
      avatar: profile.avatar,
    },
  };

  const sessionToken = await encryptJWE(session, "1y");
  const expires = new Date(
    Date.now() + 365 * 24 * 60 * 60 * 1000,
  ).toUTCString();

  const response = new Response(null, {
    status: 302,
    headers: {
      Location: safeRedirectTo,
    },
  });

  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${sessionToken}; Path=/; Max-Age=${365 * 24 * 60 * 60}; Expires=${expires}; HttpOnly; ${process.env.NODE_ENV === "production" ? "Secure; " : ""}SameSite=Lax`,
  );

  const store = await cookies();
  store.delete("vercel_auth_state");
  store.delete("vercel_code_verifier");
  store.delete("vercel_auth_redirect_to");

  return response;
}
