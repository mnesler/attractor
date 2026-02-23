// Types
export * from './types/index.js'

// Session
export { Session, SessionState } from './session.js'
export type { SessionOptions } from './session.js'

// Profiles
export type { ProviderProfile } from './profiles/base.js'
export { buildEnvironmentBlock, discoverProjectDocs } from './profiles/base.js'
export { OpenRouterProfile, createOpenRouterProfile } from './profiles/openrouter.js'
export type { OpenRouterProfileOptions } from './profiles/openrouter.js'

// Execution environments
export type { ExecutionEnvironment, ExecResult, DirEntry, GrepOptions } from './environment/interface.js'
export { LocalExecutionEnvironment } from './environment/local.js'

// Tools
export { ToolRegistry } from './tools/registry.js'
export type { ToolDefinition, RegisteredTool } from './tools/registry.js'
export { CORE_TOOLS, readFileTool, writeFileTool, editFileTool, shellTool, grepTool, globTool } from './tools/core.js'
export { truncateToolOutput, truncateOutput, truncateLines } from './tools/truncate.js'
