/**
 * Test-and-fix pipeline — runs the full Attractor test suite and, when tests
 * fail, hands the failures to an agent to diagnose and fix, then re-validates.
 *
 * Stages:
 *   build     → compile TypeScript across all packages
 *   test      → run vitest across all packages; collect failures
 *   diagnose  → (on failure) analyse failing tests and propose a fix strategy
 *   fix       → apply the fix
 *   verify    → re-run tests to confirm the fix worked
 *   exit      → done
 *
 * Usage (from repo root):
 *   set -a && source .env && set +a
 *   npx tsx pipelines/test-and-fix.mts
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

const dot = `digraph TestAndFix {
  graph [
    goal     = "Ensure all Attractor tests pass, fixing any failures automatically",
    label    = "Test & Fix",
    default_max_retry = 2
  ]

  rankdir = LR

  // ── Terminals ──────────────────────────────────────────────────────────────

  start [shape=Mdiamond, label="Start"]
  exit  [shape=Msquare,  label="Done"]

  // ── Stages ─────────────────────────────────────────────────────────────────

  build [
    shape  = box,
    label  = "Build",
    prompt = "Run \\"npm run build --workspaces --if-present\\" from the repo root to compile all TypeScript packages. If it fails, show the compiler errors and stop — do not attempt to fix them yet, just report what you found."
  ]

  test [
    shape     = box,
    label     = "Run Tests",
    goal_gate = true,
    prompt    = "Run \\"npx vitest run --reporter=verbose\\" from the repo root to execute the full test suite across all packages. Capture all output. If tests fail, write a concise summary of which tests failed and why to a file at pipeline-output/test-and-fix/failures.txt so the next stage can read it. Report the number of passed and failed tests."
  ]

  diagnose [
    shape  = box,
    label  = "Diagnose Failures",
    prompt = "Read pipeline-output/test-and-fix/failures.txt (written by the previous stage). Analyse the failing tests carefully: identify the root cause for each failure, distinguish test bugs from implementation bugs, and write a step-by-step fix plan to pipeline-output/test-and-fix/fix-plan.md. Be specific about which files need changing and why."
  ]

  fix [
    shape       = box,
    label       = "Apply Fix",
    max_retries = 1,
    prompt      = "Read pipeline-output/test-and-fix/fix-plan.md and implement every step of the plan. Edit source files directly — do not create new files unless the plan requires it. After applying all changes, run \\"npx vitest run --reporter=verbose\\" to confirm the fixes work. If tests still fail, report the remaining failures clearly."
  ]

  verify [
    shape     = box,
    label     = "Verify",
    goal_gate = true,
    prompt    = "Run \\"npx vitest run --reporter=verbose\\" one final time. All tests must pass. If any test still fails, report them explicitly so the pipeline can route back for another fix attempt. If everything passes, confirm success."
  ]

  // ── Edges ──────────────────────────────────────────────────────────────────

  start -> build

  // build always flows to test (build errors surface as a test failure)
  build -> test

  // After test: success → exit, failure → diagnose
  test -> exit     [label="Passed",  condition="outcome=success", weight=10]
  test -> diagnose [label="Failed",  condition="outcome!=success"]

  // diagnose always flows to fix
  diagnose -> fix

  // After fix: success → verify, failure → diagnose (retry the fix strategy)
  fix -> verify   [label="Fixed",   condition="outcome=success", weight=10]
  fix -> diagnose [label="Retry",   condition="outcome!=success"]

  // After verify: success → exit, failure → fix (one more attempt)
  verify -> exit  [label="All pass", condition="outcome=success", weight=10]
  verify -> fix   [label="Still failing", condition="outcome!=success"]
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

const recorder = new PipelineRecorder(join(ROOT, 'pipeline-output/test-and-fix/pipeline-history'), {
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
      case 'stage_retrying':
        console.log(`${YELLOW}↺ retrying (attempt ${e.data['attempt']})…${RESET}`)
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
  api_key:           API_KEY,
  model:             'moonshotai/kimi-k2.5',
  trigger:           'manual',
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
  logs_root: join(ROOT, 'pipeline-output/test-and-fix/run-logs'),
})

console.log(`\nFinal outcome: ${outcome.status}`)
if (outcome.notes) console.log(`Notes: ${outcome.notes}`)
