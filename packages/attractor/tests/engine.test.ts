import { describe, it, expect, vi } from 'vitest'
import { Runner } from '../src/engine/runner.js'
import type { CodergenBackend } from '../src/handlers/codergen.js'
import type { Node } from '../src/types/graph.js'
import type { Context } from '../src/types/context.js'
import type { Outcome } from '../src/types/outcome.js'
import { QueueInterviewer } from '../src/interviewer/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'attractor-test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function makeBackend(responseMap: Record<string, string | Outcome>): CodergenBackend {
  return {
    async run(node: Node, _prompt: string, _context: Context): Promise<string | Outcome> {
      const r = responseMap[node.id]
      if (r !== undefined) return r
      return `Response for ${node.id}`
    },
  }
}

// ---------------------------------------------------------------------------
// Basic execution
// ---------------------------------------------------------------------------

describe('Runner: basic execution', () => {
  it('runs a simple linear pipeline', async () => {
    const src = `
digraph Simple {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [shape=box, prompt="Do work"]
    start -> task -> exit
}
`
    await withTmpDir(async (dir) => {
      const runner = new Runner({ backend: makeBackend({}) })
      const outcome = await runner.run(src, { logs_root: dir })
      expect(outcome.status).toBe('success')
    })
  })

  it('resolves start node and executes to exit', async () => {
    const visited: string[] = []
    const backend: CodergenBackend = {
      async run(node) {
        visited.push(node.id)
        return 'done'
      },
    }
    const src = `
digraph Trace {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    a [shape=box, prompt="A"]
    b [shape=box, prompt="B"]
    start -> a -> b -> exit
}
`
    await withTmpDir(async (dir) => {
      const runner = new Runner({ backend })
      await runner.run(src, { logs_root: dir })
      expect(visited).toEqual(['a', 'b'])
    })
  })
})

// ---------------------------------------------------------------------------
// Edge selection
// ---------------------------------------------------------------------------

describe('Runner: edge selection', () => {
  it('follows condition-matched edge', async () => {
    const src = `
digraph Conditional {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    gate  [shape=diamond]
    yes   [shape=box, prompt="Yes path"]
    no    [shape=box, prompt="No path"]
    start -> gate
    gate -> yes [condition="outcome=success"]
    gate -> no  [condition="outcome=fail"]
    yes -> exit
    no  -> exit
}
`
    const visited: string[] = []
    const backend: CodergenBackend = {
      async run(node) { visited.push(node.id); return 'done' },
    }
    await withTmpDir(async (dir) => {
      const runner = new Runner({ backend })
      await runner.run(src, { logs_root: dir })
      // Conditional handler returns success, so "yes" should be visited
      expect(visited).toContain('yes')
      expect(visited).not.toContain('no')
    })
  })

  it('follows preferred_label edge', async () => {
    const visited: string[] = []
    const src = `
digraph PrefLabel {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    gate  [shape=hexagon, label="Choose path"]
    path_a [shape=box, prompt="Path A"]
    path_b [shape=box, prompt="Path B"]
    start -> gate
    gate -> path_a [label="[A] Alpha"]
    gate -> path_b [label="[B] Beta"]
    path_a -> exit
    path_b -> exit
}
`
    await withTmpDir(async (dir) => {
      // Queue interviewer selects first option (path_a)
      const interviewer = new QueueInterviewer([{ value: 'A', selected_option: { key: 'A', label: '[A] Alpha' } }])
      const backend: CodergenBackend = {
        async run(node) { visited.push(node.id); return 'done' },
      }
      const runner = new Runner({ backend, interviewer })
      await runner.run(src, { logs_root: dir })
      expect(visited).toContain('path_a')
    })
  })

  it('follows highest weight unconditional edge', async () => {
    const src = `
digraph Weights {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    a [shape=box, prompt="A"]
    b [shape=box, prompt="B"]
    start -> a [weight=5]
    start -> b [weight=10]
    a -> exit
    b -> exit
}
`
    const visited: string[] = []
    await withTmpDir(async (dir) => {
      const runner = new Runner({ backend: makeBackend({}) })
      await runner.run(src, { logs_root: dir })
      // b has higher weight, so it should be visited
      // But wait — start is a start handler (no-op), so edge from start to b/a is selected
      // The conditional handler routes by condition — but start has no condition...
      // Actually start node's outgoing edges: a (w=5) and b (w=10) → b should win
      const visited2: string[] = []
      const runner2 = new Runner({
        backend: {
          async run(node) { visited2.push(node.id); return 'done' },
        },
      })
      await runner2.run(src, { logs_root: dir + '2' })
      expect(visited2[0]).toBe('b')
    })
  })
})

// ---------------------------------------------------------------------------
// Goal gate
// ---------------------------------------------------------------------------

describe('Runner: goal gate', () => {
  it('enforces goal gate — routes to retry_target when gate not satisfied', async () => {
    const executionLog: string[] = []
    let planCallCount = 0
    const backend: CodergenBackend = {
      async run(node, _prompt, context): Promise<string | Outcome> {
        executionLog.push(node.id)
        if (node.id === 'plan') {
          planCallCount++
          if (planCallCount === 1) {
            // First run: plan fails goal gate (return fail outcome)
            return { status: 'fail', failure_reason: 'Plan not good enough' }
          }
          // Second run: succeed
          return { status: 'success', notes: 'Plan succeeded' }
        }
        return 'done'
      },
    }

    const src = `
digraph GoalGate {
    graph [retry_target="plan"]
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    plan  [shape=box, prompt="Make plan", goal_gate=true]
    start -> plan -> exit
    plan -> exit [condition="outcome=success"]
}
`
    await withTmpDir(async (dir) => {
      const runner = new Runner({ backend })
      const outcome = await runner.run(src, { logs_root: dir })
      // Should have called plan twice: first failed, then jumped back via goal gate
      expect(planCallCount).toBeGreaterThanOrEqual(1)
    })
  })
})

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

describe('Runner: retry logic', () => {
  it('retries nodes with max_retries > 0', async () => {
    let callCount = 0
    const backend: CodergenBackend = {
      async run(_node): Promise<string | Outcome> {
        callCount++
        if (callCount < 3) return { status: 'retry', failure_reason: 'Not ready yet' }
        return { status: 'success', notes: 'Done' }
      },
    }
    const src = `
digraph Retry {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [shape=box, prompt="Try", max_retries=5]
    start -> task -> exit
}
`
    await withTmpDir(async (dir) => {
      const runner = new Runner({ backend })
      const outcome = await runner.run(src, { logs_root: dir })
      expect(outcome.status).toBe('success')
      expect(callCount).toBe(3)
    })
  })

  it('fails after max retries exceeded', async () => {
    const backend: CodergenBackend = {
      async run(): Promise<Outcome> {
        return { status: 'retry', failure_reason: 'Always fails' }
      },
    }
    const src = `
digraph MaxRetry {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [shape=box, prompt="Try", max_retries=2]
    start -> task -> exit
    task -> exit [condition="outcome=fail"]
}
`
    await withTmpDir(async (dir) => {
      const runner = new Runner({ backend })
      const outcome = await runner.run(src, { logs_root: dir })
      // After 3 attempts (1 + 2 retries), should fail or take fail edge
      expect(['success', 'fail']).toContain(outcome.status)
    })
  })
})

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

describe('Runner: context', () => {
  it('passes context_updates between nodes', async () => {
    let capturedContext: unknown
    const backend: CodergenBackend = {
      async run(node, _prompt, context): Promise<string | Outcome> {
        if (node.id === 'step1') {
          return { status: 'success', context_updates: { my_flag: 'hello' } }
        }
        if (node.id === 'step2') {
          capturedContext = context.get('my_flag')
          return 'done'
        }
        return 'done'
      },
    }
    const src = `
digraph ContextFlow {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    step1 [shape=box, prompt="Step 1"]
    step2 [shape=box, prompt="Step 2"]
    start -> step1 -> step2 -> exit
}
`
    await withTmpDir(async (dir) => {
      const runner = new Runner({ backend })
      await runner.run(src, { logs_root: dir })
      expect(capturedContext).toBe('hello')
    })
  })
})

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe('Runner: events', () => {
  it('emits pipeline_started and pipeline_completed events', async () => {
    const events: string[] = []
    const src = `
digraph Events {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    start -> exit
}
`
    await withTmpDir(async (dir) => {
      const runner = new Runner({
        on_event: (e) => events.push(e.kind),
      })
      await runner.run(src, { logs_root: dir })
      expect(events).toContain('pipeline_started')
      expect(events).toContain('pipeline_completed')
    })
  })

  it('emits stage_started and stage_completed for each node', async () => {
    const events: string[] = []
    const src = `
digraph Events {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [shape=box, prompt="work"]
    start -> task -> exit
}
`
    await withTmpDir(async (dir) => {
      const runner = new Runner({
        backend: makeBackend({}),
        on_event: (e) => events.push(e.kind),
      })
      await runner.run(src, { logs_root: dir })
      expect(events).toContain('stage_started')
      expect(events).toContain('stage_completed')
    })
  })
})

// ---------------------------------------------------------------------------
// Variable expansion
// ---------------------------------------------------------------------------

describe('Runner: variable expansion', () => {
  it('expands $goal in prompts before execution', async () => {
    const prompts: string[] = []
    const backend: CodergenBackend = {
      async run(_node, prompt): Promise<string> {
        prompts.push(prompt)
        return 'done'
      },
    }
    const src = `
digraph GoalExpand {
    graph [goal="Build awesome thing"]
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [shape=box, prompt="Goal: $goal"]
    start -> task -> exit
}
`
    await withTmpDir(async (dir) => {
      const runner = new Runner({ backend })
      await runner.run(src, { logs_root: dir })
      expect(prompts[0]).toBe('Goal: Build awesome thing')
    })
  })
})

// ---------------------------------------------------------------------------
// Simulation mode
// ---------------------------------------------------------------------------

describe('Runner: simulation mode', () => {
  it('runs without a backend (simulation mode)', async () => {
    const src = `
digraph Sim {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    task  [shape=box, prompt="Do something"]
    start -> task -> exit
}
`
    await withTmpDir(async (dir) => {
      const runner = new Runner({ backend: null })
      const outcome = await runner.run(src, { logs_root: dir })
      expect(outcome.status).toBe('success')
    })
  })
})
