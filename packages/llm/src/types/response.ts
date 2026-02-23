import { Message, ContentKind } from './message.js'
import type { ToolCall, ToolResult } from './tool.js'

export interface Warning {
  message: string
  code?: string
}

export interface RateLimitInfo {
  requests_remaining?: number
  requests_limit?: number
  tokens_remaining?: number
  tokens_limit?: number
  reset_at?: Date
}

export interface FinishReason {
  reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'other'
  raw?: string
}

export interface Usage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  reasoning_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  raw?: Record<string, unknown>
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    reasoning_tokens: sumOptional(a.reasoning_tokens, b.reasoning_tokens),
    cache_read_tokens: sumOptional(a.cache_read_tokens, b.cache_read_tokens),
    cache_write_tokens: sumOptional(a.cache_write_tokens, b.cache_write_tokens),
  }
}

function sumOptional(a?: number, b?: number): number | undefined {
  if (a == null && b == null) return undefined
  return (a ?? 0) + (b ?? 0)
}

export function zeroUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
}

export class Response {
  readonly id: string
  readonly model: string
  readonly provider: string
  readonly message: Message
  readonly finish_reason: FinishReason
  readonly usage: Usage
  readonly raw?: Record<string, unknown>
  readonly warnings: Warning[]
  readonly rate_limit?: RateLimitInfo

  constructor(params: {
    id: string
    model: string
    provider: string
    message: Message
    finish_reason: FinishReason
    usage: Usage
    raw?: Record<string, unknown>
    warnings?: Warning[]
    rate_limit?: RateLimitInfo
  }) {
    this.id = params.id
    this.model = params.model
    this.provider = params.provider
    this.message = params.message
    this.finish_reason = params.finish_reason
    this.usage = params.usage
    this.raw = params.raw
    this.warnings = params.warnings ?? []
    this.rate_limit = params.rate_limit
  }

  get text(): string {
    return this.message.text
  }

  get toolCalls(): ToolCall[] {
    return this.message.content
      .filter(p => p.kind === ContentKind.TOOL_CALL && p.tool_call)
      .map(p => {
        const tc = p.tool_call!
        const args =
          typeof tc.arguments === 'string'
            ? (() => {
                try {
                  return JSON.parse(tc.arguments) as Record<string, unknown>
                } catch {
                  return {}
                }
              })()
            : (tc.arguments as Record<string, unknown>)
        return {
          id: tc.id,
          name: tc.name,
          arguments: args,
          raw_arguments: typeof tc.arguments === 'string' ? tc.arguments : undefined,
        } satisfies ToolCall
      })
  }

  get reasoning(): string | undefined {
    const parts = this.message.content.filter(
      p => p.kind === ContentKind.THINKING && p.thinking && !p.thinking.redacted,
    )
    if (parts.length === 0) return undefined
    return parts.map(p => p.thinking!.text).join('')
  }
}

export interface StepResult {
  text: string
  reasoning?: string
  tool_calls: ToolCall[]
  tool_results: ToolResult[]
  finish_reason: FinishReason
  usage: Usage
  response: Response
  warnings: Warning[]
}

export interface GenerateResult {
  text: string
  reasoning?: string
  tool_calls: ToolCall[]
  tool_results: ToolResult[]
  finish_reason: FinishReason
  usage: Usage
  total_usage: Usage
  steps: StepResult[]
  response: Response
  output?: unknown
}
