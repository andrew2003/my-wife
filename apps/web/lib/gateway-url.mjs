/** Gateway port in the dev-runner, e2e and compose setups. */
export const DEFAULT_GATEWAY_URL = "http://localhost:4000";

/**
 * Resolves where `/api/*` is proxied. Set `GATEWAY_URL` to override.
 * @param {Record<string, string | undefined>} env
 */
export function resolveGatewayUrl(env) {
  const value = env.GATEWAY_URL?.trim();
  return (value ? value : DEFAULT_GATEWAY_URL).replace(/\/+$/, "");
}

/** @param {Record<string, string | undefined>} env */
export function gatewayRewrites(env) {
  return [{ source: "/api/:path*", destination: `${resolveGatewayUrl(env)}/api/:path*` }];
}
