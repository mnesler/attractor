import { Message, Role, ContentKind } from './message.js'
import type { ToolCall } from './tool.js'
import { Response, FinishReason, Usage, Warning, RateLimitInfo, zeroUsage } from './response.js'
import type { SDKError } from './errors.js'

export enum StreamEventType {
  STREAM_START = 'stream_start',
  TEXT_START = 'text_start',
  TEXT_DELTA = 'text_delta',
  TEXT_END = 'text_end',
  REASONING_START = 'reasoning_start',
  REASONING_DELTA = 'reasoning_delta',
  REASONING_END = 'reasoning_end',
  TOOL_CALL_START = 'tool_call_start',
  TOOL_CALL_DELTA = 'tool_call_delta',
  TOOL_CALL_END = 'tool_call_end',
  FINISH = 'finish',
  ERROR = 'error',
  PROVIDER_EVENT = 'provider_event',
}

export interface StreamEvent {
  type: StreamEventType | string
  delta?: string
  text_id?: string
  reasoning_delta?: string
  tool_call?: Partial<ToolCall>
  finish_reason?: FinishReason
  usage?: Usage
  response?: Response
  error?: SDKError
  raw?: Record<string, unknown>
}

/** Accumulates stream events into a full Response. */
export class StreamAccumulator {
  private _id = ''
  private _model = ''
  private _provider = ''
  private _texts: Map<string, string> = new Map()
  private _textOrder: string[] = []
  private _reasoningParts: string[] = []
  private _toolCalls: Map<string, { id: string; name: string; args: string; index: number }> = new Map()
  private _toolCallOrder: string[] = []
  private _finishReason?: FinishReason
  private _usage?: Usage
  private _warnings: Warning[] = []
  private _rateLimit?: RateLimitInfo
  private _fullResponse?: Response

  setMeta(params: {
    id?: string
    model?: string
    provider?: string
    warnings?: Warning[]
    rate_limit?: RateLimitInfo
  }) {
    if (params.id) this._id = params.id
    if (params.model) this._model = params.model
    if (params.provider) this._provider = params.provider
    if (params.warnings) this._warnings.push(...params.warnings)
    if (params.rate_limit) this._rateLimit = params.rate_limit
  }

  process(event: StreamEvent): void {
    switch (event.type) {
      case StreamEventType.TEXT_START:
        if (event.text_id != null) {
          if (!this._texts.has(event.text_id)) {
            this._texts.set(event.text_id, '')
            this._textOrder.push(event.text_id)
          }
        }
        break
      case StreamEventType.TEXT_DELTA:
        if (event.text_id != null && event.delta != null) {
          this._texts.set(event.text_id, (this._texts.get(event.text_id) ?? '') + event.delta)
        } else if (event.delta != null) {
          // fallback: use a default text_id
          const id = '__default__'
          if (!this._texts.has(id)) {
            this._texts.set(id, '')
            this._textOrder.push(id)
          }
          this._texts.set(id, this._texts.get(id)! + event.delta)
        }
        break
      case StreamEventType.REASONING_DELTA:
        if (event.reasoning_delta != null) {
          this._reasoningParts.push(event.reasoning_delta)
        }
        break
      case StreamEventType.TOOL_CALL_START: {
        const tc = event.tool_call
        if (tc?.id) {
          if (!this._toolCalls.has(tc.id)) {
            this._toolCalls.set(tc.id, {
              id: tc.id,
              name: tc.name ?? '',
              args: '',
              index: this._toolCallOrder.length,
            })
            this._toolCallOrder.push(tc.id)
          }
        }
        break
      }
      case StreamEventType.TOOL_CALL_DELTA: {
        const tc = event.tool_call
        if (tc?.id && tc.raw_arguments != null) {
          const stored = this._toolCalls.get(tc.id)
          if (stored) stored.args += tc.raw_arguments
        }
        break
      }
      case StreamEventType.FINISH:
        if (event.finish_reason) this._finishReason = event.finish_reason
        if (event.usage) this._usage = event.usage
        if (event.response) {
          this._fullResponse = event.response
        }
        break
    }
  }

  response(): Response {
    if (this._fullResponse) return this._fullResponse

    const contentParts = []

    // Text parts in insertion order
    for (const id of this._textOrder) {
      const text = this._texts.get(id) ?? ''
      contentParts.push({ kind: ContentKind.TEXT, text })
    }

    // Reasoning
    if (this._reasoningParts.length > 0) {
      contentParts.push({
        kind: ContentKind.THINKING,
        thinking: { text: this._reasoningParts.join(''), redacted: false },
      })
    }

    // Tool calls
    for (const id of this._toolCallOrder) {
      const tc = this._toolCalls.get(id)!
      let parsedArgs: Record<string, unknown> = {}
      try {
        if (tc.args) parsedArgs = JSON.parse(tc.args) as Record<string, unknown>
      } catch {
        // ignore parse error
      }
      contentParts.push({
        kind: ContentKind.TOOL_CALL,
        tool_call: { id: tc.id, name: tc.name, arguments: parsedArgs, type: 'function' },
      })
    }

    const message = new Message({ role: Role.ASSISTANT, content: contentParts })
    const usage = this._usage ?? zeroUsage()

    return new Response({
      id: this._id,
      model: this._model,
      provider: this._provider,
      message,
      finish_reason: this._finishReason ?? { reason: 'stop' },
      usage,
      warnings: this._warnings,
      rate_limit: this._rateLimit,
    })
  }
}

/** Async-iterable stream result wrapping a provider's AsyncGenerator<StreamEvent>. */
export class StreamResult implements AsyncIterable<StreamEvent> {
  private _accumulator = new StreamAccumulator()
  private _done = false
  private _response?: Response
  private _source: AsyncGenerator<StreamEvent>

  constructor(source: AsyncGenerator<StreamEvent>) {
    this._source = source
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    for await (const event of this._source) {
      this._accumulator.process(event)
      yield event
    }
    this._done = true
    this._response = this._accumulator.response()
  }

  async response(): Promise<Response> {
    if (this._response) return this._response
    // Consume remaining events
    for await (const _ of this) {
      // accumulation is a side effect
      void _
    }
    return this._response!
  }

  get textStream(): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator]: async function* (this: StreamResult) {
        for await (const event of this) {
          if (event.type === StreamEventType.TEXT_DELTA && event.delta != null) {
            yield event.delta
          }
        }
      }.bind(this),
    }
  }

  get partial_response(): Response | undefined {
    return this._done ? this._response : undefined
  }
}
