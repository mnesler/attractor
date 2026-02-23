/**
 * History reader — load and query PipelineRun records from a JSONL history file.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PipelineRun, RunStatus } from './types.js'
import { HISTORY_FILE } from './recorder.js'

/** Load all runs from {historyRoot}/runs.jsonl (oldest first). */
export async function readHistory(historyRoot: string): Promise<PipelineRun[]> {
  let text: string
  try {
    text = await readFile(join(historyRoot, HISTORY_FILE), 'utf8')
  } catch {
    return []
  }
  const runs: PipelineRun[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      runs.push(JSON.parse(trimmed) as PipelineRun)
    } catch {
      // skip malformed lines
    }
  }
  return runs
}

export interface HistoryFilter {
  /** Filter by pipeline name (exact match). */
  name?: string
  /** Filter by run status. */
  status?: RunStatus
  /** Only include runs started at or after this ISO timestamp. */
  since?: string
  /** Max number of runs to return (from the end of the file — most recent first). */
  limit?: number
}

/** Query the history with optional filters. Results are newest-first. */
export async function findRuns(historyRoot: string, filter: HistoryFilter = {}): Promise<PipelineRun[]> {
  let runs = await readHistory(historyRoot)

  if (filter.name !== undefined) {
    runs = runs.filter(r => r.name === filter.name)
  }
  if (filter.status !== undefined) {
    runs = runs.filter(r => r.status === filter.status)
  }
  if (filter.since !== undefined) {
    const since = new Date(filter.since).getTime()
    runs = runs.filter(r => new Date(r.started_at).getTime() >= since)
  }

  // Reverse to newest-first
  runs = runs.reverse()

  if (filter.limit !== undefined) {
    runs = runs.slice(0, filter.limit)
  }

  return runs
}

/** Return the most recent run, optionally filtered by pipeline name. */
export async function getLatestRun(historyRoot: string, name?: string): Promise<PipelineRun | null> {
  const runs = await findRuns(historyRoot, { name, limit: 1 })
  return runs[0] ?? null
}

/** Return a run by its run_id. */
export async function getRunById(historyRoot: string, runId: string): Promise<PipelineRun | null> {
  const runs = await readHistory(historyRoot)
  return runs.find(r => r.run_id === runId) ?? null
}

/**
 * Summarise timing statistics for a set of runs.
 * Useful for quick analysis across many runs of the same pipeline.
 */
export interface HistorySummary {
  total_runs: number
  completed: number
  failed: number
  avg_duration_ms: number
  min_duration_ms: number
  max_duration_ms: number
  avg_stages: number
}

export async function summarise(historyRoot: string, filter: HistoryFilter = {}): Promise<HistorySummary> {
  const runs = await findRuns(historyRoot, { ...filter, limit: undefined })
  if (runs.length === 0) {
    return { total_runs: 0, completed: 0, failed: 0, avg_duration_ms: 0, min_duration_ms: 0, max_duration_ms: 0, avg_stages: 0 }
  }
  const durations = runs.map(r => r.duration_ms ?? 0)
  return {
    total_runs: runs.length,
    completed: runs.filter(r => r.status === 'completed').length,
    failed: runs.filter(r => r.status === 'failed').length,
    avg_duration_ms: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    min_duration_ms: Math.min(...durations),
    max_duration_ms: Math.max(...durations),
    avg_stages: Math.round(runs.reduce((a, r) => a + r.stages.length, 0) / runs.length),
  }
}
