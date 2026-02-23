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

const buildPrompt = dotStr(`In ${FRONTEND_DIR}, slow down the deck loading flow so the user can clearly see the loading animation working. Read app/routes/index.tsx and app/routes/deck.$deckId.tsx first to understand the current flow. The desired experience is: (1) user inputs a decklist and clicks the button, (2) the loading animation immediately shows on the current page before navigating away, (3) after a short artificial delay (~500ms) the app navigates to the deck page, (4) the deck page loading animation plays for at least 500ms before showing content even if data loads faster, (5) the Scryfall fetch stage also stays visible for at least 500ms. Add artificial delays using setTimeout or a minimum display time so every loading UI state is visible to the user. Do not use real network slowdowns - just add artificial minimum display times. Make sure all the neon loading components that were previously added are clearly visible during these transitions. Do not stop until the full flow works end to end.`)

const dot = `digraph FrontendTestPipeline {
  graph [goal="Add artificial delays to deck loading flow so loading animations are clearly visible"]
  start [shape=Mdiamond, label="Start"]
  exit [shape=Msquare, label="Done"]
  build [shape=box, label="Add Loading Delays", prompt="${buildPrompt}"]
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
