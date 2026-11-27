import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface PushRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** Minimal emulated browser push service. Paths in `gone` answer 410, in `failing` 503, others 201. */
export interface EmulatedPush {
  origin: string;
  received: PushRequest[];
  gone: Set<string>;
  failing: Set<string>;
  close(): Promise<void>;
}

export async function startEmulatedPush(): Promise<EmulatedPush> {
  const received: PushRequest[] = [];
  const gone = new Set<string>();
  const failing = new Set<string>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      received.push({ path, headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = gone.has(path) ? 410 : failing.has(path) ? 503 : 201;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    gone,
    failing,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
