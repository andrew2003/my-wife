import type { PhotoGrade } from "@my-wife/contracts";

export interface VisionInput {
  /** Raw image bytes. The caller wipes them right after grading; never copy or keep them. */
  image: Buffer;
  /** Locale key of the challenge the photo must show (the model proposes a grade only). */
  challengeKey: string;
}

/** Port for the vision-capable model; only the fake exists before M4 (no key storage). */
export interface VisionModel {
  grade(input: VisionInput): Promise<PhotoGrade>;
}

/**
 * Deterministic fake: the image text decides. A body starting with `fail` grades `fail`, one
 * starting with `unclear` grades `unclear`, anything else `pass`.
 */
export class FakeVisionModel implements VisionModel {
  async grade(input: VisionInput): Promise<PhotoGrade> {
    const head = input.image.subarray(0, 16).toString("utf8").toLowerCase();
    if (head.startsWith("fail")) return "fail";
    if (head.startsWith("unclear")) return "unclear";
    return "pass";
  }
}

/** Until M4 only the fake model exists; no real vision call and no key storage. */
export function createVisionModel(id: string = "fake"): VisionModel {
  if (id !== "fake") throw new Error(`vision model not available before M4: ${id}`);
  return new FakeVisionModel();
}
