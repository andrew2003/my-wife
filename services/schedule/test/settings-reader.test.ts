import { describe, expect, it } from "vitest";
import { createSettingsReader } from "../src/settings";

describe("createSettingsReader", () => {
  it("reads the user's settings from identity with the x-user-id header", async () => {
    const calls: unknown[] = [];
    const fetchFn = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push([url, init.headers["x-user-id"]]);
      const values = { "routine.wake.time": "06:30" };
      return new Response(JSON.stringify({ ok: true, data: { values } }));
    }) as unknown as typeof fetch;
    const read = createSettingsReader(() => "http://identity", fetchFn);
    expect(await read("u1")).toEqual({ "routine.wake.time": "06:30" });
    expect(calls).toEqual([["http://identity/settings", "u1"]]);
  });

  it("falls back to an empty object when identity fails", async () => {
    const fetchFn = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await createSettingsReader("http://identity", fetchFn)("u1")).toEqual({});
  });
});
