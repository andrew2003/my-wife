// Writes app/tokens.css from lib/theme.ts. Run: pnpm --filter @my-wife/web tokens
import { writeFileSync } from "node:fs";
import { generateTokensCss } from "../lib/theme.ts";

writeFileSync(new URL("../app/tokens.css", import.meta.url), generateTokensCss());
