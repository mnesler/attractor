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
7477392 feat(history): add model, provider, trigger, cost, tool_breakdown metrics; fix history path split
87f1d62 deleted old stuff
75ebaac feat(history): track tool calls, LLM calls, and token usage per pipeline run
2f892ef Update link to Attractor implementation in README
b8ba7ba update max tool rounds and turns to unlimited by default
Platform: linux
OS version: Linux 6.18.12-200.fc43.x86_64
Today's date: 2026-02-23
</environment>

---

# User Message

## Pipeline Context
**Goal:** Wire Deck Assistant chat to local Docker model runner hf.co/minimaxir/magic-the-gathering

---

In /home/maxwell/attractor-tcg-solid-js, wire the Deck Assistant chat to use a local Docker model runner instead of the Anthropic API. Read src/lib/server/chat.ts first to understand the current implementation. The Docker model runner exposes an OpenAI-compatible Chat Completions API. The full endpoint URL is: http://localhost:12434/engines/llama.cpp/v1/chat/completions - use this exact URL string in the code. The model name to use is hf.co/minimaxir/magic-the-gathering. Replace the Anthropic fetch call with a fetch to the Docker model runner using the OpenAI Chat Completions request format (messages array with role/content, model field, max_tokens). Keep the same system prompt about being an EDH deck building assistant. Remove the ANTHROPIC_API_KEY check - instead if the fetch fails with a connection error, return a helpful error message: Local MTG model is not running. Start it with: docker model run hf.co/minimaxir/magic-the-gathering. Update any other error messages to reference the local model rather than Anthropic. Do not change the Chat.tsx component or any UI code - only change src/lib/server/chat.ts.