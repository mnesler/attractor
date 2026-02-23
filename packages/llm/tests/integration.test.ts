/**
 * Integration tests — real API calls.
 * These are skipped by default; run with:
 *   ANTHROPIC_API_KEY=sk-... OPENROUTER_API_KEY=sk-or-... npm run test:integration
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { Client } from '../src/client.js'
import { AnthropicAdapter } from '../src/adapters/anthropic.js'
import { OpenRouterAdapter } from '../src/adapters/openrouter.js'
import { generate, generateObject, executeAllTools } from '../src/generate.js'
import { Message } from '../src/types/message.js'
import { StreamEventType } from '../src/types/stream.js'
import type { Tool } from '../src/types/tool.js'

const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY']
const OPENROUTER_KEY = process.env['OPENROUTER_API_KEY']
const skipAnthropicTests = !ANTHROPIC_KEY
const skipOpenRouterTests = !OPENROUTER_KEY

describe('Anthropic integration', () => {
  let client: Client

  beforeAll(() => {
    if (skipAnthropicTests) return
    client = new Client({
      providers: {
        anthropic: new AnthropicAdapter({ api_key: ANTHROPIC_KEY! }),
      },
      default_provider: 'anthropic',
    })
  })

  it.skipIf(skipAnthropicTests)('generates a simple text response', async () => {
    const result = await generate({
      model: 'claude-opus-4-6',
      prompt: 'Say "hello" and nothing else.',
      max_tokens: 10,
      client,
    })
    expect(result.text.toLowerCase()).toContain('hello')
    expect(result.usage.input_tokens).toBeGreaterThan(0)
    expect(result.usage.output_tokens).toBeGreaterThan(0)
  })

  it.skipIf(skipAnthropicTests)('streams text deltas', async () => {
    const resp = await client.complete({
      model: 'claude-opus-4-6',
      messages: [Message.user('Count from 1 to 5, one number per line.')],
      max_tokens: 50,
    })

    // Use streaming
    const textParts: string[] = []
    for await (const event of client.stream({
      model: 'claude-opus-4-6',
      messages: [Message.user('Count from 1 to 5.')],
      max_tokens: 50,
    })) {
      if (event.type === StreamEventType.TEXT_DELTA && event.delta) {
        textParts.push(event.delta)
      }
    }

    expect(textParts.length).toBeGreaterThan(0)
    const fullText = textParts.join('')
    expect(fullText).toContain('1')
  })

  it.skipIf(skipAnthropicTests)('executes a single tool call', async () => {
    const weatherTool: Tool = {
      name: 'get_weather',
      description: 'Get the current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name' },
        },
        required: ['location'],
      },
      execute: async (args) => `72°F and sunny in ${args['location']}`,
    }

    const result = await generate({
      model: 'claude-opus-4-6',
      prompt: 'What is the weather in San Francisco?',
      tools: [weatherTool],
      max_tool_rounds: 3,
      max_tokens: 300,
      client,
    })

    expect(result.text).toBeTruthy()
    expect(result.total_usage.input_tokens).toBeGreaterThan(0)
    // Should have used the weather tool
    const usedTool = result.steps.some(s => s.tool_calls.length > 0)
    expect(usedTool).toBe(true)
  })

  it.skipIf(skipAnthropicTests)('generates structured output', async () => {
    const result = await generateObject({
      model: 'claude-opus-4-6',
      prompt: "Extract: Alice is 30 years old and works as an engineer.",
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
          job: { type: 'string' },
        },
        required: ['name', 'age', 'job'],
      },
      max_tokens: 200,
      client,
    })

    expect(result.output).toMatchObject({
      name: 'Alice',
      age: 30,
    })
  })

  it.skipIf(skipAnthropicTests)('prompt caching works (cache tokens reported on turn 2+)', async () => {
    const systemPrompt = 'You are a helpful assistant. '.repeat(100) // Long system prompt for caching

    const resp1 = await client.complete({
      model: 'claude-opus-4-6',
      messages: [Message.system(systemPrompt), Message.user('Say hi.')],
      max_tokens: 20,
    })

    // Second request with same system prompt should show cache hits
    const resp2 = await client.complete({
      model: 'claude-opus-4-6',
      messages: [Message.system(systemPrompt), Message.user('Say bye.')],
      max_tokens: 20,
    })

    // Cache write on first request, cache read on second
    expect(resp1.usage.cache_write_tokens).toBeGreaterThan(0)
    expect(resp2.usage.cache_read_tokens).toBeGreaterThan(0)
  })
})

describe('OpenRouter integration', () => {
  let client: Client

  beforeAll(() => {
    if (skipOpenRouterTests) return
    client = new Client({
      providers: {
        openrouter: new OpenRouterAdapter({
          api_key: OPENROUTER_KEY!,
          default_headers: {
            'HTTP-Referer': 'https://github.com/test',
            'X-Title': 'Integration Test',
          },
        }),
      },
      default_provider: 'openrouter',
    })
  })

  it.skipIf(skipOpenRouterTests)('generates a response via OpenRouter', async () => {
    const result = await generate({
      model: 'anthropic/claude-sonnet-4-5',
      prompt: 'Say "hello" and nothing else.',
      max_tokens: 10,
      client,
    })
    expect(result.text.toLowerCase()).toContain('hello')
    expect(result.usage.input_tokens).toBeGreaterThan(0)
  })

  it.skipIf(skipOpenRouterTests)('streams via OpenRouter', async () => {
    const deltas: string[] = []
    for await (const event of client.stream({
      model: 'anthropic/claude-sonnet-4-5',
      messages: [Message.user('Say "hi" and nothing else.')],
      max_tokens: 10,
    })) {
      if (event.type === StreamEventType.TEXT_DELTA && event.delta) {
        deltas.push(event.delta)
      }
    }
    expect(deltas.length).toBeGreaterThan(0)
  })
})
