import { readFile } from "node:fs/promises";
import { isArtKey, isArtSize, resolveArtFile, type ArtMode, type ArtSize } from "./art";
import { SESSION_COOKIE, type CurrentUser } from "./session";

export interface ServeDeps {
  dir: string | null;
  fetchUser: (token: string | undefined) => Promise<CurrentUser | null>;
}

function sessionToken(request: Request): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || undefined;
  }
  return undefined;
}

const plain = (status: number) => new Response(null, { status });

/**
 * Serves one private art file. Order: session (401), request shape (400),
 * directory and file (404). Files are private-cacheable, never public.
 */
export async function serveArt(
  request: Request,
  key: string,
  query: URLSearchParams,
  deps: ServeDeps,
): Promise<Response> {
  const user = await deps.fetchUser(sessionToken(request));
  if (!user) return plain(401);

  const sizeParam = query.get("size") ?? "large";
  const modeParam = query.get("mode") ?? "light";
  if (!isArtKey(key) || !isArtSize(sizeParam) || (modeParam !== "light" && modeParam !== "dark")) {
    return plain(400);
  }
  if (!deps.dir) return plain(404);

  const file = await resolveArtFile(deps.dir, key, sizeParam as ArtSize, modeParam as ArtMode);
  if (!file) return plain(404);
  let body: Buffer;
  try {
    body = await readFile(file.path);
  } catch {
    return plain(404);
  }
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "content-type": file.contentType,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}
