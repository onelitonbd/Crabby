// @crabby/extensions — EXTENSIONS.md's content-only path (D-035): the native manifest (§4.2), the SKILL.md contract
// (§4.3 / D-071), the workspace (§4.1), the deterministic checker (§6), the static safety scan, the C-1 import and its
// conversion report (§11 / D-039), the file-backed repo behind §12's verbs, and the §10 MCP client with its C-2
// import (D-040 / D-137).

export type { CheckInput, CheckLine, CheckResult, ExtensionVerdict, HostFacts } from "./check.ts";
export { check, hasErrors } from "./check.ts";
export type { ConversionReport, ImportResult } from "./convert.ts";
export { importSkillPack } from "./convert.ts";
export type {
  ExtensionKind,
  ExtensionManifest,
  ManifestParseResult,
  ParseProblem,
} from "./manifest.ts";
export {
  CONTENT_KINDS,
  EXECUTABLE_KINDS,
  EXTENSION_KINDS,
  HOST_API,
  MANIFEST_FILE,
  parseManifest,
  readManifest,
} from "./manifest.ts";
export type {
  DiscoveryReport,
  McpCallResult,
  McpToolDeclaration,
  McpTransportClient,
} from "./mcp.ts";
export {
  discoverTools,
  HttpTransport,
  McpServerError,
  mapMcpToolToCapability,
  mcpCallTimeoutMs,
  StdioTransport,
} from "./mcp.ts";
export type {
  EntriesParseResult,
  HttpServerEntry,
  McpTransport,
  ServerEntries,
  ServerEntry,
  StdioServerEntry,
} from "./mcp-config.ts";
export {
  loadServerEntries,
  MCP_DIR_NAME,
  mcpDir,
  parseServerEntries,
  REPORTS_DIR_NAME,
  SERVERS_FILE,
  serversFilePath,
} from "./mcp-config.ts";
export type { McpConversionReport, McpImportResult } from "./mcp-import.ts";
export { importMcpServers } from "./mcp-import.ts";
export type { ExtRepoState, InstalledExtension } from "./repo.ts";
export { extCheckCompat, extInit, extInstall, extList, extUninstall, extValidate } from "./repo.ts";
export type { ScanLine, ScanResult } from "./scan.ts";
export { scanContent } from "./scan.ts";
export type { SkillFrontmatter, SkillParseResult } from "./skill.ts";
export { BODY_MAX_BYTES, BODY_SOFT_LINE_LIMIT, parseSkill, SKILL_FILE } from "./skill.ts";
export type { WorkspaceScan } from "./workspace.ts";
export { scanWorkspace, workspaceSkillsDir } from "./workspace.ts";
