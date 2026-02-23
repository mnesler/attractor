import { randomUUID } from 'node:crypto'
import {
  Message, Role, ContentKind,
  type Client, type ToolCall, type ToolResult, type Request,
} from '@attractor/llm'
import type { ProviderProfile } from './profiles/base.js'
import type { ExecutionEnvironment } from './environment/interface.js'
import { defaultConfig, type SessionConfig } from './types/config.js'
import { EventKind, type SessionEvent } from './types/event.js'
import {
  type Turn, type UserTurn, type AssistantTurn, type ToolResultsTurn, type SteeringTurn,
} from './types/turn.js'
import { truncateToolOutput } from './tools/truncate.js'
import { buildEnvironmentBlock, discoverProjectDocs } from './profiles/base.js'
import { LocalExecutionEnvironment } from './environment/local.js'

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export enum SessionState {
  IDLE = 'IDLE',
  PROCESSING = 'PROCESSING',
  AWAITING_INPUT = 'AWAITING_INPUT',
  CLOSED = 'CLOSED',
}

// ---------------------------------------------------------------------------
// Subagent tracking
// ---------------------------------------------------------------------------

interface SubAgentResult {
  output: string
  success: boolean
  turns_used: number
}

interface SubAgentHandle {
  session: Session
  status: 'running' | 'completed' | 'failed'
  promise: Promise<SubAgentResult>
}

// ---------------------------------------------------------------------------
// Session options
// ---------------------------------------------------------------------------

export interface SessionOptions {
  profile: ProviderProfile
  execution_env: ExecutionEnvironment
  llm_client: Client
  config?: Partial<Omit<SessionConfig, 'tool_output_limits' | 'tool_line_limits'>> & {
    tool_output_limits?: Map<string, number>
    tool_line_limits?: Map<string, number>
  }
  /** Internal — subagent depth for depth-limiting */
  depth?: number
}

// ---------------------------------------------------------------------------
// Helper: drain a generator to completion and collect result
// ---------------------------------------------------------------------------

async function drainGenerator(gen: AsyncGenerator<SessionEvent>): Promise<SubAgentResult> {
  let lastText = ''
  let success = true
  let turns = 0
  try {
    for await (const event of gen) {
      if (event.kind === EventKind.ASSISTANT_TEXT_END) {
        lastText = (event.data['text'] as string | undefined) ?? ''
        turns++
      }
      if (event.kind === EventKind.ERROR) {
        success = false
      }
    }
  } catch {
    success = false
  }
  return { output: lastText, success, turns_used: turns }
}

// ---------------------------------------------------------------------------
// Loop detection
// ---------------------------------------------------------------------------

function detectLoop(history: Turn[], windowSize: number): boolean {
  // Collect tool call signatures from the history
  const signatures: string[] = []
  for (const turn of history) {
    if (turn.kind === 'assistant') {
      for (const tc of turn.tool_calls) {
        signatures.push(tc.name + ':' + JSON.stringify(tc.arguments))
      }
    }
  }

  const recent = signatures.slice(-windowSize)
  if (recent.length < windowSize) return false

  for (const patternLen of [1, 2, 3]) {
    if (windowSize % patternLen !== 0) continue
    const pattern = recent.slice(0, patternLen)
    let allMatch = true
    for (let i = patternLen; i < windowSize; i += patternLen) {
      const chunk = recent.slice(i, i + patternLen)
      if (chunk.some((s, j) => s !== pattern[j])) {
        allMatch = false
        break
      }
    }
    if (allMatch) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// History → Messages conversion
// ---------------------------------------------------------------------------

function historyToMessages(history: Turn[]): Message[] {
  const messages: Message[] = []
  for (const turn of history) {
    switch (turn.kind) {
      case 'user':
        messages.push(Message.user(turn.content))
        break

      case 'assistant':
        if (turn.tool_calls.length > 0) {
          messages.push(new Message({
            role: Role.ASSISTANT,
            content: [
              ...(turn.content ? [{ kind: ContentKind.TEXT as const, text: turn.content }] : []),
              ...turn.tool_calls.map(tc => ({
                kind: ContentKind.TOOL_CALL as const,
                tool_call: {
                  id: tc.id,
                  name: tc.name,
                  arguments: tc.arguments,
                },
              })),
            ],
          }))
        } else {
          messages.push(Message.assistant(turn.content))
        }
        break

      case 'tool_results':
        for (const result of turn.results) {
          messages.push(Message.toolResult({
            tool_call_id: result.tool_call_id,
            content: typeof result.content === 'string'
              ? result.content
              : JSON.stringify(result.content),
            is_error: result.is_error,
          }))
        }
        break

      case 'steering':
        // SteeringTurns become user-role messages for the LLM
        messages.push(Message.user(turn.content))
        break

      case 'system':
        // SystemTurns are informational history only, not sent to LLM
        break
    }
  }
  return messages
}

// ---------------------------------------------------------------------------
// Context window check
// ---------------------------------------------------------------------------

function approxTokenCount(history: Turn[]): number {
  let chars = 0
  for (const turn of history) {
    if ('content' in turn) chars += (turn.content as string).length
    if (turn.kind === 'tool_results') {
      for (const r of turn.results) {
        chars += typeof r.content === 'string' ? r.content.length : JSON.stringify(r.content).length
      }
    }
  }
  return Math.floor(chars / 4)
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class Session {
  readonly id: string
  state: SessionState
  readonly history: Turn[]

  private readonly profile: ProviderProfile
  private readonly execution_env: ExecutionEnvironment
  private readonly llm_client: Client
  private readonly config: SessionConfig
  private readonly steering_queue: string[] = []
  private readonly followup_queue: string[] = []
  private readonly subagents: Map<string, SubAgentHandle> = new Map()
  private readonly depth: number

  constructor(options: SessionOptions) {
    this.id = randomUUID()
    this.state = SessionState.IDLE
    this.history = []
    this.profile = options.profile
    this.execution_env = options.execution_env
    this.llm_client = options.llm_client
    this.depth = options.depth ?? 0

    const base = defaultConfig()
    this.config = {
      ...base,
      ...options.config,
      tool_output_limits: options.config?.tool_output_limits ?? base.tool_output_limits,
      tool_line_limits: options.config?.tool_line_limits ?? base.tool_line_limits,
    }

    // Register subagent tools if depth allows
    if (this.depth < this.config.max_subagent_depth) {
      this.registerSubagentTools()
    }
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Submit user input. Returns an AsyncGenerator of events; iterate to drive the loop.
   * Throws synchronously if the session is not IDLE.
   */
  submit(input: string): AsyncGenerator<SessionEvent> {
    if (this.state !== SessionState.IDLE) {
      throw new Error(`Session is ${this.state}, cannot submit new input`)
    }
    return this.process_input(input)
  }

  /** Queue a steering message to be injected after the current tool round */
  steer(message: string): void {
    this.steering_queue.push(message)
  }

  /** Queue a follow-up message to be processed after the current input completes */
  follow_up(message: string): void {
    this.followup_queue.push(message)
  }

  /** Close the session */
  close(): void {
    this.state = SessionState.CLOSED
  }

  // --------------------------------------------------------------------------
  // Core agentic loop
  // --------------------------------------------------------------------------

  private async *process_input(input: string): AsyncGenerator<SessionEvent> {
    this.state = SessionState.PROCESSING

    const userTurn: UserTurn = { kind: 'user', content: input, timestamp: new Date() }
    this.history.push(userTurn)
    yield this.makeEvent(EventKind.USER_INPUT, { content: input })

    // Drain pending steering before first LLM call
    yield* this.drain_steering()

    let round = 0

    while (true) {
      // --- Check limits ---
      if (this.config.max_tool_rounds_per_input > 0 && round >= this.config.max_tool_rounds_per_input) {
        yield this.makeEvent(EventKind.TURN_LIMIT, { round, type: 'tool_rounds' })
        break
      }

      const totalTurns = this.countTurns()
      if (this.config.max_turns > 0 && totalTurns >= this.config.max_turns) {
        yield this.makeEvent(EventKind.TURN_LIMIT, { total_turns: totalTurns, type: 'total_turns' })
        break
      }

      // --- Build request ---
      const projectDocs = await discoverProjectDocs(
        this.execution_env.working_directory(),
        this.execution_env,
        this.profile.project_doc_files,
      )
      const systemPrompt = await this.profile.build_system_prompt(this.execution_env, projectDocs)
      const messages = historyToMessages(this.history)
      const toolDefs = this.profile.tool_registry.definitions()

      const request: Request = {
        model: this.profile.model,
        messages: [Message.system(systemPrompt), ...messages],
        tools: toolDefs.map(def => ({
          name: def.name,
          description: def.description,
          parameters: def.parameters,
        })),
        tool_choice: toolDefs.length > 0 ? { mode: 'auto' } : undefined,
        reasoning_effort: this.config.reasoning_effort,
        provider: this.profile.id,
        provider_options: this.profile.provider_options(),
      }

      // --- Call LLM ---
      let response
      try {
        response = await this.llm_client.complete(request)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        yield this.makeEvent(EventKind.ERROR, { error: msg })
        this.state = SessionState.CLOSED
        yield this.makeEvent(EventKind.SESSION_END, { state: 'CLOSED', error: msg })
        return
      }

      // --- Record assistant turn ---
      const assistantTurn: AssistantTurn = {
        kind: 'assistant',
        content: response.text,
        tool_calls: response.toolCalls,
        reasoning: response.reasoning,
        usage: response.usage,
        response_id: response.id,
        timestamp: new Date(),
      }
      this.history.push(assistantTurn)

      yield this.makeEvent(EventKind.ASSISTANT_TEXT_END, {
        text: response.text,
        reasoning: response.reasoning ?? null,
        usage: response.usage,
      })

      // --- Context window check ---
      const approxTokens = approxTokenCount(this.history)
      const threshold = Math.floor(this.profile.context_window_size * 0.8)
      if (approxTokens > threshold) {
        const pct = Math.round((approxTokens / this.profile.context_window_size) * 100)
        yield this.makeEvent(EventKind.WARNING, {
          message: `Context usage at ~${pct}% of context window`,
        })
      }

      // --- Natural completion ---
      if (response.toolCalls.length === 0) break

      // --- Execute tool calls ---
      round++
      const { events: toolEvents, results } = await this.execute_tool_calls(response.toolCalls)

      for (const event of toolEvents) {
        yield event
      }

      // Record tool results turn
      const toolResultsTurn: ToolResultsTurn = {
        kind: 'tool_results',
        results,
        timestamp: new Date(),
      }
      this.history.push(toolResultsTurn)

      // --- Drain steering after tool round ---
      yield* this.drain_steering()

      // --- Loop detection ---
      if (this.config.enable_loop_detection) {
        if (detectLoop(this.history, this.config.loop_detection_window)) {
          const warning =
            `Loop detected: the last ${this.config.loop_detection_window} tool calls follow a ` +
            `repeating pattern. Try a different approach.`
          const steeringTurn: SteeringTurn = {
            kind: 'steering',
            content: warning,
            timestamp: new Date(),
          }
          this.history.push(steeringTurn)
          yield this.makeEvent(EventKind.LOOP_DETECTION, { message: warning })
        }
      }
    }

    // --- Process follow-ups ---
    if (this.followup_queue.length > 0) {
      const nextInput = this.followup_queue.shift()!
      this.state = SessionState.IDLE
      yield* this.process_input(nextInput)
      return
    }

    this.state = SessionState.IDLE
    yield this.makeEvent(EventKind.SESSION_END, { state: 'IDLE' })
  }

  // --------------------------------------------------------------------------
  // Steering drain
  // --------------------------------------------------------------------------

  private async *drain_steering(): AsyncGenerator<SessionEvent> {
    while (this.steering_queue.length > 0) {
      const msg = this.steering_queue.shift()!
      const steeringTurn: SteeringTurn = {
        kind: 'steering',
        content: msg,
        timestamp: new Date(),
      }
      this.history.push(steeringTurn)
      yield this.makeEvent(EventKind.STEERING_INJECTED, { content: msg })
    }
  }

  // --------------------------------------------------------------------------
  // Tool execution
  // --------------------------------------------------------------------------

  private async execute_tool_calls(
    toolCalls: ToolCall[],
  ): Promise<{ events: SessionEvent[]; results: ToolResult[] }> {
    const events: SessionEvent[] = []

    if (this.profile.supports_parallel_tool_calls && toolCalls.length > 1) {
      // Emit start events for all
      for (const tc of toolCalls) {
        events.push(this.makeEvent(EventKind.TOOL_CALL_START, {
          tool_name: tc.name,
          call_id: tc.id,
        }))
      }
      // Execute in parallel
      const execResults = await Promise.all(toolCalls.map(tc => this.execute_single_tool(tc)))
      // Emit end events in order
      for (const { endEvent } of execResults) {
        events.push(endEvent)
      }
      return { events, results: execResults.map(r => r.result) }
    }

    // Sequential execution
    const results: ToolResult[] = []
    for (const tc of toolCalls) {
      events.push(this.makeEvent(EventKind.TOOL_CALL_START, {
        tool_name: tc.name,
        call_id: tc.id,
      }))
      const { endEvent, result } = await this.execute_single_tool(tc)
      events.push(endEvent)
      results.push(result)
    }
    return { events, results }
  }

  private async execute_single_tool(
    tc: ToolCall,
  ): Promise<{ endEvent: SessionEvent; result: ToolResult }> {
    const registered = this.profile.tool_registry.get(tc.name)

    if (!registered) {
      const errorMsg = `Unknown tool: ${tc.name}`
      return {
        endEvent: this.makeEvent(EventKind.TOOL_CALL_END, { call_id: tc.id, error: errorMsg }),
        result: { tool_call_id: tc.id, content: errorMsg, is_error: true },
      }
    }

    try {
      const rawOutput = await registered.executor(tc.arguments, this.execution_env)
      const truncated = truncateToolOutput(rawOutput, tc.name, this.config)

      return {
        endEvent: this.makeEvent(EventKind.TOOL_CALL_END, {
          call_id: tc.id,
          tool_name: tc.name,
          output: rawOutput,          // full untruncated output in event
        }),
        result: {
          tool_call_id: tc.id,
          content: truncated,         // truncated output for LLM
          is_error: false,
        },
      }
    } catch (error) {
      const errorMsg = `Tool error (${tc.name}): ${error instanceof Error ? error.message : String(error)}`
      return {
        endEvent: this.makeEvent(EventKind.TOOL_CALL_END, { call_id: tc.id, error: errorMsg }),
        result: { tool_call_id: tc.id, content: errorMsg, is_error: true },
      }
    }
  }

  // --------------------------------------------------------------------------
  // Subagent tools
  // --------------------------------------------------------------------------

  private registerSubagentTools(): void {
    this.profile.tool_registry.register({
      definition: {
        name: 'spawn_agent',
        description: 'Spawn a subagent to handle a scoped task autonomously. Returns an agent ID.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Natural language task description for the subagent' },
            working_dir: { type: 'string', description: 'Subdirectory scope for the subagent (optional)' },
            model: { type: 'string', description: 'Model override (optional, defaults to parent model)' },
            max_turns: { type: 'integer', description: 'Turn limit (optional, 0=unlimited)' },
          },
          required: ['task'],
        },
      },
      executor: (args) => this.spawnSubagent(args),
    })

    this.profile.tool_registry.register({
      definition: {
        name: 'send_input',
        description: 'Send a message to a running subagent.',
        parameters: {
          type: 'object',
          properties: {
            agent_id: { type: 'string', description: 'Subagent ID from spawn_agent' },
            message: { type: 'string', description: 'Message to send' },
          },
          required: ['agent_id', 'message'],
        },
      },
      executor: (args) => this.sendSubagentInput(args),
    })

    this.profile.tool_registry.register({
      definition: {
        name: 'wait',
        description: 'Wait for a subagent to complete and return its result.',
        parameters: {
          type: 'object',
          properties: {
            agent_id: { type: 'string', description: 'Subagent ID to wait for' },
          },
          required: ['agent_id'],
        },
      },
      executor: (args) => this.waitForSubagent(args),
    })

    this.profile.tool_registry.register({
      definition: {
        name: 'close_agent',
        description: 'Terminate a subagent.',
        parameters: {
          type: 'object',
          properties: {
            agent_id: { type: 'string', description: 'Subagent ID to close' },
          },
          required: ['agent_id'],
        },
      },
      executor: (args) => this.closeSubagent(args),
    })
  }

  private async spawnSubagent(args: Record<string, unknown>): Promise<string> {
    const task = args['task'] as string
    const workingDir = args['working_dir'] as string | undefined
    const model = args['model'] as string | undefined
    const maxTurns = (args['max_turns'] as number | undefined) ?? 0

    const subProfile = this.profile.clone({ model: model ?? this.profile.model })

    const subEnv = workingDir
      ? new LocalExecutionEnvironment(workingDir)
      : this.execution_env

    const subSession = new Session({
      profile: subProfile,
      execution_env: subEnv,
      llm_client: this.llm_client,
      config: { ...this.config, max_turns: maxTurns },
      depth: this.depth + 1,
    })

    const agentId = randomUUID()

    // Run subagent in background by consuming its generator
    const promise = drainGenerator(subSession.submit(task))

    this.subagents.set(agentId, { session: subSession, status: 'running', promise })

    return `Subagent ${agentId} spawned. Use the wait tool with agent_id="${agentId}" to get results.`
  }

  private async sendSubagentInput(args: Record<string, unknown>): Promise<string> {
    const agentId = args['agent_id'] as string
    const message = args['message'] as string
    const agent = this.subagents.get(agentId)
    if (!agent) return `Error: No subagent with ID ${agentId}`
    if (agent.status !== 'running') return `Error: Subagent ${agentId} is ${agent.status}`
    agent.session.follow_up(message)
    return `Message sent to subagent ${agentId}`
  }

  private async waitForSubagent(args: Record<string, unknown>): Promise<string> {
    const agentId = args['agent_id'] as string
    const agent = this.subagents.get(agentId)
    if (!agent) return `Error: No subagent with ID ${agentId}`

    const result = await agent.promise
    agent.status = result.success ? 'completed' : 'failed'

    return [
      `Subagent ${agentId} ${agent.status}.`,
      `Turns used: ${result.turns_used}`,
      `Output:\n${result.output}`,
    ].join('\n')
  }

  private async closeSubagent(args: Record<string, unknown>): Promise<string> {
    const agentId = args['agent_id'] as string
    const agent = this.subagents.get(agentId)
    if (!agent) return `Error: No subagent with ID ${agentId}`
    agent.session.close()
    agent.status = 'failed'
    this.subagents.delete(agentId)
    return `Subagent ${agentId} closed.`
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private makeEvent(kind: EventKind, data: Record<string, unknown> = {}): SessionEvent {
    return { kind, timestamp: new Date(), session_id: this.id, data }
  }

  private countTurns(): number {
    return this.history.filter(t => t.kind === 'user' || t.kind === 'assistant').length
  }
}
