Zero TypeScript errors. Here's a precise summary of everything that was done:

---

## What changed

### New file: `src/lib/server/rag.ts` (119 lines)

A pure, self-contained RAG helper with no network calls:

| Export | Purpose |
|---|---|
| `DeckAnalysis` interface | Shape of the structured result (`totalCards`, `commanderColors`, `avgCmc`, `manaCurve`, `summary`) |
| `analyzeDeck(deckContext)` | Parses the raw deck-context string and returns a `DeckAnalysis` |

How parsing works:
- **Card counting** — every line matching `<qty> <name>` is summed into `totalCards`
- **CMC estimation** — checks for an inline `(cmc:N)` hint first, then falls back to a small lookup table of common staples (`Sol Ring`, `Arcane Signet`, etc.)
- **Mana curve** — CMC values are bucketed 0–7 (7 = "7+") and counted per bucket
- **Color identity** — extracted from a `Color Identity: W,U,B` header line if present
- **Commander name** — extracted from a `Commander: <name>` header line if present
- `summary` is a compact multi-line string ready to paste straight into a system prompt

### Modified file: `src/lib/server/chat.ts` (55 lines, was 90)

| Before | After |
|---|---|
| `fetch('http://localhost:12434/...')` | `callKimi(messages, { model: 'moonshot/kimi-k2.5', max_tokens: 1024 })` |
| No deck analysis | `analyzeDeck(params.deckContext)` called before building the prompt |
| System prompt = raw deck dump only | System prompt = MTG description + **deck analysis summary** + raw deck dump |
| Error messages mentioned Docker/local model | Error message is the actual thrown error string |
| ~55 lines of HTTP boilerplate | Delegated entirely to `callKimi` — clean 3-line try/catch |

The exported `sendChatMessage` signature, `ChatParams`, and `ChatResult` are **identical** — the frontend needs no changes.