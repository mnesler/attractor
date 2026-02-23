/**
 * Frontend test pipeline — installs Playwright, writes e2e tests for the
 * SolidJS TCG app, runs them against http://localhost:3000, and reports results.
 *
 * Usage:
 *   set -a && source .env && set +a && npx tsx frontend-test-pipeline.mts
 */

import { Runner, PipelineRecorder } from './packages/attractor/src/index.js'
import { EventKind } from './packages/agent/src/types/event.js'

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

const fixPrompt = dotStr(`In ${FRONTEND_DIR}, fix the broken Playwright e2e tests and do not stop until they are all passing. The test file is tests/e2e/app.spec.ts. Steps: (1) Read the test file and the relevant source files (app/routes/index.tsx etc) to understand why the tests are failing. (2) Run npx playwright test --reporter=list to see current failures. (3) Fix the tests. (4) Run again. (5) Repeat until all tests pass. When all tests pass, report the final results.`)

const dot = `digraph FrontendTestPipeline {
  graph [goal="Fix broken Playwright e2e tests for the SolidJS TCG app on localhost:3000 and do not stop until they all pass"]
  start [shape=Mdiamond, label="Start"]
  exit [shape=Msquare, label="Done"]
  fix [shape=box, label="Fix Tests Until Passing", prompt="${fixPrompt}"]
  start -> fix -> exit
}`

const BOLD  = '\x1b[1m'
const DIM   = '\x1b[2m'
const CYAN  = '\x1b[36m'
const GREEN = '\x1b[32m'
const RED   = '\x1b[31m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

const recorder = new PipelineRecorder('./frontend-test-output/pipeline-history', {
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

const outcome = await runner.run(dot, { logs_root: './frontend-test-output/run-logs' })
console.log(`\nFinal outcome: ${outcome.status}`)
if (outcome.notes) console.log(`Notes: ${outcome.notes}`)
