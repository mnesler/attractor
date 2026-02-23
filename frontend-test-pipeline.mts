/**
 * Frontend test pipeline — installs Playwright, writes e2e tests for the
 * SolidJS TCG app, runs them against http://localhost:3000, and reports results.
 *
 * Usage:
 *   set -a && source .env && set +a && npx tsx frontend-test-pipeline.mts
 */

import { Runner, PipelineRecorder } from './packages/attractor/src/index.js'
import { EventKind } from './packages/agent/src/types/event.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const API_KEY = process.env['OPENROUTER_API_KEY']
if (!API_KEY) {
  console.error('Set OPENROUTER_API_KEY to run this pipeline.')
  process.exit(1)
}

const FRONTEND_DIR = '/home/maxwell/attractor-tcg-solid-js'

/** Escape a string for embedding inside a DOT double-quoted attribute value. */
function dotStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
}

const historyFile = join(__dirname, 'frontend-test-output/pipeline-history/runs.jsonl')

const dockerEndpoint = 'http:' + String.raw`//localhost:12434/engines/llama.cpp/v1/chat/completions`
const buildPrompt = dotStr(`In ${FRONTEND_DIR}, wire the Deck Assistant chat to use a local Docker model runner instead of the Anthropic API. Read src/lib/server/chat.ts first to understand the current implementation. The Docker model runner exposes an OpenAI-compatible Chat Completions API. The full endpoint URL is: ${dockerEndpoint} - use this exact URL string in the code. The model name to use is hf.co/minimaxir/magic-the-gathering. Replace the Anthropic fetch call with a fetch to the Docker model runner using the OpenAI Chat Completions request format (messages array with role/content, model field, max_tokens). Keep the same system prompt about being an EDH deck building assistant. Remove the ANTHROPIC_API_KEY check - instead if the fetch fails with a connection error, return a helpful error message: Local MTG model is not running. Start it with: docker model run hf.co/minimaxir/magic-the-gathering. Update any other error messages to reference the local model rather than Anthropic. Do not change the Chat.tsx component or any UI code - only change src/lib/server/chat.ts.`)

const dot = `digraph FrontendTestPipeline {
  graph [goal="Wire Deck Assistant chat to local Docker model runner hf.co/minimaxir/magic-the-gathering"]
  start [shape=Mdiamond, label="Start"]
  exit [shape=Msquare, label="Done"]
  build [shape=box, label="Hook Up Local MTG Model", prompt="${buildPrompt}"]
  start -> build -> exit
}`

const BOLD  = '\x1b[1m'
const DIM   = '\x1b[2m'
const CYAN  = '\x1b[36m'
const GREEN = '\x1b[32m'
const RED   = '\x1b[31m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

const recorder = new PipelineRecorder(join(__dirname, 'frontend-test-output/pipeline-history'), {
  passthrough: (e) => {
    switch (e.kind) {
      case 'pipeline_started':
        console.log(`\n${BOLD}▶ Pipeline: ${e.data['name']}${RESET}`)
        break
      case 'stage_started':
        console.log(`\n${CYAN}◆ ${e.data['name']}${RESET}`)
        break
      case 'stage_completed':
        console.log(`${GREEN}✓ done${RESET} ${DIM}(${e.data['duration']}ms)${RESET}`)
        break
      case 'stage_failed':
        console.log(`${RED}✗ failed: ${e.data['error']}${RESET}`)
        break
      case 'pipeline_completed':
        console.log(`\n${GREEN}${BOLD}✓ Pipeline complete${RESET} ${DIM}(${e.data['duration']}ms)${RESET}`)
        break
      case 'pipeline_failed':
        console.log(`\n${RED}${BOLD}✗ Pipeline failed${RESET}`)
        break
      case 'checkpoint_saved':
        console.log(`  ${DIM}[checkpoint → ${e.data['node_id']}]${RESET}`)
        break
    }
  },
})

const runner = new Runner({
  api_key: API_KEY,
  model: 'moonshotai/kimi-k2.5',
  trigger: 'claude_code',
  working_directory: FRONTEND_DIR,

  on_event: recorder.handler,

  on_agent_event: (e) => {
    recorder.agentHandler(e)
    if (e.kind === EventKind.TOOL_CALL_START) {
      const args = JSON.stringify(e.data['arguments'] ?? {})
      console.log(`  ${YELLOW}→ ${e.data['tool_name']}${RESET}  ${DIM}${args.slice(0, 80)}${RESET}`)
    }
    if (e.kind === EventKind.ASSISTANT_TEXT_END) {
      const text = String(e.data['text'] ?? '').trim()
      if (text) console.log(`  ${DIM}${text.slice(0, 400)}${text.length > 400 ? '…' : ''}${RESET}`)
    }
  },
})

const outcome = await runner.run(dot, { logs_root: join(__dirname, 'frontend-test-output/run-logs') })
console.log(`\nFinal outcome: ${outcome.status}`)
if (outcome.notes) console.log(`Notes: ${outcome.notes}`)
