import type { NextRequest } from "next/server";
import { artDirectory } from "../../../lib/art";
import { serveArt } from "../../../lib/art-serve";
import { resolveGatewayUrl } from "../../../lib/gateway-url.mjs";
import { fetchCurrentUser } from "../../../lib/session";

export const dynamic = "force-dynamic";

/** Private art for signed-in users only; never a public static path. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return serveArt(request, key, request.nextUrl.searchParams, {
    dir: artDirectory(process.env),
    fetchUser: (token) => fetchCurrentUser(token, resolveGatewayUrl(process.env)),
  });
}
