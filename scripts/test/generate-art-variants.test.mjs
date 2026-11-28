import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WIDTHS,
  parseWidths,
  generateVariants,
  isInsideRepository,
} from "../generate-art-variants.mjs";

// Fake resizer: writes the width and the input length into the output.
const fakeResize = async (input, output, width) => {
  await writeFile(output, `w${width}:${(await readFile(input)).length}`);
};

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "art-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("each original image gets a variant per configured size", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "dress-full.png"), "aaaa");
    await writeFile(join(dir, "dress-full-dark.webp"), "bb");
    await writeFile(join(dir, "credits.txt"), "credits");
    const result = await generateVariants({ dir, widths: DEFAULT_WIDTHS, resize: fakeResize });
    const files = (await readdir(dir)).sort();
    for (const size of Object.keys(DEFAULT_WIDTHS)) {
      assert.ok(files.includes(`dress-full.${size}.png`), size);
      assert.ok(files.includes(`dress-full-dark.${size}.webp`), size);
    }
    assert.equal(result.created.length, 6);
    assert.ok(files.includes("credits.txt"));
  });
});

test("variants are not treated as originals on a second run", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "a.png"), "x");
    await generateVariants({ dir, widths: DEFAULT_WIDTHS, resize: fakeResize });
    const again = await generateVariants({ dir, widths: DEFAULT_WIDTHS, resize: fakeResize });
    assert.equal(again.created.length, 0);
    assert.equal((await readdir(dir)).length, 4);
  });
});

test("sizes come from configuration", () => {
  assert.deepEqual(parseWidths("tiny=64,huge=2000"), { tiny: 64, huge: 2000 });
  assert.deepEqual(parseWidths(undefined), DEFAULT_WIDTHS);
  assert.throws(() => parseWidths("small=abc"));
});

test("a directory inside the repository is refused and nothing is written", async () => {
  const repoDir = join(process.cwd(), "scripts", "test", "tmp-art-check");
  assert.equal(isInsideRepository(repoDir), true);
  await assert.rejects(
    generateVariants({ dir: repoDir, widths: DEFAULT_WIDTHS, resize: fakeResize }),
    /repository/i,
  );
  await withDir(async (dir) => assert.equal(isInsideRepository(dir), false));
});
