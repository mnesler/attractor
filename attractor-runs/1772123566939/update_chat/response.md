TypeScript type-check passes with zero errors. Here's a summary of what was done:

---

## Changes Made — `src/lib/server/chat.ts`

**Replaced** the Attractor MCP-based implementation with a direct fetch to the local Docker model runner.

### What changed:

| Before | After |
|--------|-------|
| Called Attractor MCP server at `127.0.0.1:3001/mcp` via JSON-RPC | Calls Docker model runner directly at `http://localhost:12434/engines/llama.cpp/v1/chat/completions` |
| Required `ANTHROPIC_API_KEY` (implicit via MCP pipeline) | No API key required |
| Read a `.dot` pipeline template from disk and ran it | Sends messages array directly in OpenAI Chat Completions format |
| Parsed pipeline execution logs to find a response | Reads `choices[0].message.content` from the JSON response |
| Error message referenced Attractor MCP server | Error message says: *"Local MTG model is not running. Start it with: `docker model run hf.co/minimaxir/magic-the-gathering`"* |

### What stayed the same:
- `sendChatMessage` server function signature and export
- `ChatParams` / `ChatResult` types
- EDH deck building system prompt (kept + extended with `deckContext`)
- No changes to `Chat.tsx` or any UI code — only `chat.ts` was modified