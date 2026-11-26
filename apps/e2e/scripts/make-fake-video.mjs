// Generates a tiny y4m clip for Chromium's fake camera (no binary in git).
// Usage: node scripts/make-fake-video.mjs <output.y4m>
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const out = process.argv[2];
if (!out) throw new Error("output path required");
const W = 160, H = 120, FPS = 10, FRAMES = 20;
const chunks = [Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`)];
for (let i = 0; i < FRAMES; i++) {
  const y = Buffer.alloc(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) y[r * W + c] = (c * 2 + i * 8 + r) & 255;
  chunks.push(Buffer.from("FRAME\n"), y, Buffer.alloc((W * H) / 4, 128), Buffer.alloc((W * H) / 4, 128));
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat(chunks));
