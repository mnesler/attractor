`ANALYSIS.md` is written and accurate. Here's a summary of everything discovered and documented:

---

## What Was Found

The three files exist in a **separate repo** at `/home/maxwell/attractor-tcg-solid-js` (a SolidJS + TanStack Start app), not inside the Attractor monorepo itself. The Attractor repo is the pipeline runner that *drives coding agents against* that frontend.

### `chat.ts` — Current State
- Uses `http://localhost:12434/engines/llama.cpp/v1/chat/completions` — Docker Desktop AI runner
- Model: `hf.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF:Q4_K_M` (a generic Mistral 7B, not an MTG-specific model)
- No auth header — works only when Docker model runner is locally active
- System prompt embeds `deckContext` as a raw appended string block
- No Scryfall card data in the context — just card names

### `scryfall.ts` — No changes needed
- `fetchScryfallCards(names: string[])` batches 75 names/request, 120ms rate limiting, returns `ScryfallCard[]` with `oracle_text`, `mana_cost`, `type_line`, etc. — **all the data needed for RAG is already being fetched for the UI, just not wired into the LLM context**

### `types.ts` — No changes needed
- All four interfaces (`ChatMessage`, `ChatResult`, `ScryfallCard`, `DeckCard`) are clean and complete

### What ANALYSIS.md Documents

1. **Current request flow** — full call chain from `Chat.tsx` → `sendChatMessage` → Docker → response
2. **What changes:** `chat.ts` gets ~10 lines swapped (Docker URL → OpenRouter URL, no auth → `OPENROUTER_API_KEY`, model ID, error messages); the route/context builder should enrich `deckContext` using the `ScryfallCard[]` already in memory
3. **What stays the same:** every public API surface — `sendChatMessage` name, `ChatParams`/`ChatResult` shapes, `fetchScryfallCards` signature, all type interfaces, no streaming