# Analysis: Replace Docker Model with Kimi k2.5 + Scryfall RAG

**Goal:** Swap the local Docker model in `chat.ts` for Kimi k2.5 via OpenRouter, and wire
Scryfall card data into the LLM context for genuine deck-building advice.

---

## Repository Layout

This is a monorepo at `/home/maxwell/attractor` (the pipeline runner). The MTG frontend is a
**separate project** at `/home/maxwell/attractor-tcg-solid-js` — a SolidJS + TanStack Start app.
All three files named in the task brief live there:

| Spec path | Actual path |
|---|---|
| `src/lib/server/chat.ts` | `/home/maxwell/attractor-tcg-solid-js/src/lib/server/chat.ts` |
| `src/lib/server/scryfall.ts` | `/home/maxwell/attractor-tcg-solid-js/src/lib/server/scryfall.ts` |
| `src/lib/types.ts` | `/home/maxwell/attractor-tcg-solid-js/src/lib/types.ts` |

There is also a pre-built OpenRouter helper already in the frontend repo at
`/home/maxwell/attractor-tcg-solid-js/src/lib/server/openrouter.ts`.

---

## Current Flow of Chat Requests

```
User types a message in Chat.tsx
  └─▶ send() collects { messages: ChatMessage[], deckContext: string }
        └─▶ sendChatMessage({ data: { messages, deckContext } })    [TanStack createServerFn POST]
              └─▶ chat.ts handler:
                    1. Builds systemPrompt:
                         "You are a Magic: The Gathering EDH/Commander deck building assistant…"
                         + deckContext (plain card list — NO oracle text, NO mana costs)
                    2. Prepends system turn; strips any 'system' messages from history
                    3. POST http://localhost:12434/engines/llama.cpp/v1/chat/completions
                         model: hf.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF:Q4_K_M
                         max_tokens: 1024
                         (no auth header)
                    4. Returns ChatResult { content } on success
                       Returns ChatResult { error } on HTTP error or connection failure
```

### Where `deckContext` comes from today

`deckContext` is assembled in `deck.$deckId.tsx` by `buildDeckContext()` (from `deck-parser.ts`).
It produces a plain-text card list like:

```
Deck: My EDH Deck
Commander(s): Thassa's Oracle
Total cards: 100

Card list:
  1x Thassa's Oracle
  1x Mana Crypt
  1x Sol Ring
  …
```

**Crucially:** the `ScryfallCard[]` array — which contains `oracle_text`, `mana_cost`,
`type_line`, and `cmc` — is fetched separately for UI purposes (card images, stats panel)
and is already available in `enrichedCommanders()` / `enrichedMainboard()` / `allEnrichedCards()`
**at the same moment** that `deckContext()` is computed. However, none of that Scryfall data is
currently forwarded into the LLM context string. The model only sees card names.

---

## Key File-by-File State

### `chat.ts` — the only file that needs to change

| Property | Current value |
|---|---|
| Endpoint | `http://localhost:12434/engines/llama.cpp/v1/chat/completions` (Docker Desktop AI) |
| Model | `hf.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF:Q4_K_M` (generic Mistral 7B) |
| Auth | None — no `Authorization` header |
| Connection error message | "Start it with: `docker model run hf.co/minimaxir/magic-the-gathering`" |
| Fallback error | "Check if Docker model runner is running." |

The rest of the function — message building, system-role filtering, `choices[0].message.content`
extraction, HTTP error body parsing — is OpenAI-compatible and works identically against
OpenRouter. It does not need to change.

There is also an existing `openrouter.ts` helper (`callKimi`) in the same `server/` directory.
It has a **bug in the model ID**: it uses `'moonshot/kimi-k2.5'` but the correct OpenRouter
model slug is `'moonshotai/kimi-k2.5'`. This helper is not yet wired into `chat.ts`.

### `scryfall.ts` — no changes needed

- `fetchScryfallCards(names: string[]): Promise<ScryfallCard[]>` — correct signature
- Batches 75 names per `POST /cards/collection` request
- 120 ms sleep between batches (≤ 10 req/s, within Scryfall's limit)
- Returns full `ScryfallCard[]` including `oracle_text`, `type_line`, `mana_cost`, `cmc`

### `types.ts` — no changes needed

```ts
ChatMessage  { role: 'user' | 'assistant' | 'system'; content: string }
ChatResult   { content?: string; error?: string }
ScryfallCard { id, name, type_line, mana_cost?, oracle_text?,
               image_uris?, card_faces?, colors?, color_identity, cmc }
DeckCard     { quantity: number; name: string; scryfallCard?: ScryfallCard }
Deck         { id, name, commander?, mainboard: DeckCard[], format }
```

All interfaces are complete and correct for the target design.

### `deck-parser.ts` — `buildDeckContext` is where RAG enrichment belongs

`buildDeckContext(deckName, commander[], cards: DeckCard[])` already receives `DeckCard[]`
objects, and each `DeckCard` already carries an optional `.scryfallCard: ScryfallCard`. The
Scryfall data is therefore available inside `buildDeckContext` — it just isn't used yet. Enriching
`buildDeckContext` to emit oracle text is the minimal, zero-interface-change path for RAG.

---

## What Needs to Change

### 1. `chat.ts` — swap Docker → OpenRouter (~10 lines)

| | Current | Target |
|---|---|---|
| Endpoint | `http://localhost:12434/…` | `https://openrouter.ai/api/v1/chat/completions` |
| Model | `hf.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF:Q4_K_M` | `moonshotai/kimi-k2.5` |
| Auth | None | `Authorization: Bearer ${process.env['OPENROUTER_API_KEY']}` |
| Missing key | N/A | Return `ChatResult { error }` immediately before fetch |
| HTTP error prefix | `"Local model error …"` | `"OpenRouter error …"` |
| Connection error msg | Docker-specific | OpenRouter-specific |
| Fallback error msg | Docker-specific | OpenRouter-specific |

Options: either (a) inline the fetch changes directly in `chat.ts` (10-line swap), or (b)
delegate to the existing `callKimi` helper in `openrouter.ts` after fixing its model ID bug.
Option (b) is cleaner — it keeps `chat.ts` thin and tests `openrouter.ts` in production.

### 2. `openrouter.ts` — fix the model ID bug (1 line)

`'moonshot/kimi-k2.5'` → `'moonshotai/kimi-k2.5'`

The correct OpenRouter slug for Moonshot AI's Kimi k2.5 is `moonshotai/kimi-k2.5`.

### 3. `deck-parser.ts` — enrich `buildDeckContext` with Scryfall RAG

`buildDeckContext` already receives `DeckCard[]`, each of which may have `.scryfallCard`.
Change it to emit a compact per-card block instead of bare card names:

```
Deck: My EDH Deck
Commander(s): Thassa's Oracle
Total cards: 100

Card list:
  1x Thassa's Oracle — {U}{U} — Legendary Creature — Merfolk Wizard
    Devotion to blue. When this enters, if library cards ≤ devotion, you win.

  1x Mana Crypt — {0} — Artifact
    At the beginning of your upkeep, flip a coin. On tails, take 3 damage.
    Tap: Add {C}{C}.

  1x Sol Ring — {1} — Artifact
    Tap: Add {C}{C}.
  …
```

Cards without Scryfall data (not yet fetched, or not found) fall back to the current
`"  Nx Name"` format, preserving backwards compatibility.

**Why here and not in `chat.ts`?** `buildDeckContext` already has the `DeckCard[]` objects
with `.scryfallCard` attached. The caller (`deck.$deckId.tsx`) passes `allEnrichedCards()`
which is the post-Scryfall-enriched array. Adding oracle text here:
- requires zero changes to `ChatParams`, `ChatResult`, `sendChatMessage`, or `Chat.tsx`
- requires zero additional fetches
- keeps `chat.ts` a pure transport layer

---

## What Must Stay the Same (API Compatibility)

| Surface | Constraint | Why |
|---|---|---|
| `sendChatMessage` export name | Unchanged | Imported directly by `Chat.tsx` line 2 |
| `ChatParams` shape `{ messages, deckContext }` | Unchanged | `Chat.tsx` passes `data: { messages, deckContext }` |
| `ChatResult` shape `{ content?, error? }` | Unchanged | `Chat.tsx` reads both fields in `send()` |
| `fetchScryfallCards` export + signature | Unchanged | Used by `deck.$deckId.tsx` via `callScryfallFetch` wrapper |
| `buildDeckContext` signature | Unchanged | Called in `deck.$deckId.tsx` `deckContext()` memo |
| `ScryfallCard` interface fields | Unchanged | Used in `CardGrid`, `CardImage`, `DeckStats`, `DeckSection` |
| `ChatMessage.role` union `'user'|'assistant'|'system'` | Unchanged | Filtering logic in `chat.ts` line 27 |
| No streaming | Unchanged | `Chat.tsx` reads `.content` as a completed string |
| `callKimi` in `openrouter.ts` | Signature unchanged, model ID corrected | `chat.ts` will call it; other future callers expect the same signature |

---

## Implementation Plan (in order)

1. **`openrouter.ts`** — fix `DEFAULT_MODEL` from `'moonshot/kimi-k2.5'` to `'moonshotai/kimi-k2.5'`
   *(1-line fix, unblocks everything else)*

2. **`chat.ts`** — replace the Docker `fetch` block with a delegated call to `callKimi`
   from `openrouter.ts`; add missing-key guard; update error messages
   *(~10 lines changed, zero interface changes)*

3. **`deck-parser.ts`** — extend `buildDeckContext` to include per-card oracle text,
   mana cost, and type line from `.scryfallCard` where available
   *(adds ~12 lines, purely additive, no interface changes)*

4. **`.env.example`** — add `OPENROUTER_API_KEY=sk-or-v1-your-key-here` so future
   contributors know the variable name
   *(1 line)*

No changes to `scryfall.ts`, `types.ts`, `Chat.tsx`, or `deck.$deckId.tsx`.
