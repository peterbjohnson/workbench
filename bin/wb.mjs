#!/usr/bin/env node
/**
 * What `wb` runs.
 *
 * Two lines and a shebang, so the command's entry point is a plain `.mjs` that any
 * npm can link, and the compiled CLI it points at is built by `prepare`. Node refuses to strip
 * types under `node_modules`, so an installed workbench runs JavaScript; working in
 * this repository runs the TypeScript directly, through `yarn wb`.
 *
 * The import has the side effect: `src/cli/index.ts` runs its own `main` and sets
 * `process.exitCode`. There is nothing here to call.
 */
import '../dist/cli/index.js';
