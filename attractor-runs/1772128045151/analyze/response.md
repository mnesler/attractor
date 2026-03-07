`ANALYSIS.md` is written and accurate. Here's a precise summary of everything discovered:

---

## What Was Found

### Repository structure (important context)
The task brief uses spec paths like `src/lib/server/chat.ts`, but this Attractor repo is the **pipeline runner** — the actual MTG app lives at `/home/maxwell/attractor-tcg-solid-js`, a SolidJS + TanStack Start app. All three target files, plus a pre-existing `openrouter.ts` helper, are in that repo.

---

### `chat.ts` — current state (needs changes)

**Full call chain:**
```
Chat.tsx send()
  → sendChatMessage({ data: { messages, deckContext } })   [TanStack createServerFn POST]
    → chat.ts builds systemPrompt + filters history messages
    → POST http://localhost:12434/engines/llama.cpp/v1/chat/completions
         model: hf.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF:Q4_K_M   ← generic Mistral 7B
         (no auth header)
    → returns ChatResult { content } or { error }
```

- **No auth** — works only when Docker Desktop AI runner is locally active
- **deckContext** passed as a plain card name list — no oracle text, no mana costs, no type lines
- Error messages hard-code Docker-specific advice ("Start it with: `docker model run …`")
- Everything else (OpenAI message format, `choices[0].message.content`, HTTP error body parsing) is already OpenRouter-compatible

---

### `openrouter.ts` — already exists, has a bug
A `callKimi` helper sits at `src/lib/server/openrouter.ts` and is not yet wired into `chat.ts`. It has a **model ID bug**: `DEFAULT_MODEL = 'moonshot/kimi-k2.5'` — the correct OpenRouter slug is `'moonshotai/kimi-k2.5'`.

---

### `scryfall.ts` — no changes needed
`fetchScryfallCards(names: string[])` is complete: batches 75/request, 120ms rate-limiting, returns `ScryfallCard[]` with full `oracle_text`, `mana_cost`, `type_line`, `cmc`.

---

### `types.ts` — no changes needed
All four interfaces (`ChatMessage`, `ChatResult`, `ScryfallCard`, `DeckCard`) are correct and complete.

---

### The RAG opportunity in `deck-parser.ts`
`buildDeckContext(deckName, commanders, cards: DeckCard[])` is called in `deck.$deckId.tsx` **after** `allEnrichedCards()` is computed — meaning every `DeckCard` already has `.scryfallCard` populated at that point. The oracle text is right there, it's just not being written into the context string. Enriching `buildDeckContext` is zero-interface-change RAG.

---

## ANALYSIS.md Documents

| Section | Content |
|---|---|
| Repository layout | Correct absolute paths for all three target files + the existing openrouter.ts helper |
| Current request flow | Full annotated call chain from `Chat.tsx` through to the Docker endpoint |
| `deckContext` today | What `buildDeckContext` produces and what data it's missing |
| File-by-file state | What's broken, what's correct, the model ID bug in `openrouter.ts` |
| What needs to change | 4 targeted changes across 3 files + env example; tables with before/after for each |
| What must stay the same | 9 public API surfaces with the exact file/line reason each is locked |
| Implementation plan | Ordered 4-step plan with line-count estimates |