import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PipelineRecorder } from '../src/history/recorder.js'
import { readHistory, findRuns, getLatestRun, getRunById, summarise } from '../src/history/reader.js'
import type { PipelineEvent } from '../src/types/event.js'
import type { SessionEvent } from '@attractor/agent'
import { EventKind } from '@attractor/agent'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(kind: PipelineEvent['kind'], data: Record<string, unknown> = {}): PipelineEvent {
  return { kind, timestamp: new Date(), data }
}

function makeAgentEvent(kind: EventKind, data: Record<string, unknown> = {}): SessionEvent {
  return { kind, timestamp: new Date(), session_id: 'test-session', data }
}

function mkTmpDir(): string {
  return join(tmpdir(), 'attractor-history-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
}

async function runFakePipeline(recorder: PipelineRecorder, opts: {
  name?: string
  goal?: string
  logsRoot?: string
  stages?: Array<{ node_id: string; name: string; fail?: boolean }>
  fail?: boolean
} = {}): Promise<void> {
  const name = opts.name ?? 'TestPipeline'
  const logsRoot = opts.logsRoot ?? '/tmp/fake-run'
  const stages = opts.stages ?? [
    { node_id: 'write', name: 'Write Code' },
    { node_id: 'test', name: 'Run Tests' },
  ]

  recorder.handler(makeEvent('pipeline_started', { name, goal: opts.goal ?? 'Do something', id: logsRoot, model: 'anthropic/claude-sonnet-4-6', provider: 'openrouter', trigger: 'test' }))

  for (const stage of stages) {
    recorder.handler(makeEvent('stage_started', { node_id: stage.node_id, name: stage.name }))
    if (stage.fail) {
      recorder.handler(makeEvent('stage_failed', { node_id: stage.node_id, name: stage.name, error: 'boom' }))
    } else {
      recorder.handler(makeEvent('stage_completed', { node_id: stage.node_id, name: stage.name, duration: 150 }))
    }
  }

  if (opts.fail) {
    recorder.handler(makeEvent('pipeline_failed', { duration: 300, error: 'pipeline error' }))
  } else {
    recorder.handler(makeEvent('pipeline_completed', { duration: 300 }))
  }

  // Wait for async flush
  await new Promise(r => setTimeout(r, 20))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PipelineRecorder', () => {
  let historyRoot: string

  beforeEach(async () => {
    historyRoot = mkTmpDir()
    await mkdir(historyRoot, { recursive: true })
  })

  it('records a completed run with stage details', async () => {
    const recorder = new PipelineRecorder(historyRoot)
    await runFakePipeline(recorder, { name: 'MyPipeline', goal: 'Build stuff' })

    const runs = await readHistory(historyRoot)
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    expect(run.name).toBe('MyPipeline')
    expect(run.goal).toBe('Build stuff')
    expect(run.status).toBe('completed')
    expect(run.duration_ms).toBe(300)
    expect(run.stages).toHaveLength(2)
    expect(run.stages[0]!.node_id).toBe('write')
    expect(run.stages[0]!.status).toBe('success')
    expect(run.stages[0]!.duration_ms).toBe(150)
    expect(run.stages[1]!.node_id).toBe('test')
    expect(run.stages[1]!.status).toBe('success')
    expect(run.run_id).toBeTruthy()
    expect(run.started_at).toBeTruthy()
    expect(run.completed_at).toBeTruthy()
  })

  it('records a failed run', async () => {
    const recorder = new PipelineRecorder(historyRoot)
    await runFakePipeline(recorder, { fail: true })

    const runs = await readHistory(historyRoot)
    expect(runs[0]!.status).toBe('failed')
  })

  it('records a failed stage', async () => {
    const recorder = new PipelineRecorder(historyRoot)
    await runFakePipeline(recorder, {
      stages: [{ node_id: 'deploy', name: 'Deploy', fail: true }],
    })

    const runs = await readHistory(historyRoot)
    const stage = runs[0]!.stages[0]!
    expect(stage.status).toBe('fail')
    expect(stage.failure_reason).toBe('boom')
  })

  it('tracks retries on a stage', async () => {
    const recorder = new PipelineRecorder(historyRoot)
    const name = 'Flaky Stage'
    const node_id = 'flaky'

    recorder.handler(makeEvent('pipeline_started', { name: 'P', id: '/tmp/x' }))
    recorder.handler(makeEvent('stage_started', { node_id, name }))
    recorder.handler(makeEvent('stage_retrying', { node_id, name, attempt: 1, delay: 200 }))
    recorder.handler(makeEvent('stage_retrying', { node_id, name, attempt: 2, delay: 400 }))
    recorder.handler(makeEvent('stage_completed', { node_id, name, duration: 800 }))
    recorder.handler(makeEvent('pipeline_completed', { duration: 1000 }))
    await new Promise(r => setTimeout(r, 20))

    const runs = await readHistory(historyRoot)
    expect(runs[0]!.stages[0]!.retries).toBe(2)
  })

  it('appends multiple runs to the same file', async () => {
    const recorder = new PipelineRecorder(historyRoot)
    await runFakePipeline(recorder, { name: 'Pipeline A' })
    await runFakePipeline(recorder, { name: 'Pipeline B' })
    await runFakePipeline(recorder, { name: 'Pipeline A' })

    const runs = await readHistory(historyRoot)
    expect(runs).toHaveLength(3)
    expect(runs[0]!.name).toBe('Pipeline A')
    expect(runs[1]!.name).toBe('Pipeline B')
    expect(runs[2]!.name).toBe('Pipeline A')
  })

  it('forwards events to a passthrough callback', async () => {
    const received: PipelineEvent[] = []
    const recorder = new PipelineRecorder(historyRoot, { passthrough: e => received.push(e) })
    await runFakePipeline(recorder)

    expect(received.length).toBeGreaterThan(0)
    expect(received.some(e => e.kind === 'pipeline_completed')).toBe(true)
  })

  it('tracks tool calls, tokens, cost, and tool_breakdown via agentHandler', async () => {
    const recorder = new PipelineRecorder(historyRoot)

    recorder.handler(makeEvent('pipeline_started', { name: 'P', id: '/tmp/z', model: 'anthropic/claude-sonnet-4-6', provider: 'openrouter', trigger: 'claude_code' }))
    recorder.handler(makeEvent('stage_started', { node_id: 'write', name: 'Write', model: 'anthropic/claude-sonnet-4-6', provider: 'openrouter' }))

    recorder.agentHandler(makeAgentEvent(EventKind.TOOL_CALL_START, { tool_name: 'shell', call_id: '1' }))
    recorder.agentHandler(makeAgentEvent(EventKind.TOOL_CALL_START, { tool_name: 'write_file', call_id: '2' }))
    recorder.agentHandler(makeAgentEvent(EventKind.ASSISTANT_TEXT_END, {
      text: 'done',
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, raw: { cost: 0.002 } },
    }))

    recorder.handler(makeEvent('stage_completed', { node_id: 'write', name: 'Write', duration: 200 }))

    recorder.handler(makeEvent('stage_started', { node_id: 'test', name: 'Test', model: 'anthropic/claude-sonnet-4-6', provider: 'openrouter' }))
    recorder.agentHandler(makeAgentEvent(EventKind.TOOL_CALL_START, { tool_name: 'shell', call_id: '3' }))
    recorder.agentHandler(makeAgentEvent(EventKind.ASSISTANT_TEXT_END, {
      text: 'ok',
      usage: { input_tokens: 80, output_tokens: 30, total_tokens: 110, raw: { cost: 0.001 } },
    }))
    recorder.handler(makeEvent('stage_completed', { node_id: 'test', name: 'Test', duration: 100 }))

    recorder.handler(makeEvent('pipeline_completed', { duration: 300 }))
    await new Promise(r => setTimeout(r, 20))

    const runs = await readHistory(historyRoot)
    const run = runs[0]!

    // Stage 0 checks
    expect(run.stages[0]!.tool_calls).toBe(2)
    expect(run.stages[0]!.tool_breakdown).toEqual({ shell: 1, write_file: 1 })
    expect(run.stages[0]!.llm_calls).toBe(1)
    expect(run.stages[0]!.tokens_input).toBe(100)
    expect(run.stages[0]!.tokens_output).toBe(50)
    expect(run.stages[0]!.tokens_total).toBe(150)
    expect(run.stages[0]!.estimated_cost_usd).toBeCloseTo(0.002)
    expect(run.stages[0]!.model).toBe('anthropic/claude-sonnet-4-6')
    expect(run.stages[0]!.provider).toBe('openrouter')

    // Stage 1 checks
    expect(run.stages[1]!.tool_calls).toBe(1)
    expect(run.stages[1]!.tool_breakdown).toEqual({ shell: 1 })
    expect(run.stages[1]!.tokens_input).toBe(80)

    // Run-level rollup
    expect(run.total_tool_calls).toBe(3)
    expect(run.total_llm_calls).toBe(2)
    expect(run.tokens_input).toBe(180)
    expect(run.tokens_output).toBe(80)
    expect(run.tokens_total).toBe(260)
    expect(run.estimated_cost_usd).toBeCloseTo(0.003)
    expect(run.tool_breakdown).toEqual({ shell: 2, write_file: 1 })
    expect(run.model).toBe('anthropic/claude-sonnet-4-6')
    expect(run.provider).toBe('openrouter')
    expect(run.trigger).toBe('claude_code')
  })

  it('exposes currentRun during in-flight pipeline', () => {
    const recorder = new PipelineRecorder(historyRoot)
    expect(recorder.currentRun).toBeNull()

    recorder.handler(makeEvent('pipeline_started', { name: 'Live', id: '/tmp/y' }))
    expect(recorder.currentRun).not.toBeNull()
    expect(recorder.currentRun!.status).toBe('in_progress')
    expect(recorder.currentRun!.name).toBe('Live')
  })
})

describe('readHistory / findRuns / getLatestRun / getRunById / summarise', () => {
  let historyRoot: string

  beforeEach(async () => {
    historyRoot = mkTmpDir()
    await mkdir(historyRoot, { recursive: true })
  })

  it('returns empty array when file does not exist', async () => {
    const runs = await readHistory(historyRoot)
    expect(runs).toEqual([])
  })

  it('findRuns filters by name', async () => {
    const recorder = new PipelineRecorder(historyRoot)
    await runFakePipeline(recorder, { name: 'Alpha' })
    await runFakePipeline(recorder, { name: 'Beta' })
    await runFakePipeline(recorder, { name: 'Alpha' })

    const alphas = await findRuns(historyRoot, { name: 'Alpha' })
    expect(alphas).toHaveLength(2)
    expect(alphas.every(r => r.name === 'Alpha')).toBe(true)
  })

  it('findRuns filters by status', async () => {
    const recorder = new PipelineRecorder(historyRoot)
    await runFakePipeline(recorder, { name: 'P' })
    await runFakePipeline(recorder, { name: 'P', fail: true })

    const completed = await findRuns(historyRoot, { status: 'completed' })
    const failed = await findRuns(historyRoot, { status: 'failed' })
    expect(completed).toHaveLength(1)
    expect(failed).toHaveLength(1)
  })

  it('findRuns limits results and returns newest first', async () => {
    const recorder = new PipelineRecorder(historyRoot)
    for (let i = 0; i < 5; i++) {
      await runFakePipeline(recorder, { name: `Run ${i}` })
    }
    const recent = await findRuns(historyRoot, { limit: 2 })
    expect(recent).toHaveLength(2)
    // newest first means Run 4 then Run 3
    expect(recent[0]!.name).toBe('Run 4')
    expect(recent[1]!.name).toBe('Run 3')
  })

  it('getLatestRun returns the most recent run', async () => {
    const recorder = new PipelineRecorder(historyRoot)
    await runFakePipeline(recorder, { name: 'Old' })
    await runFakePipeline(recorder, { name: 'New' })

    const latest = await getLatestRun(historyRoot)
    expect(latest!.name).toBe('New')
  })

  it('getLatestRun filters by name', async () => {
    const recorder = new PipelineRecorder(historyRoot)
    await runFakePipeline(recorder, { name: 'Alpha' })
    await runFakePipeline(recorder, { name: 'Beta' })
    await runFakePipeline(recorder, { name: 'Alpha' })

    const latest = await getLatestRun(historyRoot, 'Beta')
    expect(latest!.name).toBe('Beta')
  })

  it('getRunById finds by run_id', async () => {
    const recorder = new PipelineRecorder(historyRoot)
    await runFakePipeline(recorder, { name: 'FindMe' })

    const all = await readHistory(historyRoot)
    const id = all[0]!.run_id
    const found = await getRunById(historyRoot, id)
    expect(found).not.toBeNull()
    expect(found!.name).toBe('FindMe')

    const missing = await getRunById(historyRoot, 'nonexistent')
    expect(missing).toBeNull()
  })

  it('summarise computes correct statistics', async () => {
    const recorder = new PipelineRecorder(historyRoot)
    await runFakePipeline(recorder, { name: 'P' })
    await runFakePipeline(recorder, { name: 'P', fail: true })

    const stats = await summarise(historyRoot)
    expect(stats.total_runs).toBe(2)
    expect(stats.completed).toBe(1)
    expect(stats.failed).toBe(1)
    expect(stats.avg_duration_ms).toBe(300)
    expect(stats.avg_stages).toBe(2)
  })

  it('summarise returns zeros for empty history', async () => {
    const stats = await summarise(historyRoot)
    expect(stats.total_runs).toBe(0)
    expect(stats.avg_duration_ms).toBe(0)
  })

  it('handles malformed lines in JSONL gracefully', async () => {
    await writeFile(join(historyRoot, 'runs.jsonl'), '{"run_id":"x","name":"Good","status":"completed","stages":[],"logs_root":"/tmp","started_at":"2026-01-01T00:00:00Z"}\nnot-json\n{"run_id":"y","name":"Also good","status":"failed","stages":[],"logs_root":"/tmp","started_at":"2026-01-01T00:01:00Z"}\n')
    const runs = await readHistory(historyRoot)
    expect(runs).toHaveLength(2)
  })
})
