import type { ToolCall, ToolResult, Usage } from '@attractor/llm'

export interface UserTurn {
  kind: 'user'
  content: string
  timestamp: Date
}

export interface AssistantTurn {
  kind: 'assistant'
  content: string
  tool_calls: ToolCall[]
  reasoning?: string
  usage: Usage
  response_id?: string
  timestamp: Date
}

export interface ToolResultsTurn {
  kind: 'tool_results'
  results: ToolResult[]
  timestamp: Date
}

export interface SystemTurn {
  kind: 'system'
  content: string
  timestamp: Date
}

export interface SteeringTurn {
  kind: 'steering'
  content: string
  timestamp: Date
}

export type Turn = UserTurn | AssistantTurn | ToolResultsTurn | SystemTurn | SteeringTurn
