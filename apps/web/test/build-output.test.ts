import { describe, expect, it } from "vitest";
import { resolveBuildOutput } from "../lib/build-output.mjs";

describe("resolveBuildOutput", () => {
  it("leaves the output unset so `next start` logs no standalone warning", () => {
    expect(resolveBuildOutput({})).toBeUndefined();
    expect(resolveBuildOutput({ NEXT_OUTPUT: "" })).toBeUndefined();
  });

  it("builds the standalone bundle for the container image", () => {
    expect(resolveBuildOutput({ NEXT_OUTPUT: "standalone" })).toBe("standalone");
  });
});
