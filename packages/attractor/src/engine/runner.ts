/**
 * Pipeline execution engine — the heart of Attractor.
 *
 * Traverses the graph from start to exit, executing handlers and selecting edges.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Graph, Node, Edge } from '../types/graph.js'
import type { Outcome } from '../types/outcome.js'
import { successOutcome, failOutcome } from '../types/outcome.js'
import { Context } from '../types/context.js'
import { Checkpoint } from '../types/checkpoint.js'
import { findStartNode, findExitNodes } from '../lint/index.js'
import type { Handler } from '../handlers/interface.js'
import { HandlerRegistry } from '../handlers/registry.js'
import { startHandler } from '../handlers/start.js'
import { exitHandler } from '../handlers/exit.js'
import { conditionalHandler } from '../handlers/conditional.js'
import { createCodergenHandler } from '../handlers/codergen.js'
import { toolHandler } from '../handlers/tool.js'
import { fanInHandler } from '../handlers/fanin.js'
import { createParallelHandler } from '../handlers/parallel.js'
import { managerLoopHandler } from '../handlers/manager_loop.js'
import { createWaitHumanHandler } from '../handlers/wait_human.js'
import { evaluateCondition } from '../conditions/eval.js'
import { normalizeLabel, AutoApproveInterviewer } from '../interviewer/index.js'
import type { Interviewer } from '../interviewer/index.js'
import type { CodergenBackend } from '../handlers/codergen.js'
import type { PipelineEvent } from '../types/event.js'
import { makeEvent } from '../types/event.js'
import type { Transform } from '../transforms/index.js'
import { applyTransforms } from '../transforms/index.js'
import { validateOrRaise } from '../lint/index.js'
import type { LintRule } from '../lint/index.js'
import { parseDot } from '../parser/dot.js'
import { AgentBackend } from '../backends/agent.js'

// ---------------------------------------------------------------------------
// Backoff config
// ---------------------------------------------------------------------------

export interface BackoffConfig {
  initial_delay_ms: number
  backoff_factor: number
  max_delay_ms: number
  jitter: boolean
}

const DEFAULT_BACKOFF: BackoffConfig = {
  initial_delay_ms: 200,
  backoff_factor: 2.0,
  max_delay_ms: 60_000,
  jitter: true,
}

function delayForAttempt(attempt: number, config: BackoffConfig): number {
  let delay = config.initial_delay_ms * Math.pow(config.backoff_factor, attempt - 1)
  delay = Math.min(delay, config.max_delay_ms)
  if (config.jitter) {
    delay = delay * (0.5 + Math.random())
  }
  return delay
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Runner config
// ---------------------------------------------------------------------------

export interface RunnerConfig {
  logs_root?: string
  backend?: CodergenBackend | null
  interviewer?: Interviewer
  extra_lint_rules?: LintRule[]
  custom_transforms?: Transform[]
  on_event?: (event: PipelineEvent) => void
  /** Load checkpoint from this path for resume */
  resume_checkpoint?: string
  /**
   * Convenience: OpenRouter API key. If set and no backend is provided,
   * an AgentBackend is created automatically.
   */
  api_key?: string
  /** Default model when using api_key shortcut. Default: anthropic/claude-sonnet-4-6 */
  model?: string
  /** Working directory for the agent's tools when using api_key shortcut. */
  working_directory?: string
  /** Callback for raw agent session events (tool calls, text deltas) within each node. */
  on_agent_event?: (event: import('@attractor/agent').SessionEvent) => void
  /** How the pipeline was invoked, e.g. "claude_code", "github_issue". Default: "unknown" */
  trigger?: string
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class Runner {
  private registry: HandlerRegistry
  private interviewer: Interviewer
  private backend: CodergenBackend | null
  private onEvent: (event: PipelineEvent) => void
  private extraLintRules: LintRule[]
  private customTransforms: Transform[]
  private defaultModel: string
  private defaultProvider: string
  private defaultTrigger: string

  constructor(config: RunnerConfig = {}) {
    this.defaultModel = config.model ?? 'anthropic/claude-sonnet-4-6'
    this.defaultProvider = config.api_key ? 'openrouter' : 'none'
    this.defaultTrigger = config.trigger ?? 'unknown'

    // Auto-create AgentBackend from api_key if no backend provided
    if (config.backend === undefined && config.api_key) {
      this.backend = new AgentBackend({
        api_key: config.api_key,
        model: config.model,
        working_directory: config.working_directory,
        on_agent_event: config.on_agent_event,
      })
    } else {
      this.backend = config.backend ?? null
    }
    this.interviewer = config.interviewer ?? new AutoApproveInterviewer()
    this.onEvent = config.on_event ?? (() => { /* no-op */ })
    this.extraLintRules = config.extra_lint_rules ?? []
    this.customTransforms = config.custom_transforms ?? []

    // Build registry
    this.registry = new HandlerRegistry()
    this.registry.register('start', startHandler)
    this.registry.register('exit', exitHandler)
    this.registry.register('conditional', conditionalHandler)
    this.registry.register('tool', toolHandler)
    this.registry.register('parallel.fan_in', fanInHandler)
    this.registry.register('wait.human', createWaitHumanHandler(this.interviewer))
    this.registry.register('stack.manager_loop', managerLoopHandler)

    // Parallel handler needs access to a branch executor (set up in run())
    // We'll create it lazily in run()

    const codergen = createCodergenHandler(this.backend)
    this.registry.register('codergen', codergen)
    this.registry.setDefault(codergen)
  }

  /** Register a custom handler. */
  registerHandler(typeString: string, handler: Handler): void {
    this.registry.register(typeString, handler)
  }

  /** Parse, validate, and execute a DOT pipeline source string. */
  async run(dotSource: string, runConfig: RunnerConfig = {}): Promise<Outcome> {
    const logsRoot = runConfig.logs_root ?? './attractor-runs/' + Date.now()
    await mkdir(logsRoot, { recursive: true })

    // Parse
    let graph = parseDot(dotSource)

    // Transforms
    graph = applyTransforms(graph, [...this.customTransforms, ...(runConfig.custom_transforms ?? [])])

    // Validate
    validateOrRaise(graph, [...this.extraLintRules, ...(runConfig.extra_lint_rules ?? [])])

    // Write manifest
    await this.writeManifest(logsRoot, graph)

    // Initialize context
    let context = new Context()
    let completedNodes: string[] = []
    const nodeRetries = new Map<string, number>()
    let startNodeId: string

    // Handle resume
    if (runConfig.resume_checkpoint) {
      const cp = await this.loadCheckpoint(runConfig.resume_checkpoint)
      if (cp) {
        context = Context.fromSnapshot(cp.context_values)
        completedNodes = [...cp.completed_nodes]
        for (const [k, v] of cp.node_retries) nodeRetries.set(k, v)
        startNodeId = cp.current_node
      } else {
        startNodeId = findStartNode(graph)?.id ?? ''
      }
    } else {
      startNodeId = findStartNode(graph)?.id ?? ''
    }

    if (!startNodeId) {
      return failOutcome('No start node found')
    }

    // Mirror graph attributes into context
    context.set('graph.goal', graph.goal)
    context.set('graph.label', graph.label)

    // Set up parallel handler with branch executor
    const self = this
    const parallelHandler = createParallelHandler(
      async (nodeId: string, branchContext: Context): Promise<Outcome> => {
        return self.executeNodeById(nodeId, branchContext, graph, logsRoot)
      },
      this.onEvent,
    )
    this.registry.register('parallel', parallelHandler)

    this.emitEvent(makeEvent('pipeline_started', {
      name: graph.label || graph.id,
      goal: graph.goal,
      id: logsRoot,
      model: this.defaultModel,
      provider: this.defaultProvider,
      trigger: runConfig.trigger ?? this.defaultTrigger,
    }))

    const startTime = Date.now()
    let lastOutcome: Outcome = successOutcome()

    try {
      lastOutcome = await this.executeGraph(
        graph, context, logsRoot, startNodeId, completedNodes, nodeRetries,
      )
      const duration = Date.now() - startTime
      this.emitEvent(makeEvent('pipeline_completed', { duration }))
    } catch (e) {
      const duration = Date.now() - startTime
      this.emitEvent(makeEvent('pipeline_failed', { error: String(e), duration }))
      return failOutcome(String(e))
    }

    return lastOutcome
  }

  private async executeGraph(
    graph: Graph,
    context: Context,
    logsRoot: string,
    startNodeId: string,
    completedNodes: string[],
    nodeRetries: Map<string, number>,
  ): Promise<Outcome> {
    const nodeOutcomes = new Map<string, Outcome>()

    // Replay already-completed nodes into nodeOutcomes (for goal gate checks on resume)
    for (const id of completedNodes) {
      const node = graph.nodes.get(id)
      if (node) {
        nodeOutcomes.set(id, successOutcome()) // assume success for completed
      }
    }

    let currentNodeId = startNodeId
    let lastOutcome: Outcome = successOutcome()

    while (true) {
      const node = graph.nodes.get(currentNodeId)
      if (!node) {
        return failOutcome(`Node '${currentNodeId}' not found`)
      }

      context.set('current_node', currentNodeId)

      // Check for terminal node
      const isTerminal = node.attrs.shape === 'Msquare' || node.id === 'exit' || node.id === 'end'
      if (isTerminal) {
        const { ok, failedGate } = checkGoalGates(graph, nodeOutcomes)
        if (!ok && failedGate) {
          const retryTarget = failedGate.attrs.retry_target
            ?? failedGate.attrs.fallback_retry_target
            ?? graph.retry_target
            ?? graph.fallback_retry_target
          if (retryTarget) {
            currentNodeId = retryTarget
            continue
          } else {
            return failOutcome(`Goal gate unsatisfied for node '${failedGate.id}' and no retry target configured`)
          }
        }
        // Execute exit handler (no-op)
        await this.registry.resolve(node).execute(node, context, graph, logsRoot)
        break
      }

      // Execute node with retry policy
      const maxRetries = node.attrs.max_retries ?? graph.default_max_retry ?? 0
      const maxAttempts = maxRetries + 1

      const stageModel = (node.attrs.llm_model as string | undefined) ?? this.defaultModel
      this.emitEvent(makeEvent('stage_started', {
        node_id: node.id,
        name: node.attrs.label ?? node.id,
        index: completedNodes.length,
        model: stageModel,
        provider: this.defaultProvider,
      }))
      const stageStart = Date.now()

      const outcome = await this.executeWithRetry(node, context, graph, logsRoot, maxAttempts, nodeRetries)
      const stageDuration = Date.now() - stageStart

      if (outcome.status === 'fail') {
        this.emitEvent(makeEvent('stage_failed', { node_id: node.id, name: node.attrs.label ?? node.id, index: completedNodes.length, error: outcome.failure_reason ?? '', will_retry: false }))
      } else {
        this.emitEvent(makeEvent('stage_completed', { node_id: node.id, name: node.attrs.label ?? node.id, index: completedNodes.length, duration: stageDuration }))
      }

      // Record completion
      completedNodes.push(node.id)
      nodeOutcomes.set(node.id, outcome)

      // Apply context updates
      if (outcome.context_updates) {
        context.applyUpdates(outcome.context_updates)
      }
      context.set('outcome', outcome.status)
      if (outcome.preferred_label) {
        context.set('preferred_label', outcome.preferred_label)
      }

      // Save checkpoint
      await this.saveCheckpoint(logsRoot, currentNodeId, completedNodes, context, nodeRetries)
      this.emitEvent(makeEvent('checkpoint_saved', { node_id: currentNodeId }))

      lastOutcome = outcome

      // Handle failure routing
      if (outcome.status === 'fail') {
        const failEdge = selectFailEdge(graph.outgoing(node.id), outcome, context)
        if (failEdge) {
          currentNodeId = failEdge.to
          continue
        }
        if (node.attrs.retry_target) {
          currentNodeId = node.attrs.retry_target
          continue
        }
        if (node.attrs.fallback_retry_target) {
          currentNodeId = node.attrs.fallback_retry_target
          continue
        }
        return failOutcome(`Stage '${node.id}' failed: ${outcome.failure_reason ?? 'unknown'} and no failure route`)
      }

      // Select next edge
      const nextEdge = selectEdge(graph.outgoing(node.id), outcome, context)
      if (!nextEdge) {
        if (outcome.status === 'fail') {
          return failOutcome(`Stage '${node.id}' failed with no outgoing fail edge`)
        }
        // No more edges — pipeline complete
        break
      }

      // Handle loop_restart
      if (nextEdge.attrs.loop_restart) {
        // Re-run from the target node with a fresh context
        return this.executeGraph(graph, new Context(), logsRoot, nextEdge.to, [], new Map())
      }

      currentNodeId = nextEdge.to
    }

    return lastOutcome
  }

  private async executeWithRetry(
    node: Node,
    context: Context,
    graph: Graph,
    logsRoot: string,
    maxAttempts: number,
    nodeRetries: Map<string, number>,
  ): Promise<Outcome> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let outcome: Outcome
      try {
        const handler = this.registry.resolve(node)
        outcome = await handler.execute(node, context, graph, logsRoot)
      } catch (e) {
        if (attempt < maxAttempts) {
          const delay = delayForAttempt(attempt, DEFAULT_BACKOFF)
          this.emitEvent(makeEvent('stage_retrying', { node_id: node.id, name: node.attrs.label ?? node.id, index: attempt, attempt, delay }))
          await sleep(delay)
          continue
        }
        return failOutcome(String(e))
      }

      if (outcome.status === 'success' || outcome.status === 'partial_success') {
        nodeRetries.delete(node.id)
        return outcome
      }

      if (outcome.status === 'retry') {
        if (attempt < maxAttempts) {
          const retryCount = (nodeRetries.get(node.id) ?? 0) + 1
          nodeRetries.set(node.id, retryCount)
          const delay = delayForAttempt(attempt, DEFAULT_BACKOFF)
          this.emitEvent(makeEvent('stage_retrying', { node_id: node.id, name: node.attrs.label ?? node.id, index: attempt, attempt, delay }))
          await sleep(delay)
          continue
        } else {
          if (node.attrs.allow_partial) {
            return { status: 'partial_success', notes: 'retries exhausted, partial accepted' }
          }
          return failOutcome('max retries exceeded')
        }
      }

      if (outcome.status === 'fail') {
        return outcome
      }

      return outcome
    }

    return failOutcome('max retries exceeded')
  }

  /** Execute a single node by ID — used by the parallel handler for branch execution. */
  async executeNodeById(nodeId: string, context: Context, graph: Graph, logsRoot: string): Promise<Outcome> {
    const node = graph.nodes.get(nodeId)
    if (!node) return failOutcome(`Node '${nodeId}' not found`)
    try {
      const handler = this.registry.resolve(node)
      return await handler.execute(node, context, graph, logsRoot)
    } catch (e) {
      return failOutcome(String(e))
    }
  }

  private emitEvent(event: PipelineEvent): void {
    this.onEvent(event)
  }

  private async saveCheckpoint(
    logsRoot: string,
    currentNode: string,
    completedNodes: string[],
    context: Context,
    nodeRetries: Map<string, number>,
  ): Promise<void> {
    try {
      const cp = Checkpoint.fromContext(currentNode, completedNodes, context, nodeRetries)
      await writeFile(join(logsRoot, 'checkpoint.json'), JSON.stringify(cp.toJSON(), null, 2), 'utf8')
    } catch {
      // Non-fatal
    }
  }

  private async loadCheckpoint(path: string): Promise<Checkpoint | null> {
    try {
      const data = await readFile(path, 'utf8')
      return Checkpoint.fromJSON(JSON.parse(data))
    } catch {
      return null
    }
  }

  private async writeManifest(logsRoot: string, graph: Graph): Promise<void> {
    try {
      const manifest = {
        name: graph.label || graph.id,
        goal: graph.goal,
        start_time: new Date().toISOString(),
      }
      await writeFile(join(logsRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    } catch {
      // Non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// Edge selection
// ---------------------------------------------------------------------------

function selectEdge(edges: Edge[], outcome: Outcome, context: Context): Edge | null {
  if (edges.length === 0) return null

  // Step 1: Condition-matching edges
  const conditionMatched: Edge[] = []
  for (const edge of edges) {
    if (edge.attrs.condition) {
      if (evaluateCondition(edge.attrs.condition, outcome, context)) {
        conditionMatched.push(edge)
      }
    }
  }
  if (conditionMatched.length > 0) {
    return bestByWeightThenLexical(conditionMatched)
  }

  // Step 2: Preferred label match
  if (outcome.preferred_label) {
    const normalized = normalizeLabel(outcome.preferred_label)
    for (const edge of edges) {
      if (edge.attrs.label && normalizeLabel(edge.attrs.label) === normalized) {
        return edge
      }
    }
  }

  // Step 3: Suggested next IDs
  if (outcome.suggested_next_ids && outcome.suggested_next_ids.length > 0) {
    for (const suggestedId of outcome.suggested_next_ids) {
      for (const edge of edges) {
        if (edge.to === suggestedId) return edge
      }
    }
  }

  // Step 4 & 5: Unconditional edges by weight then lexical
  const unconditional = edges.filter(e => !e.attrs.condition)
  if (unconditional.length > 0) {
    return bestByWeightThenLexical(unconditional)
  }

  // Fallback: any edge
  return bestByWeightThenLexical(edges)
}

function selectFailEdge(edges: Edge[], outcome: Outcome, context: Context): Edge | null {
  for (const edge of edges) {
    if (edge.attrs.condition && evaluateCondition(edge.attrs.condition, outcome, context)) {
      return edge
    }
  }
  return null
}

function bestByWeightThenLexical(edges: Edge[]): Edge | null {
  if (edges.length === 0) return null
  return [...edges].sort((a, b) => {
    const wa = a.attrs.weight ?? 0
    const wb = b.attrs.weight ?? 0
    if (wa !== wb) return wb - wa  // descending weight
    return a.to.localeCompare(b.to)  // ascending lexical
  })[0] ?? null
}

// ---------------------------------------------------------------------------
// Goal gate check
// ---------------------------------------------------------------------------

function checkGoalGates(graph: Graph, nodeOutcomes: Map<string, Outcome>): { ok: boolean; failedGate: Node | null } {
  for (const [nodeId, outcome] of nodeOutcomes) {
    const node = graph.nodes.get(nodeId)
    if (node?.attrs.goal_gate) {
      if (outcome.status !== 'success' && outcome.status !== 'partial_success') {
        return { ok: false, failedGate: node }
      }
    }
  }
  return { ok: true, failedGate: null }
}
