export const DEFAULT_GATEWAY_URL: string;
export function resolveGatewayUrl(env: Record<string, string | undefined>): string;
export function gatewayRewrites(env: Record<string, string | undefined>): { source: string; destination: string }[];
