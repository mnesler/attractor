Clean. Here's a summary of every decision made.

---

## What was created and why

### `test-mtg-assistant.ts` — at repo root, runnable with `npx tsx`

The example in the task brief assumed a SvelteKit/TanStack app with a `src/lib/server/chat` module and a `createServerFn` wrapper. After reading the actual codebase, none of that exists — this is a **TypeScript monorepo** (`packages/llm`, `packages/agent`, `packages/attractor`) where runnable scripts live at the root or in `pipelines/` and are executed directly with `npx tsx`, exactly like `pipelines/example.mts` and `pipelines/test-and-fix.mts`.

The script was written to match the real architecture:

| Concern | Decision |
|---|---|
| **Import path** | `./packages/llm/src/index.js` — mirrors how all other pipelines import packages (TypeScript source, `.js` extension, resolved at runtime by tsx) |
| **Client setup** | `new Client({ providers: { openrouter: new OpenRouterAdapter(...) } })` — the explicit form, so the test owns its own client instance rather than relying on the module-level singleton |
| **Model** | `moonshotai/kimi-k2-5` — the OpenRouter model ID for Kimi k2.5 as specified in the pipeline goal |
| **API call** | `generate({ client, model, provider, messages, system, … })` — the real high-level API from `packages/llm/src/generate.ts`; no mocked or invented wrappers |
| **Scryfall RAG** | Three focused functions: `parseCardNames` (regex over the decklist), `fetchCard` (Scryfall `/cards/named?exact=` endpoint), `fetchDeckCards` (chunked parallelism at 4 with 100ms inter-chunk pause to respect rate limits), `formatCard` (name + mana cost + type + oracle text) |
| **Prompt structure** | System prompt sets the expert MTG persona; user message embeds both the raw decklist and the Scryfall oracle context, then asks three specific questions — representative of how a real assistant would be prompted |
| **Error handling** | `fetchCard` returns `null` on any failure so a bad card name never aborts the whole run; `generate()` errors are caught and surface as a clean `process.exit(1)` |
| **Output** | Prints parsed card count → retrieval count → model response → token usage, giving full visibility into each stage of the RAG pipeline |

**Type-checking:** `tsc --noEmit` on the file exits 0 against the real `@attractor/llm` types. The four imported names (`Client`, `OpenRouterAdapter`, `generate`, `Message`) are all verified exports of `packages/llm/src/index.ts`. Runtime dynamic import of the same path also resolves correctly under `tsx`.