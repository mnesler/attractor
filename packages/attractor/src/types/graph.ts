/**
 * Core graph model types — the in-memory representation of a parsed DOT pipeline.
 */

export interface NodeAttrs {
  label?: string
  shape?: string
  type?: string
  prompt?: string
  max_retries?: number
  goal_gate?: boolean
  retry_target?: string
  fallback_retry_target?: string
  fidelity?: string
  thread_id?: string
  class?: string
  timeout?: number   // milliseconds, parsed from Duration syntax
  llm_model?: string
  llm_provider?: string
  reasoning_effort?: string
  auto_status?: boolean
  allow_partial?: boolean
  // Dynamic extra attributes (e.g. tool_command, manager.* etc.)
  [key: string]: unknown
}

export interface EdgeAttrs {
  label?: string
  condition?: string
  weight?: number
  fidelity?: string
  thread_id?: string
  loop_restart?: boolean
}

export interface Node {
  id: string
  attrs: NodeAttrs
}

export interface Edge {
  from: string
  to: string
  attrs: EdgeAttrs
}

export interface Graph {
  id: string
  // Graph-level attributes
  goal: string
  label: string
  model_stylesheet: string
  default_max_retry: number
  retry_target: string
  fallback_retry_target: string
  default_fidelity: string

  nodes: Map<string, Node>
  edges: Edge[]

  // Convenience: outgoing edges index
  outgoing(nodeId: string): Edge[]
  // Convenience: incoming edges index
  incoming(nodeId: string): Edge[]
}

export function createGraph(id: string): Graph {
  const _outgoing = new Map<string, Edge[]>()
  const _incoming = new Map<string, Edge[]>()

  const g: Graph = {
    id,
    goal: '',
    label: '',
    model_stylesheet: '',
    default_max_retry: 0,
    retry_target: '',
    fallback_retry_target: '',
    default_fidelity: '',
    nodes: new Map(),
    edges: [],
    outgoing(nodeId: string): Edge[] {
      return _outgoing.get(nodeId) ?? []
    },
    incoming(nodeId: string): Edge[] {
      return _incoming.get(nodeId) ?? []
    },
  }

  // Proxy the edges array so index is kept in sync
  // Instead, expose addEdge() on the raw object via a helper
  ;(g as unknown as Record<string, unknown>)['_addEdge'] = (edge: Edge) => {
    g.edges.push(edge)
    if (!_outgoing.has(edge.from)) _outgoing.set(edge.from, [])
    _outgoing.get(edge.from)!.push(edge)
    if (!_incoming.has(edge.to)) _incoming.set(edge.to, [])
    _incoming.get(edge.to)!.push(edge)
  }

  return g
}

export function addEdge(g: Graph, edge: Edge): void {
  ;(g as unknown as Record<string, unknown>)['_addEdge'](edge)
}

/** Parse a Duration string like "900s", "15m", "2h", "250ms", "1d" → milliseconds */
export function parseDuration(s: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(s.trim())
  if (!m) return 0
  const n = parseInt(m[1]!, 10)
  switch (m[2]) {
    case 'ms': return n
    case 's':  return n * 1000
    case 'm':  return n * 60 * 1000
    case 'h':  return n * 3600 * 1000
    case 'd':  return n * 86400 * 1000
    default:   return 0
  }
}

/** Shape → handler type mapping */
export const SHAPE_TO_HANDLER_TYPE: Record<string, string> = {
  Mdiamond:      'start',
  Msquare:       'exit',
  box:           'codergen',
  hexagon:       'wait.human',
  diamond:       'conditional',
  component:     'parallel',
  tripleoctagon: 'parallel.fan_in',
  parallelogram: 'tool',
  house:         'stack.manager_loop',
}
