# Pipelines

This directory contains Attractor pipeline definitions — each `.mts` file is a
self-contained pipeline that can be run directly with `tsx`.

## Running a pipeline

```bash
# Load env vars, then run a pipeline
set -a && source ../.env && set +a
npx tsx <pipeline-name>.mts
```

## Structure

Each pipeline file:
1. Defines a DOT-graph (`digraph`) that describes the stages and transitions
2. Instantiates a `Runner` with the desired model + API key
3. Optionally attaches a `PipelineRecorder` for history + checkpointing
4. Calls `runner.run(dot, { logs_root })` and reports the outcome

## Adding a pipeline

Copy an existing file as a starting point and update:
- The `digraph` stages, prompts, and edges
- The `logs_root` / `historyFile` output paths
- Any pipeline-specific constants (working directory, model, etc.)
