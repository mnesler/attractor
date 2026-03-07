/**
 * Attractor MCP Server
 *
 * Exposes the Attractor pipeline runner as MCP tools so Claude Code and
 * OpenCode can always execute pipelines from any project.
 *
 * Tools:
 *   run_pipeline      — execute a DOT pipeline from source
 *   validate_pipeline — lint/validate a DOT source
 *   load_pipeline     — run a pipeline from a .dot file path
 *
 * Configuration (environment variables):
 *   OPENROUTER_API_KEY   — required for pipelines that use LLM nodes
 *   ATTRACTOR_MCP_PORT   — port to listen on (default: 3001)
 *   ATTRACTOR_MODEL      — default model (default: anthropic/claude-sonnet-4-6)
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { Runner, validate, parseDot } from '@attractor/attractor'
import type { PipelineEvent } from '@attractor/attractor'

const PORT = parseInt(process.env['ATTRACTOR_MCP_PORT'] ?? '3001', 10)
const API_KEY = process.env['OPENROUTER_API_KEY']
const DEFAULT_MODEL = process.env['ATTRACTOR_MODEL'] ?? 'anthropic/claude-sonnet-4-6'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatEvents(events: PipelineEvent[]): string {
  return events
    .filter(e =>
      ['stage_started', 'stage_completed', 'stage_failed', 'stage_retrying',
       'pipeline_completed', 'pipeline_failed'].includes(e.kind)
    )
    .map(e => {
      const d = e.data
      if (e.kind === 'stage_started')    return `  ▶ ${d['name']}`
      if (e.kind === 'stage_completed')  return `  ✓ ${d['name']} (${d['duration']}ms)`
      if (e.kind === 'stage_failed')     return `  ✗ ${d['name']}: ${d['error']}`
      if (e.kind === 'stage_retrying')   return `  ↻ ${d['name']} retry #${d['attempt']}`
      if (e.kind === 'pipeline_completed') return `Pipeline completed in ${d['duration']}ms`
      if (e.kind === 'pipeline_failed')    return `Pipeline FAILED: ${d['error']}`
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

async function executepipeline(
  dotSource: string,
  workingDirectory?: string,
): Promise<{ text: string }> {
  const events: PipelineEvent[] = []

  const runner = new Runner({
    api_key: API_KEY,
    model: DEFAULT_MODEL,
    working_directory: workingDirectory ?? process.cwd(),
    on_event: (e: PipelineEvent) => events.push(e),
  })

  const outcome = await runner.run(dotSource)
  const eventLog = formatEvents(events)

  const lines = [
    `Status: ${outcome.status}`,
    '',
    eventLog,
  ]
  if (outcome.failure_reason) {
    lines.push('', `Error: ${outcome.failure_reason}`)
  }

  return { text: lines.join('\n').trim() }
}

// ---------------------------------------------------------------------------
// MCP server factory — one instance per session
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: 'attractor',
    version: '0.1.0',
  })

  // ------------------------------------------------------------------
  // Tool: run_pipeline
  // ------------------------------------------------------------------
  server.registerTool(
    'run_pipeline',
    {
      description:
        'Execute an Attractor DOT pipeline. ' +
        'Reads OPENROUTER_API_KEY from the server environment. ' +
        'Returns a stage-by-stage execution log and final status.',
      inputSchema: {
        dot_source: z.string().describe('The DOT pipeline source to execute'),
        working_directory: z
          .string()
          .optional()
          .describe(
            'Working directory for agent tools (file reads, shell commands). ' +
            'Defaults to the MCP server\'s working directory.',
          ),
      },
    },
    async ({ dot_source, working_directory }) => {
      try {
        const { text } = await executepipeline(dot_source, working_directory)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Pipeline error: ${e}` }] }
      }
    },
  )

  // ------------------------------------------------------------------
  // Tool: validate_pipeline
  // ------------------------------------------------------------------
  server.registerTool(
    'validate_pipeline',
    {
      description:
        'Parse and lint an Attractor DOT pipeline. ' +
        'Returns any validation errors or warnings without executing it.',
      inputSchema: {
        dot_source: z.string().describe('The DOT pipeline source to validate'),
      },
    },
    async ({ dot_source }) => {
      try {
        const graph = parseDot(dot_source)
        const diagnostics = validate(graph)

        if (diagnostics.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'Pipeline is valid. No issues found.' }],
          }
        }

        const text = diagnostics
          .map(d => `[${d.severity.toUpperCase()}] ${d.message} (rule: ${d.rule})`)
          .join('\n')

        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Parse error: ${e}` }] }
      }
    },
  )

  // ------------------------------------------------------------------
  // Tool: load_pipeline
  // ------------------------------------------------------------------
  server.registerTool(
    'load_pipeline',
    {
      description:
        'Load a .dot pipeline file from the filesystem and execute it. ' +
        'The working directory defaults to the directory containing the file.',
      inputSchema: {
        file_path: z
          .string()
          .describe('Absolute path to the .dot pipeline file'),
        working_directory: z
          .string()
          .optional()
          .describe(
            'Working directory for agent tools. ' +
            'Defaults to the directory containing the .dot file.',
          ),
      },
    },
    async ({ file_path, working_directory }) => {
      let dotSource: string
      try {
        dotSource = await readFile(file_path, 'utf8')
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Failed to read file: ${e}` }] }
      }

      const wd = working_directory ?? dirname(file_path)

      try {
        const { text } = await executepipeline(dotSource, wd)
        return {
          content: [{ type: 'text' as const, text: `File: ${file_path}\n\n${text}` }],
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Pipeline error: ${e}` }] }
      }
    },
  )

  return server
}

// ---------------------------------------------------------------------------
// HTTP server — session-per-connection pattern
// ---------------------------------------------------------------------------

const app = createMcpExpressApp()

const transports = new Map<string, StreamableHTTPServerTransport>()

app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (sessionId && transports.has(sessionId)) {
      // Reuse existing session transport
      await transports.get(sessionId)!.handleRequest(req, res, req.body)
      return
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      // New session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport)
        },
        onsessionclosed: (id) => {
          transports.delete(id)
        },
      })

      const server = createServer()
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
      return
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: missing or invalid session' },
      id: null,
    })
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      })
    }
  }
})

app.get('/mcp', (_req, res) => {
  res.status(405).set('Allow', 'POST').send('Method Not Allowed')
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Attractor MCP server listening on http://127.0.0.1:${PORT}/mcp`)
  if (!API_KEY) {
    console.warn('Warning: OPENROUTER_API_KEY not set — LLM-backed pipeline nodes will fail')
  }
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
