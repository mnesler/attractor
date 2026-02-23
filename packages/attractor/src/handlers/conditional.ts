import type { Handler } from './interface.js'
import type { Node, Graph } from '../types/graph.js'
import type { Context } from '../types/context.js'
import { successOutcome } from '../types/outcome.js'

/** ConditionalHandler — no-op. Routing is handled by the engine's edge selection. */
export const conditionalHandler: Handler = {
  async execute(node: Node, _context: Context, _graph: Graph, _logs_root: string) {
    return successOutcome({ notes: `Conditional node evaluated: ${node.id}` })
  },
}
