/**
 * Validation and linting for pipeline graphs.
 */

import type { Graph } from '../types/graph.js'
import { SHAPE_TO_HANDLER_TYPE } from '../types/graph.js'
import { validateConditionSyntax } from '../conditions/eval.js'
import { parseStylesheet } from '../stylesheet/parser.js'

export type Severity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  rule: string
  severity: Severity
  message: string
  node_id?: string
  edge?: [string, string]
  fix?: string
}

export interface LintRule {
  name: string
  apply(graph: Graph): Diagnostic[]
}

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

const startNodeRule: LintRule = {
  name: 'start_node',
  apply(g) {
    const starts = [...g.nodes.values()].filter(
      n => n.attrs.shape === 'Mdiamond' || n.id === 'start' || n.id === 'Start',
    )
    if (starts.length === 0) {
      return [{ rule: 'start_node', severity: 'error', message: 'Pipeline must have exactly one start node (shape=Mdiamond)', fix: 'Add a node with shape=Mdiamond' }]
    }
    if (starts.length > 1) {
      return [{ rule: 'start_node', severity: 'error', message: `Pipeline has ${starts.length} start nodes; exactly one required`, fix: 'Remove extra start nodes' }]
    }
    return []
  },
}

const terminalNodeRule: LintRule = {
  name: 'terminal_node',
  apply(g) {
    const exits = [...g.nodes.values()].filter(
      n => n.attrs.shape === 'Msquare' || n.id === 'exit' || n.id === 'end',
    )
    if (exits.length === 0) {
      return [{ rule: 'terminal_node', severity: 'error', message: 'Pipeline must have at least one terminal node (shape=Msquare)', fix: 'Add a node with shape=Msquare' }]
    }
    return []
  },
}

const reachabilityRule: LintRule = {
  name: 'reachability',
  apply(g) {
    const start = findStartNode(g)
    if (!start) return []  // covered by start_node rule

    const visited = new Set<string>()
    const queue = [start.id]
    while (queue.length > 0) {
      const id = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      for (const edge of g.outgoing(id)) {
        if (!visited.has(edge.to)) queue.push(edge.to)
      }
    }

    const diags: Diagnostic[] = []
    for (const id of g.nodes.keys()) {
      if (!visited.has(id)) {
        diags.push({ rule: 'reachability', severity: 'error', message: `Node '${id}' is not reachable from the start node`, node_id: id, fix: 'Add a path from start to this node or remove it' })
      }
    }
    return diags
  },
}

const edgeTargetExistsRule: LintRule = {
  name: 'edge_target_exists',
  apply(g) {
    const diags: Diagnostic[] = []
    for (const edge of g.edges) {
      if (!g.nodes.has(edge.from)) {
        diags.push({ rule: 'edge_target_exists', severity: 'error', message: `Edge source '${edge.from}' does not exist`, edge: [edge.from, edge.to] })
      }
      if (!g.nodes.has(edge.to)) {
        diags.push({ rule: 'edge_target_exists', severity: 'error', message: `Edge target '${edge.to}' does not exist`, edge: [edge.from, edge.to] })
      }
    }
    return diags
  },
}

const startNoIncomingRule: LintRule = {
  name: 'start_no_incoming',
  apply(g) {
    const start = findStartNode(g)
    if (!start) return []
    const incoming = g.incoming(start.id)
    if (incoming.length > 0) {
      return [{ rule: 'start_no_incoming', severity: 'error', message: `Start node '${start.id}' must have no incoming edges`, node_id: start.id, fix: 'Remove incoming edges to the start node' }]
    }
    return []
  },
}

const exitNoOutgoingRule: LintRule = {
  name: 'exit_no_outgoing',
  apply(g) {
    const exits = [...g.nodes.values()].filter(
      n => n.attrs.shape === 'Msquare' || n.id === 'exit' || n.id === 'end',
    )
    const diags: Diagnostic[] = []
    for (const exit of exits) {
      if (g.outgoing(exit.id).length > 0) {
        diags.push({ rule: 'exit_no_outgoing', severity: 'error', message: `Exit node '${exit.id}' must have no outgoing edges`, node_id: exit.id, fix: 'Remove outgoing edges from the exit node' })
      }
    }
    return diags
  },
}

const conditionSyntaxRule: LintRule = {
  name: 'condition_syntax',
  apply(g) {
    const diags: Diagnostic[] = []
    for (const edge of g.edges) {
      if (edge.attrs.condition) {
        const err = validateConditionSyntax(edge.attrs.condition)
        if (err) {
          diags.push({ rule: 'condition_syntax', severity: 'error', message: `Invalid condition on edge ${edge.from}->${edge.to}: ${err}`, edge: [edge.from, edge.to], fix: 'Fix the condition expression syntax' })
        }
      }
    }
    return diags
  },
}

const stylesheetSyntaxRule: LintRule = {
  name: 'stylesheet_syntax',
  apply(g) {
    if (!g.model_stylesheet) return []
    try {
      parseStylesheet(g.model_stylesheet)
      return []
    } catch (e) {
      return [{ rule: 'stylesheet_syntax', severity: 'error', message: `Invalid model_stylesheet: ${String(e)}`, fix: 'Fix the stylesheet syntax' }]
    }
  },
}

const typeKnownRule: LintRule = {
  name: 'type_known',
  apply(g) {
    const knownTypes = new Set(Object.values(SHAPE_TO_HANDLER_TYPE))
    const diags: Diagnostic[] = []
    for (const node of g.nodes.values()) {
      if (node.attrs.type && !knownTypes.has(node.attrs.type)) {
        diags.push({ rule: 'type_known', severity: 'warning', message: `Node '${node.id}' has unknown type '${node.attrs.type}'`, node_id: node.id, fix: `Use one of: ${[...knownTypes].join(', ')}` })
      }
    }
    return diags
  },
}

const fidelityValidRule: LintRule = {
  name: 'fidelity_valid',
  apply(g) {
    const valid = new Set(['full', 'truncate', 'compact', 'summary:low', 'summary:medium', 'summary:high'])
    const diags: Diagnostic[] = []
    for (const node of g.nodes.values()) {
      if (node.attrs.fidelity && !valid.has(node.attrs.fidelity)) {
        diags.push({ rule: 'fidelity_valid', severity: 'warning', message: `Node '${node.id}' has invalid fidelity '${node.attrs.fidelity}'`, node_id: node.id })
      }
    }
    for (const edge of g.edges) {
      if (edge.attrs.fidelity && !valid.has(edge.attrs.fidelity)) {
        diags.push({ rule: 'fidelity_valid', severity: 'warning', message: `Edge ${edge.from}->${edge.to} has invalid fidelity '${edge.attrs.fidelity}'`, edge: [edge.from, edge.to] })
      }
    }
    return diags
  },
}

const retryTargetExistsRule: LintRule = {
  name: 'retry_target_exists',
  apply(g) {
    const diags: Diagnostic[] = []
    for (const node of g.nodes.values()) {
      if (node.attrs.retry_target && !g.nodes.has(node.attrs.retry_target)) {
        diags.push({ rule: 'retry_target_exists', severity: 'warning', message: `Node '${node.id}' retry_target '${node.attrs.retry_target}' does not exist`, node_id: node.id })
      }
      if (node.attrs.fallback_retry_target && !g.nodes.has(node.attrs.fallback_retry_target)) {
        diags.push({ rule: 'retry_target_exists', severity: 'warning', message: `Node '${node.id}' fallback_retry_target '${node.attrs.fallback_retry_target}' does not exist`, node_id: node.id })
      }
    }
    return diags
  },
}

const goalGateHasRetryRule: LintRule = {
  name: 'goal_gate_has_retry',
  apply(g) {
    const diags: Diagnostic[] = []
    for (const node of g.nodes.values()) {
      if (node.attrs.goal_gate && !node.attrs.retry_target && !node.attrs.fallback_retry_target && !g.retry_target && !g.fallback_retry_target) {
        diags.push({ rule: 'goal_gate_has_retry', severity: 'warning', message: `Node '${node.id}' has goal_gate=true but no retry_target configured`, node_id: node.id, fix: 'Add a retry_target attribute to this node or the graph' })
      }
    }
    return diags
  },
}

const promptOnLlmNodesRule: LintRule = {
  name: 'prompt_on_llm_nodes',
  apply(g) {
    const diags: Diagnostic[] = []
    for (const node of g.nodes.values()) {
      const shape = node.attrs.shape ?? 'box'
      const handlerType = node.attrs.type ?? SHAPE_TO_HANDLER_TYPE[shape] ?? 'codergen'
      if (handlerType === 'codergen') {
        if (!node.attrs.prompt && !node.attrs.label) {
          diags.push({ rule: 'prompt_on_llm_nodes', severity: 'warning', message: `LLM node '${node.id}' has no prompt or label`, node_id: node.id, fix: 'Add a prompt or label attribute' })
        }
      }
    }
    return diags
  },
}

export const BUILT_IN_RULES: LintRule[] = [
  startNodeRule,
  terminalNodeRule,
  reachabilityRule,
  edgeTargetExistsRule,
  startNoIncomingRule,
  exitNoOutgoingRule,
  conditionSyntaxRule,
  stylesheetSyntaxRule,
  typeKnownRule,
  fidelityValidRule,
  retryTargetExistsRule,
  goalGateHasRetryRule,
  promptOnLlmNodesRule,
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validate(graph: Graph, extraRules: LintRule[] = []): Diagnostic[] {
  const rules = [...BUILT_IN_RULES, ...extraRules]
  const diags: Diagnostic[] = []
  for (const rule of rules) {
    diags.push(...rule.apply(graph))
  }
  return diags
}

export class ValidationError extends Error {
  diagnostics: Diagnostic[]
  constructor(diagnostics: Diagnostic[]) {
    const msgs = diagnostics.filter(d => d.severity === 'error').map(d => d.message)
    super(`Pipeline validation failed:\n  ${msgs.join('\n  ')}`)
    this.name = 'ValidationError'
    this.diagnostics = diagnostics
  }
}

export function validateOrRaise(graph: Graph, extraRules: LintRule[] = []): Diagnostic[] {
  const diags = validate(graph, extraRules)
  const errors = diags.filter(d => d.severity === 'error')
  if (errors.length > 0) {
    throw new ValidationError(errors)
  }
  return diags
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function findStartNode(g: Graph) {
  for (const node of g.nodes.values()) {
    if (node.attrs.shape === 'Mdiamond') return node
  }
  for (const node of g.nodes.values()) {
    if (node.id === 'start' || node.id === 'Start') return node
  }
  return null
}

export function findExitNodes(g: Graph) {
  return [...g.nodes.values()].filter(
    n => n.attrs.shape === 'Msquare' || n.id === 'exit' || n.id === 'end',
  )
}
