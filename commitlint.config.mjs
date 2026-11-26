// Scopes: services and packages from CLAUDE.md, plus tooling scopes used by
// Dependabot (deps) and release-please (main). See docs/decisions.md.
export const SCOPES = [
  "gateway",
  "identity",
  "budget",
  "ingest",
  "schedule",
  "monitor",
  "rules",
  "ai",
  "notify",
  "sync",
  "web",
  "contracts",
  "infra",
  "e2e",
  "factory",
  "ci",
  "deps",
  "docs",
  "config",
  "dev-runner",
  "service-kit",
  "test-kit",
  "main",
];

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [2, "always", SCOPES],
    "subject-case": [2, "always", "lower-case"],
    "header-max-length": [2, "always", 72],
    "body-max-line-length": [1, "always", 100],
    "footer-max-line-length": [0],
  },
};
