/**
 * ParallelHandler — fans out to multiple branches concurrently.
 */

import type { Handler } from './interface.js'
import type { Node, Graph } from '../types/graph.js'
import type { Context } from '../types/context.js'
import type { Outcome } from '../types/outcome.js'
import { successOutcome, failOutcome } from '../types/outcome.js'
import type { PipelineEvent } from '../types/event.js'
import { makeEvent } from '../types/event.js'

type BranchExecutor = (nodeId: string, context: Context) => Promise<Outcome>

export function createParallelHandler(branchExecutor: BranchExecutor, emitEvent?: (e: PipelineEvent) => void): Handler {
  return {
    async execute(node: Node, context: Context, graph: Graph, _logs_root: string): Promise<Outcome> {
      const branches = graph.outgoing(node.id)
      const joinPolicy = (node.attrs['join_policy'] as string | undefined) ?? 'wait_all'
      const errorPolicy = (node.attrs['error_policy'] as string | undefined) ?? 'continue'
      const maxParallel = parseInt(String(node.attrs['max_parallel'] ?? '4'), 10)

      emitEvent?.(makeEvent('parallel_started', { branch_count: branches.length }))

      const results: Array<{ branchId: string; outcome: Outcome }> = []

      // Execute in batches of maxParallel
      for (let i = 0; i < branches.length; i += maxParallel) {
        const batch = branches.slice(i, i + maxParallel)
        const batchPromises = batch.map(async (edge, idx) => {
          const branchIdx = i + idx
          emitEvent?.(makeEvent('parallel_branch_started', { branch: edge.to, index: branchIdx }))
          const branchContext = context.clone()
          const start = Date.now()
          const outcome = await branchExecutor(edge.to, branchContext)
          const duration = Date.now() - start
          emitEvent?.(makeEvent('parallel_branch_completed', { branch: edge.to, index: branchIdx, duration, success: outcome.status === 'success' }))
          return { branchId: edge.to, outcome }
        })

        if (errorPolicy === 'fail_fast') {
          // Race: first failure cancels remaining
          const settled = await Promise.allSettled(batchPromises)
          for (const r of settled) {
            if (r.status === 'fulfilled') {
              results.push(r.value)
              if (r.value.outcome.status === 'fail') break
            } else {
              results.push({ branchId: 'unknown', outcome: failOutcome(r.reason as string) })
              break
            }
          }
        } else {
          const settled = await Promise.allSettled(batchPromises)
          for (const r of settled) {
            if (r.status === 'fulfilled') {
              results.push(r.value)
            } else {
              results.push({ branchId: 'unknown', outcome: failOutcome(r.reason as string) })
            }
          }
        }
      }

      const successCount = results.filter(r => r.outcome.status === 'success').length
      const failCount = results.filter(r => r.outcome.status === 'fail').length
      const duration = 0

      emitEvent?.(makeEvent('parallel_completed', { duration, success_count: successCount, failure_count: failCount }))

      // Store results in context for fan-in
      context.set('parallel.results', results.map(r => ({ id: r.branchId, outcome: r.outcome.status, notes: r.outcome.notes ?? '' })))

      // Evaluate join policy
      if (joinPolicy === 'wait_all') {
        return failCount === 0
          ? successOutcome({ notes: `All ${successCount} branches succeeded` })
          : successOutcome({ status: 'partial_success' as Outcome['status'], notes: `${failCount} of ${results.length} branches failed` } as Partial<Outcome>)
      }

      if (joinPolicy === 'first_success') {
        return successCount > 0
          ? successOutcome()
          : failOutcome(`All ${results.length} branches failed`)
      }

      if (joinPolicy === 'k_of_n') {
        const k = parseInt(String(node.attrs['k_of_n'] ?? '1'), 10)
        return successCount >= k
          ? successOutcome()
          : failOutcome(`Only ${successCount} of ${results.length} branches succeeded, need ${k}`)
      }

      if (joinPolicy === 'quorum') {
        const quorum = parseFloat(String(node.attrs['quorum'] ?? '0.5'))
        const fraction = successCount / results.length
        return fraction >= quorum
          ? successOutcome()
          : failOutcome(`Only ${Math.round(fraction * 100)}% branches succeeded, need ${Math.round(quorum * 100)}%`)
      }

      return successOutcome()
    },
  }
}
