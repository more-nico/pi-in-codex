export interface BuildInfo { version: string; buildId: string; builtAt: number; protocolVersion: number }
declare const __PI_IN_CODEX_BUILD__: BuildInfo;
// esbuild supplies the same identity to the daemon, MCP server and panel.
export const BUILD: BuildInfo = typeof __PI_IN_CODEX_BUILD__ === 'undefined'
  ? { version: 'development', buildId: 'development', builtAt: 0, protocolVersion: 1 }
  : __PI_IN_CODEX_BUILD__;
