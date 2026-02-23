/**
 * CodergenHandler — LLM task handler.
 *
 * Calls a CodergenBackend, writes prompt/response to logs, returns an Outcome.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Handler } from './interface.js'
import type { Node, Graph } from '../types/graph.js'
import type { Outcome } from '../types/outcome.js'
import type { Context } from '../types/context.js'
import { successOutcome, failOutcome } from '../types/outcome.js'

export interface CodergenBackend {
  run(node: Node, prompt: string, context: Context, logs_root: string): Promise<string | Outcome>
}

export function createCodergenHandler(backend: CodergenBackend | null = null): Handler {
  return {
    async execute(node: Node, context: Context, graph: Graph, logs_root: string): Promise<Outcome> {
      // 1. Build prompt
      let prompt = node.attrs.prompt as string | undefined ?? ''
      if (!prompt) prompt = node.attrs.label ?? node.id
      // $goal expansion is handled by the VariableExpansionTransform, but handle it here too as fallback
      if (prompt.includes('$goal')) {
        prompt = prompt.replaceAll('$goal', graph.goal)
      }

      // 2. Ensure stage dir exists; backend will write its own prompt.md with full content
      const stageDir = join(logs_root, node.id)
      try {
        await mkdir(stageDir, { recursive: true })
      } catch {
        // Non-fatal
      }

      // 3. Call LLM backend
      let responseText: string
      if (backend !== null) {
        try {
          const result = await backend.run(node, prompt, context, logs_root)
          if (typeof result === 'object' && result !== null && 'status' in result) {
            // Result is an Outcome
            const outcome = result as Outcome
            await writeStatus(stageDir, outcome)
            return outcome
          }
          responseText = String(result)
        } catch (e) {
          return failOutcome(String(e))
        }
      } else {
        responseText = `[Simulated] Response for stage: ${node.id}`
      }

      // 4. Write response to logs
      try {
        await writeFile(join(stageDir, 'response.md'), responseText, 'utf8')
      } catch {
        // Non-fatal
      }

      // 5. Return outcome
      const outcome = successOutcome({
        notes: `Stage completed: ${node.id}`,
        context_updates: {
          last_stage: node.id,
          last_response: responseText.slice(0, 200),
        },
      })
      await writeStatus(stageDir, outcome)
      return outcome
    },
  }
}

async function writeStatus(stageDir: string, outcome: Outcome): Promise<void> {
  try {
    await mkdir(stageDir, { recursive: true })
    await writeFile(join(stageDir, 'status.json'), JSON.stringify(outcome, null, 2), 'utf8')
  } catch {
    // Non-fatal
  }
}
