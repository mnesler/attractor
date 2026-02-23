/**
 * Condition expression language evaluator.
 *
 * Grammar:
 *   ConditionExpr  ::= Clause ( '&&' Clause )*
 *   Clause         ::= Key Operator Literal
 *   Key            ::= 'outcome' | 'preferred_label' | 'context.' Path
 *   Operator       ::= '=' | '!='
 *   Literal        ::= String | Integer | Boolean
 */

import type { Outcome } from '../types/outcome.js'
import type { Context } from '../types/context.js'

export function evaluateCondition(condition: string, outcome: Outcome, context: Context): boolean {
  if (!condition || condition.trim() === '') return true

  const clauses = condition.split('&&')
  for (const rawClause of clauses) {
    const clause = rawClause.trim()
    if (!clause) continue
    if (!evaluateClause(clause, outcome, context)) return false
  }
  return true
}

function evaluateClause(clause: string, outcome: Outcome, context: Context): boolean {
  // Check for != first (longer operator)
  const neqIdx = clause.indexOf('!=')
  if (neqIdx !== -1) {
    const key = clause.slice(0, neqIdx).trim()
    const val = clause.slice(neqIdx + 2).trim()
    return resolveKey(key, outcome, context) !== stripQuotes(val)
  }

  const eqIdx = clause.indexOf('=')
  if (eqIdx !== -1) {
    const key = clause.slice(0, eqIdx).trim()
    const val = clause.slice(eqIdx + 1).trim()
    return resolveKey(key, outcome, context) === stripQuotes(val)
  }

  // Bare key: check truthy
  const resolved = resolveKey(clause.trim(), outcome, context)
  return resolved !== '' && resolved !== 'false' && resolved !== '0'
}

function resolveKey(key: string, outcome: Outcome, context: Context): string {
  if (key === 'outcome') {
    return outcome.status
  }
  if (key === 'preferred_label') {
    return outcome.preferred_label ?? ''
  }
  if (key.startsWith('context.')) {
    const contextKey = key.slice('context.'.length)
    const v = context.get(key)
    if (v !== undefined) return String(v)
    const v2 = context.get(contextKey)
    if (v2 !== undefined) return String(v2)
    return ''
  }
  // Direct context lookup for unqualified keys
  const v = context.get(key)
  if (v !== undefined) return String(v)
  return ''
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

/** Validate that a condition expression has valid syntax. Returns error message or null. */
export function validateConditionSyntax(condition: string): string | null {
  if (!condition || condition.trim() === '') return null
  const clauses = condition.split('&&')
  for (const rawClause of clauses) {
    const clause = rawClause.trim()
    if (!clause) continue
    // Must contain = or !=, or be a bare identifier-like token
    if (!clause.includes('=') && !/^[A-Za-z_.]+$/.test(clause)) {
      return `Invalid condition clause: "${clause}"`
    }
  }
  return null
}
