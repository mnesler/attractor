import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Client } from '../src/client.js'
import { generate, generateObject, executeAllTools } from '../src/generate.js'
import { AnthropicAdapter } from '../src/adapters/anthropic.js'
import { Message, Role, ContentKind } from '../src/types/message.js'
import { Response } from '../src/types/response.js'
import { zeroUsage } from '../src/types/response.js'
import { RateLimitError, InvalidRequestError, NoObjectGeneratedError } from '../src/types/errors.js'
import type { Tool, ToolCall } from '../src/types/tool.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockAdapter(responses: Response[]) {
  let idx = 0
  return {
    name: 'mock',
    async complete() {
      return responses[idx++]!
    },
    async *stream() {
      yield { type: 'stream_start' }
    },
  }
}

function makeTextResponse(text: string, opts: Partial<{
  id: string
  model: string
  provider: string
  finish_reason: { reason: 'stop' | 'tool_calls' }
  tool_calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
}> = {}): Response {
  const toolCallParts = (opts.tool_calls ?? []).map(tc => ({
    kind: ContentKind.TOOL_CALL,
    tool_call: { id: tc.id, name: tc.name, arguments: tc.arguments },
  }))

  const content = [
    ...(text ? [{ kind: ContentKind.TEXT, text }] : []),
    ...toolCallParts,
  ]

  return new Response({
    id: opts.id ?? 'resp_1',
    model: opts.model ?? 'claude-opus-4-6',
    provider: opts.provider ?? 'mock',
    message: new Message({ role: Role.ASSISTANT, content }),
    finish_reason: opts.finish_reason ?? { reason: 'stop' },
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })
}

function makeClient(responses: Response[]): Client {
  return new Client({
    providers: { mock: makeMockAdapter(responses) as never },
    default_provider: 'mock',
  })
}

// ---------------------------------------------------------------------------
// generate() validation
// ---------------------------------------------------------------------------

describe('generate() parameter validation', () => {
  it('throws when both prompt and messages provided', async () => {
    const client = makeClient([makeTextResponse('hi')])
    await expect(generate({
      model: 'test',
      prompt: 'hello',
      messages: [Message.user('hello')],
      client,
    })).rejects.toBeInstanceOf(InvalidRequestError)
  })

  it('throws when neither prompt nor messages provided', async () => {
    const client = makeClient([makeTextResponse('hi')])
    await expect(generate({
      model: 'test',
      client,
    } as never)).rejects.toBeInstanceOf(InvalidRequestError)
  })
})

// ---------------------------------------------------------------------------
// generate() basic usage
// ---------------------------------------------------------------------------

describe('generate() basic usage', () => {
  it('works with a simple prompt string', async () => {
    const client = makeClient([makeTextResponse('Hello!')])
    const result = await generate({ model: 'test', prompt: 'Hi', client })
    expect(result.text).toBe('Hello!')
    expect(result.steps).toHaveLength(1)
  })

  it('works with messages array', async () => {
    const client = makeClient([makeTextResponse('Howdy!')])
    const result = await generate({
      model: 'test',
      messages: [Message.user('Howdy partner')],
      client,
    })
    expect(result.text).toBe('Howdy!')
  })

  it('prepends system message when system param provided', async () => {
    let capturedRequest: unknown
    const adapter = {
      name: 'capture',
      async complete(req: unknown) {
        capturedRequest = req
        return makeTextResponse('hi')
      },
      async *stream() { yield { type: 'stream_start' } },
    }
    const client = new Client({ providers: { capture: adapter as never }, default_provider: 'capture' })
    await generate({ model: 'test', prompt: 'hello', system: 'Be helpful', client })

    const req = capturedRequest as { messages: Message[] }
    expect(req.messages[0]!.role).toBe(Role.SYSTEM)
    expect(req.messages[0]!.text).toBe('Be helpful')
  })

  it('aggregates total_usage across steps', async () => {
    const toolResp = makeTextResponse('', {
      finish_reason: { reason: 'tool_calls' },
      tool_calls: [{ id: 'call_1', name: 'echo', arguments: { msg: 'hi' } }],
    })
    const finalResp = makeTextResponse('Done')
    const client = makeClient([toolResp, finalResp])

    const result = await generate({
      model: 'test',
      prompt: 'Do something',
      client,
      tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object' }, execute: async (args) => args }],
      max_tool_rounds: 3,
    })

    expect(result.steps.length).toBeGreaterThanOrEqual(2)
    expect(result.total_usage.input_tokens).toBe(20) // 10 + 10
    expect(result.total_usage.output_tokens).toBe(10) // 5 + 5
  })
})

// ---------------------------------------------------------------------------
// Tool execution loop
// ---------------------------------------------------------------------------

describe('Tool execution loop', () => {
  it('executes active tools and continues loop', async () => {
    const toolResp = makeTextResponse('', {
      finish_reason: { reason: 'tool_calls' },
      tool_calls: [{ id: 'call_1', name: 'add', arguments: { a: 2, b: 3 } }],
    })
    const finalResp = makeTextResponse('The answer is 5.')
    const client = makeClient([toolResp, finalResp])

    const addTool: Tool = {
      name: 'add',
      description: 'Add two numbers',
      parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      execute: async (args) => (args['a'] as number) + (args['b'] as number),
    }

    const result = await generate({
      model: 'test',
      prompt: 'What is 2 + 3?',
      client,
      tools: [addTool],
      max_tool_rounds: 3,
    })

    expect(result.text).toBe('The answer is 5.')
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]!.tool_calls).toHaveLength(1)
    expect(result.steps[0]!.tool_results).toHaveLength(1)
    expect(result.steps[0]!.tool_results[0]!.content).toBe('5')
  })

  it('does not execute passive tools (no execute handler)', async () => {
    const toolResp = makeTextResponse('', {
      finish_reason: { reason: 'tool_calls' },
      tool_calls: [{ id: 'call_1', name: 'search', arguments: { query: 'test' } }],
    })
    const client = makeClient([toolResp])

    const searchTool: Tool = {
      name: 'search',
      description: 'Search the web',
      parameters: { type: 'object' },
      // No execute handler
    }

    const result = await generate({
      model: 'test',
      prompt: 'Search for something',
      client,
      tools: [searchTool],
      max_tool_rounds: 3,
    })

    // Should stop at first response (no execution = no continuation)
    expect(result.steps).toHaveLength(1)
    expect(result.tool_calls).toHaveLength(1)
    expect(result.tool_results).toHaveLength(0)
  })

  it('respects max_tool_rounds = 0 (no tool execution)', async () => {
    const toolResp = makeTextResponse('', {
      finish_reason: { reason: 'tool_calls' },
      tool_calls: [{ id: 'call_1', name: 'fn', arguments: {} }],
    })
    const client = makeClient([toolResp])

    const result = await generate({
      model: 'test',
      prompt: 'Do stuff',
      client,
      tools: [{ name: 'fn', description: 'fn', parameters: { type: 'object' }, execute: async () => 'done' }],
      max_tool_rounds: 0,
    })

    expect(result.steps).toHaveLength(1)
    expect(result.tool_results).toHaveLength(0)
  })

  it('stops at max_tool_rounds even if model keeps calling tools', async () => {
    const toolResp = makeTextResponse('', {
      finish_reason: { reason: 'tool_calls' },
      tool_calls: [{ id: 'call_1', name: 'fn', arguments: {} }],
    })
    // Return 5 tool responses — but max_tool_rounds = 2 means max 3 LLM calls total
    const client = makeClient([toolResp, toolResp, toolResp, toolResp, toolResp])

    const result = await generate({
      model: 'test',
      prompt: 'Do stuff',
      client,
      tools: [{ name: 'fn', description: 'fn', parameters: { type: 'object' }, execute: async () => 'ok' }],
      max_tool_rounds: 2,
    })

    expect(result.steps.length).toBeLessThanOrEqual(3)
  })

  it('sends tool error as is_error result on tool failure', async () => {
    const toolResp = makeTextResponse('', {
      finish_reason: { reason: 'tool_calls' },
      tool_calls: [{ id: 'call_1', name: 'fail_tool', arguments: {} }],
    })
    const finalResp = makeTextResponse('Tool failed, sorry.')
    const client = makeClient([toolResp, finalResp])

    const failTool: Tool = {
      name: 'fail_tool',
      description: 'always fails',
      parameters: { type: 'object' },
      execute: async () => { throw new Error('Something went wrong') },
    }

    const result = await generate({
      model: 'test',
      prompt: 'Run fail_tool',
      client,
      tools: [failTool],
      max_tool_rounds: 1,
    })

    expect(result.steps[0]!.tool_results[0]!.is_error).toBe(true)
    expect(result.steps[0]!.tool_results[0]!.content).toBe('Something went wrong')
  })
})

// ---------------------------------------------------------------------------
// executeAllTools
// ---------------------------------------------------------------------------

describe('executeAllTools', () => {
  it('executes all tools concurrently and returns results in order', async () => {
    const tools: Tool[] = [
      { name: 'a', description: 'a', parameters: { type: 'object' }, execute: async () => 'result_a' },
      { name: 'b', description: 'b', parameters: { type: 'object' }, execute: async () => 'result_b' },
    ]

    const calls: ToolCall[] = [
      { id: 'call_a', name: 'a', arguments: {} },
      { id: 'call_b', name: 'b', arguments: {} },
    ]

    const results = await executeAllTools(tools, calls)
    expect(results).toHaveLength(2)
    expect(results[0]!.tool_call_id).toBe('call_a')
    expect(results[0]!.content).toBe('result_a')
    expect(results[0]!.is_error).toBe(false)
    expect(results[1]!.tool_call_id).toBe('call_b')
    expect(results[1]!.content).toBe('result_b')
  })

  it('returns error result for unknown tools', async () => {
    const tools: Tool[] = [{ name: 'known', description: 'k', parameters: { type: 'object' } }]
    const calls: ToolCall[] = [{ id: 'call_1', name: 'unknown_tool', arguments: {} }]

    const results = await executeAllTools(tools, calls)
    expect(results[0]!.is_error).toBe(true)
    expect(results[0]!.content).toContain('Unknown tool')
  })

  it('returns error result when tool throws', async () => {
    const tools: Tool[] = [{
      name: 'boom',
      description: 'explodes',
      parameters: { type: 'object' },
      execute: async () => { throw new Error('BOOM') },
    }]
    const calls: ToolCall[] = [{ id: 'call_1', name: 'boom', arguments: {} }]

    const results = await executeAllTools(tools, calls)
    expect(results[0]!.is_error).toBe(true)
    expect(results[0]!.content).toBe('BOOM')
  })

  it('handles mixed success and failure preserving order', async () => {
    const tools: Tool[] = [
      { name: 'ok', description: 'ok', parameters: { type: 'object' }, execute: async () => 'fine' },
      { name: 'bad', description: 'bad', parameters: { type: 'object' }, execute: async () => { throw new Error('fail') } },
      { name: 'ok2', description: 'ok2', parameters: { type: 'object' }, execute: async () => 'also fine' },
    ]
    const calls: ToolCall[] = [
      { id: 'c1', name: 'ok', arguments: {} },
      { id: 'c2', name: 'bad', arguments: {} },
      { id: 'c3', name: 'ok2', arguments: {} },
    ]

    const results = await executeAllTools(tools, calls)
    expect(results).toHaveLength(3)
    expect(results[0]!.is_error).toBe(false)
    expect(results[1]!.is_error).toBe(true)
    expect(results[2]!.is_error).toBe(false)
    expect(results[0]!.tool_call_id).toBe('c1')
    expect(results[1]!.tool_call_id).toBe('c2')
    expect(results[2]!.tool_call_id).toBe('c3')
  })
})

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

describe('Retry logic in generate()', () => {
  it('retries on transient RateLimitError', async () => {
    let callCount = 0
    const adapter = {
      name: 'flaky',
      async complete() {
        callCount++
        if (callCount < 3) {
          throw new RateLimitError({ message: 'Rate limited', provider: 'test', retry_after: 0 })
        }
        return makeTextResponse('Finally!')
      },
      async *stream() { yield { type: 'stream_start' } },
    }

    const client = new Client({ providers: { flaky: adapter as never }, default_provider: 'flaky' })
    const result = await generate({
      model: 'test',
      prompt: 'Hello',
      client,
      max_retries: 3,
    })

    expect(result.text).toBe('Finally!')
    expect(callCount).toBe(3)
  })

  it('does not retry non-retryable errors', async () => {
    let callCount = 0
    const adapter = {
      name: 'auth_fail',
      async complete() {
        callCount++
        throw new InvalidRequestError({ message: 'Bad request', provider: 'test' })
      },
      async *stream() { yield { type: 'stream_start' } },
    }

    const client = new Client({ providers: { auth_fail: adapter as never }, default_provider: 'auth_fail' })
    await expect(generate({ model: 'test', prompt: 'Hello', client, max_retries: 3 }))
      .rejects.toBeInstanceOf(InvalidRequestError)

    expect(callCount).toBe(1) // No retries
  })
})

// ---------------------------------------------------------------------------
// generate_object()
// ---------------------------------------------------------------------------

describe('generateObject()', () => {
  it('returns parsed JSON output', async () => {
    const client = makeClient([makeTextResponse('{"name": "Alice", "age": 30}')])
    const result = await generateObject({
      model: 'test',
      prompt: "Extract: Alice is 30 years old",
      client,
      schema: {
        type: 'object',
        properties: { name: { type: 'string' }, age: { type: 'integer' } },
        required: ['name', 'age'],
      },
    })
    expect(result.output).toEqual({ name: 'Alice', age: 30 })
  })

  it('strips markdown code blocks before parsing', async () => {
    const client = makeClient([makeTextResponse('```json\n{"name": "Bob", "age": 25}\n```')])
    const result = await generateObject({
      model: 'test',
      prompt: "Extract",
      client,
      schema: { type: 'object' },
    })
    expect(result.output).toEqual({ name: 'Bob', age: 25 })
  })

  it('throws NoObjectGeneratedError on invalid JSON', async () => {
    const client = makeClient([makeTextResponse('This is not JSON!')])
    await expect(generateObject({
      model: 'test',
      prompt: "Extract",
      client,
      schema: { type: 'object' },
    })).rejects.toBeInstanceOf(NoObjectGeneratedError)
  })
})

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

describe('Client configuration', () => {
  it('throws ConfigurationError when no provider is configured', async () => {
    const { ConfigurationError } = await import('../src/types/errors.js')
    const client = new Client({ providers: {} })
    await expect(client.complete({
      model: 'test',
      messages: [Message.user('Hi')],
    })).rejects.toBeInstanceOf(ConfigurationError)
  })

  it('routes to correct provider by name', async () => {
    let usedProvider = ''
    const adapterA = {
      name: 'providerA',
      async complete(req: unknown) { usedProvider = 'A'; return makeTextResponse('from A') },
      async *stream() { yield { type: 'test' } },
    }
    const adapterB = {
      name: 'providerB',
      async complete(req: unknown) { usedProvider = 'B'; return makeTextResponse('from B') },
      async *stream() { yield { type: 'test' } },
    }

    const client = new Client({
      providers: { providerA: adapterA as never, providerB: adapterB as never },
      default_provider: 'providerA',
    })

    await client.complete({ model: 'test', messages: [Message.user('Hi')], provider: 'providerB' })
    expect(usedProvider).toBe('B')
  })

  it('middleware runs in registration order (request) and reverse (response)', async () => {
    const log: string[] = []
    const mw1 = async (req: unknown, next: (req: unknown) => Promise<Response>) => {
      log.push('mw1-req')
      const resp = await next(req as never)
      log.push('mw1-resp')
      return resp
    }
    const mw2 = async (req: unknown, next: (req: unknown) => Promise<Response>) => {
      log.push('mw2-req')
      const resp = await next(req as never)
      log.push('mw2-resp')
      return resp
    }

    const client = new Client({
      providers: { mock: makeMockAdapter([makeTextResponse('hi')]) as never },
      default_provider: 'mock',
      middleware: [mw1 as never, mw2 as never],
    })

    await client.complete({ model: 'test', messages: [Message.user('hi')] })

    // Request phase: mw1 then mw2 (registration order)
    // Response phase: mw2-resp then mw1-resp (reverse order)
    expect(log).toEqual(['mw1-req', 'mw2-req', 'mw2-resp', 'mw1-resp'])
  })
})
