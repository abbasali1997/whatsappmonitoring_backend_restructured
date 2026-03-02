/**
 * Runtime path alias registration for the API.
 *
 * TypeScript's tsc (tsconfig.api.json) compiles with:
 *   rootDir: ./src   outDir: ./dist/api
 * so the compiled tree is dist/api/<module-path> (no "src/" prefix).
 *
 * The base tsconfig.json maps  @/* → src/*  which resolves correctly at
 * compile time but NOT at runtime because there is no src/ in the production
 * image.  We register the corrected mapping here so that Node's require()
 * can find every @/-prefixed import in the compiled JS.
 */
const tsConfigPaths = require("tsconfig-paths");
const path = require("path");

tsConfigPaths.register({
  baseUrl: path.join(__dirname, "..", "dist", "api"),
  paths: {
    "@/*": ["*"],
    "@/common/*": ["common/*"],
    "@/modules/*": ["modules/*"],
    "@/config/*": ["config/*"],
    "@/apps/*": ["apps/*"],
  },
});
