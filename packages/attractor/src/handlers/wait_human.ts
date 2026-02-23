/**
 * WaitForHumanHandler — blocks until a human selects an option.
 */

import type { Handler } from './interface.js'
import type { Node, Graph } from '../types/graph.js'
import type { Context } from '../types/context.js'
import type { Outcome } from '../types/outcome.js'
import { successOutcome, failOutcome, retryOutcome } from '../types/outcome.js'
import type { Interviewer, Question } from '../interviewer/index.js'
import { parseAcceleratorKey } from '../interviewer/index.js'

export function createWaitHumanHandler(interviewer: Interviewer): Handler {
  return {
    async execute(node: Node, _context: Context, graph: Graph, _logs_root: string): Promise<Outcome> {
      const edges = graph.outgoing(node.id)

      // Build choices from outgoing edge labels
      const choices: Array<{ key: string; label: string; to: string }> = []
      for (const edge of edges) {
        const label = edge.attrs.label ?? edge.to
        const key = parseAcceleratorKey(label)
        choices.push({ key, label, to: edge.to })
      }

      if (choices.length === 0) {
        return failOutcome('No outgoing edges for human gate')
      }

      // Build question
      const question: Question = {
        text: node.attrs.label ?? 'Select an option:',
        type: 'multiple_choice',
        options: choices.map(c => ({ key: c.key, label: c.label })),
        stage: node.id,
      }

      // Present to interviewer
      const answer = await interviewer.ask(question)

      // Handle timeout/skip
      if (answer.value === 'timeout') {
        const defaultChoice = node.attrs['human.default_choice'] as string | undefined
        if (defaultChoice) {
          const found = choices.find(c => c.to === defaultChoice || c.key === defaultChoice || c.label === defaultChoice)
          if (found) {
            return successOutcome({
              suggested_next_ids: [found.to],
              context_updates: { 'human.gate.selected': found.key, 'human.gate.label': found.label },
            })
          }
        }
        return retryOutcome('human gate timeout, no default')
      }

      if (answer.value === 'skipped') {
        return failOutcome('human skipped interaction')
      }

      // Find matching choice
      const selected = findMatchingChoice(answer.value as string, choices) ?? choices[0]!

      return successOutcome({
        suggested_next_ids: [selected.to],
        context_updates: {
          'human.gate.selected': selected.key,
          'human.gate.label': selected.label,
        },
      })
    },
  }
}

function findMatchingChoice(response: string, choices: Array<{ key: string; label: string; to: string }>) {
  const r = response.trim().toLowerCase()
  return choices.find(c =>
    c.key.toLowerCase() === r ||
    c.label.toLowerCase() === r ||
    c.to.toLowerCase() === r,
  )
}
