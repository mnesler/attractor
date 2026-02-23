export interface SessionConfig {
  /** 0 = unlimited */
  max_turns: number
  /** 0 = unlimited, resets per user input */
  max_tool_rounds_per_input: number
  default_command_timeout_ms: number
  max_command_timeout_ms: number
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high'
  /** Per-tool character limits — overrides defaults */
  tool_output_limits: Map<string, number>
  /** Per-tool line limits — overrides defaults */
  tool_line_limits: Map<string, number>
  enable_loop_detection: boolean
  loop_detection_window: number
  max_subagent_depth: number
}

export function defaultConfig(): SessionConfig {
  return {
    max_turns: 0,
    max_tool_rounds_per_input: 0,
    default_command_timeout_ms: 10_000,
    max_command_timeout_ms: 600_000,
    enable_loop_detection: true,
    loop_detection_window: 10,
    max_subagent_depth: 1,
    tool_output_limits: new Map(),
    tool_line_limits: new Map(),
  }
}
