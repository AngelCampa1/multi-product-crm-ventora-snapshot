import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import tailwindConfig from "./tailwind.config";

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname),
  css: {
    postcss: {
      plugins: [tailwindcss(tailwindConfig as Parameters<typeof tailwindcss>[0]), autoprefixer()],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  base: "/",
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
  resolve: {
    alias: {
      "@admin": path.resolve(__dirname, "src"),
      "@": path.resolve(__dirname, "../src"),
    },
  },
});
