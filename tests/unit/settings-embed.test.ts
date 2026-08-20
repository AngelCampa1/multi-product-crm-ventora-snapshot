import { describe, expect, it } from "vitest";
import { buildEmbedSnippet } from "../../admin/src/pages/settings-embed";

describe("settings embed snippet", () => {
  it("uses the public widgets host for copyable embed code", () => {
    expect(buildEmbedSnippet("wk_test_grantpipe", "wall-grid")).toBe(
      '<script src="https://widgets.ventoralabs.com/w/v1.js" data-product="wk_test_grantpipe" data-widget="wall-grid"></script>',
    );
  });

  it("escapes product and widget attributes", () => {
    expect(buildEmbedSnippet('bad"key', "wall-grid<script>")).toContain(
      'data-product="bad&quot;key" data-widget="wall-grid&lt;script&gt;"',
    );
  });

  it("builds feedback-button embed snippets", () => {
    expect(buildEmbedSnippet("wk_test_grantpipe", "feedback-button")).toBe(
      '<script src="https://widgets.ventoralabs.com/w/v1.js" data-product="wk_test_grantpipe" data-widget="feedback-button"></script>',
    );
  });
});
