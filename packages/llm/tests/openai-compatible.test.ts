import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenRouterAdapter } from '../src/adapters/openrouter.js'
import { Message, Role, ContentKind } from '../src/types/message.js'
import { AuthenticationError, RateLimitError, ServerError } from '../src/types/errors.js'
import { StreamEventType } from '../src/types/stream.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockFetch(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    body: null,
  } as unknown as Response)
}

function mockSSEFetch(lines: string[], status = 200) {
  const body = lines.join('\n') + '\n'
  const encoder = new TextEncoder()
  const chunks = [encoder.encode(body)]
  let idx = 0

  const reader = {
    read: vi.fn().mockImplementation(async () => {
      if (idx < chunks.length) return { done: false, value: chunks[idx++] }
      return { done: true, value: undefined }
    }),
    releaseLock: vi.fn(),
  }

  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: { getReader: () => reader },
  } as unknown as Response)
}

function makeOpenRouterAdapter() {
  return new OpenRouterAdapter({
    api_key: 'sk-or-test',
    base_url: 'https://openrouter.ai/api/v1',
    default_headers: {
      'HTTP-Referer': 'https://myapp.example.com',
      'X-Title': 'Test App',
    },
  })
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

describe('OpenRouterAdapter request translation', () => {
  let adapter: OpenRouterAdapter

  beforeEach(() => {
    adapter = makeOpenRouterAdapter()
    vi.stubGlobal('fetch', mockFetch(makeChatResponse('Hello')))
  })

  afterEach(() => vi.unstubAllGlobals())

  it('sends correct auth header', async () => {
    await adapter.complete({ model: 'anthropic/claude-opus-4-6', messages: [Message.user('Hi')] })
    const [, opts] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit]
    const headers = opts.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer sk-or-test')
  })

  it('passes through default_headers', async () => {
    await adapter.complete({ model: 'anthropic/claude-opus-4-6', messages: [Message.user('Hi')] })
    const [, opts] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit]
    const headers = opts.headers as Record<string, string>
    expect(headers['HTTP-Referer']).toBe('https://myapp.example.com')
    expect(headers['X-Title']).toBe('Test App')
  })

  it('translates SYSTEM role correctly', async () => {
    await adapter.complete({
      model: 'anthropic/claude-opus-4-6',
      messages: [Message.system('You are helpful'), Message.user('Hi')],
    })
    const [, opts] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content).toBe('You are helpful')
  })

  it('translates TOOL role to tool message', async () => {
    await adapter.complete({
      model: 'anthropic/claude-opus-4-6',
      messages: [
        Message.user('Weather?'),
        new Message({
          role: Role.ASSISTANT,
          content: [{ kind: ContentKind.TOOL_CALL, tool_call: { id: 'call_1', name: 'get_weather', arguments: { city: 'SF' } } }],
        }),
        Message.toolResult({ tool_call_id: 'call_1', content: '72F and sunny', is_error: false }),
      ],
    })
    const [, opts] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string)
    const toolMsg = body.messages.find((m: { role: string }) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg.tool_call_id).toBe('call_1')
    expect(toolMsg.content).toBe('72F and sunny')
  })

  it('translates assistant TOOL_CALL content to tool_calls array', async () => {
    await adapter.complete({
      model: 'anthropic/claude-opus-4-6',
      messages: [
        new Message({
          role: Role.ASSISTANT,
          content: [{ kind: ContentKind.TOOL_CALL, tool_call: { id: 'call_1', name: 'get_weather', arguments: { city: 'SF' } } }],
        }),
      ],
    })
    const [, opts] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string)
    const assistantMsg = body.messages.find((m: { role: string }) => m.role === 'assistant')
    expect(assistantMsg.tool_calls).toBeDefined()
    expect(assistantMsg.tool_calls[0].function.name).toBe('get_weather')
    expect(assistantMsg.tool_calls[0].function.arguments).toBe('{"city":"SF"}')
  })

  it('translates tools to Chat Completions format', async () => {
    await adapter.complete({
      model: 'anthropic/claude-opus-4-6',
      messages: [Message.user('Weather?')],
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
    })
    const [, opts] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string)
    expect(body.tools[0].type).toBe('function')
    expect(body.tools[0].function.name).toBe('get_weather')
  })

  it('translates image content to image_url format with data URI', async () => {
    const imageData = new Uint8Array([137, 80, 78, 71]) // PNG header
    await adapter.complete({
      model: 'anthropic/claude-opus-4-6',
      messages: [new Message({
        role: Role.USER,
        content: [
          { kind: ContentKind.TEXT, text: 'What is this?' },
          { kind: ContentKind.IMAGE, image: { data: imageData, media_type: 'image/png' } },
        ],
      })],
    })
    const [, opts] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string)
    const content = body.messages[0].content
    const imgPart = content.find((p: { type: string }) => p.type === 'image_url')
    expect(imgPart).toBeDefined()
    expect(imgPart.image_url.url).toMatch(/^data:image\/png;base64,/)
  })
})

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

describe('OpenRouterAdapter response translation', () => {
  let adapter: OpenRouterAdapter

  beforeEach(() => {
    adapter = makeOpenRouterAdapter()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('translates a simple text response', async () => {
    vi.stubGlobal('fetch', mockFetch(makeChatResponse('Hello, world!')))
    const resp = await adapter.complete({ model: 'openai/gpt-4.5', messages: [Message.user('Hi')] })
    expect(resp.text).toBe('Hello, world!')
    expect(resp.provider).toBe('openrouter')
    expect(resp.finish_reason.reason).toBe('stop')
  })

  it('maps tool_calls finish reason correctly', async () => {
    vi.stubGlobal('fetch', mockFetch(makeChatToolCallResponse()))
    const resp = await adapter.complete({ model: 'openai/gpt-4.5', messages: [Message.user('Weather?')] })
    expect(resp.finish_reason.reason).toBe('tool_calls')
    expect(resp.toolCalls).toHaveLength(1)
    expect(resp.toolCalls[0]!.name).toBe('get_weather')
    expect(resp.toolCalls[0]!.arguments).toEqual({ city: 'SF' })
  })

  it('maps usage fields from prompt_tokens/completion_tokens', async () => {
    vi.stubGlobal('fetch', mockFetch({
      ...makeChatResponse('Hi'),
      usage: { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 },
    }))
    const resp = await adapter.complete({ model: 'openai/gpt-4.5', messages: [Message.user('Hi')] })
    expect(resp.usage.input_tokens).toBe(25)
    expect(resp.usage.output_tokens).toBe(10)
    expect(resp.usage.total_tokens).toBe(35)
  })

  it('maps reasoning_tokens from completion_tokens_details', async () => {
    vi.stubGlobal('fetch', mockFetch({
      ...makeChatResponse('Hi'),
      usage: {
        prompt_tokens: 20,
        completion_tokens: 50,
        total_tokens: 70,
        completion_tokens_details: { reasoning_tokens: 30 },
      },
    }))
    const resp = await adapter.complete({ model: 'openai/gpt-4.5', messages: [Message.user('Hi')] })
    expect(resp.usage.reasoning_tokens).toBe(30)
  })

  it('maps cache_read_tokens from prompt_tokens_details', async () => {
    vi.stubGlobal('fetch', mockFetch({
      ...makeChatResponse('Hi'),
      usage: {
        prompt_tokens: 20,
        completion_tokens: 5,
        total_tokens: 25,
        prompt_tokens_details: { cached_tokens: 15 },
      },
    }))
    const resp = await adapter.complete({ model: 'openai/gpt-4.5', messages: [Message.user('Hi')] })
    expect(resp.usage.cache_read_tokens).toBe(15)
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('OpenRouterAdapter error handling', () => {
  let adapter: OpenRouterAdapter

  beforeEach(() => {
    adapter = makeOpenRouterAdapter()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('throws AuthenticationError on 401', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }, 401))
    await expect(adapter.complete({ model: 'test', messages: [Message.user('Hi')] })).rejects.toBeInstanceOf(AuthenticationError)
  })

  it('throws RateLimitError on 429 with retry-after header', async () => {
    vi.stubGlobal('fetch', mockFetch(
      { error: { message: 'Rate limit', code: 'rate_limit_exceeded' } },
      429,
      { 'retry-after': '10' },
    ))
    try {
      await adapter.complete({ model: 'test', messages: [Message.user('Hi')] })
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError)
      expect((e as RateLimitError).retry_after).toBe(10)
    }
  })

  it('throws ServerError on 500', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: { message: 'Server error' } }, 500))
    await expect(adapter.complete({ model: 'test', messages: [Message.user('Hi')] })).rejects.toBeInstanceOf(ServerError)
  })
})

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe('OpenRouterAdapter streaming', () => {
  let adapter: OpenRouterAdapter

  beforeEach(() => {
    adapter = makeOpenRouterAdapter()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('emits TEXT_START/DELTA/END and FINISH events', async () => {
    const lines = [
      `data: ${JSON.stringify({ id: 'chatcmpl-1', model: 'gpt-4.5', choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'world' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}`,
      'data: [DONE]',
    ]

    vi.stubGlobal('fetch', mockSSEFetch(lines))

    const events = []
    for await (const event of adapter.stream({ model: 'openai/gpt-4.5', messages: [Message.user('Hi')] })) {
      events.push(event)
    }

    const types = events.map(e => e.type)
    expect(types).toContain(StreamEventType.STREAM_START)
    expect(types).toContain(StreamEventType.TEXT_START)
    expect(types).toContain(StreamEventType.TEXT_DELTA)
    expect(types).toContain(StreamEventType.TEXT_END)
    expect(types).toContain(StreamEventType.FINISH)

    const deltas = events.filter(e => e.type === StreamEventType.TEXT_DELTA)
    expect(deltas.map(e => e.delta).join('')).toBe('Hello world')

    const finish = events.find(e => e.type === StreamEventType.FINISH)!
    expect(finish.finish_reason!.reason).toBe('stop')
  })

  it('emits TOOL_CALL events for streamed tool calls', async () => {
    const lines = [
      `data: ${JSON.stringify({ id: 'chatcmpl-2', model: 'gpt-4.5', choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ': "SF"}' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
      'data: [DONE]',
    ]

    vi.stubGlobal('fetch', mockSSEFetch(lines))

    const events = []
    for await (const event of adapter.stream({ model: 'openai/gpt-4.5', messages: [Message.user('Weather?')] })) {
      events.push(event)
    }

    const types = events.map(e => e.type)
    expect(types).toContain(StreamEventType.TOOL_CALL_START)
    expect(types).toContain(StreamEventType.TOOL_CALL_DELTA)
    expect(types).toContain(StreamEventType.TOOL_CALL_END)

    const start = events.find(e => e.type === StreamEventType.TOOL_CALL_START)!
    expect(start.tool_call!.name).toBe('get_weather')

    const end = events.find(e => e.type === StreamEventType.TOOL_CALL_END)!
    expect(end.tool_call!.arguments).toEqual({ city: 'SF' })
  })
})

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeChatResponse(content: string, finish_reason = 'stop') {
  return {
    id: 'chatcmpl-test123',
    object: 'chat.completion',
    model: 'gpt-4.5',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason,
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

function makeChatToolCallResponse() {
  return {
    id: 'chatcmpl-tool456',
    object: 'chat.completion',
    model: 'gpt-4.5',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"SF"}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
  }
}
