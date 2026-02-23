/**
 * PipelineRecorder — hooks into Runner's on_event stream, builds a PipelineRun
 * record, and appends it to a JSONL history file when the pipeline finishes.
 *
 * Usage:
 *   const recorder = new PipelineRecorder('./my-history')
 *   const runner = new Runner({ ..., on_event: recorder.handler })
 *   await runner.run(dot, { logs_root: './runs/1' })
 *   // history is written automatically
 */

import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PipelineEvent } from '../types/event.js'
import type { PipelineRun, StageRecord } from './types.js'
import type { SessionEvent } from '@attractor/agent'

export const HISTORY_FILE = 'runs.jsonl'

/** Generate a short unique run ID based on current time + random suffix. */
function newRunId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

export class PipelineRecorder {
  private readonly historyRoot: string
  /** In-flight run being recorded. */
  private run: PipelineRun | null = null
  /** Stages keyed by node_id for fast lookup during retries. */
  private stageMap = new Map<string, StageRecord>()
  /** Node ID of the stage currently executing (for agent event attribution). */
  private currentStageId: string | null = null
  /** Optional passthrough so callers can chain their own listener. */
  private readonly passthrough: ((event: PipelineEvent) => void) | undefined

  constructor(historyRoot: string, opts?: { passthrough?: (event: PipelineEvent) => void }) {
    this.historyRoot = historyRoot
    this.passthrough = opts?.passthrough
  }

  /** Bind-safe event handler — pass directly to RunnerConfig.on_event. */
  readonly handler = (event: PipelineEvent): void => {
    this.passthrough?.(event)
    this.handleEvent(event)
  }

  /**
   * Bind-safe agent event handler — pass directly to RunnerConfig.on_agent_event.
   * Accumulates tool call counts, token usage, and cost onto the currently-executing stage.
   */
  readonly agentHandler = (event: SessionEvent): void => {
    if (!this.run || !this.currentStageId) return
    const stage = this.stageMap.get(this.currentStageId)
    if (!stage) return
    const d = event.data

    if (event.kind === 'TOOL_CALL_START') {
      stage.tool_calls += 1
      const toolName = String(d['tool_name'] ?? 'unknown')
      stage.tool_breakdown[toolName] = (stage.tool_breakdown[toolName] ?? 0) + 1
    } else if (event.kind === 'ASSISTANT_TEXT_END') {
      stage.llm_calls += 1
      const usage = d['usage'] as {
        input_tokens?: number
        output_tokens?: number
        total_tokens?: number
        raw?: Record<string, unknown>
      } | undefined
      if (usage) {
        stage.tokens_input += usage.input_tokens ?? 0
        stage.tokens_output += usage.output_tokens ?? 0
        stage.tokens_total += usage.total_tokens ?? 0
        const cost = usage.raw?.['cost'] as number | undefined
        if (typeof cost === 'number') {
          stage.estimated_cost_usd += cost
        }
      }
    }
  }

  private handleEvent(event: PipelineEvent): void {
    const d = event.data as Record<string, unknown>

    switch (event.kind) {
      case 'pipeline_started':
        this.run = {
          run_id: newRunId(),
          name: String(d['name'] ?? 'unnamed'),
          goal: d['goal'] !== undefined ? String(d['goal']) : undefined,
          logs_root: String(d['id'] ?? ''),
          started_at: event.timestamp.toISOString(),
          status: 'in_progress',
          stages: [],
          model: String(d['model'] ?? 'unknown'),
          provider: String(d['provider'] ?? 'unknown'),
          trigger: String(d['trigger'] ?? 'unknown'),
          total_tool_calls: 0,
          total_llm_calls: 0,
          total_retries: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_total: 0,
          estimated_cost_usd: 0,
          tool_breakdown: {},
        }
        this.stageMap.clear()
        this.currentStageId = null
        break

      case 'stage_started': {
        if (!this.run) break
        const stage: StageRecord = {
          node_id: String(d['node_id'] ?? d['name'] ?? ''),
          name: String(d['name'] ?? d['node_id'] ?? ''),
          started_at: event.timestamp.toISOString(),
          status: 'in_progress',
          retries: 0,
          model: String(d['model'] ?? 'unknown'),
          provider: String(d['provider'] ?? 'unknown'),
          tool_calls: 0,
          tool_breakdown: {},
          llm_calls: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_total: 0,
          estimated_cost_usd: 0,
        }
        this.run.stages.push(stage)
        this.stageMap.set(stage.node_id, stage)
        this.currentStageId = stage.node_id
        break
      }

      case 'stage_completed': {
        if (!this.run) break
        const node_id = String(d['node_id'] ?? d['name'] ?? '')
        const stage = this.stageMap.get(node_id) ?? this.findStageByName(String(d['name'] ?? ''))
        if (stage) {
          stage.completed_at = event.timestamp.toISOString()
          stage.duration_ms = typeof d['duration'] === 'number' ? d['duration'] : undefined
          stage.status = 'success'
        }
        break
      }

      case 'stage_failed': {
        if (!this.run) break
        const node_id = String(d['node_id'] ?? d['name'] ?? '')
        const stage = this.stageMap.get(node_id) ?? this.findStageByName(String(d['name'] ?? ''))
        if (stage) {
          stage.completed_at = event.timestamp.toISOString()
          stage.duration_ms = computeDuration(stage.started_at, event.timestamp)
          stage.status = 'fail'
          stage.failure_reason = d['error'] !== undefined ? String(d['error']) : undefined
        }
        break
      }

      case 'stage_retrying': {
        if (!this.run) break
        const node_id = String(d['node_id'] ?? d['name'] ?? '')
        const stage = this.stageMap.get(node_id) ?? this.findStageByName(String(d['name'] ?? ''))
        if (stage) {
          stage.retries += 1
        }
        break
      }

      case 'pipeline_completed': {
        if (!this.run) break
        this.run.status = 'completed'
        this.run.completed_at = event.timestamp.toISOString()
        this.run.duration_ms = typeof d['duration'] === 'number' ? d['duration'] : computeDuration(this.run.started_at, event.timestamp)
        rollUpTotals(this.run)
        this.flush(this.run)
        break
      }

      case 'pipeline_failed': {
        if (!this.run) break
        this.run.status = 'failed'
        this.run.completed_at = event.timestamp.toISOString()
        this.run.duration_ms = typeof d['duration'] === 'number' ? d['duration'] : computeDuration(this.run.started_at, event.timestamp)
        rollUpTotals(this.run)
        this.flush(this.run)
        break
      }
    }
  }

  private findStageByName(name: string): StageRecord | undefined {
    if (!this.run) return undefined
    // Walk in reverse so we find the most recently started stage with that name
    for (let i = this.run.stages.length - 1; i >= 0; i--) {
      if (this.run.stages[i]!.name === name) return this.run.stages[i]
    }
    return undefined
  }

  /** Fire-and-forget write to {historyRoot}/runs.jsonl */
  private flush(run: PipelineRun): void {
    const line = JSON.stringify(run) + '\n'
    mkdir(this.historyRoot, { recursive: true })
      .then(() => appendFile(join(this.historyRoot, HISTORY_FILE), line, 'utf8'))
      .catch(() => { /* non-fatal */ })
  }

  /** Expose the current in-flight run (useful for testing). */
  get currentRun(): PipelineRun | null {
    return this.run
  }
}

function computeDuration(startedAt: string, endTimestamp: Date): number {
  return endTimestamp.getTime() - new Date(startedAt).getTime()
}

function rollUpTotals(run: PipelineRun): void {
  run.total_tool_calls = 0
  run.total_llm_calls = 0
  run.total_retries = 0
  run.tokens_input = 0
  run.tokens_output = 0
  run.tokens_total = 0
  run.estimated_cost_usd = 0
  run.tool_breakdown = {}
  for (const stage of run.stages) {
    run.total_tool_calls += stage.tool_calls
    run.total_llm_calls += stage.llm_calls
    run.total_retries += stage.retries
    run.tokens_input += stage.tokens_input
    run.tokens_output += stage.tokens_output
    run.tokens_total += stage.tokens_total
    run.estimated_cost_usd += stage.estimated_cost_usd
    for (const [tool, count] of Object.entries(stage.tool_breakdown)) {
      run.tool_breakdown[tool] = (run.tool_breakdown[tool] ?? 0) + count
    }
  }
}
