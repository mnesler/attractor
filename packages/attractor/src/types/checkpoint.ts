/**
 * Checkpoint — serializable snapshot of execution state.
 */

import type { Context } from './context.js'

export interface CheckpointData {
  timestamp: string
  current_node: string
  completed_nodes: string[]
  node_retries: Record<string, number>
  context: Record<string, unknown>
  logs: string[]
}

export class Checkpoint {
  timestamp: Date
  current_node: string
  completed_nodes: string[]
  node_retries: Map<string, number>
  context_values: Record<string, unknown>
  logs: string[]

  constructor(
    current_node = '',
    completed_nodes: string[] = [],
    node_retries: Map<string, number> = new Map(),
    context_values: Record<string, unknown> = {},
    logs: string[] = [],
  ) {
    this.timestamp = new Date()
    this.current_node = current_node
    this.completed_nodes = [...completed_nodes]
    this.node_retries = new Map(node_retries)
    this.context_values = { ...context_values }
    this.logs = [...logs]
  }

  toJSON(): CheckpointData {
    return {
      timestamp: this.timestamp.toISOString(),
      current_node: this.current_node,
      completed_nodes: this.completed_nodes,
      node_retries: Object.fromEntries(this.node_retries),
      context: this.context_values,
      logs: this.logs,
    }
  }

  static fromJSON(data: CheckpointData): Checkpoint {
    const cp = new Checkpoint()
    cp.timestamp = new Date(data.timestamp)
    cp.current_node = data.current_node
    cp.completed_nodes = data.completed_nodes
    cp.node_retries = new Map(Object.entries(data.node_retries))
    cp.context_values = data.context
    cp.logs = data.logs
    return cp
  }

  static fromContext(current_node: string, completed_nodes: string[], context: Context, node_retries: Map<string, number>): Checkpoint {
    return new Checkpoint(current_node, completed_nodes, node_retries, context.snapshot(), [...context.logs])
  }
}
