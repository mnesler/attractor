import { describe, it, expect } from 'vitest'
import { parseDot } from '../src/parser/dot.js'
import { validate, validateOrRaise, ValidationError } from '../src/lint/index.js'

const SIMPLE = `
digraph Simple {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [shape=box, prompt="Do work"]
    start -> task -> exit
}
`

describe('Lint: valid pipeline', () => {
  it('produces no errors for a valid pipeline', () => {
    const g = parseDot(SIMPLE)
    const diags = validate(g)
    const errors = diags.filter(d => d.severity === 'error')
    expect(errors).toHaveLength(0)
  })
})

describe('Lint: start_node', () => {
  it('errors on missing start node', () => {
    const src = `
digraph NoStart {
    exit [shape=Msquare]
    task [shape=box, prompt="work"]
    task -> exit
}
`
    const g = parseDot(src)
    const diags = validate(g)
    expect(diags.some(d => d.rule === 'start_node' && d.severity === 'error')).toBe(true)
  })

  it('errors on multiple start nodes', () => {
    const src = `
digraph TwoStarts {
    s1 [shape=Mdiamond]
    s2 [shape=Mdiamond]
    exit [shape=Msquare]
    s1 -> exit
    s2 -> exit
}
`
    const g = parseDot(src)
    const diags = validate(g)
    expect(diags.some(d => d.rule === 'start_node' && d.severity === 'error')).toBe(true)
  })
})

describe('Lint: terminal_node', () => {
  it('errors on missing exit node', () => {
    const src = `
digraph NoExit {
    start [shape=Mdiamond]
    task  [shape=box, prompt="work"]
    start -> task
}
`
    const g = parseDot(src)
    const diags = validate(g)
    expect(diags.some(d => d.rule === 'terminal_node' && d.severity === 'error')).toBe(true)
  })
})

describe('Lint: start_no_incoming', () => {
  it('errors when start node has incoming edges', () => {
    const src = `
digraph BadStart {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [shape=box, prompt="work"]
    start -> task -> exit
    task -> start
}
`
    const g = parseDot(src)
    const diags = validate(g)
    expect(diags.some(d => d.rule === 'start_no_incoming' && d.severity === 'error')).toBe(true)
  })
})

describe('Lint: exit_no_outgoing', () => {
  it('errors when exit node has outgoing edges', () => {
    const src = `
digraph BadExit {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [shape=box, prompt="work"]
    start -> task -> exit
    exit -> task
}
`
    const g = parseDot(src)
    const diags = validate(g)
    expect(diags.some(d => d.rule === 'exit_no_outgoing' && d.severity === 'error')).toBe(true)
  })
})

describe('Lint: reachability', () => {
  it('errors on unreachable node', () => {
    const src = `
digraph Orphan {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [shape=box, prompt="work"]
    orphan [shape=box, prompt="orphan"]
    start -> task -> exit
}
`
    const g = parseDot(src)
    const diags = validate(g)
    expect(diags.some(d => d.rule === 'reachability' && d.severity === 'error' && d.node_id === 'orphan')).toBe(true)
  })
})

describe('Lint: validate_or_raise', () => {
  it('throws ValidationError on errors', () => {
    const src = `
digraph Bad {
    exit [shape=Msquare]
    task [shape=box, prompt="work"]
    task -> exit
}
`
    const g = parseDot(src)
    expect(() => validateOrRaise(g)).toThrow(ValidationError)
  })

  it('returns diagnostics without throwing on warnings only', () => {
    const g = parseDot(SIMPLE)
    const diags = validateOrRaise(g)
    expect(Array.isArray(diags)).toBe(true)
  })
})

describe('Lint: warnings', () => {
  it('warns when codergen node has no prompt or label', () => {
    const src = `
digraph NoPrompt {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [shape=box]
    start -> task -> exit
}
`
    const g = parseDot(src)
    const diags = validate(g)
    expect(diags.some(d => d.rule === 'prompt_on_llm_nodes' && d.severity === 'warning')).toBe(true)
  })

  it('warns on invalid fidelity value', () => {
    const src = `
digraph BadFidelity {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [shape=box, prompt="work", fidelity="invalid_value"]
    start -> task -> exit
}
`
    const g = parseDot(src)
    const diags = validate(g)
    expect(diags.some(d => d.rule === 'fidelity_valid' && d.severity === 'warning')).toBe(true)
  })

  it('warns on unknown node type', () => {
    const src = `
digraph CustomType {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [shape=box, type="my_custom_handler", prompt="work"]
    start -> task -> exit
}
`
    const g = parseDot(src)
    const diags = validate(g)
    expect(diags.some(d => d.rule === 'type_known' && d.severity === 'warning')).toBe(true)
  })
})
