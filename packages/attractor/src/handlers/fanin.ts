/**
 * FanInHandler — consolidates parallel branch results.
 */

import type { Handler } from './interface.js'
import type { Node, Graph } from '../types/graph.js'
import type { Context } from '../types/context.js'
import type { Outcome } from '../types/outcome.js'
import { successOutcome, failOutcome } from '../types/outcome.js'

interface CandidateResult {
  id: string
  outcome: string
  notes: string
  score?: number
}

export const fanInHandler: Handler = {
  async execute(node: Node, context: Context, _graph: Graph, _logs_root: string): Promise<Outcome> {
    const rawResults = context.get('parallel.results') as CandidateResult[] | undefined
    if (!rawResults || rawResults.length === 0) {
      return failOutcome('No parallel results to evaluate')
    }

    const best = heuristicSelect(rawResults)
    if (!best) {
      return failOutcome('All parallel branches failed')
    }

    return successOutcome({
      context_updates: {
        'parallel.fan_in.best_id': best.id,
        'parallel.fan_in.best_outcome': best.outcome,
      },
      notes: `Selected best candidate: ${best.id}`,
    })
  },
}

const OUTCOME_RANK: Record<string, number> = {
  success: 0,
  partial_success: 1,
  retry: 2,
  fail: 3,
}

function heuristicSelect(candidates: CandidateResult[]): CandidateResult | null {
  // Filter out failures if any successes exist
  const nonFailed = candidates.filter(c => c.outcome !== 'fail')
  const pool = nonFailed.length > 0 ? nonFailed : candidates

  if (pool.length === 0) return null

  return [...pool].sort((a, b) => {
    const rankA = OUTCOME_RANK[a.outcome] ?? 99
    const rankB = OUTCOME_RANK[b.outcome] ?? 99
    if (rankA !== rankB) return rankA - rankB
    const scoreA = a.score ?? 0
    const scoreB = b.score ?? 0
    if (scoreA !== scoreB) return scoreB - scoreA
    return a.id.localeCompare(b.id)
  })[0] ?? null
}
