import type { Message } from './message.js'
import type { Tool, ToolChoice, ResponseFormat } from './tool.js'

export interface Request {
  model: string
  messages: Message[]
  provider?: string
  tools?: Tool[]
  tool_choice?: ToolChoice
  response_format?: ResponseFormat
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop_sequences?: string[]
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high'
  metadata?: Record<string, string>
  provider_options?: Record<string, unknown>
}
