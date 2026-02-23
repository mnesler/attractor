/**
 * Lightweight SSE (Server-Sent Events) parser.
 * Yields {event?, data} objects as the server emits them.
 */

export interface SSELine {
  event?: string
  data: string
}

/** Parse a single SSE line, updating current event state. Returns null for comment/empty lines. */
export function parseSSELine(
  line: string,
  state: { event?: string },
): { type: 'event'; event?: string; data: string } | { type: 'set_event'; value: string } | null {
  if (line.startsWith(':')) return null // comment

  if (line.startsWith('event:')) {
    state.event = line.slice(6).trim()
    return { type: 'set_event', value: state.event }
  }

  if (line.startsWith('data:')) {
    const data = line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5)
    return { type: 'event', event: state.event, data }
  }

  return null
}

/**
 * Creates an async iterable of SSE lines from a fetch Response body.
 * Handles multi-line data, comment lines, and the [DONE] sentinel.
 */
export async function* createSSEStream(
  response: globalThis.Response,
): AsyncGenerator<SSELine> {
  const body = response.body
  if (!body) return

  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  const state: { event?: string } = {}

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // Keep last (potentially incomplete) line in buffer
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trimEnd()

        if (trimmed === '') {
          // Blank line = event boundary; reset event type
          state.event = undefined
          continue
        }

        if (trimmed.startsWith(':')) continue // SSE comment

        if (trimmed.startsWith('data:')) {
          const raw = trimmed.slice(5).startsWith(' ') ? trimmed.slice(6) : trimmed.slice(5)
          if (raw === '[DONE]') return // OpenAI/OpenRouter stream terminator
          yield { event: state.event, data: raw }
          continue
        }

        if (trimmed.startsWith('event:')) {
          state.event = trimmed.slice(6).trim()
          continue
        }

        if (trimmed.startsWith('retry:')) continue // reconnect interval, ignore
      }
    }

    // Process any remaining buffer content
    if (buffer.trim()) {
      if (buffer.startsWith('data:')) {
        const raw = buffer.slice(5).startsWith(' ') ? buffer.slice(6) : buffer.slice(5)
        if (raw !== '[DONE]') yield { event: state.event, data: raw.trim() }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
