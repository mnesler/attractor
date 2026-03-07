✅ Done. Here's a summary of what was changed and why:

---

## `src/lib/server/chat.ts` — Updated

### Problem
The working tree had drifted back to the Docker local model (`localhost:12434`) version. The committed HEAD version used an Attractor MCP client, but that approach had a fundamental flaw: the MCP `run_pipeline` tool returns pipeline **execution logs** (stage summaries), not the actual LLM response text — and there was an unresolved `// TODO: Parse the actual LLM response from the pipeline result` comment to prove it. It also required a separate MCP server process to be running on port 3001.

### What changed
Replaced the MCP pipeline integration with a **direct OpenRouter Chat Completions fetch**:

| | Before (MCP) | After (direct) |
|---|---|---|
| Endpoint | `http://127.0.0.1:3001/mcp` (local process) | `https://openrouter.ai/api/v1/chat/completions` |
| Model | `moonshot/kimi-k2` (wrong ID) | `moonshotai/kimi-k2.5` (correct ID) |
| Response | Pipeline execution log (unusable) | Actual LLM text via `choices[0].message.content` |
| Auth | None (relied on server env) | `OPENROUTER_API_KEY` read per-request with clear error if missing |
| Dependencies | MCP server process + pipeline file on disk | Just `fetch` |
| LOC | ~185 | ~98 |

The model, `max_tokens: 1024`, `temperature: 0.7`, and system prompt are all kept in sync with what `pipelines/mtg-assistant.dot` specifies.