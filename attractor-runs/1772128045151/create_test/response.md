Everything is working end-to-end. Here's a summary of everything that was done:

---

## What was created and fixed

### `test-mtg-assistant.ts` (new file)
A standalone integration test script that can be run with `npx tsx test-mtg-assistant.ts`. Key design decisions:

- **Bypasses `createServerFn`** — `sendChatMessage` wraps the logic in a TanStack server function that requires the full Vinxi/SSR runtime. The test script calls `callKimi()` and `analyzeDeck()` directly, which is exactly what the server function composes at runtime.
- **Loads `.env` manually** — no `dotenv` dependency required; a simple 8-line parser reads `OPENROUTER_API_KEY` before the imports run.
- **Two-phase output** — prints the full `DeckAnalysis` struct first (RAG sanity check), then fires the API call and prints the response.
- **Informative on failure** — exits with code 1 and prints the error message so CI can catch it.

### `src/lib/server/openrouter.ts` (two fixes)
Kimi k2.5 is a **reasoning model** — it thinks internally before answering. This caused two problems:

1. **`DEFAULT_MAX_TOKENS` bumped `1024 → 4096`**: The model was exhausting its entire budget on chain-of-thought, leaving nothing for the actual reply. 4096 gives it room for both.
2. **Reasoning fallback added**: The response type now also reads `message.reasoning`. If `content` is empty or blank (e.g. the model ran long on a complex prompt), `callKimi` returns the reasoning text instead of a silent empty string.