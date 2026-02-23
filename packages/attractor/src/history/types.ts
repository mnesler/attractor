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
  /** LLM model used for this stage, e.g. "anthropic/claude-sonnet-4-6" */
  model: string
  /** LLM provider used for this stage, e.g. "openrouter" */
  provider: string
  /** Number of tool calls made during this stage */
  tool_calls: number
  /** Per-tool call counts, e.g. { shell: 3, read_file: 2 } */
  tool_breakdown: Record<string, number>
  /** Number of LLM round-trips (assistant responses) during this stage */
  llm_calls: number
  tokens_input: number
  tokens_output: number
  tokens_total: number
  /** Estimated cost in USD for this stage (from provider response) */
  estimated_cost_usd: number
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
  /** Default LLM model for the run */
  model: string
  /** LLM provider for the run */
  provider: string
  /** How the pipeline was invoked, e.g. "claude_code", "github_issue" */
  trigger: string
  /** Totals across all stages */
  total_tool_calls: number
  total_llm_calls: number
  total_retries: number
  tokens_input: number
  tokens_output: number
  tokens_total: number
  /** Total estimated cost in USD across all stages */
  estimated_cost_usd: number
  /** Rolled-up per-tool call counts across all stages */
  tool_breakdown: Record<string, number>
}
