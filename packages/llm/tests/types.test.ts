import { describe, it, expect } from 'vitest'
import {
  Message,
  Role,
  ContentKind,
  Response,
  Usage,
  addUsage,
  zeroUsage,
  FinishReason,
  StreamAccumulator,
  StreamEventType,
  getModelInfo,
  listModels,
  getLatestModel,
  SDKError,
  ProviderError,
  AuthenticationError,
  RateLimitError,
  ConfigurationError,
  ServerError,
  InvalidRequestError,
  ContentFilterError,
  errorFromStatus,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

describe('Message factory methods', () => {
  it('creates a system message', () => {
    const m = Message.system('You are helpful.')
    expect(m.role).toBe(Role.SYSTEM)
    expect(m.content).toHaveLength(1)
    expect(m.content[0]!.kind).toBe(ContentKind.TEXT)
    expect(m.content[0]!.text).toBe('You are helpful.')
    expect(m.text).toBe('You are helpful.')
  })

  it('creates a user message', () => {
    const m = Message.user('Hello!')
    expect(m.role).toBe(Role.USER)
    expect(m.text).toBe('Hello!')
  })

  it('creates an assistant message', () => {
    const m = Message.assistant('Hi there!')
    expect(m.role).toBe(Role.ASSISTANT)
    expect(m.text).toBe('Hi there!')
  })

  it('creates a tool result message', () => {
    const m = Message.toolResult({
      tool_call_id: 'call_123',
      content: 'The weather is sunny.',
      is_error: false,
    })
    expect(m.role).toBe(Role.TOOL)
    expect(m.tool_call_id).toBe('call_123')
    expect(m.content[0]!.kind).toBe(ContentKind.TOOL_RESULT)
    expect(m.content[0]!.tool_result!.content).toBe('The weather is sunny.')
    expect(m.content[0]!.tool_result!.is_error).toBe(false)
  })

  it('creates a tool result with is_error=true', () => {
    const m = Message.toolResult({
      tool_call_id: 'call_456',
      content: 'Error: API failed',
      is_error: true,
    })
    expect(m.content[0]!.tool_result!.is_error).toBe(true)
  })

  it('.text returns empty string for messages with no text parts', () => {
    const m = new Message({
      role: Role.ASSISTANT,
      content: [{ kind: ContentKind.TOOL_CALL, tool_call: { id: 'c1', name: 'fn', arguments: {} } }],
    })
    expect(m.text).toBe('')
  })

  it('.text concatenates multiple text parts', () => {
    const m = new Message({
      role: Role.ASSISTANT,
      content: [
        { kind: ContentKind.TEXT, text: 'Hello ' },
        { kind: ContentKind.TEXT, text: 'world' },
      ],
    })
    expect(m.text).toBe('Hello world')
  })
})

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

describe('Usage addition', () => {
  it('adds two usage objects', () => {
    const a: Usage = { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
    const b: Usage = { input_tokens: 5, output_tokens: 15, total_tokens: 20 }
    const result = addUsage(a, b)
    expect(result.input_tokens).toBe(15)
    expect(result.output_tokens).toBe(35)
    expect(result.total_tokens).toBe(50)
  })

  it('sums optional fields when both are present', () => {
    const a: Usage = { input_tokens: 10, output_tokens: 20, total_tokens: 30, reasoning_tokens: 5 }
    const b: Usage = { input_tokens: 5, output_tokens: 15, total_tokens: 20, reasoning_tokens: 10 }
    const result = addUsage(a, b)
    expect(result.reasoning_tokens).toBe(15)
  })

  it('treats None as 0 for optional fields', () => {
    const a: Usage = { input_tokens: 10, output_tokens: 20, total_tokens: 30, reasoning_tokens: 5 }
    const b: Usage = { input_tokens: 5, output_tokens: 15, total_tokens: 20 }
    const result = addUsage(a, b)
    expect(result.reasoning_tokens).toBe(5)
  })

  it('returns undefined for optional fields when both are undefined', () => {
    const a: Usage = { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
    const b: Usage = { input_tokens: 5, output_tokens: 15, total_tokens: 20 }
    const result = addUsage(a, b)
    expect(result.reasoning_tokens).toBeUndefined()
  })

  it('zeroUsage returns zero values', () => {
    const z = zeroUsage()
    expect(z.input_tokens).toBe(0)
    expect(z.output_tokens).toBe(0)
    expect(z.total_tokens).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Response convenience accessors
// ---------------------------------------------------------------------------

describe('Response accessors', () => {
  const makeResponse = (content: Message['content']) =>
    new Response({
      id: 'resp_1',
      model: 'claude-opus-4-6',
      provider: 'anthropic',
      message: new Message({ role: Role.ASSISTANT, content }),
      finish_reason: { reason: 'stop' },
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    })

  it('.text returns concatenated text', () => {
    const r = makeResponse([
      { kind: ContentKind.TEXT, text: 'Hello ' },
      { kind: ContentKind.TEXT, text: 'world' },
    ])
    expect(r.text).toBe('Hello world')
  })

  it('.toolCalls extracts tool calls', () => {
    const r = makeResponse([
      {
        kind: ContentKind.TOOL_CALL,
        tool_call: { id: 'call_1', name: 'get_weather', arguments: { city: 'SF' } },
      },
    ])
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]!.id).toBe('call_1')
    expect(r.toolCalls[0]!.name).toBe('get_weather')
    expect(r.toolCalls[0]!.arguments).toEqual({ city: 'SF' })
  })

  it('.toolCalls parses JSON string arguments', () => {
    const r = makeResponse([
      {
        kind: ContentKind.TOOL_CALL,
        tool_call: { id: 'call_1', name: 'fn', arguments: '{"x": 42}' },
      },
    ])
    expect(r.toolCalls[0]!.arguments).toEqual({ x: 42 })
  })

  it('.reasoning returns thinking text', () => {
    const r = makeResponse([
      {
        kind: ContentKind.THINKING,
        thinking: { text: 'Let me think...', redacted: false },
      },
    ])
    expect(r.reasoning).toBe('Let me think...')
  })

  it('.reasoning returns undefined when no thinking blocks', () => {
    const r = makeResponse([{ kind: ContentKind.TEXT, text: 'Hello' }])
    expect(r.reasoning).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// StreamAccumulator
// ---------------------------------------------------------------------------

describe('StreamAccumulator', () => {
  it('accumulates text deltas into a response', () => {
    const acc = new StreamAccumulator()
    acc.setMeta({ id: 'resp_1', model: 'claude-opus-4-6', provider: 'anthropic' })

    acc.process({ type: StreamEventType.TEXT_START, text_id: '0' })
    acc.process({ type: StreamEventType.TEXT_DELTA, text_id: '0', delta: 'Hello ' })
    acc.process({ type: StreamEventType.TEXT_DELTA, text_id: '0', delta: 'world' })
    acc.process({ type: StreamEventType.TEXT_END, text_id: '0' })
    acc.process({
      type: StreamEventType.FINISH,
      finish_reason: { reason: 'stop' },
      usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
    })

    const response = acc.response()
    expect(response.id).toBe('resp_1')
    expect(response.text).toBe('Hello world')
    expect(response.finish_reason.reason).toBe('stop')
    expect(response.usage.output_tokens).toBe(10)
  })

  it('accumulates tool call deltas', () => {
    const acc = new StreamAccumulator()

    acc.process({
      type: StreamEventType.TOOL_CALL_START,
      tool_call: { id: 'call_1', name: 'get_weather' },
    })
    acc.process({
      type: StreamEventType.TOOL_CALL_DELTA,
      tool_call: { id: 'call_1', raw_arguments: '{"city"' },
    })
    acc.process({
      type: StreamEventType.TOOL_CALL_DELTA,
      tool_call: { id: 'call_1', raw_arguments: ': "SF"}' },
    })
    acc.process({
      type: StreamEventType.FINISH,
      finish_reason: { reason: 'tool_calls' },
      usage: zeroUsage(),
    })

    const response = acc.response()
    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls[0]!.arguments).toEqual({ city: 'SF' })
  })

  it('uses full response from FINISH event when provided', () => {
    const acc = new StreamAccumulator()
    const fullResponse = new Response({
      id: 'resp_full',
      model: 'test',
      provider: 'anthropic',
      message: Message.assistant('Done'),
      finish_reason: { reason: 'stop' },
      usage: zeroUsage(),
    })

    acc.process({ type: StreamEventType.FINISH, response: fullResponse })
    expect(acc.response()).toBe(fullResponse)
  })
})

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------

describe('Error hierarchy', () => {
  it('SDKError is instance of Error', () => {
    const e = new SDKError('test')
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('test')
  })

  it('ProviderError carries provider metadata', () => {
    const e = new ProviderError({
      message: 'fail',
      provider: 'anthropic',
      status_code: 401,
      retryable: false,
    })
    expect(e.provider).toBe('anthropic')
    expect(e.status_code).toBe(401)
    expect(e.retryable).toBe(false)
    expect(e).toBeInstanceOf(SDKError)
  })

  it('AuthenticationError is not retryable', () => {
    const e = new AuthenticationError({ message: 'bad key', provider: 'anthropic' })
    expect(e.retryable).toBe(false)
  })

  it('RateLimitError is retryable', () => {
    const e = new RateLimitError({ message: 'too many', provider: 'openrouter' })
    expect(e.retryable).toBe(true)
  })

  it('ConfigurationError is not retryable', () => {
    const e = new ConfigurationError('no provider')
    expect(e.retryable).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// errorFromStatus
// ---------------------------------------------------------------------------

describe('errorFromStatus', () => {
  const base = { provider: 'test', raw: {} }

  it('maps 401 to AuthenticationError', () => {
    const e = errorFromStatus({ status: 401, message: 'Unauthorized', ...base })
    expect(e).toBeInstanceOf(AuthenticationError)
    expect((e as ProviderError).retryable).toBe(false)
  })

  it('maps 429 to RateLimitError', () => {
    const e = errorFromStatus({ status: 429, message: 'Rate limit', ...base })
    expect(e).toBeInstanceOf(RateLimitError)
    expect((e as ProviderError).retryable).toBe(true)
  })

  it('maps 500 to ServerError (retryable)', () => {
    const e = errorFromStatus({ status: 500, message: 'Internal error', ...base })
    expect(e).toBeInstanceOf(ServerError)
    expect((e as ProviderError).retryable).toBe(true)
  })

  it('maps 400 to InvalidRequestError', () => {
    const e = errorFromStatus({ status: 400, message: 'Bad request', ...base })
    expect(e).toBeInstanceOf(InvalidRequestError)
  })

  it('classifies by message content for content_filter', () => {
    const e = errorFromStatus({ status: 400, message: 'content filter triggered', ...base })
    expect(e).toBeInstanceOf(ContentFilterError)
  })
})

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

describe('Model catalog', () => {
  it('getModelInfo returns model by id', () => {
    const m = getModelInfo('claude-opus-4-6')
    expect(m).not.toBeUndefined()
    expect(m!.provider).toBe('anthropic')
    expect(m!.supports_reasoning).toBe(true)
  })

  it('getModelInfo returns undefined for unknown model', () => {
    expect(getModelInfo('totally-fake-model-xyz')).toBeUndefined()
  })

  it('listModels returns all models', () => {
    const all = listModels()
    expect(all.length).toBeGreaterThan(0)
  })

  it('listModels filters by provider', () => {
    const anthropic = listModels('anthropic')
    expect(anthropic.every(m => m.provider === 'anthropic')).toBe(true)
    expect(anthropic.length).toBeGreaterThan(0)
  })

  it('getLatestModel returns best model for provider', () => {
    const m = getLatestModel('anthropic')
    expect(m).not.toBeUndefined()
    expect(m!.provider).toBe('anthropic')
  })

  it('getLatestModel filters by reasoning capability', () => {
    const m = getLatestModel('anthropic', 'reasoning')
    expect(m).not.toBeUndefined()
    expect(m!.supports_reasoning).toBe(true)
  })
})
