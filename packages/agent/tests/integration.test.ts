/**
 * Integration tests — real API calls and real filesystem.
 * Skipped by default. Run with:
 *   OPENROUTER_API_KEY=sk-or-... npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, OpenRouterAdapter } from '@attractor/llm'
import { Session } from '../src/session.js'
import { EventKind } from '../src/types/event.js'
import { OpenRouterProfile } from '../src/profiles/openrouter.js'
import { LocalExecutionEnvironment } from '../src/environment/local.js'

const OPENROUTER_KEY = process.env['OPENROUTER_API_KEY']
const skip = !OPENROUTER_KEY

describe('Coding Agent Loop integration', () => {
  let client: Client
  let tmpDir: string

  beforeAll(async () => {
    if (skip) return

    client = new Client({
      providers: {
        openrouter: new OpenRouterAdapter({
          api_key: OPENROUTER_KEY!,
          default_headers: {
            'HTTP-Referer': 'https://github.com/strongdm/attractor',
            'X-Title': 'Attractor Integration Test',
          },
        }),
      },
      default_provider: 'openrouter',
    })

    tmpDir = await mkdtemp(join(tmpdir(), 'attractor-agent-test-'))
  })

  afterAll(async () => {
    if (!skip && tmpDir) {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it.skipIf(skip)('creates a file when asked', async () => {
    const profile = new OpenRouterProfile({ model: 'anthropic/claude-sonnet-4-5' })
    const env = new LocalExecutionEnvironment(tmpDir)
    const session = new Session({ profile, execution_env: env, llm_client: client })

    const events = []
    for await (const event of session.submit(
      "Create a file called hello.py that prints 'Hello World'. Do not explain, just create the file.",
    )) {
      events.push(event)
    }

    const exists = await env.file_exists(join(tmpDir, 'hello.py'))
    expect(exists).toBe(true)

    const content = await env.read_file(join(tmpDir, 'hello.py'))
    expect(content.toLowerCase()).toContain('hello')
  })

  it.skipIf(skip)('reads a file, edits it, and verifies', async () => {
    const profile = new OpenRouterProfile({ model: 'anthropic/claude-sonnet-4-5' })
    const env = new LocalExecutionEnvironment(tmpDir)

    // Create a file for the agent to edit
    await env.write_file(join(tmpDir, 'counter.py'), 'count = 0\nprint(count)\n')

    const session = new Session({ profile, execution_env: env, llm_client: client })

    for await (const _ of session.submit(
      'Read counter.py, then edit it to set count=42 and add a comment "# updated by agent". Save the file.',
    )) { /* consume events */ }

    const content = await env.read_file(join(tmpDir, 'counter.py'))
    expect(content).toContain('42')
  })

  it.skipIf(skip)('runs a shell command and reports the output', async () => {
    const profile = new OpenRouterProfile({ model: 'anthropic/claude-sonnet-4-5' })
    const env = new LocalExecutionEnvironment(tmpDir)
    const session = new Session({ profile, execution_env: env, llm_client: client })

    const events = []
    for await (const event of session.submit(
      "Run the shell command 'echo integration-test-marker' and tell me what it printed.",
    )) {
      events.push(event)
    }

    const toolCallEnds = events.filter(e => e.kind === EventKind.TOOL_CALL_END)
    const hasShellCall = toolCallEnds.some(e =>
      typeof e.data['output'] === 'string' &&
      (e.data['output'] as string).includes('integration-test-marker'),
    )
    expect(hasShellCall).toBe(true)
  })

  it.skipIf(skip)('handles tool output truncation transparently', async () => {
    const profile = new OpenRouterProfile({ model: 'anthropic/claude-sonnet-4-5' })
    const env = new LocalExecutionEnvironment(tmpDir)

    // Write a file larger than the 50k char read_file limit
    await env.write_file(join(tmpDir, 'big.txt'), 'x'.repeat(100_000))

    const session = new Session({ profile, execution_env: env, llm_client: client })

    const events = []
    for await (const event of session.submit('Read big.txt and tell me how long it seems to be.')) {
      events.push(event)
    }

    const toolEnd = events.find(
      e => e.kind === EventKind.TOOL_CALL_END && e.data['tool_name'] === 'read_file',
    )
    if (toolEnd) {
      // Full output in event (100k chars of line-numbered content)
      expect((toolEnd.data['output'] as string).length).toBeGreaterThan(50_000)
    }
  })
})
