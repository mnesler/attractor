import type { ExecutionEnvironment } from '../environment/interface.js'
import { ToolRegistry } from '../tools/registry.js'
import { CORE_TOOLS } from '../tools/core.js'
import type { ToolDefinition } from '../tools/registry.js'
import { buildEnvironmentBlock, discoverProjectDocs, type ProviderProfile } from './base.js'

// ---------------------------------------------------------------------------
// OpenRouter provider-neutral base prompt
// ---------------------------------------------------------------------------

const OPENROUTER_BASE_PROMPT = `You are a skilled coding assistant with access to tools for reading and modifying files, running shell commands, and searching codebases. Your goal is to help users accomplish software development tasks accurately and efficiently.

## Guidelines

**File operations:**
- Read files before editing them to understand current content
- Prefer edit_file (targeted search-and-replace) over write_file (full rewrites) when making changes
- Use write_file when creating new files or when changes are extensive
- Verify your edits by reading the file after making changes

**Shell commands:**
- Use shell for build commands, tests, package management, and git operations
- Check exit codes — a non-zero exit means something went wrong
- Prefer specific targeted commands over broad ones

**Searching:**
- Use grep to find code patterns, function definitions, or usages
- Use glob to find files by name pattern
- Combine grep and glob to efficiently navigate large codebases

**Code quality:**
- Make minimal changes that accomplish the task
- Follow the existing code style and conventions in the project
- Do not add unnecessary comments, documentation, or refactoring unless asked

**Task completion:**
- When done, provide a brief summary of what was changed and why
- If you encounter an error you cannot resolve, explain what you tried and what failed`

// ---------------------------------------------------------------------------
// OpenRouterProfile
// ---------------------------------------------------------------------------

export interface OpenRouterProfileOptions {
  model: string
  /** HTTP-Referer header for OpenRouter attribution */
  http_referer?: string
  /** X-Title header for OpenRouter attribution */
  x_title?: string
}

export class OpenRouterProfile implements ProviderProfile {
  readonly id = 'openrouter'
  readonly model: string
  readonly tool_registry: ToolRegistry
  readonly project_doc_files: string[]

  readonly supports_reasoning = true
  readonly supports_streaming = true
  readonly supports_parallel_tool_calls = true
  readonly context_window_size = 200_000

  private readonly _http_referer: string
  private readonly _x_title: string

  constructor(options: OpenRouterProfileOptions) {
    this.model = options.model
    this._http_referer = options.http_referer ?? 'https://github.com/strongdm/attractor'
    this._x_title = options.x_title ?? 'Attractor Coding Agent'

    // Project docs: AGENTS.md always, no provider-specific files for OpenRouter
    this.project_doc_files = ['AGENTS.md']

    // Create registry with core tools
    this.tool_registry = new ToolRegistry()
    for (const tool of CORE_TOOLS) {
      this.tool_registry.register(tool)
    }
  }

  async build_system_prompt(env: ExecutionEnvironment, projectDocs: string): Promise<string> {
    const envBlock = await buildEnvironmentBlock(env)

    const parts: string[] = [OPENROUTER_BASE_PROMPT, '', envBlock]

    if (projectDocs.trim()) {
      parts.push('', '## Project Instructions', '', projectDocs.trim())
    }

    return parts.join('\n')
  }

  tools(): ToolDefinition[] {
    return this.tool_registry.definitions()
  }

  provider_options(): Record<string, unknown> {
    return {
      openrouter: {
        'HTTP-Referer': this._http_referer,
        'X-Title': this._x_title,
      },
    }
  }

  clone(overrides?: { model?: string }): OpenRouterProfile {
    return new OpenRouterProfile({
      model: overrides?.model ?? this.model,
      http_referer: this._http_referer,
      x_title: this._x_title,
    })
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export function createOpenRouterProfile(options: OpenRouterProfileOptions): OpenRouterProfile {
  return new OpenRouterProfile(options)
}
