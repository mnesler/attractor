The README looks good. Here's a summary of what was written and why:

---

## `README.md` — Created

### What it covers

The previous `README.md` was a stub pointing at the spec files. The new README is a complete project document that serves both first-time readers and returning contributors. It is organised into six sections:

| Section | Purpose |
|---------|---------|
| **Packages** | Table of the four monorepo packages (`llm`, `agent`, `attractor`, `attractor-mcp`) with one-line descriptions |
| **Specs** | Links to the three NLSpec files in `attractor-spec/` |
| **Pipelines / Quick start** | The two `set -a && source .env && npx tsx` commands needed to run a pipeline; table of included pipelines |
| **How pipelines work** | Four numbered subsections: writing a `digraph`, conditional routing with `condition`/`weight`, goal gates + retries, full node and graph attribute reference tables drawn directly from `NodeAttrs`, `Graph`, and `SHAPE_TO_HANDLER_TYPE` in the source |
| **Writing a pipeline file** | Four-bullet checklist of what to change when copying `example.mts`, plus a minimal boilerplate snippet |
| **History and observability** | Bullet list of every field written to `runs.jsonl` by `PipelineRecorder`, sourced from `history/types.ts` |
| **Development** | `npm install`, build, and vitest commands |
| **Terminology** | NLSpec, Attractor, Stage, Goal gate |