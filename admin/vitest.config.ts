import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Separate jsdom config for admin React component tests. Kept distinct from the
// root node-environment config (which gates backend coverage) so the two suites
// never bleed into each other.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@admin": path.resolve(__dirname, "src"),
      "@": path.resolve(__dirname, "../src"),
    },
  },
  test: {
    root: __dirname,
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
