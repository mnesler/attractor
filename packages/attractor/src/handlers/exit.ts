import type { Handler } from './interface.js'
import type { Node, Graph } from '../types/graph.js'
import type { Context } from '../types/context.js'
import { successOutcome } from '../types/outcome.js'

export const exitHandler: Handler = {
  async execute(_node: Node, _context: Context, _graph: Graph, _logs_root: string) {
    return successOutcome()
  },
}
