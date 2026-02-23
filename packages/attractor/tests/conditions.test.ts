import { describe, it, expect } from 'vitest'
import { evaluateCondition, validateConditionSyntax } from '../src/conditions/eval.js'
import { Context } from '../src/types/context.js'
import type { Outcome } from '../src/types/outcome.js'

function makeOutcome(status: Outcome['status'], preferred_label?: string): Outcome {
  return { status, preferred_label }
}

function makeContext(entries: Record<string, unknown> = {}): Context {
  const c = new Context()
  for (const [k, v] of Object.entries(entries)) c.set(k, v)
  return c
}

describe('evaluateCondition', () => {
  it('empty condition always returns true', () => {
    expect(evaluateCondition('', makeOutcome('success'), makeContext())).toBe(true)
    expect(evaluateCondition('   ', makeOutcome('fail'), makeContext())).toBe(true)
  })

  it('outcome= equals operator', () => {
    expect(evaluateCondition('outcome=success', makeOutcome('success'), makeContext())).toBe(true)
    expect(evaluateCondition('outcome=success', makeOutcome('fail'), makeContext())).toBe(false)
    expect(evaluateCondition('outcome=fail', makeOutcome('fail'), makeContext())).toBe(true)
  })

  it('outcome!= not-equals operator', () => {
    expect(evaluateCondition('outcome!=success', makeOutcome('fail'), makeContext())).toBe(true)
    expect(evaluateCondition('outcome!=success', makeOutcome('success'), makeContext())).toBe(false)
  })

  it('preferred_label comparison', () => {
    const outcome = makeOutcome('success', 'Fix')
    expect(evaluateCondition('preferred_label=Fix', outcome, makeContext())).toBe(true)
    expect(evaluateCondition('preferred_label=Deploy', outcome, makeContext())).toBe(false)
  })

  it('context.* key lookup', () => {
    const ctx = makeContext({ 'tests_passed': 'true', 'loop_state': 'active' })
    expect(evaluateCondition('context.tests_passed=true', makeOutcome('success'), ctx)).toBe(true)
    expect(evaluateCondition('context.loop_state!=exhausted', makeOutcome('success'), ctx)).toBe(true)
    expect(evaluateCondition('context.loop_state=exhausted', makeOutcome('success'), ctx)).toBe(false)
  })

  it('missing context key compares as empty string', () => {
    const ctx = makeContext({})
    expect(evaluateCondition('context.missing_key=something', makeOutcome('success'), ctx)).toBe(false)
    expect(evaluateCondition('context.missing_key!=something', makeOutcome('success'), ctx)).toBe(true)
  })

  it('AND conjunction — all clauses must be true', () => {
    const ctx = makeContext({ 'tests_passed': 'true' })
    expect(evaluateCondition('outcome=success && context.tests_passed=true', makeOutcome('success'), ctx)).toBe(true)
    expect(evaluateCondition('outcome=success && context.tests_passed=false', makeOutcome('success'), ctx)).toBe(false)
    expect(evaluateCondition('outcome=fail && context.tests_passed=true', makeOutcome('success'), ctx)).toBe(false)
  })

  it('direct context key lookup (without context. prefix)', () => {
    const ctx = makeContext({ 'my_key': 'hello' })
    expect(evaluateCondition('my_key=hello', makeOutcome('success'), ctx)).toBe(true)
  })
})

describe('validateConditionSyntax', () => {
  it('returns null for valid conditions', () => {
    expect(validateConditionSyntax('outcome=success')).toBeNull()
    expect(validateConditionSyntax('outcome!=fail')).toBeNull()
    expect(validateConditionSyntax('outcome=success && context.done=true')).toBeNull()
    expect(validateConditionSyntax('')).toBeNull()
  })
})
