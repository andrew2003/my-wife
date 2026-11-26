import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY_URL, gatewayRewrites, resolveGatewayUrl } from "../lib/gateway-url.mjs";

describe("gateway url", () => {
  it("defaults to the gateway port 4000", () => {
    expect(DEFAULT_GATEWAY_URL).toBe("http://localhost:4000");
    expect(resolveGatewayUrl({})).toBe("http://localhost:4000");
  });
  it("uses GATEWAY_URL and trims trailing slashes", () => {
    expect(resolveGatewayUrl({ GATEWAY_URL: "http://gateway:4000/" })).toBe("http://gateway:4000");
  });
  it("ignores an empty GATEWAY_URL", () => {
    expect(resolveGatewayUrl({ GATEWAY_URL: "  " })).toBe("http://localhost:4000");
  });
  it("proxies /api/* to the gateway", () => {
    expect(gatewayRewrites({})).toEqual([
      { source: "/api/:path*", destination: "http://localhost:4000/api/:path*" },
    ]);
  });
});
