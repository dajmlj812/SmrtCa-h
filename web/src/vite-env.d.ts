/// <reference types="vite/client" />

// Injected by Vite via `define` (see web/vite.config.ts).
// Pulled from web/package.json at build time so the displayed
// version can't drift from the actual release.
declare const __APP_VERSION__: string;

declare module '*.md?raw' {
  const content: string;
  export default content;
}
