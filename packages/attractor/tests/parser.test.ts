import { describe, it, expect } from 'vitest'
import { parseDot } from '../src/parser/dot.js'

describe('DOT Parser', () => {
  it('parses a simple linear pipeline', () => {
    const src = `
digraph Simple {
    graph [goal="Run tests"]
    start [shape=Mdiamond, label="Start"]
    exit  [shape=Msquare, label="Exit"]
    run   [label="Run Tests", prompt="Run the test suite"]
    start -> run -> exit
}
`
    const g = parseDot(src)
    expect(g.goal).toBe('Run tests')
    expect(g.nodes.has('start')).toBe(true)
    expect(g.nodes.has('exit')).toBe(true)
    expect(g.nodes.has('run')).toBe(true)
    expect(g.nodes.get('run')?.attrs.label).toBe('Run Tests')
    expect(g.nodes.get('run')?.attrs.prompt).toBe('Run the test suite')
    expect(g.edges.length).toBe(2)
  })

  it('parses graph-level attributes', () => {
    const src = `
digraph Pipeline {
    graph [
        goal="Implement feature X",
        label="My Pipeline",
        default_max_retry=3,
        retry_target="plan"
    ]
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    plan  [shape=box, prompt="Plan it"]
    start -> plan -> exit
}
`
    const g = parseDot(src)
    expect(g.goal).toBe('Implement feature X')
    expect(g.label).toBe('My Pipeline')
    expect(g.default_max_retry).toBe(3)
    expect(g.retry_target).toBe('plan')
  })

  it('parses edge attributes (label, condition, weight)', () => {
    const src = `
digraph Branch {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    gate  [shape=diamond]
    start -> gate
    gate -> exit  [label="Yes", condition="outcome=success", weight=10]
    gate -> start [label="No",  condition="outcome!=success"]
}
`
    const g = parseDot(src)
    const exitEdge = g.outgoing('gate').find(e => e.to === 'exit')
    expect(exitEdge?.attrs.label).toBe('Yes')
    expect(exitEdge?.attrs.condition).toBe('outcome=success')
    expect(exitEdge?.attrs.weight).toBe(10)
  })

  it('expands chained edges A -> B -> C into two edges', () => {
    const src = `
digraph Chain {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    a [shape=box]
    b [shape=box]
    start -> a -> b -> exit
}
`
    const g = parseDot(src)
    expect(g.edges.length).toBe(3)
    expect(g.outgoing('start')[0]?.to).toBe('a')
    expect(g.outgoing('a')[0]?.to).toBe('b')
    expect(g.outgoing('b')[0]?.to).toBe('exit')
  })

  it('applies node and edge default blocks', () => {
    const src = `
digraph Defaults {
    node [shape=box, timeout="900s"]
    edge [weight=5]
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [label="Task"]
    start -> task -> exit
}
`
    const g = parseDot(src)
    // task should inherit shape=box from defaults (it had no explicit shape)
    expect(g.nodes.get('task')?.attrs.shape).toBe('box')
    // edges should have weight=5 from edge defaults
    expect(g.outgoing('start')[0]?.attrs.weight).toBe(5)
  })

  it('parses subgraph and derives class from label', () => {
    const src = `
digraph Subgraphs {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    subgraph cluster_loop {
        label = "Loop A"
        node [thread_id="loop-a"]
        plan [shape=box, prompt="Plan"]
    }
    start -> plan -> exit
}
`
    const g = parseDot(src)
    const plan = g.nodes.get('plan')
    expect(plan?.attrs.thread_id).toBe('loop-a')
    // class derived from "Loop A" -> "loop-a"
    expect(plan?.attrs.class).toBe('loop-a')
  })

  it('strips comments before parsing', () => {
    const src = `
// This is a line comment
digraph Commented {
    /* Block comment */
    start [shape=Mdiamond] // inline comment
    exit  [shape=Msquare]
    start -> exit
}
`
    const g = parseDot(src)
    expect(g.nodes.has('start')).toBe(true)
    expect(g.nodes.has('exit')).toBe(true)
  })

  it('parses Boolean and Duration attribute values', () => {
    const src = `
digraph Typed {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [shape=box, goal_gate=true, timeout="900s", max_retries=2, allow_partial=false]
    start -> task -> exit
}
`
    const g = parseDot(src)
    const task = g.nodes.get('task')!
    expect(task.attrs.goal_gate).toBe(true)
    expect(task.attrs.timeout).toBe(900_000)
    expect(task.attrs.max_retries).toBe(2)
    expect(task.attrs.allow_partial).toBe(false)
  })

  it('parses multi-line attribute blocks', () => {
    const src = `
digraph MultiLine {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task [
        shape=box,
        label="Long Task",
        prompt="Do something complex",
        max_retries=3
    ]
    start -> task -> exit
}
`
    const g = parseDot(src)
    const task = g.nodes.get('task')!
    expect(task.attrs.label).toBe('Long Task')
    expect(task.attrs.prompt).toBe('Do something complex')
    expect(task.attrs.max_retries).toBe(3)
  })

  it('parses model_stylesheet attribute', () => {
    const src = `
digraph Styled {
    graph [model_stylesheet="* { llm_model: claude-sonnet-4-5; }"]
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    start -> exit
}
`
    const g = parseDot(src)
    expect(g.model_stylesheet).toContain('claude-sonnet-4-5')
  })

  it('rejects undirected edges', () => {
    const src = `
digraph Bad {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    start -- exit
}
`
    // The parser won't error on -- but it also won't create an edge
    // (-- is not a recognized arrow token)
    const g = parseDot(src)
    expect(g.edges.length).toBe(0)
  })
})
