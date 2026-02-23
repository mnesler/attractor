/**
 * AST Transforms — applied after parsing, before validation.
 */

import type { Graph } from '../types/graph.js'
import { parseStylesheet, applyStylesheetToNode } from '../stylesheet/parser.js'

export interface Transform {
  apply(graph: Graph): Graph
}

/**
 * VariableExpansionTransform — replaces $goal in node prompt attributes.
 */
export const variableExpansionTransform: Transform = {
  apply(graph: Graph): Graph {
    for (const node of graph.nodes.values()) {
      if (node.attrs.prompt && node.attrs.prompt.includes('$goal')) {
        node.attrs.prompt = node.attrs.prompt.replaceAll('$goal', graph.goal)
      }
    }
    return graph
  },
}

/**
 * StylesheetApplicationTransform — applies model_stylesheet to nodes.
 */
export const stylesheetApplicationTransform: Transform = {
  apply(graph: Graph): Graph {
    if (!graph.model_stylesheet) return graph
    const stylesheet = parseStylesheet(graph.model_stylesheet)
    for (const node of graph.nodes.values()) {
      applyStylesheetToNode(node.id, node.attrs.class, node.attrs as Record<string, unknown>, stylesheet)
    }
    return graph
  },
}

/** Apply built-in transforms in order, then custom transforms. */
export function applyTransforms(graph: Graph, customTransforms: Transform[] = []): Graph {
  const transforms: Transform[] = [
    variableExpansionTransform,
    stylesheetApplicationTransform,
    ...customTransforms,
  ]
  let g = graph
  for (const t of transforms) {
    g = t.apply(g)
  }
  return g
}
