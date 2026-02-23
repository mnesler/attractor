/**
 * Attractor demo — runs a real coding pipeline with a live LLM.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... npx tsx demo.mts
 *   or:
 *   source .env && npx tsx demo.mts
 */

import { Runner, PipelineRecorder } from './packages/attractor/src/index.js'
import { EventKind } from './packages/agent/src/types/event.js'

const API_KEY = process.env['OPENROUTER_API_KEY']
if (!API_KEY) {
  console.error('Set OPENROUTER_API_KEY to run this demo.')
  process.exit(1)
}

const dot = `
digraph CodingDemo {
    graph [goal="Write a Fibonacci script, verify it works, and save it to ./demo-output/"]

    start [shape=Mdiamond, label="Start"]
    exit  [shape=Msquare,  label="Done"]

    write [shape=box, label="Write Script",
           prompt="Create the directory ./demo-output/ if it doesn't exist. Write a Python script to ./demo-output/fibonacci.py that prints the first 10 Fibonacci numbers when run. Keep it short."]

    test  [shape=box, label="Test Script",
           prompt="Run the script at ./demo-output/fibonacci.py using: python3 ./demo-output/fibonacci.py — verify it prints numbers. Report what it printed."]

    start -> write -> test -> exit
}
`

const BOLD   = '\x1b[1m'
const DIM    = '\x1b[2m'
const CYAN   = '\x1b[36m'
const GREEN  = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RESET  = '\x1b[0m'

const recorder = new PipelineRecorder('./demo-output/pipeline-history', {
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
      case 'pipeline_completed':
        console.log(`\n${GREEN}${BOLD}✓ Pipeline complete${RESET} ${DIM}(${e.data['duration']}ms)${RESET}`)
        break
      case 'checkpoint_saved':
        console.log(`  ${DIM}[checkpoint → ${e.data['node_id']}]${RESET}`)
        break
    }
  },
})

const runner = new Runner({
  api_key: API_KEY,
  model: 'anthropic/claude-sonnet-4-6',
  working_directory: process.cwd(),

  on_event: recorder.handler,

  on_agent_event: (e) => {
    recorder.agentHandler(e)
    if (e.kind === EventKind.TOOL_CALL_START) {
      const args = JSON.stringify(e.data['arguments'] ?? {})
      console.log(`  ${YELLOW}→ ${e.data['tool_name']}${RESET}  ${DIM}${args.slice(0, 80)}${RESET}`)
    }
    if (e.kind === EventKind.ASSISTANT_TEXT_END) {
      const text = String(e.data['text'] ?? '').trim()
      if (text) console.log(`  ${DIM}${text.slice(0, 300)}${text.length > 300 ? '…' : ''}${RESET}`)
    }
  },
})

const outcome = await runner.run(dot, { logs_root: './demo-output/run-logs' })
console.log(`\nFinal outcome: ${outcome.status}`)
if (outcome.notes) console.log(`Notes: ${outcome.notes}`)
