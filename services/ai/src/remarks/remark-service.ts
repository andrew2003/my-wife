import { SETTINGS, type Locale } from "@my-wife/contracts";
import { renderMessage } from "../i18n";
import type { LlmProvider } from "../llm";
import { buildSystemPrompt } from "../chat/persona";
import { checkNumbers, type RemarkFacts } from "./number-check";

/** The registry has no key for the cache window yet; it is read from settings when present. */
export const REMARK_CACHE_HOURS_KEY = "ai.companion_remark_cache_hours";
export const DEFAULT_REMARK_CACHE_HOURS = 24;

export interface RemarkResult {
  text: string;
  /** `model` when the generated text passed the number check, else the fixed sentence. */
  source: "model" | "fallback";
}

export interface RemarkRequest {
  userId: string;
  screen: string;
  facts: RemarkFacts;
  locale: Locale;
}

export interface RemarkServiceDeps {
  provider: LlmProvider;
  readSettings: (userId: string) => Promise<Record<string, unknown>>;
  now: () => Date;
  /** True while the user's models are all failing; no call is made then. */
  isDegraded?: (userId: string) => boolean;
  /** Overrides `ai.request_timeout_seconds`, mainly for tests. */
  timeoutMs?: number;
  warn?: (fields: Record<string, unknown>, message: string) => void;
}

interface Entry {
  result: RemarkResult;
  expiresAt: number;
}

/**
 * Writes the short remark shown beside each screen. The model only phrases; code supplies the
 * facts and rejects any text whose numbers are not among them. One generation per user, screen
 * and day is cached; a failure, a timeout or a failed check caches the fixed fallback sentence.
 */
export class RemarkService {
  private readonly cache = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<RemarkResult>>();

  constructor(private readonly deps: RemarkServiceDeps) {}

  async remark(request: RemarkRequest): Promise<RemarkResult> {
    const { userId, screen, locale } = request;
    // Degraded mode: nothing was tried, so nothing is cached and the next request may recover.
    if (this.deps.isDegraded?.(userId)) return this.fallback(locale);
    const at = this.deps.now();
    const key = `${userId}|${screen}|${locale}|${at.toISOString().slice(0, 10)}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > at.getTime()) return hit.result;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const run = this.generate(request)
      .then(async (result) => {
        const hours = await this.cacheHours(userId);
        this.cache.set(key, { result, expiresAt: at.getTime() + hours * 3_600_000 });
        return result;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  private fallback(locale: Locale): RemarkResult {
    const text = renderMessage({ key: "ai.remark.fallback", params: {} }, locale);
    return { text, source: "fallback" };
  }

  private async settings(userId: string): Promise<Record<string, unknown>> {
    try {
      return await this.deps.readSettings(userId);
    } catch {
      return {};
    }
  }

  private async cacheHours(userId: string): Promise<number> {
    const values = await this.settings(userId);
    const value = values[REMARK_CACHE_HOURS_KEY];
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_REMARK_CACHE_HOURS;
  }

  private async timeoutMs(userId: string): Promise<number> {
    if (this.deps.timeoutMs !== undefined) return this.deps.timeoutMs;
    const values = await this.settings(userId);
    const def = SETTINGS["ai.request_timeout_seconds"];
    const parsed = def.schema.safeParse(values["ai.request_timeout_seconds"]);
    return (parsed.success ? parsed.data : def.default) * 1000;
  }

  private async generate({ userId, screen, facts, locale }: RemarkRequest): Promise<RemarkResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const limit = await this.timeoutMs(userId);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("remark timeout")), limit);
      });
      const system = [
        buildSystemPrompt(locale),
        renderMessage({ key: "ai.remark.instruction", params: {} }, locale),
      ].join("\n");
      // Facts are code-computed data; the screen name only picks the topic.
      const userText = JSON.stringify({ screen, facts });
      const response = await Promise.race([
        this.deps.provider.complete({ system, userText, locale }),
        timeout,
      ]);
      const text = response.text.trim();
      if (text === "" || !checkNumbers(text, facts)) {
        this.deps.warn?.({ screen }, "remark rejected by the number check");
        return this.fallback(locale);
      }
      return { text, source: "model" };
    } catch (error) {
      this.deps.warn?.({ screen, error: (error as Error).message }, "remark generation failed");
      return this.fallback(locale);
    } finally {
      clearTimeout(timer);
    }
  }
}
