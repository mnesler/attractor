import { describe, it, expect, vi } from 'vitest'
import { Session, SessionState } from '../src/session.js'
import { EventKind, type SessionEvent } from '../src/types/event.js'
import { ToolRegistry, type RegisteredTool } from '../src/tools/registry.js'
import type { ProviderProfile } from '../src/profiles/base.js'
import type { ExecutionEnvironment } from '../src/environment/interface.js'
import type { Client, ToolCall, Usage } from '@attractor/llm'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockResponse = {
  id: string
  model: string
  provider: string
  text: string
  toolCalls: ToolCall[]
  reasoning: undefined
  usage: Usage
  finish_reason: { reason: string; raw: string }
  warnings: never[]
  rate_limit: undefined
}

function mockResp(text: string, toolCalls: ToolCall[] = []): MockResponse {
  return {
    id: 'resp-1',
    model: 'test-model',
    provider: 'openrouter',
    text,
    toolCalls,
    reasoning: undefined,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    finish_reason: { reason: toolCalls.length > 0 ? 'tool_calls' : 'stop', raw: '' },
    warnings: [],
    rate_limit: undefined,
  }
}

function makeClient(responses: MockResponse[]): Client {
  let idx = 0
  return {
    complete: vi.fn().mockImplementation(async () => {
      const r = responses[idx] ?? responses[responses.length - 1]!
      idx++
      return r
    }),
  } as unknown as Client
}

function makeRegistry(...tools: RegisteredTool[]): ToolRegistry {
  const r = new ToolRegistry()
  for (const t of tools) r.register(t)
  return r
}

function makeProfile(client: Client, registry: ToolRegistry, opts: { parallel?: boolean; model?: string } = {}): ProviderProfile {
  return {
    id: 'openrouter',
    model: opts.model ?? 'test/model',
    tool_registry: registry,
    project_doc_files: [],
    supports_reasoning: false,
    supports_streaming: false,
    supports_parallel_tool_calls: opts.parallel ?? true,
    context_window_size: 200_000,
    build_system_prompt: async () => 'You are a test assistant.',
    tools: () => registry.definitions(),
    provider_options: () => ({}),
    clone: (overrides) => makeProfile(client, registry, { ...opts, model: overrides?.model ?? opts.model }),
  }
}

function makeEnv(): ExecutionEnvironment {
  return {
    read_file: vi.fn().mockResolvedValue(''),
    write_file: vi.fn().mockResolvedValue(undefined),
    file_exists: vi.fn().mockResolvedValue(false),
    list_directory: vi.fn().mockResolvedValue([]),
    exec_command: vi.fn().mockResolvedValue({
      stdout: '', stderr: '', exit_code: 1, timed_out: false, duration_ms: 0,
    }),
    grep: vi.fn().mockResolvedValue(''),
    glob: vi.fn().mockResolvedValue([]),
    initialize: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    working_directory: () => '/tmp/test',
    platform: () => 'linux',
    os_version: () => 'Linux 6.0.0',
  }
}

async function collect(gen: AsyncGenerator<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = []
  for await (const e of gen) events.push(e)
  return events
}

// ---------------------------------------------------------------------------
// Basic lifecycle
// ---------------------------------------------------------------------------

describe('Session: lifecycle', () => {
  it('starts IDLE, becomes IDLE after natural completion', async () => {
    const r = makeRegistry()
    const c = makeClient([mockResp('Hello!')])
    const s = new Session({ profile: makeProfile(c, r), execution_env: makeEnv(), llm_client: c })
    expect(s.state).toBe(SessionState.IDLE)
    const events = await collect(s.submit('Hi'))
    expect(s.state).toBe(SessionState.IDLE)
    expect(events.some(e => e.kind === EventKind.SESSION_END)).toBe(true)
  })

  it('throws if submit called while PROCESSING', () => {
    const r = makeRegistry()
    const c = makeClient([mockResp('Hello!')])
    const s = new Session({ profile: makeProfile(c, r), execution_env: makeEnv(), llm_client: c })
    ;(s as unknown as Record<string, unknown>)['state'] = SessionState.PROCESSING
    expect(() => s.submit('Hi')).toThrow(/PROCESSING/)
  })

  it('supports multiple sequential inputs', async () => {
    const r = makeRegistry()
    const c = makeClient([mockResp('First'), mockResp('Second')])
    const s = new Session({ profile: makeProfile(c, r), execution_env: makeEnv(), llm_client: c })
    await collect(s.submit('Input 1'))
    expect(s.state).toBe(SessionState.IDLE)
    await collect(s.submit('Input 2'))
    expect(s.state).toBe(SessionState.IDLE)
    expect(s.history.filter(t => t.kind === 'user').length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

describe('Session: event emission', () => {
  it('emits USER_INPUT and ASSISTANT_TEXT_END', async () => {
    const r = makeRegistry()
    const c = makeClient([mockResp('Hello!')])
    const s = new Session({ profile: makeProfile(c, r), execution_env: makeEnv(), llm_client: c })
    const events = await collect(s.submit('Say hello'))
    const kinds = events.map(e => e.kind)
    expect(kinds).toContain(EventKind.USER_INPUT)
    expect(kinds).toContain(EventKind.ASSISTANT_TEXT_END)
    const textEnd = events.find(e => e.kind === EventKind.ASSISTANT_TEXT_END)!
    expect(textEnd.data['text']).toBe('Hello!')
  })
})

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

describe('Session: tool execution', () => {
  it('executes tool and sends result back in next request', async () => {
    const weatherTool: RegisteredTool = {
      definition: {
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
      executor: async (args) => `72F in ${args['city']}`,
    }
    const r = makeRegistry(weatherTool)
    const tc: ToolCall = { id: 'c1', name: 'get_weather', arguments: { city: 'SF' } }
    const c = makeClient([mockResp('', [tc]), mockResp('The weather is 72F.')])
    const s = new Session({ profile: makeProfile(c, r), execution_env: makeEnv(), llm_client: c })

    const events = await collect(s.submit('Weather?'))
    const kinds = events.map(e => e.kind)
    expect(kinds).toContain(EventKind.TOOL_CALL_START)
    expect(kinds).toContain(EventKind.TOOL_CALL_END)

    // TOOL_CALL_END carries full untruncated output
    const toolEnd = events.find(e => e.kind === EventKind.TOOL_CALL_END)!
    expect(toolEnd.data['output']).toContain('72F in SF')
  })

  it('returns error result for unknown tool without throwing', async () => {
    const r = makeRegistry()  // empty
    const tc: ToolCall = { id: 'c1', name: 'unknown_tool', arguments: {} }
    const c = makeClient([mockResp('', [tc]), mockResp('Handled the error.')])
    const s = new Session({ profile: makeProfile(c, r), execution_env: makeEnv(), llm_client: c })

    const events = await collect(s.submit('Run unknown'))
    const toolEnd = events.find(e => e.kind === EventKind.TOOL_CALL_END)!
    expect(toolEnd.data['error']).toContain('Unknown tool')
    expect(events.some(e => e.kind === EventKind.SESSION_END)).toBe(true)
  })

  it('catches executor errors and sends is_error result', async () => {
    const buggy: RegisteredTool = {
      definition: { name: 'buggy', description: 'Fails', parameters: { type: 'object', properties: {} } },
      executor: async () => { throw new Error('boom') },
    }
    const r = makeRegistry(buggy)
    const tc: ToolCall = { id: 'c1', name: 'buggy', arguments: {} }
    const c = makeClient([mockResp('', [tc]), mockResp('Tool failed, retrying differently.')])
    const s = new Session({ profile: makeProfile(c, r), execution_env: makeEnv(), llm_client: c })

    const events = await collect(s.submit('Run buggy'))
    const toolEnd = events.find(e => e.kind === EventKind.TOOL_CALL_END)!
    expect(toolEnd.data['error']).toContain('boom')
  })

  it('executes tools in parallel when profile supports it', async () => {
    const calls: string[] = []
    const tool1: RegisteredTool = {
      definition: { name: 'tool_a', description: 'A', parameters: { type: 'object', properties: {} } },
      executor: async () => { calls.push('a'); return 'result a' },
    }
    const tool2: RegisteredTool = {
      definition: { name: 'tool_b', description: 'B', parameters: { type: 'object', properties: {} } },
      executor: async () => { calls.push('b'); return 'result b' },
    }
    const r = makeRegistry(tool1, tool2)
    const tcs: ToolCall[] = [
      { id: 'c1', name: 'tool_a', arguments: {} },
      { id: 'c2', name: 'tool_b', arguments: {} },
    ]
    const c = makeClient([mockResp('', tcs), mockResp('Both done.')])
    const s = new Session({ profile: makeProfile(c, r, { parallel: true }), execution_env: makeEnv(), llm_client: c })

    await collect(s.submit('Run both'))
    expect(calls).toContain('a')
    expect(calls).toContain('b')
  })
})

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe('Session: max_tool_rounds_per_input', () => {
  it('stops after max rounds and emits TURN_LIMIT', async () => {
    const tool: RegisteredTool = {
      definition: { name: 'step', description: 'Step', parameters: { type: 'object', properties: {} } },
      executor: async () => 'ok',
    }
    const r = makeRegistry(tool)
    const tc: ToolCall = { id: 'c', name: 'step', arguments: {} }
    const c = makeClient([mockResp('', [tc])])  // always returns tool call
    const s = new Session({
      profile: makeProfile(c, r),
      execution_env: makeEnv(),
      llm_client: c,
      config: { max_tool_rounds_per_input: 2 },
    })

    const events = await collect(s.submit('Loop'))
    expect(events.some(e => e.kind === EventKind.TURN_LIMIT)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

describe('Session: steering', () => {
  it('drains steering queue and emits STEERING_INJECTED', async () => {
    const r = makeRegistry()
    const c = makeClient([mockResp('Done')])
    const s = new Session({ profile: makeProfile(c, r), execution_env: makeEnv(), llm_client: c })
    s.steer('Redirect: focus only on tests')

    const events = await collect(s.submit('Do work'))
    const steering = events.find(e => e.kind === EventKind.STEERING_INJECTED)
    expect(steering).toBeDefined()
    expect(steering!.data['content']).toBe('Redirect: focus only on tests')
    expect(s.history.some(t => t.kind === 'steering')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Follow-up
// ---------------------------------------------------------------------------

describe('Session: follow_up', () => {
  it('processes follow-up input after current completion', async () => {
    const r = makeRegistry()
    let callCount = 0
    const c = {
      complete: vi.fn().mockImplementation(async () => {
        callCount++
        return mockResp(`Response ${callCount}`)
      }),
    } as unknown as Client
    const s = new Session({ profile: makeProfile(c, r), execution_env: makeEnv(), llm_client: c })
    s.follow_up('Second input')

    const events = await collect(s.submit('First input'))
    const userInputs = events.filter(e => e.kind === EventKind.USER_INPUT)
    expect(userInputs.length).toBe(2)
    expect(callCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Loop detection
// ---------------------------------------------------------------------------

describe('Session: loop detection', () => {
  it('emits LOOP_DETECTION when same tool call repeats', async () => {
    const tool: RegisteredTool = {
      definition: { name: 'loop', description: 'Loops', parameters: { type: 'object', properties: {} } },
      executor: async () => 'ok',
    }
    const r = makeRegistry(tool)
    const tc: ToolCall = { id: 'c', name: 'loop', arguments: {} }
    let round = 0
    const c = {
      complete: vi.fn().mockImplementation(async () => {
        round++
        if (round >= 12) return mockResp('Finally done')
        return mockResp('', [tc])
      }),
    } as unknown as Client
    const s = new Session({
      profile: makeProfile(c, r),
      execution_env: makeEnv(),
      llm_client: c,
      config: { loop_detection_window: 10, enable_loop_detection: true },
    })

    const events = await collect(s.submit('Run'))
    expect(events.some(e => e.kind === EventKind.LOOP_DETECTION)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('Session: error handling', () => {
  it('transitions to CLOSED and emits ERROR on API failure', async () => {
    const r = makeRegistry()
    const c = {
      complete: vi.fn().mockRejectedValue(new Error('Authentication failed')),
    } as unknown as Client
    const s = new Session({ profile: makeProfile(c, r), execution_env: makeEnv(), llm_client: c })

    const events = await collect(s.submit('Hi'))
    expect(s.state).toBe(SessionState.CLOSED)
    expect(events.some(e => e.kind === EventKind.ERROR)).toBe(true)
    expect(events.some(e => e.kind === EventKind.SESSION_END)).toBe(true)
  })
})
