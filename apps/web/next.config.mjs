/**
 * Browser calls go to the web origin; `/api/*` is proxied to the gateway
 * (the session cookie travels with the request).
 * @type {import('next').NextConfig}
 */
export default {
  output: "standalone",
  transpilePackages: ["@my-wife/contracts"],
  async rewrites() {
    const gateway = process.env.GATEWAY_URL ?? "http://localhost:3000";
    return [{ source: "/api/:path*", destination: `${gateway}/api/:path*` }];
  },
};
