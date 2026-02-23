export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface Tool extends ToolDefinition {
  execute?: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  raw_arguments?: string
}

export interface ToolResult {
  tool_call_id: string
  content: string | Record<string, unknown> | unknown[]
  is_error: boolean
}

export interface ToolChoice {
  mode: 'auto' | 'none' | 'required' | 'named'
  tool_name?: string
}

export interface ResponseFormat {
  type: 'text' | 'json' | 'json_schema'
  json_schema?: Record<string, unknown>
  strict?: boolean
}
