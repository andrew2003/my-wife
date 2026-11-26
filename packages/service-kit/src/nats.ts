import { connect, type NatsConnection } from "nats";

/** Connects to NATS; `prefix` isolates worktrees inside the shared stack. */
export async function connectNats(url: string, name: string): Promise<NatsConnection> {
  return connect({ servers: url, name, maxReconnectAttempts: -1 });
}

export function subject(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name;
}
