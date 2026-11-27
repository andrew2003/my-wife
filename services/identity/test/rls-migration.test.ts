import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Runs without PostgreSQL (CI has none), so the RLS migration is checked as text;
// rls.test.ts proves the behavior when DATABASE_URL points at the shared stack.
const sql = readFileSync(new URL("../drizzle/0003_secrets_and_rls.sql", import.meta.url), "utf8");

describe("migration 0003 row-level security", () => {
  for (const table of ["user_settings", "setting_audit", "onboarding_steps", "secrets"]) {
    it(`enables, forces and isolates ${table}`, () => {
      const t = `"identity"."${table}"`;
      expect(sql).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      const policy = sql.slice(sql.indexOf(`CREATE POLICY user_isolation ON ${t}`));
      expect(policy).toContain(`USING ("user_id" = current_setting('app.user_id', true))`);
      expect(policy).toContain("WITH CHECK");
    });
  }

  it("lets the connecting user switch to the app role", () => {
    expect(sql).toContain("GRANT identity_app TO CURRENT_USER");
  });
});
