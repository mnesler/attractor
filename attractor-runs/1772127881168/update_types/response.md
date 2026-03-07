The picture is now completely clear. Here's the full accounting:

**OpenRouter types** — fully covered in `packages/llm/`:
- API request/response shapes → `request.ts`, `response.ts`
- Auth/adapter options → `OpenRouterAdapterOptions` in `openrouter.ts`
- Model catalogue → `models.ts` (already has `provider: 'openrouter'` entries)
- Errors, streaming, tools, messages → all in their own type files

**RAG / Scryfall types** — `rag.ts` does not exist yet; neither does any Scryfall or MTG pipeline code at all. The pipeline context describes work that hasn't been done yet in this repo, so there are no missing types to add *right now* — adding speculative types ahead of implementation would be premature.

**`src/lib/types.ts`** — this path does not exist and never has. It appears to be a context artefact from a different project (a SvelteKit frontend). There is nothing to create or fix here.

---

## Verdict: no changes needed

Every type required for the OpenRouter integration is already defined and well-organised:

| Need | Where it lives |
|---|---|
| `OpenRouterAdapterOptions` | `packages/llm/src/adapters/openrouter.ts` |
| `Request` / `Response` / `Usage` / `FinishReason` | `packages/llm/src/types/request.ts` + `response.ts` |
| `Message` / `Role` / `ContentKind` / `ContentPart` | `packages/llm/src/types/message.ts` |
| `Tool` / `ToolCall` / `ToolResult` / `ToolChoice` | `packages/llm/src/types/tool.ts` |
| `StreamEvent` / `StreamEventType` / `StreamAccumulator` | `packages/llm/src/types/stream.ts` |
| All error classes (`RateLimitError`, `AuthenticationError`, …) | `packages/llm/src/types/errors.ts` |
| `ModelInfo` + Kimi/OpenRouter entries | `packages/llm/src/types/models.ts` |

There is no `src/lib/types.ts` — that path belongs to a SvelteKit frontend that doesn't exist in this repo. The RAG helper (`rag.ts`) and Scryfall integration haven't been built yet, so there are no RAG types to add until that implementation is written. Adding types speculatively would be premature and could drift from what the implementation actually needs.