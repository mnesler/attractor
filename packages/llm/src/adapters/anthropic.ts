import { Message, Role, ContentKind, ContentPart } from '../types/message.js'
import type { Request } from '../types/request.js'
import { Response, FinishReason, Usage, RateLimitInfo, Warning } from '../types/response.js'
import { StreamEvent, StreamEventType } from '../types/stream.js'
import type { Tool } from '../types/tool.js'
import { errorFromStatus, NetworkError } from '../types/errors.js'
import { createSSEStream } from '../sse.js'

const ANTHROPIC_API_URL = 'https://api.anthropic.com'
const ANTHROPIC_VERSION = '2023-06-01'

// Reasoning effort → budget_tokens mapping
const REASONING_EFFORT_TOKENS: Record<string, number> = {
  low: 1024,
  medium: 8000,
  high: 32000,
}

export interface AnthropicAdapterOptions {
  api_key: string
  base_url?: string
  default_headers?: Record<string, string>
}

export class AnthropicAdapter {
  readonly name = 'anthropic'
  private api_key: string
  private base_url: string
  private default_headers: Record<string, string>

  constructor(options: AnthropicAdapterOptions) {
    this.api_key = options.api_key
    this.base_url = (options.base_url ?? ANTHROPIC_API_URL).replace(/\/$/, '')
    this.default_headers = options.default_headers ?? {}
  }

  async complete(request: Request): Promise<Response> {
    const { body, headers } = this.buildRequest(request, false)

    let httpResponse: globalThis.Response
    try {
      httpResponse = await fetch(`${this.base_url}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: (request.provider_options?.['anthropic'] as Record<string, unknown>)
          ?.abort_signal as AbortSignal | undefined,
      })
    } catch (err) {
      throw new NetworkError(`Anthropic request failed: ${String(err)}`, err instanceof Error ? err : undefined)
    }

    if (!httpResponse.ok) {
      await this.throwHttpError(httpResponse)
    }

    const data = await httpResponse.json() as Record<string, unknown>
    return this.translateResponse(data, httpResponse.headers)
  }

  async *stream(request: Request): AsyncGenerator<StreamEvent> {
    const { body, headers } = this.buildRequest(request, true)

    let httpResponse: globalThis.Response
    try {
      httpResponse = await fetch(`${this.base_url}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: (request.provider_options?.['anthropic'] as Record<string, unknown>)
          ?.abort_signal as AbortSignal | undefined,
      })
    } catch (err) {
      throw new NetworkError(`Anthropic stream request failed: ${String(err)}`, err instanceof Error ? err : undefined)
    }

    if (!httpResponse.ok) {
      await this.throwHttpError(httpResponse)
    }

    yield* this.translateStream(httpResponse)
  }

  private buildRequest(
    request: Request,
    stream: boolean,
  ): { body: Record<string, unknown>; headers: Record<string, string> } {
    const anthropicOpts = (request.provider_options?.['anthropic'] ?? {}) as Record<string, unknown>
    const autoCache = anthropicOpts['auto_cache'] !== false

    // Separate system/developer messages from conversation
    const systemBlocks: unknown[] = []
    const conversationMessages: Message[] = []

    for (const msg of request.messages) {
      if (msg.role === Role.SYSTEM || msg.role === Role.DEVELOPER) {
        for (const part of msg.content) {
          if (part.kind === ContentKind.TEXT && part.text != null) {
            systemBlocks.push({ type: 'text', text: part.text })
          }
        }
      } else {
        conversationMessages.push(msg)
      }
    }

    // Inject cache_control on last system block
    if (autoCache && systemBlocks.length > 0) {
      const last = systemBlocks[systemBlocks.length - 1] as Record<string, unknown>
      systemBlocks[systemBlocks.length - 1] = { ...last, cache_control: { type: 'ephemeral' } }
    }

    // Merge consecutive same-role messages (strict alternation requirement)
    const mergedMessages = mergeConsecutiveRoles(conversationMessages)

    // Inject cache_control on last human turn (last user message)
    if (autoCache) {
      injectCacheControlOnLastUserMessage(mergedMessages)
    }

    // Translate messages
    const messages = mergedMessages.map(msg => this.translateMessage(msg))

    // Translate tools
    let tools: unknown[] | undefined
    let toolChoice: unknown | undefined

    if (request.tools && request.tools.length > 0 && request.tool_choice?.mode !== 'none') {
      tools = request.tools.map(t => translateToolDefinition(t))

      // Inject cache_control on last tool definition
      if (autoCache && tools.length > 0) {
        const last = tools[tools.length - 1] as Record<string, unknown>
        tools[tools.length - 1] = { ...last, cache_control: { type: 'ephemeral' } }
      }

      toolChoice = translateToolChoice(request.tool_choice)
    }

    // Build body
    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens ?? 4096,
    }

    if (systemBlocks.length > 0) {
      body['system'] = systemBlocks
    }

    if (tools) body['tools'] = tools
    if (toolChoice) body['tool_choice'] = toolChoice
    if (request.temperature != null) body['temperature'] = request.temperature
    if (request.top_p != null) body['top_p'] = request.top_p
    if (request.stop_sequences?.length) body['stop_sequences'] = request.stop_sequences
    if (stream) body['stream'] = true

    // reasoning_effort → thinking parameter
    if (request.reasoning_effort && request.reasoning_effort !== 'none') {
      const budget = REASONING_EFFORT_TOKENS[request.reasoning_effort] ?? 8000
      body['thinking'] = { type: 'enabled', budget_tokens: budget }
    }

    // Merge provider_options.anthropic overrides (excluding known keys)
    const excluded = new Set(['beta_headers', 'auto_cache', 'abort_signal'])
    for (const [k, v] of Object.entries(anthropicOpts)) {
      if (!excluded.has(k)) body[k] = v
    }

    // Build headers
    const betaHeaders: string[] = []

    // Auto-add prompt caching beta if auto_cache is on and we have system blocks or tools
    if (autoCache && (systemBlocks.length > 0 || tools)) {
      betaHeaders.push('prompt-caching-2024-07-31')
    }

    // User-supplied beta headers
    const userBeta = anthropicOpts['beta_headers'] as string[] | undefined
    if (userBeta) betaHeaders.push(...userBeta)

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.api_key,
      'anthropic-version': ANTHROPIC_VERSION,
      ...this.default_headers,
    }

    if (betaHeaders.length > 0) {
      headers['anthropic-beta'] = [...new Set(betaHeaders)].join(',')
    }

    return { body, headers }
  }

  private translateMessage(msg: Message): Record<string, unknown> {
    if (msg.role === Role.TOOL) {
      // Tool results → user message with tool_result content blocks
      const content = msg.content
        .filter(p => p.kind === ContentKind.TOOL_RESULT && p.tool_result)
        .map(p => {
          const tr = p.tool_result!
          return {
            type: 'tool_result',
            tool_use_id: tr.tool_call_id,
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
            is_error: tr.is_error,
          }
        })
      return { role: 'user', content }
    }

    const role = msg.role === Role.USER ? 'user' : 'assistant'
    const content = msg.content.map(p => this.translateContentPart(p)).filter(Boolean)
    return { role, content }
  }

  private translateContentPart(part: ContentPart): Record<string, unknown> | null {
    switch (part.kind) {
      case ContentKind.TEXT:
        return { type: 'text', text: part.text ?? '' }

      case ContentKind.IMAGE: {
        const img = part.image
        if (!img) return null
        if (img.url && !isLocalPath(img.url)) {
          return { type: 'image', source: { type: 'url', url: img.url } }
        }
        if (img.data) {
          const b64 = uint8ArrayToBase64(img.data)
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.media_type ?? 'image/png',
              data: b64,
            },
          }
        }
        // Local file path — read it (in sync context we can't, so treat as URL for now)
        if (img.url) {
          return { type: 'image', source: { type: 'url', url: img.url } }
        }
        return null
      }

      case ContentKind.TOOL_CALL: {
        const tc = part.tool_call
        if (!tc) return null
        const input = typeof tc.arguments === 'string'
          ? (() => { try { return JSON.parse(tc.arguments) } catch { return {} } })()
          : tc.arguments
        return { type: 'tool_use', id: tc.id, name: tc.name, input }
      }

      case ContentKind.THINKING: {
        const th = part.thinking
        if (!th) return null
        return { type: 'thinking', thinking: th.text, signature: th.signature ?? '' }
      }

      case ContentKind.REDACTED_THINKING: {
        const th = part.thinking
        if (!th) return null
        return { type: 'redacted_thinking', data: th.text }
      }

      default:
        return null
    }
  }

  private translateResponse(
    data: Record<string, unknown>,
    headers: Headers,
  ): Response {
    const content = (data['content'] as unknown[]) ?? []
    const contentParts: ContentPart[] = content.map(block => translateContentBlock(block as Record<string, unknown>)).filter((p): p is ContentPart => p != null)

    const message = new Message({ role: Role.ASSISTANT, content: contentParts })

    const stopReason = data['stop_reason'] as string | undefined
    const finish_reason = translateFinishReason(stopReason)

    const rawUsage = (data['usage'] ?? {}) as Record<string, number>
    const usage: Usage = {
      input_tokens: rawUsage['input_tokens'] ?? 0,
      output_tokens: rawUsage['output_tokens'] ?? 0,
      total_tokens: (rawUsage['input_tokens'] ?? 0) + (rawUsage['output_tokens'] ?? 0),
      cache_read_tokens: rawUsage['cache_read_input_tokens'] ?? undefined,
      cache_write_tokens: rawUsage['cache_creation_input_tokens'] ?? undefined,
      raw: rawUsage,
    }

    const rate_limit = parseRateLimitHeaders(headers)
    const warnings: Warning[] = []

    return new Response({
      id: (data['id'] as string) ?? '',
      model: (data['model'] as string) ?? '',
      provider: 'anthropic',
      message,
      finish_reason,
      usage,
      raw: data,
      warnings,
      rate_limit,
    })
  }

  async *translateStream(httpResponse: globalThis.Response): AsyncGenerator<StreamEvent> {
    const accumulator = {
      id: '',
      model: '',
      inputTokens: 0,
      blocks: new Map<number, { type: string; id?: string; name?: string; text: string; signature?: string }>(),
    }

    let finishReason: FinishReason | undefined
    let usage: Usage | undefined
    let rateLimit: RateLimitInfo | undefined

    yield { type: StreamEventType.STREAM_START }

    for await (const { event, data } of createSSEStream(httpResponse)) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(data) as Record<string, unknown>
      } catch {
        continue
      }

      const eventType = event ?? (parsed['type'] as string)

      switch (eventType) {
        case 'message_start': {
          const msg = (parsed['message'] ?? {}) as Record<string, unknown>
          accumulator.id = (msg['id'] as string) ?? ''
          accumulator.model = (msg['model'] as string) ?? ''
          const rawUsage = (msg['usage'] ?? {}) as Record<string, number>
          accumulator.inputTokens = rawUsage['input_tokens'] ?? 0
          rateLimit = parseRateLimitHeaders(httpResponse.headers)
          break
        }

        case 'content_block_start': {
          const idx = parsed['index'] as number
          const block = (parsed['content_block'] ?? {}) as Record<string, unknown>
          const blockType = block['type'] as string

          if (blockType === 'text') {
            accumulator.blocks.set(idx, { type: 'text', text: '' })
            yield { type: StreamEventType.TEXT_START, text_id: String(idx) }
          } else if (blockType === 'tool_use') {
            const toolId = (block['id'] as string) ?? `tool_${idx}`
            const toolName = (block['name'] as string) ?? ''
            accumulator.blocks.set(idx, { type: 'tool_use', id: toolId, name: toolName, text: '' })
            yield {
              type: StreamEventType.TOOL_CALL_START,
              tool_call: { id: toolId, name: toolName },
            }
          } else if (blockType === 'thinking') {
            accumulator.blocks.set(idx, { type: 'thinking', text: '' })
            yield { type: StreamEventType.REASONING_START }
          }
          break
        }

        case 'content_block_delta': {
          const idx = parsed['index'] as number
          const delta = (parsed['delta'] ?? {}) as Record<string, unknown>
          const deltaType = delta['type'] as string
          const stored = accumulator.blocks.get(idx)

          if (!stored) break

          if (deltaType === 'text_delta') {
            const text = (delta['text'] as string) ?? ''
            stored.text += text
            yield { type: StreamEventType.TEXT_DELTA, text_id: String(idx), delta: text }
          } else if (deltaType === 'input_json_delta') {
            const partial = (delta['partial_json'] as string) ?? ''
            stored.text += partial
            yield {
              type: StreamEventType.TOOL_CALL_DELTA,
              tool_call: { id: stored.id, raw_arguments: partial },
            }
          } else if (deltaType === 'thinking_delta') {
            const text = (delta['thinking'] as string) ?? ''
            stored.text += text
            yield { type: StreamEventType.REASONING_DELTA, reasoning_delta: text }
          } else if (deltaType === 'signature_delta') {
            stored.signature = (delta['signature'] as string) ?? ''
          }
          break
        }

        case 'content_block_stop': {
          const idx = parsed['index'] as number
          const stored = accumulator.blocks.get(idx)
          if (!stored) break

          if (stored.type === 'text') {
            yield { type: StreamEventType.TEXT_END, text_id: String(idx) }
          } else if (stored.type === 'tool_use') {
            let parsedArgs: Record<string, unknown> = {}
            try {
              if (stored.text) parsedArgs = JSON.parse(stored.text) as Record<string, unknown>
            } catch {
              // ignore
            }
            yield {
              type: StreamEventType.TOOL_CALL_END,
              tool_call: { id: stored.id, name: stored.name, arguments: parsedArgs },
            }
          } else if (stored.type === 'thinking') {
            yield { type: StreamEventType.REASONING_END }
          }
          break
        }

        case 'message_delta': {
          const delta = (parsed['delta'] ?? {}) as Record<string, unknown>
          const rawUsage = (parsed['usage'] ?? {}) as Record<string, number>
          const stopReason = delta['stop_reason'] as string | undefined
          finishReason = translateFinishReason(stopReason)
          usage = {
            input_tokens: accumulator.inputTokens,
            output_tokens: rawUsage['output_tokens'] ?? 0,
            total_tokens: accumulator.inputTokens + (rawUsage['output_tokens'] ?? 0),
          }
          break
        }

        case 'message_stop': {
          // Assemble final response
          const contentParts: ContentPart[] = []
          for (const [, block] of accumulator.blocks) {
            if (block.type === 'text') {
              contentParts.push({ kind: ContentKind.TEXT, text: block.text })
            } else if (block.type === 'tool_use') {
              let parsedArgs: Record<string, unknown> = {}
              try {
                if (block.text) parsedArgs = JSON.parse(block.text) as Record<string, unknown>
              } catch {
                // ignore
              }
              contentParts.push({
                kind: ContentKind.TOOL_CALL,
                tool_call: { id: block.id!, name: block.name!, arguments: parsedArgs },
              })
            } else if (block.type === 'thinking') {
              contentParts.push({
                kind: ContentKind.THINKING,
                thinking: { text: block.text, signature: block.signature, redacted: false },
              })
            }
          }

          const message = new Message({ role: Role.ASSISTANT, content: contentParts })
          const finalUsage = usage ?? { input_tokens: accumulator.inputTokens, output_tokens: 0, total_tokens: accumulator.inputTokens }

          const response = new Response({
            id: accumulator.id,
            model: accumulator.model,
            provider: 'anthropic',
            message,
            finish_reason: finishReason ?? { reason: 'stop' },
            usage: finalUsage,
            rate_limit: rateLimit,
          })

          yield {
            type: StreamEventType.FINISH,
            finish_reason: finishReason,
            usage: finalUsage,
            response,
          }
          return
        }
      }
    }
  }

  private async throwHttpError(response: globalThis.Response): Promise<never> {
    let body: Record<string, unknown> = {}
    let message = `HTTP ${response.status}`
    let errorCode: string | undefined
    let retryAfter: number | undefined

    try {
      body = await response.json() as Record<string, unknown>
      const err = (body['error'] ?? {}) as Record<string, unknown>
      message = (err['message'] as string) ?? (body['message'] as string) ?? message
      errorCode = (err['type'] as string) ?? (err['code'] as string) ?? undefined
    } catch {
      // ignore JSON parse error
    }

    const retryAfterHeader = response.headers.get('retry-after')
    if (retryAfterHeader) {
      retryAfter = parseFloat(retryAfterHeader)
      if (isNaN(retryAfter)) retryAfter = undefined
    }

    throw errorFromStatus({
      status: response.status,
      message,
      provider: 'anthropic',
      error_code: errorCode,
      retry_after: retryAfter,
      raw: body,
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeConsecutiveRoles(messages: Message[]): Message[] {
  if (messages.length === 0) return []

  const result: Message[] = []
  let prev = messages[0]!

  for (let i = 1; i < messages.length; i++) {
    const curr = messages[i]!
    const prevRole = effectiveRole(prev)
    const currRole = effectiveRole(curr)

    if (prevRole === currRole) {
      // Merge content arrays
      prev = new Message({
        role: prev.role,
        content: [...prev.content, ...curr.content],
        name: prev.name,
        tool_call_id: prev.tool_call_id,
      })
    } else {
      result.push(prev)
      prev = curr
    }
  }
  result.push(prev)
  return result
}

/** Map TOOL role to 'user' for alternation purposes */
function effectiveRole(msg: Message): 'user' | 'assistant' {
  return msg.role === Role.ASSISTANT ? 'assistant' : 'user'
}

function injectCacheControlOnLastUserMessage(messages: Message[]): void {
  // Find the last user-role (or TOOL) message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role === Role.USER || msg.role === Role.TOOL) {
      const content = [...msg.content]
      if (content.length > 0) {
        const lastIdx = content.length - 1
        content[lastIdx] = { ...content[lastIdx]!, _cache_control: { type: 'ephemeral' } } as ContentPart & { _cache_control: unknown }
        // Store as metadata that translateMessage can use
        ;(messages[i] as Message & { _inject_cache?: boolean })['_inject_cache'] = true
      }
      break
    }
  }
}

function translateToolDefinition(tool: Tool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }
}

function translateToolChoice(toolChoice: Request['tool_choice']): Record<string, unknown> | undefined {
  if (!toolChoice) return { type: 'auto' }
  switch (toolChoice.mode) {
    case 'auto':
      return { type: 'auto' }
    case 'required':
      return { type: 'any' }
    case 'named':
      return { type: 'tool', name: toolChoice.tool_name }
    case 'none':
      return undefined
    default:
      return { type: 'auto' }
  }
}

function translateContentBlock(block: Record<string, unknown>): ContentPart | null {
  const type = block['type'] as string
  switch (type) {
    case 'text':
      return { kind: ContentKind.TEXT, text: (block['text'] as string) ?? '' }
    case 'tool_use': {
      const input = block['input'] as Record<string, unknown>
      return {
        kind: ContentKind.TOOL_CALL,
        tool_call: {
          id: (block['id'] as string) ?? '',
          name: (block['name'] as string) ?? '',
          arguments: input ?? {},
          type: 'function',
        },
      }
    }
    case 'thinking':
      return {
        kind: ContentKind.THINKING,
        thinking: {
          text: (block['thinking'] as string) ?? '',
          signature: (block['signature'] as string) ?? undefined,
          redacted: false,
        },
      }
    case 'redacted_thinking':
      return {
        kind: ContentKind.REDACTED_THINKING,
        thinking: {
          text: (block['data'] as string) ?? '',
          redacted: true,
        },
      }
    default:
      return null
  }
}

function translateFinishReason(raw?: string): FinishReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return { reason: 'stop', raw }
    case 'max_tokens':
      return { reason: 'length', raw }
    case 'tool_use':
      return { reason: 'tool_calls', raw }
    default:
      return { reason: raw ? 'other' : 'stop', raw }
  }
}

function parseRateLimitHeaders(headers: Headers): RateLimitInfo | undefined {
  const reqRemaining = headers.get('x-ratelimit-remaining-requests')
  const reqLimit = headers.get('x-ratelimit-limit-requests')
  const tokRemaining = headers.get('x-ratelimit-remaining-tokens')
  const tokLimit = headers.get('x-ratelimit-limit-tokens')
  const resetAt = headers.get('x-ratelimit-reset-requests') ?? headers.get('x-ratelimit-reset-tokens')

  if (!reqRemaining && !tokRemaining) return undefined

  return {
    requests_remaining: reqRemaining ? parseInt(reqRemaining) : undefined,
    requests_limit: reqLimit ? parseInt(reqLimit) : undefined,
    tokens_remaining: tokRemaining ? parseInt(tokRemaining) : undefined,
    tokens_limit: tokLimit ? parseInt(tokLimit) : undefined,
    reset_at: resetAt ? new Date(resetAt) : undefined,
  }
}

function isLocalPath(url: string): boolean {
  return url.startsWith('/') || url.startsWith('./') || url.startsWith('~')
}

function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!)
  }
  return btoa(binary)
}
