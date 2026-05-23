import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  outDir: "dist",
  clean: true,
  bundle: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  format: ["esm"],
  platform: "node",
  target: "node22",
  external: ["ink", "react", "react-devtools-core", "smol-toml", "typescript", "zod"],
  noExternal: [/^@nexus\//]
});
