import type { SessionConfig } from '../types/config.js'

// ---------------------------------------------------------------------------
// Default limits from spec Section 5.2
// ---------------------------------------------------------------------------

const DEFAULT_CHAR_LIMITS: Record<string, number> = {
  read_file: 50_000,
  shell: 30_000,
  grep: 20_000,
  glob: 20_000,
  edit_file: 10_000,
  write_file: 1_000,
  spawn_agent: 20_000,
  send_input: 1_000,
  wait: 20_000,
  close_agent: 1_000,
}

const DEFAULT_LINE_LIMITS: Record<string, number | undefined> = {
  shell: 256,
  grep: 200,
  glob: 500,
  read_file: undefined,
  edit_file: undefined,
  write_file: undefined,
}

const DEFAULT_TRUNCATION_MODES: Record<string, 'head_tail' | 'tail'> = {
  read_file: 'head_tail',
  shell: 'head_tail',
  grep: 'tail',
  glob: 'tail',
  edit_file: 'tail',
  write_file: 'tail',
  spawn_agent: 'head_tail',
  wait: 'head_tail',
  send_input: 'tail',
  close_agent: 'tail',
}

const DEFAULT_FALLBACK_CHARS = 10_000
const DEFAULT_FALLBACK_MODE: 'head_tail' | 'tail' = 'head_tail'

// ---------------------------------------------------------------------------
// Core truncation functions
// ---------------------------------------------------------------------------

export function truncateOutput(output: string, maxChars: number, mode: 'head_tail' | 'tail'): string {
  if (output.length <= maxChars) return output

  if (mode === 'head_tail') {
    const half = Math.floor(maxChars / 2)
    const removed = output.length - maxChars
    return (
      output.slice(0, half) +
      `\n\n[WARNING: Tool output was truncated. ${removed} characters were removed from the middle. ` +
      `The full output is available in the event stream. ` +
      `If you need to see specific parts, re-run the tool with more targeted parameters.]\n\n` +
      output.slice(output.length - half)
    )
  }

  // tail mode
  const removed = output.length - maxChars
  return (
    `[WARNING: Tool output was truncated. First ${removed} characters were removed. ` +
    `The full output is available in the event stream.]\n\n` +
    output.slice(output.length - maxChars)
  )
}

export function truncateLines(output: string, maxLines: number): string {
  const lines = output.split('\n')
  if (lines.length <= maxLines) return output

  const headCount = Math.floor(maxLines / 2)
  const tailCount = maxLines - headCount
  const omitted = lines.length - headCount - tailCount

  return (
    lines.slice(0, headCount).join('\n') +
    `\n[... ${omitted} lines omitted ...]\n` +
    lines.slice(lines.length - tailCount).join('\n')
  )
}

// ---------------------------------------------------------------------------
// Full pipeline (character first, then lines)
// ---------------------------------------------------------------------------

export function truncateToolOutput(output: string, toolName: string, config: SessionConfig): string {
  const maxChars =
    config.tool_output_limits.get(toolName) ??
    DEFAULT_CHAR_LIMITS[toolName] ??
    DEFAULT_FALLBACK_CHARS

  const mode = DEFAULT_TRUNCATION_MODES[toolName] ?? DEFAULT_FALLBACK_MODE

  // Step 1: character-based truncation (always runs first)
  let result = truncateOutput(output, maxChars, mode)

  // Step 2: line-based truncation (secondary pass)
  const maxLines =
    config.tool_line_limits.get(toolName) ?? DEFAULT_LINE_LIMITS[toolName]
  if (maxLines !== undefined) {
    result = truncateLines(result, maxLines)
  }

  return result
}
