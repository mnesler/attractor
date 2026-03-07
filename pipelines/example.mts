/**
 * Example pipeline — a minimal template to copy when building new pipelines.
 *
 * Usage (from repo root):
 *   set -a && source .env && set +a
 *   npx tsx pipelines/example.mts
 */

import { Runner, PipelineRecorder } from '../packages/attractor/src/index.js'
import { EventKind } from '../packages/agent/src/types/event.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ── Auth ─────────────────────────────────────────────────────────────────────

const API_KEY = process.env['OPENROUTER_API_KEY']
if (!API_KEY) {
  console.error('Set OPENROUTER_API_KEY to run this pipeline.')
  process.exit(1)
}

// ── Pipeline graph ────────────────────────────────────────────────────────────

const dot = `digraph ExamplePipeline {
  graph [goal="Demonstrate a minimal two-stage pipeline"]

  start [shape=Mdiamond, label="Start"]
  exit  [shape=Msquare,  label="Done"]

  greet [shape=box, label="Greet", prompt="Say hello and list the files in the current directory."]
  check [shape=box, label="Check", prompt="Summarise what you found in the previous step in one sentence."]

  start -> greet -> check -> exit
}`

// ── Console helpers ───────────────────────────────────────────────────────────

const BOLD   = '\x1b[1m'
const DIM    = '\x1b[2m'
const CYAN   = '\x1b[36m'
const GREEN  = '\x1b[32m'
const RED    = '\x1b[31m'
const YELLOW = '\x1b[33m'
const RESET  = '\x1b[0m'

// ── Recorder ──────────────────────────────────────────────────────────────────

const recorder = new PipelineRecorder(join(ROOT, 'pipeline-output/example/pipeline-history'), {
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

// ── Runner ────────────────────────────────────────────────────────────────────

const runner = new Runner({
  api_key: API_KEY,
  model: 'moonshotai/kimi-k2.5',
  trigger: 'manual',
  working_directory: ROOT,

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

// ── Run ───────────────────────────────────────────────────────────────────────

const outcome = await runner.run(dot, {
  logs_root: join(ROOT, 'pipeline-output/example/run-logs'),
})

console.log(`\nFinal outcome: ${outcome.status}`)
if (outcome.notes) console.log(`Notes: ${outcome.notes}`)
