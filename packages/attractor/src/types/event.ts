/**
 * Pipeline execution events emitted during a run.
 */

export type PipelineEventKind =
  | 'pipeline_started'
  | 'pipeline_completed'
  | 'pipeline_failed'
  | 'stage_started'
  | 'stage_completed'
  | 'stage_failed'
  | 'stage_retrying'
  | 'parallel_started'
  | 'parallel_branch_started'
  | 'parallel_branch_completed'
  | 'parallel_completed'
  | 'interview_started'
  | 'interview_completed'
  | 'interview_timeout'
  | 'checkpoint_saved'

export interface PipelineEvent {
  kind: PipelineEventKind
  timestamp: Date
  data: Record<string, unknown>
}

export function makeEvent(kind: PipelineEventKind, data: Record<string, unknown> = {}): PipelineEvent {
  return { kind, timestamp: new Date(), data }
}
