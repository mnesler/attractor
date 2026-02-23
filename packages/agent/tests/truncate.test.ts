import { describe, it, expect } from 'vitest'
import { truncateOutput, truncateLines, truncateToolOutput } from '../src/tools/truncate.js'
import { defaultConfig } from '../src/types/config.js'

// ---------------------------------------------------------------------------
// truncateOutput
// ---------------------------------------------------------------------------

describe('truncateOutput', () => {
  it('returns output unchanged if within limit', () => {
    expect(truncateOutput('hello', 100, 'head_tail')).toBe('hello')
    expect(truncateOutput('hello', 100, 'tail')).toBe('hello')
  })

  it('head_tail: keeps first and last halves with marker', () => {
    const input = 'A'.repeat(100) + 'B'.repeat(100)
    const result = truncateOutput(input, 50, 'head_tail')
    expect(result).toContain('WARNING: Tool output was truncated')
    expect(result).toContain('150 characters were removed')
    expect(result.startsWith('A'.repeat(25))).toBe(true)
    expect(result.endsWith('B'.repeat(25))).toBe(true)
  })

  it('tail: keeps last N chars with marker', () => {
    const input = 'OLD'.repeat(100) + 'NEW'.repeat(10)
    const result = truncateOutput(input, 30, 'tail')
    expect(result).toContain('WARNING: Tool output was truncated')
    expect(result).toContain('First')
    // Last 30 chars of input
    expect(result.endsWith(input.slice(-30))).toBe(true)
  })

  it('tail: marker says how many chars removed', () => {
    const input = 'x'.repeat(1000)
    const result = truncateOutput(input, 200, 'tail')
    expect(result).toContain('First 800 characters were removed')
  })
})

// ---------------------------------------------------------------------------
// truncateLines
// ---------------------------------------------------------------------------

describe('truncateLines', () => {
  it('returns output unchanged if within limit', () => {
    const input = 'line1\nline2\nline3'
    expect(truncateLines(input, 10)).toBe(input)
  })

  it('splits into head+tail with omitted lines marker', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
    const input = lines.join('\n')
    const result = truncateLines(input, 6)
    expect(result).toContain('... 14 lines omitted ...')
    expect(result).toContain('line1')
    expect(result).toContain('line20')
    expect(result).not.toContain('line10')
  })
})

// ---------------------------------------------------------------------------
// truncateToolOutput (full pipeline)
// ---------------------------------------------------------------------------

describe('truncateToolOutput', () => {
  it('applies default char limit for shell (30000)', () => {
    const config = defaultConfig()
    const big = 'x'.repeat(50_000)
    const result = truncateToolOutput(big, 'shell', config)
    expect(result.length).toBeLessThan(big.length)
    expect(result).toContain('WARNING: Tool output was truncated')
  })

  it('applies default line limit for shell (256)', () => {
    const config = defaultConfig()
    const lines = Array.from({ length: 300 }, (_, i) => `line${i}`).join('\n')
    // Total chars is small enough to not trigger char truncation
    const result = truncateToolOutput(lines, 'shell', config)
    expect(result).toContain('lines omitted')
  })

  it('respects custom char limit override', () => {
    const config = defaultConfig()
    config.tool_output_limits.set('shell', 100)
    const big = 'x'.repeat(500)
    const result = truncateToolOutput(big, 'shell', config)
    expect(result.length).toBeLessThan(500)
    expect(result).toContain('WARNING')
  })

  it('does not truncate short outputs', () => {
    const config = defaultConfig()
    const short = 'Hello, world!'
    expect(truncateToolOutput(short, 'shell', config)).toBe(short)
  })

  it('uses tail mode for grep', () => {
    const config = defaultConfig()
    const big = 'match\n'.repeat(5000)
    const result = truncateToolOutput(big, 'grep', config)
    expect(result).toContain('First')  // tail mode marker
  })

  it('uses head_tail mode for read_file', () => {
    const config = defaultConfig()
    const big = 'A'.repeat(30_000) + 'B'.repeat(30_000)
    const result = truncateToolOutput(big, 'read_file', config)
    expect(result).toContain('removed from the middle')
    expect(result.startsWith('A')).toBe(true)
    expect(result.endsWith('B')).toBe(true)
  })

  it('char truncation runs before line truncation', () => {
    const config = defaultConfig()
    // 2 lines each 20000 chars — char limit 30000 would truncate but line limit 256 would not
    const twoHugelines = 'A'.repeat(20_000) + '\n' + 'B'.repeat(20_000)
    const result = truncateToolOutput(twoHugelines, 'shell', config)
    expect(result).toContain('WARNING')  // char truncation fired
  })
})
