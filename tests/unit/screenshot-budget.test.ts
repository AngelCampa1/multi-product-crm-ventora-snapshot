import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SCREENSHOTS_DIR = join(process.cwd(), "docs", "screenshots");
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 600 * 1024;

describe("docs/screenshots size budget", () => {
  it("stays within the total and per-file size budget", () => {
    if (!existsSync(SCREENSHOTS_DIR)) {
      // Nothing captured yet (e.g. `npm run shots` hasn't run in this environment) —
      // there's no budget to violate, so this is a pass rather than a failure.
      return;
    }

    const files = readdirSync(SCREENSHOTS_DIR).filter((f) => f.endsWith(".png") || f.endsWith(".jpg"));
    let total = 0;
    const oversized: string[] = [];

    for (const file of files) {
      const size = statSync(join(SCREENSHOTS_DIR, file)).size;
      total += size;
      if (size > MAX_FILE_BYTES) oversized.push(`${file} (${size} bytes)`);
    }

    expect(oversized, `file(s) exceed the ${MAX_FILE_BYTES}-byte per-file budget: ${oversized.join(", ")}`).toHaveLength(0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });
});
