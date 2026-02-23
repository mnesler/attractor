import { describe, it, expect } from 'vitest'
import { parseStylesheet, applyStylesheetToNode } from '../src/stylesheet/parser.js'
import { parseDot } from '../src/parser/dot.js'
import { applyTransforms } from '../src/transforms/index.js'

describe('parseStylesheet', () => {
  it('parses universal selector', () => {
    const rules = parseStylesheet('* { llm_model: claude-sonnet-4-5; llm_provider: anthropic; }')
    expect(rules).toHaveLength(1)
    expect(rules[0]!.selector.kind).toBe('universal')
    expect(rules[0]!.declarations).toHaveLength(2)
    expect(rules[0]!.declarations[0]!.property).toBe('llm_model')
    expect(rules[0]!.declarations[0]!.value).toBe('claude-sonnet-4-5')
  })

  it('parses class selector', () => {
    const rules = parseStylesheet('.code { llm_model: claude-opus-4-6; }')
    expect(rules[0]!.selector.kind).toBe('class')
    expect(rules[0]!.selector.value).toBe('code')
    expect(rules[0]!.selector.specificity).toBe(1)
  })

  it('parses ID selector', () => {
    const rules = parseStylesheet('#critical_review { reasoning_effort: high; }')
    expect(rules[0]!.selector.kind).toBe('id')
    expect(rules[0]!.selector.value).toBe('critical_review')
    expect(rules[0]!.selector.specificity).toBe(2)
  })

  it('parses multiple rules', () => {
    const css = `
      * { llm_model: claude-sonnet-4-5; }
      .code { llm_model: claude-opus-4-6; }
      #review { reasoning_effort: high; }
    `
    const rules = parseStylesheet(css)
    expect(rules).toHaveLength(3)
  })

  it('returns empty array for empty input', () => {
    expect(parseStylesheet('')).toHaveLength(0)
    expect(parseStylesheet('   ')).toHaveLength(0)
  })
})

describe('applyStylesheetToNode', () => {
  it('applies universal rule', () => {
    const rules = parseStylesheet('* { llm_model: claude-sonnet-4-5; }')
    const attrs: Record<string, unknown> = {}
    applyStylesheetToNode('some_node', undefined, attrs, rules)
    expect(attrs['llm_model']).toBe('claude-sonnet-4-5')
  })

  it('class rule overrides universal rule (higher specificity)', () => {
    const rules = parseStylesheet(`
      * { llm_model: claude-sonnet-4-5; }
      .code { llm_model: claude-opus-4-6; }
    `)
    const attrs: Record<string, unknown> = {}
    applyStylesheetToNode('impl', 'code', attrs, rules)
    // Class rule should win over universal
    expect(attrs['llm_model']).toBe('claude-opus-4-6')
  })

  it('ID rule overrides class and universal rules', () => {
    const rules = parseStylesheet(`
      * { llm_model: claude-sonnet-4-5; }
      .code { llm_model: claude-opus-4-6; }
      #critical_review { llm_model: gpt-5; reasoning_effort: high; }
    `)
    const attrs: Record<string, unknown> = {}
    applyStylesheetToNode('critical_review', 'code', attrs, rules)
    expect(attrs['llm_model']).toBe('gpt-5')
    expect(attrs['reasoning_effort']).toBe('high')
  })

  it('does not override explicit node attributes', () => {
    const rules = parseStylesheet('* { llm_model: claude-sonnet-4-5; }')
    const attrs: Record<string, unknown> = { llm_model: 'my-special-model' }
    applyStylesheetToNode('node', undefined, attrs, rules)
    // Should NOT be overridden
    expect(attrs['llm_model']).toBe('my-special-model')
  })
})

describe('Stylesheet Application Transform', () => {
  it('applies stylesheet to all nodes after parsing', () => {
    const src = `
digraph Styled {
    graph [model_stylesheet="* { llm_model: claude-sonnet-4-5; } .code { llm_model: claude-opus-4-6; }"]
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    plan  [shape=box, prompt="Plan"]
    impl  [shape=box, class="code", prompt="Implement"]
    start -> plan -> impl -> exit
}
`
    const g = applyTransforms(parseDot(src))
    expect(g.nodes.get('plan')?.attrs.llm_model).toBe('claude-sonnet-4-5')
    expect(g.nodes.get('impl')?.attrs.llm_model).toBe('claude-opus-4-6')
  })
})
