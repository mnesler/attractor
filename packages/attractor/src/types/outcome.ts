/**
 * Outcome — the result of executing a node handler.
 */

export type StageStatus = 'success' | 'fail' | 'partial_success' | 'retry' | 'skipped'

export interface Outcome {
  status: StageStatus
  preferred_label?: string
  suggested_next_ids?: string[]
  context_updates?: Record<string, unknown>
  notes?: string
  failure_reason?: string
}

export function successOutcome(opts?: Partial<Outcome>): Outcome {
  return { status: 'success', ...opts }
}

export function failOutcome(failure_reason: string, opts?: Partial<Outcome>): Outcome {
  return { status: 'fail', failure_reason, ...opts }
}

export function retryOutcome(failure_reason: string, opts?: Partial<Outcome>): Outcome {
  return { status: 'retry', failure_reason, ...opts }
}
