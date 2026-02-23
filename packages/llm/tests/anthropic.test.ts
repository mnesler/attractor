import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AnthropicAdapter } from '../src/adapters/anthropic.js'
import { Message, Role, ContentKind } from '../src/types/message.js'
import { AuthenticationError, RateLimitError, ServerError } from '../src/types/errors.js'
import { StreamEventType } from '../src/types/stream.js'

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

function mockFetch(data: unknown, status = 200, headers: Record<string, string> = {}) {
  const responseHeaders = new Headers({ 'content-type': 'application/json', ...headers })
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    body: null,
  } as unknown as Response)
}

function mockSSEFetch(events: string[], status = 200) {
  const body = events.join('\n') + '\n'
  const encoder = new TextEncoder()
  const chunks = [encoder.encode(body)]
  let idx = 0

  const reader = {
    read: vi.fn().mockImplementation(async () => {
      if (idx < chunks.length) {
        return { done: false, value: chunks[idx++] }
      }
      return { done: true, value: undefined }
    }),
    releaseLock: vi.fn(),
  }

  const bodyStream = { getReader: () => reader }

  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: bodyStream,
    json: () => Promise.reject(new Error('not json')),
  } as unknown as Response)
}

// ---------------------------------------------------------------------------
// Anthropic adapter: request translation
// ---------------------------------------------------------------------------

describe('AnthropicAdapter request translation', () => {
  let adapter: AnthropicAdapter
  let fetchMock: ReturnType<typeof mockFetch>

  beforeEach(() => {
    adapter = new AnthropicAdapter({ api_key: 'sk-test-key' })
    fetchMock = mockFetch(makeAnthropicResponse('Hello!'))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends correct headers', async () => {
    await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('Hi')],
    })

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/messages')
    const headers = options.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test-key')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['content-type']).toBe('application/json')
  })

  it('extracts system messages to system parameter', async () => {
    await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [
        Message.system('You are helpful.'),
        Message.user('Hi'),
      ],
    })

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(options.body as string)
    expect(body.system).toBeDefined()
    expect(body.system[0].type).toBe('text')
    expect(body.system[0].text).toBe('You are helpful.')
    expect(body.messages.some((m: {role: string}) => m.role === 'system')).toBe(false)
  })

  it('defaults max_tokens to 4096', async () => {
    await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('Hi')],
    })
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(options.body as string)
    expect(body.max_tokens).toBe(4096)
  })

  it('respects explicit max_tokens', async () => {
    await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('Hi')],
      max_tokens: 1000,
    })
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(options.body as string)
    expect(body.max_tokens).toBe(1000)
  })

  it('merges consecutive same-role messages', async () => {
    await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [
        Message.user('Part 1'),
        Message.user('Part 2'),
        Message.assistant('Response'),
      ],
    })
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(options.body as string)
    // Two user messages should be merged into one
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].content).toHaveLength(2)
    expect(body.messages[1].role).toBe('assistant')
  })

  it('translates tool definitions to Anthropic format', async () => {
    await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('What is the weather?')],
      tools: [{
        name: 'get_weather',
        description: 'Get weather for a location',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    })
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(options.body as string)
    expect(body.tools).toBeDefined()
    expect(body.tools[0].name).toBe('get_weather')
    expect(body.tools[0].input_schema).toBeDefined()
  })

  it('omits tools when tool_choice is none', async () => {
    await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('Hi')],
      tools: [{ name: 'fn', description: 'test', parameters: { type: 'object' } }],
      tool_choice: { mode: 'none' },
    })
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(options.body as string)
    expect(body.tools).toBeUndefined()
  })

  it('translates tool_choice required to Anthropic any', async () => {
    await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('Hi')],
      tools: [{ name: 'fn', description: 'test', parameters: { type: 'object' } }],
      tool_choice: { mode: 'required' },
    })
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(options.body as string)
    expect(body.tool_choice).toEqual({ type: 'any' })
  })

  it('injects prompt-caching beta header when system prompt present', async () => {
    await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.system('System'), Message.user('Hi')],
    })
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = options.headers as Record<string, string>
    expect(headers['anthropic-beta']).toContain('prompt-caching-2024-07-31')
  })

  it('injects cache_control on last system block', async () => {
    await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.system('Be helpful'), Message.user('Hi')],
    })
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(options.body as string)
    const lastBlock = body.system[body.system.length - 1]
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('appends user-supplied beta headers', async () => {
    await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('Hi')],
      provider_options: {
        anthropic: { beta_headers: ['interleaved-thinking-2025-05-14'] },
      },
    })
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = options.headers as Record<string, string>
    expect(headers['anthropic-beta']).toContain('interleaved-thinking-2025-05-14')
  })

  it('maps reasoning_effort to thinking parameter', async () => {
    await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('Think hard')],
      reasoning_effort: 'high',
    })
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(options.body as string)
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 32000 })
  })
})

// ---------------------------------------------------------------------------
// Anthropic adapter: response translation
// ---------------------------------------------------------------------------

describe('AnthropicAdapter response translation', () => {
  let adapter: AnthropicAdapter

  beforeEach(() => {
    adapter = new AnthropicAdapter({ api_key: 'sk-test-key' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('translates a simple text response', async () => {
    vi.stubGlobal('fetch', mockFetch(makeAnthropicResponse('Hello, world!')))
    const response = await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('Hi')],
    })
    expect(response.text).toBe('Hello, world!')
    expect(response.provider).toBe('anthropic')
    expect(response.finish_reason.reason).toBe('stop')
    expect(response.finish_reason.raw).toBe('end_turn')
  })

  it('maps tool_use stop reason to tool_calls', async () => {
    vi.stubGlobal('fetch', mockFetch(makeAnthropicToolUseResponse()))
    const response = await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('What is the weather?')],
    })
    expect(response.finish_reason.reason).toBe('tool_calls')
    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls[0]!.name).toBe('get_weather')
  })

  it('maps max_tokens stop reason to length', async () => {
    vi.stubGlobal('fetch', mockFetch(makeAnthropicResponse('Truncated', 'max_tokens')))
    const response = await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('Write a novel')],
    })
    expect(response.finish_reason.reason).toBe('length')
  })

  it('translates usage fields correctly', async () => {
    vi.stubGlobal('fetch', mockFetch({
      ...makeAnthropicResponse('Hi'),
      usage: {
        input_tokens: 50,
        output_tokens: 100,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 20,
      },
    }))
    const response = await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('Hi')],
    })
    expect(response.usage.input_tokens).toBe(50)
    expect(response.usage.output_tokens).toBe(100)
    expect(response.usage.cache_read_tokens).toBe(30)
    expect(response.usage.cache_write_tokens).toBe(20)
  })

  it('translates thinking blocks to THINKING content parts', async () => {
    vi.stubGlobal('fetch', mockFetch(makeAnthropicThinkingResponse()))
    const response = await adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('Solve this')],
    })
    const thinkingPart = response.message.content.find(p => p.kind === ContentKind.THINKING)
    expect(thinkingPart).toBeDefined()
    expect(thinkingPart!.thinking!.text).toBe('Let me reason...')
    expect(thinkingPart!.thinking!.signature).toBe('sig_abc123')
    expect(response.reasoning).toBe('Let me reason...')
  })
})

// ---------------------------------------------------------------------------
// Anthropic adapter: error handling
// ---------------------------------------------------------------------------

describe('AnthropicAdapter error handling', () => {
  let adapter: AnthropicAdapter

  beforeEach(() => {
    adapter = new AnthropicAdapter({ api_key: 'sk-test-key' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws AuthenticationError on 401', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: { message: 'Invalid API key', type: 'authentication_error' } }, 401))
    await expect(adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('Hi')],
    })).rejects.toBeInstanceOf(AuthenticationError)
  })

  it('throws RateLimitError on 429', async () => {
    vi.stubGlobal('fetch', mockFetch(
      { error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } },
      429,
      { 'retry-after': '5' },
    ))
    try {
      await adapter.complete({
        model: 'claude-opus-4-6',
        messages: [Message.user('Hi')],
      })
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError)
      expect((e as RateLimitError).retry_after).toBe(5)
    }
  })

  it('throws ServerError on 500', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: { message: 'Internal server error', type: 'server_error' } }, 500))
    await expect(adapter.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('Hi')],
    })).rejects.toBeInstanceOf(ServerError)
  })
})

// ---------------------------------------------------------------------------
// Anthropic adapter: streaming
// ---------------------------------------------------------------------------

describe('AnthropicAdapter streaming', () => {
  let adapter: AnthropicAdapter

  beforeEach(() => {
    adapter = new AnthropicAdapter({ api_key: 'sk-test-key' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('emits TEXT_START/DELTA/END events for text blocks', async () => {
    const sseData = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-4-6', usage: { input_tokens: 10 } } })}`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } })}`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
    ]

    vi.stubGlobal('fetch', mockSSEFetch(sseData))

    const events = []
    for await (const event of adapter.stream({
      model: 'claude-opus-4-6',
      messages: [Message.user('Hi')],
    })) {
      events.push(event)
    }

    const types = events.map(e => e.type)
    expect(types).toContain(StreamEventType.TEXT_START)
    expect(types).toContain(StreamEventType.TEXT_DELTA)
    expect(types).toContain(StreamEventType.TEXT_END)
    expect(types).toContain(StreamEventType.FINISH)

    const textDeltas = events.filter(e => e.type === StreamEventType.TEXT_DELTA)
    const text = textDeltas.map(e => e.delta).join('')
    expect(text).toBe('Hello world')

    const finish = events.find(e => e.type === StreamEventType.FINISH)!
    expect(finish.response!.text).toBe('Hello world')
    expect(finish.finish_reason!.reason).toBe('stop')
  })

  it('emits TOOL_CALL events for tool use blocks', async () => {
    const sseData = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-4-6', usage: { input_tokens: 15 } } })}`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather' } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city"' } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ': "SF"}' } })}`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
    ]

    vi.stubGlobal('fetch', mockSSEFetch(sseData))

    const events = []
    for await (const event of adapter.stream({
      model: 'claude-opus-4-6',
      messages: [Message.user('Weather?')],
    })) {
      events.push(event)
    }

    const types = events.map(e => e.type)
    expect(types).toContain(StreamEventType.TOOL_CALL_START)
    expect(types).toContain(StreamEventType.TOOL_CALL_DELTA)
    expect(types).toContain(StreamEventType.TOOL_CALL_END)

    const start = events.find(e => e.type === StreamEventType.TOOL_CALL_START)!
    expect(start.tool_call!.name).toBe('get_weather')

    const finish = events.find(e => e.type === StreamEventType.FINISH)!
    expect(finish.finish_reason!.reason).toBe('tool_calls')
    expect(finish.response!.toolCalls[0]!.arguments).toEqual({ city: 'SF' })
  })
})

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeAnthropicResponse(text: string, stop_reason = 'end_turn') {
  return {
    id: 'msg_test123',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-6',
    content: [{ type: 'text', text }],
    stop_reason,
    usage: { input_tokens: 10, output_tokens: 5 },
  }
}

function makeAnthropicToolUseResponse() {
  return {
    id: 'msg_test456',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-6',
    content: [{
      type: 'tool_use',
      id: 'call_1',
      name: 'get_weather',
      input: { city: 'San Francisco' },
    }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 20, output_tokens: 30 },
  }
}

function makeAnthropicThinkingResponse() {
  return {
    id: 'msg_think',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-6',
    content: [
      { type: 'thinking', thinking: 'Let me reason...', signature: 'sig_abc123' },
      { type: 'text', text: 'The answer is 42.' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 30, output_tokens: 50 },
  }
}
