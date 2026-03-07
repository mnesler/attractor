Done! Here's a summary of everything created:

---

## ✅ `pipelines/` directory created

### What was added

| Path | Purpose |
|---|---|
| `pipelines/README.md` | Documents the directory: how to run pipelines, the expected file structure, and how to add new ones |
| `pipelines/example.mts` | A fully-working starter pipeline you can copy for any new task |

### How `pipelines/example.mts` is structured

It follows the exact same conventions as `frontend-test-pipeline.mts` at the repo root:

- **DOT graph** — defines `start`, two agent stages (`greet` → `check`), and `exit`
- **`PipelineRecorder`** — writes history to `pipeline-output/example/pipeline-history/runs.jsonl`
- **`Runner`** — uses `moonshotai/kimi-k2.5` via OpenRouter, with coloured console output for every event
- **Logs** — written to `pipeline-output/example/run-logs/`

### `.gitignore` update

Added `pipeline-output/` so generated run logs and history files from any pipeline in this directory are never accidentally committed.

### Running a pipeline

```bash
# from repo root
set -a && source .env && set +a
npx tsx pipelines/example.mts
```