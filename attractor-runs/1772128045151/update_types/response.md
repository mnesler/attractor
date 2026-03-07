That's a thorough picture. Here's the complete type accounting:

**`types.ts` already defines:**
- `DeckCard` — used by `deck-parser.ts`, `chat.ts` via `deckContext`, `scryfall.ts`
- `ScryfallCard` — used by `scryfall.ts`, `rag.ts` (indirectly via context string)
- `Deck` — used by route/deck pages
- `ChatResult` — used by `chat.ts` (locally re-declared) and `Chat.tsx`
- `ChatMessage` — used by `chat.ts` and `Chat.tsx`
- `CardType` + `CARD_TYPE_ORDER` + `getCardType()` — used by `DeckSection.tsx`

**OpenRouter types — `openrouter.ts` already defines:**
- `OpenRouterMessage` — `{ role: 'system' | 'user' | 'assistant'; content: string }`
- `OpenRouterOptions` — `{ model?, max_tokens?, temperature? }`

**RAG types — `rag.ts` already defines:**
- `DeckAnalysis` — `{ totalCards, commanderColors, avgCmc, manaCurve, summary }`

**`scryfall.ts` already defines:**
- `SearchScryfallParams` — `{ query: string; limit?: number }`

Every type needed by the OpenRouter integration and RAG layer is already declared in its own file, co-located with the code that owns it. `types.ts` covers the shared domain model (`ChatMessage`, `ChatResult`, `ScryfallCard`, `DeckCard`, `Deck`) that multiple modules share.

**No changes are needed.** `types.ts` is complete and correct. Here's the full accounting of why nothing is missing:

| Type | Where defined | Status |
|---|---|---|
| `ChatMessage` | `types.ts` | ✅ Present — imported by `chat.ts` and `Chat.tsx` |
| `ChatResult` | `types.ts` | ✅ Present — `chat.ts` re-declares a local copy (fine, compatible shape) |
| `ScryfallCard` | `types.ts` | ✅ Present — imported by `scryfall.ts`, used throughout |
| `DeckCard` | `types.ts` | ✅ Present — used by `deck-parser.ts`, routes |
| `Deck` | `types.ts` | ✅ Present — used by route/deck pages |
| `CardType` / `getCardType` | `types.ts` | ✅ Present — used by `DeckSection.tsx` |
| `OpenRouterMessage` | `openrouter.ts` | ✅ Correctly co-located — internal to that module |
| `OpenRouterOptions` | `openrouter.ts` | ✅ Correctly co-located — internal to that module |
| `DeckAnalysis` | `rag.ts` | ✅ Correctly co-located — exported but owned by the RAG module |
| `SearchScryfallParams` | `scryfall.ts` | ✅ Correctly co-located — owned by the Scryfall module |

`types.ts` needs no modifications. All shared types are present and correctly shaped for the OpenRouter/RAG integration that `chat.ts` already implements.