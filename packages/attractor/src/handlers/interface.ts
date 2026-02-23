/**
 * Handler interface — the contract every node handler must fulfill.
 */

import type { Node, Graph } from '../types/graph.js'
import type { Outcome } from '../types/outcome.js'
import type { Context } from '../types/context.js'

export interface Handler {
  execute(node: Node, context: Context, graph: Graph, logs_root: string): Promise<Outcome>
}
