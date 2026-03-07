✅ `pipelines/test-and-fix.mts` is created, parses cleanly, and validates with zero errors. Here's a summary of what was built:

---

## ✅ `pipelines/test-and-fix.mts` created

### What it does

Runs the Attractor test suite end-to-end and autonomously fixes any failures using a **branching, self-correcting DOT graph**:

```
start → build → test ──────────────────────────────→ exit
                  │ (failure)                           ↑
                  ↓                                     │
               diagnose → fix ──────(success)──→ verify ┘
                  ↑         │ (failure)           │ (failure)
                  └─────────┘                     ↓
                                                  fix
```

### Graph features demonstrated

| Feature | Where used |
|---|---|
| `graph [goal, label, default_max_retry]` | Top-level pipeline metadata |
| `goal_gate = true` | `test` and `verify` — pipeline cannot exit until both pass |
| `condition="outcome=success"` / `condition="outcome!=success"` | All branching edges |
| `weight=10` | Success edges win over failure edges at each branch point |
| `max_retries = 1` | `fix` node gets one automatic retry before routing back to `diagnose` |
| `stage_retrying` event | Handled in the console passthrough |
| Conditional loop-back | `fix → diagnose` and `verify → fix` close the feedback loop |

### Outputs

- Run logs → `pipeline-output/test-and-fix/run-logs/`
- History → `pipeline-output/test-and-fix/pipeline-history/runs.jsonl`
- Failures summary (written by agent) → `pipeline-output/test-and-fix/failures.txt`
- Fix plan (written by agent) → `pipeline-output/test-and-fix/fix-plan.md`

### Run it

```bash
set -a && source .env && set +a
npx tsx pipelines/test-and-fix.mts
```