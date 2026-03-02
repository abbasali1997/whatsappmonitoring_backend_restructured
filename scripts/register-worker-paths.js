/**
 * Runtime path alias registration for the Worker.
 *
 * TypeScript's tsc (tsconfig.worker.json) compiles with:
 *   rootDir: ./src   outDir: ./dist/worker
 * so the compiled tree is dist/worker/<module-path> (no "src/" prefix).
 */
const tsConfigPaths = require("tsconfig-paths");
const path = require("path");

tsConfigPaths.register({
  baseUrl: path.join(__dirname, "..", "dist", "worker"),
  paths: {
    "@/*": ["*"],
    "@/common/*": ["common/*"],
    "@/modules/*": ["modules/*"],
    "@/config/*": ["config/*"],
    "@/apps/*": ["apps/*"],
  },
});
