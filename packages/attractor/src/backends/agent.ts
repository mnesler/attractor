/**
 * AgentBackend — wires @attractor/agent into the codergen handler.
 *
 * Each pipeline node that runs an LLM task gets a full agentic session
 * with read_file, write_file, edit_file, shell, grep, glob tools.
 * Session reuse is supported for nodes sharing the same thread_id (full fidelity).
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Session, EventKind, OpenRouterProfile, LocalExecutionEnvironment } from '@attractor/agent'
import { Client, OpenRouterAdapter } from '@attractor/llm'
import type { CodergenBackend } from '../handlers/codergen.js'
import type { Node } from '../types/graph.js'
import type { Context } from '../types/context.js'
import type { Outcome } from '../types/outcome.js'
import type { SessionEvent } from '@attractor/agent'

export interface AgentBackendConfig {
  /** OpenRouter API key */
  api_key: string
  /** Default model (OpenRouter format: "provider/model"). Default: anthropic/claude-sonnet-4-6 */
  model?: string
  /** Working directory for the agent's tools. Default: process.cwd() */
  working_directory?: string
  /** Callback for agent session events (tool calls, text, etc.) */
  on_agent_event?: (event: SessionEvent) => void
}

export class AgentBackend implements CodergenBackend {
  private client: Client
  private config: AgentBackendConfig
  /** Session pool for full-fidelity thread reuse, keyed by thread_id */
  private sessions = new Map<string, Session>()

  constructor(config: AgentBackendConfig) {
    this.config = config
    this.client = new Client({
      providers: {
        openrouter: new OpenRouterAdapter({
          api_key: config.api_key,
          default_headers: {
            'HTTP-Referer': 'https://github.com/strongdm/attractor',
            'X-Title': 'Attractor Pipeline',
          },
        }),
      },
      default_provider: 'openrouter',
    })
  }

  async run(node: Node, prompt: string, context: Context, logs_root: string): Promise<string | Outcome> {
    const model = (node.attrs.llm_model as string | undefined)
      ?? this.config.model
      ?? 'anthropic/claude-sonnet-4-6'

    const workingDir = (node.attrs['working_directory'] as string | undefined)
      ?? context.getString('working_directory')
      ?? this.config.working_directory
      ?? process.cwd()

    // Build the full prompt — inject context preamble based on fidelity
    const fidelity = (node.attrs.fidelity as string | undefined) ?? 'compact'
    const fullPrompt = buildPrompt(prompt, fidelity, context)

    // Build system prompt for logging (mirrors what the Session will use)
    const profile = new OpenRouterProfile({ model })
    const env = new LocalExecutionEnvironment(workingDir)
    const systemPrompt = await profile.build_system_prompt(env, '')

    // Write full assembled prompt to logs
    const stageDir = join(logs_root, node.id)
    try {
      await mkdir(stageDir, { recursive: true })
      const loggedPrompt = [
        '# System Prompt',
        '',
        systemPrompt,
        '',
        '---',
        '',
        '# User Message',
        '',
        fullPrompt,
      ].join('\n')
      await writeFile(join(stageDir, 'prompt.md'), loggedPrompt, 'utf8')
    } catch {
      // Non-fatal
    }

    // Resolve session (reuse for full fidelity, fresh otherwise)
    const session = this.resolveSession(node, model, workingDir)

    let lastText = ''

    for await (const event of session.submit(fullPrompt)) {
      this.config.on_agent_event?.(event)

      if (event.kind === EventKind.ASSISTANT_TEXT_END) {
        lastText = event.data['text'] as string
      }
      if (event.kind === EventKind.ERROR) {
        const msg = event.data['message'] as string ?? 'Agent session error'
        return { status: 'fail', failure_reason: msg }
      }
    }

    return lastText || `[No response from agent at node: ${node.id}]`
  }

  private resolveSession(node: Node, model: string, workingDir: string): Session {
    const fidelity = (node.attrs.fidelity as string | undefined) ?? 'compact'

    if (fidelity === 'full') {
      const threadId = (node.attrs.thread_id as string | undefined) ?? node.id
      if (!this.sessions.has(threadId)) {
        this.sessions.set(threadId, this.createSession(model, workingDir))
      }
      return this.sessions.get(threadId)!
    }

    // Fresh session for every other fidelity mode
    return this.createSession(model, workingDir)
  }

  private createSession(model: string, workingDir: string): Session {
    const profile = new OpenRouterProfile({ model })
    const env = new LocalExecutionEnvironment(workingDir)
    return new Session({ profile, execution_env: env, llm_client: this.client })
  }

  /** Close all pooled sessions (call when the pipeline run is complete). */
  close(): void {
    this.sessions.clear()
  }
}

// ---------------------------------------------------------------------------
// Context preamble injection
// ---------------------------------------------------------------------------

function buildPrompt(prompt: string, fidelity: string, context: Context): string {
  const preamble = buildPreamble(fidelity, context)
  if (!preamble) return prompt
  return `${preamble}\n\n---\n\n${prompt}`
}

function buildPreamble(fidelity: string, context: Context): string {
  if (fidelity === 'full' || fidelity === 'truncate') return ''

  const goal = context.getString('graph.goal')
  const lastStage = context.getString('last_stage')
  const lastResponse = context.getString('last_response')
  const outcome = context.getString('outcome')

  if (fidelity === 'truncate') {
    return goal ? `Goal: ${goal}` : ''
  }

  if (fidelity === 'compact' || fidelity === '') {
    const lines: string[] = []
    if (goal) lines.push(`**Goal:** ${goal}`)
    if (lastStage) lines.push(`**Last completed stage:** ${lastStage} (outcome: ${outcome})`)
    if (lastResponse) lines.push(`**Last response summary:** ${lastResponse}`)

    // Include any context.* keys set by handlers
    const snap = context.snapshot()
    for (const [k, v] of Object.entries(snap)) {
      if (k.startsWith('context.') && v !== undefined && v !== '') {
        lines.push(`**${k}:** ${v}`)
      }
    }

    return lines.length > 0 ? `## Pipeline Context\n${lines.join('\n')}` : ''
  }

  // summary:low / summary:medium / summary:high — vary detail level
  const detailLevel = fidelity.startsWith('summary:') ? fidelity.split(':')[1] : 'medium'
  return buildSummaryPreamble(detailLevel ?? 'medium', context)
}

function buildSummaryPreamble(level: string, context: Context): string {
  const snap = context.snapshot()
  const lines: string[] = ['## Pipeline State Summary']

  if (snap['graph.goal']) lines.push(`Goal: ${snap['graph.goal']}`)
  if (snap['last_stage']) lines.push(`Last stage: ${snap['last_stage']} → ${snap['outcome']}`)

  if (level === 'medium' || level === 'high') {
    for (const [k, v] of Object.entries(snap)) {
      if (k.startsWith('context.') && v) lines.push(`${k}: ${v}`)
    }
  }

  if (level === 'high') {
    if (snap['last_response']) lines.push(`Last response: ${snap['last_response']}`)
  }

  return lines.join('\n')
}
