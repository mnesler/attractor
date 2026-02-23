import { Message, Role, ContentKind, ContentPart } from '../types/message.js'
import type { Request } from '../types/request.js'
import { Response, FinishReason, Usage, RateLimitInfo } from '../types/response.js'
import { StreamEvent, StreamEventType } from '../types/stream.js'
import type { Tool } from '../types/tool.js'
import { errorFromStatus, NetworkError } from '../types/errors.js'
import { createSSEStream } from '../sse.js'

export interface OpenRouterAdapterOptions {
  api_key: string
  base_url?: string
  default_headers?: Record<string, string>
  timeout?: number
}

export class OpenRouterAdapter {
  readonly name: string
  private api_key: string
  private base_url: string
  private default_headers: Record<string, string>

  constructor(options: OpenRouterAdapterOptions) {
    this.name = 'openrouter'
    this.api_key = options.api_key
    this.base_url = (options.base_url ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '')
    this.default_headers = options.default_headers ?? {}
  }

  async complete(request: Request): Promise<Response> {
    const { body, headers } = this.buildRequest(request, false)

    let httpResponse: globalThis.Response
    try {
      httpResponse = await fetch(`${this.base_url}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: (request.provider_options?.[this.name] as Record<string, unknown>)
          ?.abort_signal as AbortSignal | undefined,
      })
    } catch (err) {
      throw new NetworkError(
        `${this.name} request failed: ${String(err)}`,
        err instanceof Error ? err : undefined,
      )
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
      httpResponse = await fetch(`${this.base_url}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: (request.provider_options?.[this.name] as Record<string, unknown>)
          ?.abort_signal as AbortSignal | undefined,
      })
    } catch (err) {
      throw new NetworkError(
        `${this.name} stream request failed: ${String(err)}`,
        err instanceof Error ? err : undefined,
      )
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
    const messages = request.messages.map(msg => this.translateMessage(msg))

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
    }

    if (stream) body['stream'] = true

    // Add stream_options for usage in streaming
    if (stream) body['stream_options'] = { include_usage: true }

    if (request.tools && request.tools.length > 0 && request.tool_choice?.mode !== 'none') {
      body['tools'] = request.tools.map(t => translateToolDefinition(t))
      body['tool_choice'] = translateToolChoice(request.tool_choice)
    } else if (request.tool_choice?.mode === 'none') {
      body['tool_choice'] = 'none'
    }

    if (request.temperature != null) body['temperature'] = request.temperature
    if (request.top_p != null) body['top_p'] = request.top_p
    if (request.max_tokens != null) body['max_tokens'] = request.max_tokens
    if (request.stop_sequences?.length) body['stop'] = request.stop_sequences
    if (request.response_format) {
      if (request.response_format.type === 'json_schema' && request.response_format.json_schema) {
        body['response_format'] = {
          type: 'json_schema',
          json_schema: {
            name: 'output',
            schema: request.response_format.json_schema,
            strict: request.response_format.strict ?? false,
          },
        }
      } else if (request.response_format.type === 'json') {
        body['response_format'] = { type: 'json_object' }
      }
    }

    // Merge provider-specific options
    const providerOpts = (request.provider_options?.[this.name] ?? {}) as Record<string, unknown>
    const excluded = new Set(['abort_signal'])
    for (const [k, v] of Object.entries(providerOpts)) {
      if (!excluded.has(k)) body[k] = v
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'authorization': `Bearer ${this.api_key}`,
      ...this.default_headers,
    }

    return { body, headers }
  }

  private translateMessage(msg: Message): Record<string, unknown> {
    switch (msg.role) {
      case Role.SYSTEM:
        return { role: 'system', content: msg.text || extractTextContent(msg) }

      case Role.DEVELOPER:
        return { role: 'developer', content: msg.text || extractTextContent(msg) }

      case Role.TOOL: {
        // Tool result messages
        const tr = msg.content.find(p => p.kind === ContentKind.TOOL_RESULT)?.tool_result
        const toolCallId = tr?.tool_call_id ?? msg.tool_call_id ?? ''
        const content = tr
          ? typeof tr.content === 'string'
            ? tr.content
            : JSON.stringify(tr.content)
          : ''
        return { role: 'tool', tool_call_id: toolCallId, content }
      }

      case Role.USER: {
        const content = translateUserContent(msg.content)
        return { role: 'user', content }
      }

      case Role.ASSISTANT: {
        const toolCalls = msg.content
          .filter(p => p.kind === ContentKind.TOOL_CALL && p.tool_call)
          .map(p => {
            const tc = p.tool_call!
            const args =
              typeof tc.arguments === 'string'
                ? tc.arguments
                : JSON.stringify(tc.arguments)
            return {
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: args },
            }
          })

        const textParts = msg.content.filter(p => p.kind === ContentKind.TEXT && p.text)
        const textContent = textParts.map(p => p.text).join('')

        if (toolCalls.length > 0) {
          const result: Record<string, unknown> = {
            role: 'assistant',
            content: textContent || null,
            tool_calls: toolCalls,
          }
          return result
        }

        return { role: 'assistant', content: textContent }
      }

      default:
        return { role: 'user', content: msg.text }
    }
  }

  private translateResponse(data: Record<string, unknown>, headers: Headers): Response {
    const choices = (data['choices'] as unknown[]) ?? []
    const choice = (choices[0] ?? {}) as Record<string, unknown>
    const msgData = (choice['message'] ?? {}) as Record<string, unknown>

    const contentParts: ContentPart[] = []

    const textContent = msgData['content'] as string | null | undefined
    if (textContent) {
      contentParts.push({ kind: ContentKind.TEXT, text: textContent })
    }

    const toolCallsRaw = (msgData['tool_calls'] as unknown[] | undefined) ?? []
    for (const tc of toolCallsRaw) {
      const t = tc as Record<string, unknown>
      const fn = (t['function'] ?? {}) as Record<string, unknown>
      const argsStr = (fn['arguments'] as string) ?? '{}'
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(argsStr) as Record<string, unknown>
      } catch {
        // keep empty
      }
      contentParts.push({
        kind: ContentKind.TOOL_CALL,
        tool_call: {
          id: (t['id'] as string) ?? '',
          name: (fn['name'] as string) ?? '',
          arguments: args,
          type: 'function',
        },
      })
    }

    const message = new Message({ role: Role.ASSISTANT, content: contentParts })

    const finishReasonRaw = choice['finish_reason'] as string | undefined
    const finish_reason = translateFinishReason(finishReasonRaw)

    const rawUsage = (data['usage'] ?? {}) as Record<string, unknown>
    const completionDetails = (rawUsage['completion_tokens_details'] ?? {}) as Record<string, number>
    const promptDetails = (rawUsage['prompt_tokens_details'] ?? {}) as Record<string, number>

    const usage: Usage = {
      input_tokens: (rawUsage['prompt_tokens'] as number) ?? 0,
      output_tokens: (rawUsage['completion_tokens'] as number) ?? 0,
      total_tokens: (rawUsage['total_tokens'] as number) ?? 0,
      reasoning_tokens: completionDetails['reasoning_tokens'] ?? undefined,
      cache_read_tokens: promptDetails['cached_tokens'] ?? undefined,
      raw: rawUsage,
    }

    const rate_limit = parseRateLimitHeaders(headers)

    return new Response({
      id: (data['id'] as string) ?? '',
      model: (data['model'] as string) ?? '',
      provider: this.name,
      message,
      finish_reason,
      usage,
      raw: data,
      rate_limit,
    })
  }

  async *translateStream(httpResponse: globalThis.Response): AsyncGenerator<StreamEvent> {
    // Track per-call-index tool call state
    const toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>()
    let textStarted = false
    let usage: Usage | undefined
    let finishReason: FinishReason | undefined
    const rateLimit = parseRateLimitHeaders(httpResponse.headers)
    let responseId = ''
    let responseModel = ''

    yield { type: StreamEventType.STREAM_START }

    for await (const { data } of createSSEStream(httpResponse)) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(data) as Record<string, unknown>
      } catch {
        continue
      }

      if (parsed['id']) responseId = parsed['id'] as string
      if (parsed['model']) responseModel = parsed['model'] as string

      // Usage chunk (may come as a separate chunk with empty choices)
      const rawUsage = parsed['usage'] as Record<string, unknown> | undefined | null
      if (rawUsage) {
        const completionDetails = (rawUsage['completion_tokens_details'] ?? {}) as Record<string, number>
        const promptDetails = (rawUsage['prompt_tokens_details'] ?? {}) as Record<string, number>
        usage = {
          input_tokens: (rawUsage['prompt_tokens'] as number) ?? 0,
          output_tokens: (rawUsage['completion_tokens'] as number) ?? 0,
          total_tokens: (rawUsage['total_tokens'] as number) ?? 0,
          reasoning_tokens: completionDetails['reasoning_tokens'] ?? undefined,
          cache_read_tokens: promptDetails['cached_tokens'] ?? undefined,
          raw: rawUsage,
        }
      }

      const choices = (parsed['choices'] as unknown[] | undefined) ?? []
      if (choices.length === 0) continue

      const choice = choices[0] as Record<string, unknown>
      const delta = (choice['delta'] ?? {}) as Record<string, unknown>

      // Text content
      const textDelta = delta['content'] as string | null | undefined
      if (textDelta != null && textDelta !== '') {
        if (!textStarted) {
          textStarted = true
          yield { type: StreamEventType.TEXT_START, text_id: '__text__' }
        }
        yield { type: StreamEventType.TEXT_DELTA, text_id: '__text__', delta: textDelta }
      }

      // Tool calls
      const toolCallDeltas = (delta['tool_calls'] as unknown[] | undefined) ?? []
      for (const tcDelta of toolCallDeltas) {
        const tcd = tcDelta as Record<string, unknown>
        const idx = tcd['index'] as number
        const fn = (tcd['function'] ?? {}) as Record<string, unknown>

        if (!toolCallsByIndex.has(idx)) {
          // New tool call starting
          const tcId = (tcd['id'] as string) ?? `call_${idx}`
          const tcName = (fn['name'] as string) ?? ''
          toolCallsByIndex.set(idx, { id: tcId, name: tcName, args: '' })
          yield {
            type: StreamEventType.TOOL_CALL_START,
            tool_call: { id: tcId, name: tcName },
          }
        }

        const tc = toolCallsByIndex.get(idx)!
        const argsChunk = (fn['arguments'] as string) ?? ''
        if (argsChunk) {
          tc.args += argsChunk
          yield {
            type: StreamEventType.TOOL_CALL_DELTA,
            tool_call: { id: tc.id, raw_arguments: argsChunk },
          }
        }
      }

      // Finish reason
      const fr = choice['finish_reason'] as string | null | undefined
      if (fr) {
        finishReason = translateFinishReason(fr)

        // Emit end events
        if (textStarted) {
          yield { type: StreamEventType.TEXT_END, text_id: '__text__' }
        }

        for (const tc of toolCallsByIndex.values()) {
          let parsedArgs: Record<string, unknown> = {}
          try {
            if (tc.args) parsedArgs = JSON.parse(tc.args) as Record<string, unknown>
          } catch {
            // ignore
          }
          yield {
            type: StreamEventType.TOOL_CALL_END,
            tool_call: { id: tc.id, name: tc.name, arguments: parsedArgs },
          }
        }
      }
    }

    // Build accumulated response
    const contentParts: ContentPart[] = []
    if (textStarted) {
      // Text was yielded via deltas; accumulator will have it
    }
    for (const tc of toolCallsByIndex.values()) {
      let parsedArgs: Record<string, unknown> = {}
      try {
        if (tc.args) parsedArgs = JSON.parse(tc.args) as Record<string, unknown>
      } catch {
        // ignore
      }
      contentParts.push({
        kind: ContentKind.TOOL_CALL,
        tool_call: { id: tc.id, name: tc.name, arguments: parsedArgs, type: 'function' },
      })
    }

    const message = new Message({ role: Role.ASSISTANT, content: contentParts })
    const finalUsage = usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 }

    const response = new Response({
      id: responseId,
      model: responseModel,
      provider: this.name,
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
      errorCode = (err['code'] as string) ?? (err['type'] as string) ?? undefined
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
      provider: this.name,
      error_code: errorCode,
      retry_after: retryAfter,
      raw: body,
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function translateToolDefinition(tool: Tool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

function translateToolChoice(toolChoice: Request['tool_choice']): unknown {
  if (!toolChoice) return 'auto'
  switch (toolChoice.mode) {
    case 'auto':
      return 'auto'
    case 'none':
      return 'none'
    case 'required':
      return 'required'
    case 'named':
      return { type: 'function', function: { name: toolChoice.tool_name } }
    default:
      return 'auto'
  }
}

function translateFinishReason(raw?: string | null): FinishReason {
  switch (raw) {
    case 'stop':
      return { reason: 'stop', raw: raw ?? undefined }
    case 'length':
      return { reason: 'length', raw }
    case 'tool_calls':
      return { reason: 'tool_calls', raw }
    case 'content_filter':
      return { reason: 'content_filter', raw }
    default:
      return { reason: raw ? 'other' : 'stop', raw: raw ?? undefined }
  }
}

function parseRateLimitHeaders(headers: Headers): RateLimitInfo | undefined {
  const reqRemaining = headers.get('x-ratelimit-remaining-requests')
  const tokRemaining = headers.get('x-ratelimit-remaining-tokens')
  if (!reqRemaining && !tokRemaining) return undefined
  return {
    requests_remaining: reqRemaining ? parseInt(reqRemaining) : undefined,
    requests_limit: headers.get('x-ratelimit-limit-requests') ? parseInt(headers.get('x-ratelimit-limit-requests')!) : undefined,
    tokens_remaining: tokRemaining ? parseInt(tokRemaining) : undefined,
    tokens_limit: headers.get('x-ratelimit-limit-tokens') ? parseInt(headers.get('x-ratelimit-limit-tokens')!) : undefined,
  }
}

function extractTextContent(msg: Message): string {
  return msg.content
    .filter(p => p.kind === ContentKind.TEXT)
    .map(p => p.text ?? '')
    .join('')
}

function translateUserContent(parts: ContentPart[]): unknown {
  // If only text parts, return string directly
  const hasImages = parts.some(p => p.kind === ContentKind.IMAGE)
  if (!hasImages) {
    return parts.filter(p => p.kind === ContentKind.TEXT).map(p => p.text ?? '').join('')
  }

  return parts.map(part => {
    switch (part.kind) {
      case ContentKind.TEXT:
        return { type: 'text', text: part.text ?? '' }
      case ContentKind.IMAGE: {
        const img = part.image
        if (!img) return null
        if (img.data) {
          const b64 = uint8ArrayToBase64(img.data)
          const mime = img.media_type ?? 'image/png'
          const url = `data:${mime};base64,${b64}`
          const imageUrl: Record<string, unknown> = { url }
          if (img.detail) imageUrl['detail'] = img.detail
          return { type: 'image_url', image_url: imageUrl }
        }
        if (img.url) {
          const imageUrl: Record<string, unknown> = { url: img.url }
          if (img.detail) imageUrl['detail'] = img.detail
          return { type: 'image_url', image_url: imageUrl }
        }
        return null
      }
      default:
        return null
    }
  }).filter(Boolean)
}

function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!)
  }
  return btoa(binary)
}
