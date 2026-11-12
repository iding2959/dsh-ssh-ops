// Client-bundle budget guard.
//
// The browser bundle is rebuilt by `npm run build`; this test re-runs the same
// esbuild configuration and asserts what is *in* it, so a dependency can never
// silently drag its whole catalogue into every page load again.
//
// Background: `zod` used to be 444KB of a 1179KB bundle (37.7%) while the
// client never parsed anything — it only hands descriptors to `$mount()`. 255KB
// of that was zod's 64-language locale catalogue. `scripts/build-client.mjs`
// now empties `zod/v4/locales/index.js`; this test fails if that stops working.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));

// Keep this in sync with scripts/build-client.mjs (same plugin, same externals).
const dropZodLocaleCatalogue = {
  name: "drop-zod-locale-catalogue",
  setup(buildContext) {
    buildContext.onLoad({ filter: /node_modules[\\/]zod[\\/]v4[\\/]locales[\\/]index\.js$/ }, () => ({
      contents: "export {};",
      loader: "js"
    }));
  }
};

const result = await build({
  entryPoints: [resolve(rootDir, "src/client/index.jsx")],
  format: "cjs",
  platform: "browser",
  target: "es2022",
  bundle: true,
  write: false,
  minify: true,
  metafile: true,
  plugins: [dropZodLocaleCatalogue],
  define: { __DSH_SSH_OPS_VERSION__: JSON.stringify(manifest.version), __DSH_HIGHLIGHT_WORKER_SOURCE__: '""' },
  external: ["react", "react/*", "@deepseek-ai/*"],
  logLevel: "silent"
});

const inputs = Object.values(result.metafile.outputs)[0].inputs;
const bytesOf = (predicate) => Object.entries(inputs)
  .filter(([file]) => predicate(file))
  .reduce((sum, [, info]) => sum + info.bytesInOutput, 0);

const total = bytesOf(() => true);
const zodBytes = bytesOf((file) => file.includes("zod"));
// Every locale pack except English: `v4/classic/schemas.js` imports `en.js`
// directly to register zod's default messages, so that one must survive.
const droppedLocaleBytes = bytesOf((file) => /zod[\\/]v4[\\/]locales[\\/]/.test(file) && !file.endsWith("en.js") && !file.endsWith("locales/index.js"));

assert.ok(
  droppedLocaleBytes < 8 * 1024,
  `zod's locale catalogue must not reach the browser (found ${(droppedLocaleBytes / 1024).toFixed(0)}KB)`
);
assert.ok(
  bytesOf((file) => file.endsWith("zod/v4/locales/en.js")) > 0,
  "the English default locale must stay: zod registers it when a schema is constructed"
);
assert.ok(
  zodBytes < 260 * 1024,
  `zod in the client bundle grew to ${(zodBytes / 1024).toFixed(0)}KB; the client renders descriptors, it does not validate`
);
assert.ok(
  total < 1750 * 1024,
  `client bundle grew to ${(total / 1024).toFixed(0)}KB — investigate before raising this budget`
);

console.log(`client bundle budget: ${(total / 1024).toFixed(0)}KB total, zod ${(zodBytes / 1024).toFixed(0)}KB, locale catalogue dropped`);