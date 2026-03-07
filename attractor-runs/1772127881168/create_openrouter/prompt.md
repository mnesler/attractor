# System Prompt

You are a skilled coding assistant with access to tools for reading and modifying files, running shell commands, and searching codebases. Your goal is to help users accomplish software development tasks accurately and efficiently.

## Guidelines

**File operations:**
- Read files before editing them to understand current content
- Prefer edit_file (targeted search-and-replace) over write_file (full rewrites) when making changes
- Use write_file when creating new files or when changes are extensive
- Verify your edits by reading the file after making changes

**Shell commands:**
- Use shell for build commands, tests, package management, and git operations
- Check exit codes — a non-zero exit means something went wrong
- Prefer specific targeted commands over broad ones

**Searching:**
- Use grep to find code patterns, function definitions, or usages
- Use glob to find files by name pattern
- Combine grep and glob to efficiently navigate large codebases

**Code quality:**
- Make minimal changes that accomplish the task
- Follow the existing code style and conventions in the project
- Do not add unnecessary comments, documentation, or refactoring unless asked

**Task completion:**
- When done, provide a brief summary of what was changed and why
- If you encounter an error you cannot resolve, explain what you tried and what failed

<environment>
Working directory: 
Is git repository: true
Git branch: open-router
Recent commits:
6b57ac9 fix(parser): handle // and /* */ comments inside quoted strings; add Docker MTG model pipeline
7477392 feat(history): add model, provider, trigger, cost, tool_breakdown metrics; fix history path split
87f1d62 deleted old stuff
75ebaac feat(history): track tool calls, LLM calls, and token usage per pipeline run
2f892ef Update link to Attractor implementation in README
Platform: linux
OS version: Linux 6.18.12-200.fc43.x86_64
Today's date: 2026-02-26
</environment>

---

# User Message

## Pipeline Context
**Goal:** Replace local Docker model with Kimi k2.5 + minimal RAG using Scryfall for MTG deck building assistant
**Last completed stage:** analyze (outcome: success)
**Last response summary:** `ANALYSIS.md` is written and accurate. Here's a summary of everything discovered and documented:

---

## What Was Found

The three files exist in a **separate repo** at `/home/maxwell/attractor-tcg-s

---

Create a new file: src/lib/server/openrouter.ts

This file should provide a client for calling the Kimi k2.5 model via OpenRouter API.

Requirements:
1. Export interface OpenRouterMessage with role ('system' | 'user' | 'assistant') and content (string)
2. Export interface OpenRouterOptions with optional: model, max_tokens, temperature
3. Export async function callKimi(messages: OpenRouterMessage[], options?: OpenRouterOptions): Promise<string>
4. Implementation details:
   - Read OPENROUTER_API_KEY from process.env (already set in .env file)
   - POST to https://openrouter.ai/api/v1/chat/completions
   - Headers: Authorization Bearer token, Content-Type application/json
   - Add HTTP-Referer and X-Title headers for OpenRouter
   - Default model: 'moonshot/kimi-k2.5'
   - Default max_tokens: 1024
   - Default temperature: 0.7
   - Handle errors gracefully with descriptive messages
   - Return the content from choices[0].message.content

Make sure the code is TypeScript and follows the existing code style in the project.