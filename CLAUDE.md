# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This is a **specification-only repository** — it contains no runnable code, no build system, and no tests. It defines three NLSpecs (Natural Language Specs) intended to be fed to coding agents to implement Attractor: a DOT-based AI workflow pipeline runner.

There are no build, lint, or test commands. All work here is authoring and editing markdown specification documents.

## Terminology

- **NLSpec** (Natural Language Spec): a human-readable spec written directly for coding agents to implement or validate behavior against.
- **Attractor**: a DOT-based pipeline runner that uses Graphviz DOT syntax to orchestrate multi-stage AI workflows. Each graph node is an AI task; edges define control flow.

## Specification Files

| File | Purpose |
|------|---------|
| `attractor-spec.md` | The main spec: DOT DSL schema, pipeline execution engine, node handlers, state management, condition expression language, validation/linting |
| `coding-agent-loop-spec.md` | Spec for a programmable coding agent library: agentic loop, provider-aligned toolsets, execution environment abstraction, subagents, event system |
| `unified-llm-spec.md` | Spec for a unified multi-provider LLM client: four-layer architecture, data model, streaming, tool calling, retry/error handling. Providers: Anthropic (Messages API) and OpenRouter (Chat Completions via `OpenAICompatibleAdapter`) |

## Architecture Relationships

The three specs form a layered stack:

```
Attractor (attractor-spec.md)
    ↓ uses
Coding Agent Loop (coding-agent-loop-spec.md)
    ↓ uses
Unified LLM Client (unified-llm-spec.md)
```

The **Coding Agent Loop** spec calls `Client.complete()` from the Unified LLM SDK directly — it does NOT use the high-level `generate()` function — so it can interleave tool execution with output truncation, steering injection, event emission, and loop detection.

## Key Design Decisions in the Specs

**Provider alignment:** Three providers are in scope: **Anthropic** (Claude Code profile — uses `edit_file` old_string/new_string), **OpenCode** (uses the shared core tool set), and **OpenRouter** (OpenAI-compatible Chat Completions API routing to many models). OpenRouter model IDs use `provider/model` format (e.g., `anthropic/claude-opus-4-6`).

**Execution environment abstraction:** Tool operations run through an `ExecutionEnvironment` interface, not directly against the local filesystem. This enables Docker, Kubernetes, WASM, and SSH backends without changing tool logic.

**Tool output truncation:** Character-based truncation runs first (always), then line-based truncation. Order matters — never swap them. The `TOOL_CALL_END` event always carries the full untruncated output.

**Project document loading:** The coding agent loop loads `AGENTS.md` (always), plus provider-specific files (`CLAUDE.md` for Anthropic, `OPENCODE.md` for OpenCode). Total budget: 32KB.

## Editing Guidelines

When editing specs:
- The "Definition of Done" checklist at the end of each spec is the authoritative validation criteria for implementors — keep it consistent with the body of the spec.
- Pseudocode in specs uses neutral notation (not any specific language). Preserve this language-agnostic style.
- The specs reference real open-source projects (codex-rs, pi-agent-core, gemini-cli, Vercel AI SDK, LiteLLM) as reference implementations — links and descriptions should stay accurate.
