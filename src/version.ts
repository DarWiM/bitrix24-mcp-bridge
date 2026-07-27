// Single source for "which version of this package is running".
//
// Injected by build:dist (esbuild define) from package.json. A non-bundled run (bun run
// src/index.ts, tests) has no define and reports the dev sentinel — code that would touch a
// user's installation must treat that as "version unknown" and keep its hands off.
declare const __EXT_VERSION__: string | undefined;

export const DEV_VERSION = "0.0.0-dev";
export const PACKAGE_VERSION = typeof __EXT_VERSION__ === "string" ? __EXT_VERSION__ : DEV_VERSION;
export const isReleaseBuild = PACKAGE_VERSION !== DEV_VERSION;
