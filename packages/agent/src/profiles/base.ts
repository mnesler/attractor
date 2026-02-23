import * as nodePath from 'node:path'
import type { ExecutionEnvironment } from '../environment/interface.js'
import type { ToolRegistry, ToolDefinition } from '../tools/registry.js'

export interface ProviderProfile {
  readonly id: string
  readonly model: string
  readonly tool_registry: ToolRegistry

  /** Files to discover and load as project docs (AGENTS.md is always included) */
  readonly project_doc_files: string[]

  /** Build the full system prompt for an LLM request */
  build_system_prompt(env: ExecutionEnvironment, projectDocs: string): Promise<string>

  /** Tool definitions to pass to the LLM */
  tools(): ToolDefinition[]

  /** Provider-specific options to pass through to the LLM SDK */
  provider_options(): Record<string, unknown>

  /** Create a copy with optional overrides (used by subagent spawning) */
  clone(overrides?: { model?: string }): ProviderProfile

  // Capability flags
  readonly supports_reasoning: boolean
  readonly supports_streaming: boolean
  readonly supports_parallel_tool_calls: boolean
  readonly context_window_size: number
}

// ---------------------------------------------------------------------------
// Shared helpers for building system prompt sections
// ---------------------------------------------------------------------------

export async function buildEnvironmentBlock(env: ExecutionEnvironment): Promise<string> {
  const wd = env.working_directory()

  const zeroExec = { exit_code: 1, stdout: '', stderr: '', timed_out: false, duration_ms: 0 }
  const gitCheck = await env.exec_command('git rev-parse --is-inside-work-tree', 5_000)
    .catch(() => zeroExec)
  const isGit = gitCheck.exit_code === 0

  let gitBranch = ''
  let recentCommits = ''
  if (isGit) {
    const [branchResult, logResult] = await Promise.all([
      env.exec_command('git rev-parse --abbrev-ref HEAD', 5_000).catch(() => zeroExec),
      env.exec_command('git log --oneline -5', 5_000).catch(() => zeroExec),
    ])
    gitBranch = branchResult.stdout.trim()
    recentCommits = logResult.stdout.trim()
  }

  const today = new Date().toISOString().split('T')[0]!

  const lines: string[] = [
    '<environment>',
    `Working directory: ${wd}`,
    `Is git repository: ${isGit}`,
  ]
  if (isGit && gitBranch) lines.push(`Git branch: ${gitBranch}`)
  if (isGit && recentCommits) lines.push(`Recent commits:\n${recentCommits}`)
  lines.push(
    `Platform: ${env.platform()}`,
    `OS version: ${env.os_version()}`,
    `Today's date: ${today}`,
    '</environment>',
  )
  return lines.join('\n')
}

export async function discoverProjectDocs(
  workingDir: string,
  env: ExecutionEnvironment,
  filesToLoad: string[],
): Promise<string> {
  const zeroExec = { exit_code: 1, stdout: workingDir, stderr: '', timed_out: false, duration_ms: 0 }
  const gitRootResult = await env.exec_command('git rev-parse --show-toplevel', 5_000)
    .catch(() => zeroExec)

  const gitRoot = gitRootResult.exit_code === 0
    ? gitRootResult.stdout.trim()
    : workingDir

  // Build directory list from git root to working dir
  const dirs: string[] = []
  let cur = gitRoot
  while (true) {
    dirs.push(cur)
    if (cur === workingDir) break
    const parent = nodePath.dirname(cur)
    if (parent === cur) break  // reached filesystem root
    cur = parent
  }
  if (!dirs.includes(workingDir)) dirs.push(workingDir)

  const sections: string[] = []
  let totalBytes = 0
  const MAX_BYTES = 32 * 1024

  outer: for (const d of dirs) {
    for (const filename of filesToLoad) {
      const filePath = nodePath.join(d, filename)
      const exists = await env.file_exists(filePath)
      if (!exists) continue

      const content = await env.read_file(filePath).catch(() => '')
      if (!content) continue

      const header = `\n# ${filename} (from ${d})\n\n`
      const section = header + content

      if (totalBytes + section.length > MAX_BYTES) {
        const remaining = MAX_BYTES - totalBytes
        if (remaining > 200) {
          sections.push(section.slice(0, remaining) + '\n[Project instructions truncated at 32KB]')
        }
        break outer
      }

      sections.push(section)
      totalBytes += section.length
    }
  }

  return sections.join('\n')
}
