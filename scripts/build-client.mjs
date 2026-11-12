/**
 * Build the client face as a CJS bundle with react external; xterm, the fit
 * addon and zod are inlined so the browser module table needs no extra row.
 * Then wrap the output into the window.__ModuleLoader__.load({ id, factory })
 * contract.
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cjsOut = resolve(rootDir, "lib/client.cjs");
const clientOut = resolve(rootDir, "lib/client.js");

// The settings page shows the package version; inject it as a constant so
// the bundle never carries the whole manifest.
const manifest = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));

/**
 * Drop zod's locale catalogue from the client bundle.
 *
 * `zod` reaches the browser through client → remote.js → descriptors.js →
 * schemas.js, and it was 444KB of the 1179KB bundle (37.7%) — of which 255KB
 * was `v4/locales/` (64 language packs: he, ru, be, hy, ta, …). The client
 * never validates anything: it hands the descriptor objects to `$mount()` and
 * the host does the parsing, so none of that catalogue can ever be reached.
 *
 * Only the aggregate `locales/index.js` is emptied. `v4/classic/schemas.js`
 * imports `locales/en.js` directly to register the default English locale, so
 * replacing the whole directory would break zod's own error messages.
 */
const dropZodLocaleCatalogue = {
  name: "drop-zod-locale-catalogue",
  setup(build) {
    build.onLoad({ filter: /node_modules[\\/]zod[\\/]v4[\\/]locales[\\/]index\.js$/ }, () => ({
      contents: "export {};",
      loader: "js"
    }));
  }
};

const worker = await build({
  entryPoints: [resolve(rootDir, "src/client/terminal-display/highlight-worker.js")],
  bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", minify: true
});

await build({
  entryPoints: [resolve(rootDir, "src/client/index.jsx")],
  outfile: cjsOut,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  bundle: true,
  sourcemap: false,
  define: { __DSH_SSH_OPS_VERSION__: JSON.stringify(manifest.version), __DSH_HIGHLIGHT_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text) },
  // xterm/zod are inlined; react stays external (resolved by the host page
  // through the ModuleLoader seed table).
  external: ["react", "react/*", "@deepseek-ai/*"],
  plugins: [dropZodLocaleCatalogue],
  logLevel: "info"
});

const raw = readFileSync(cjsOut, "utf8");
const indented = raw.split("\n").map((line) => {
  const normalized = line.trimEnd();
  return normalized ? "\t\t" + normalized : "";
}).join("\n");
const wrapped =
  "window.__ModuleLoader__.load({\n\tid: \"dsh-ssh-ops\",\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n" +
  indented +
  "\n\t\treturn module.exports;\n\t}\n});\n";
writeFileSync(clientOut, wrapped, "utf8");
rmSync(cjsOut, { force: true });
console.log("build-client: wrote " + clientOut + " (" + wrapped.length + " bytes)");
