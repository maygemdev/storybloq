import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

const storybloqVersion = pkg.version;
const piCommand = process.env.STORYBLOQ_PI_COMMAND ?? "";

export default defineConfig({
  entry: {
    cli: "src/cli/index.ts",
    index: "src/index.ts",
    mcp: "src/mcp/index.ts",
    "pi-extension": "src/pi/extension.ts",
  },
  dts: true,
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  splitting: false,
  shims: true,
  external: ["@earendil-works/pi-coding-agent", "typebox"],
  define: {
    "process.env.STORYBLOQ_VERSION": JSON.stringify(storybloqVersion),
    "process.env.STORYBLOQ_PI_COMMAND": JSON.stringify(piCommand),
  },
});
