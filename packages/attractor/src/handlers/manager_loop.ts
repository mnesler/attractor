/**
 * ManagerLoopHandler — supervisor loop over a child pipeline.
 */

import type { Handler } from './interface.js'
import type { Node, Graph } from '../types/graph.js'
import type { Context } from '../types/context.js'
import { successOutcome, failOutcome } from '../types/outcome.js'
import { evaluateCondition } from '../conditions/eval.js'

export const managerLoopHandler: Handler = {
  async execute(node: Node, context: Context, _graph: Graph, _logs_root: string) {
    const pollIntervalMs = parseDurationMs(String(node.attrs['manager.poll_interval'] ?? '45s'))
    const maxCycles = parseInt(String(node.attrs['manager.max_cycles'] ?? '1000'), 10)
    const stopCondition = String(node.attrs['manager.stop_condition'] ?? '')
    const actions = String(node.attrs['manager.actions'] ?? 'observe,wait').split(',').map(s => s.trim())

    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      if (actions.includes('observe')) {
        // Ingest child telemetry — read from context keys set by the child
        // In a full implementation, this would monitor a child pipeline process
      }

      // Check child status
      const childStatus = context.getString('context.stack.child.status')
      if (childStatus === 'completed' || childStatus === 'failed') {
        const childOutcome = context.getString('context.stack.child.outcome')
        if (childOutcome === 'success') {
          return successOutcome({ notes: 'Child completed' })
        }
        if (childStatus === 'failed') {
          return failOutcome('Child failed')
        }
      }

      // Check custom stop condition
      if (stopCondition) {
        const dummyOutcome = { status: 'success' as const }
        if (evaluateCondition(stopCondition, dummyOutcome, context)) {
          return successOutcome({ notes: 'Stop condition satisfied' })
        }
      }

      if (actions.includes('wait')) {
        await sleep(pollIntervalMs)
      }
    }

    return failOutcome('Max cycles exceeded')
  },
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseDurationMs(s: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(s.trim())
  if (!m) return 45_000
  const n = parseInt(m[1]!, 10)
  switch (m[2]) {
    case 'ms': return n
    case 's':  return n * 1000
    case 'm':  return n * 60_000
    case 'h':  return n * 3_600_000
    case 'd':  return n * 86_400_000
    default:   return 45_000
  }
}
