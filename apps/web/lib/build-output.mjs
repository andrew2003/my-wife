/**
 * The standalone server bundle is only needed for the container image, which
 * runs `node server.js`. `next start` warns when it is combined with
 * `output: "standalone"`, so local, e2e and demo builds leave it off.
 * The Dockerfile sets `NEXT_OUTPUT=standalone`.
 * @param {Record<string, string | undefined>} env
 * @returns {"standalone" | undefined}
 */
export function resolveBuildOutput(env) {
  return env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined;
}
