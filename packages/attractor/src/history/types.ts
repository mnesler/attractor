/**
 * Data types for pipeline run history.
 */

export type RunStatus = 'completed' | 'failed' | 'in_progress'
export type StageStatus = 'success' | 'fail' | 'in_progress'

export interface StageRecord {
  /** Node ID from the DOT graph */
  node_id: string
  /** Display label (falls back to node_id) */
  name: string
  started_at: string   // ISO 8601
  completed_at?: string
  duration_ms?: number
  status: StageStatus
  /** Number of retries before this outcome (0 = first attempt succeeded) */
  retries: number
  failure_reason?: string
  /** Number of tool calls made during this stage */
  tool_calls: number
  /** Number of LLM round-trips (assistant responses) during this stage */
  llm_calls: number
  tokens_input: number
  tokens_output: number
  tokens_total: number
}

export interface PipelineRun {
  /** Unique run identifier */
  run_id: string
  /** Graph label / pipeline name */
  name: string
  /** Graph goal attribute, if set */
  goal?: string
  /** Path to the detailed logs directory for this run */
  logs_root: string
  started_at: string   // ISO 8601
  completed_at?: string
  duration_ms?: number
  status: RunStatus
  stages: StageRecord[]
  /** Totals across all stages */
  total_tool_calls: number
  total_llm_calls: number
  tokens_input: number
  tokens_output: number
  tokens_total: number
}
