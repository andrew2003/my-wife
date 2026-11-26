import { gatewayRewrites } from "./lib/gateway-url.mjs";

/**
 * Browser calls go to the web origin; `/api/*` is proxied to the gateway
 * (the session cookie travels with the request). The target comes from
 * `GATEWAY_URL` and defaults to http://localhost:4000.
 * @type {import('next').NextConfig}
 */
export default {
  output: "standalone",
  transpilePackages: ["@my-wife/contracts"],
  async rewrites() {
    return gatewayRewrites(process.env);
  },
};
