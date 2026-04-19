import { type NextRequest } from "next/server";
import { getPrimarySignInPath } from "@/lib/auth/signin-path";

export async function GET(req: NextRequest): Promise<Response> {
  const next = req.nextUrl.searchParams.get("next") ?? "/";
  const params = new URLSearchParams({ next });
  return Response.redirect(
    new URL(`${getPrimarySignInPath()}?${params.toString()}`, req.url),
  );
}
