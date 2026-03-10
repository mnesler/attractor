You are designing a web dashboard for Attractor, a DOT-based AI pipeline runner.

The data model is:
- Pipelines: id, name, description, dot_content, model
- Runs: id, pipeline_id, pipeline_name, graph_id, graph_goal, model, status (running/success/failed), start_time, end_time, duration_ms, total_prompt_tokens, total_completion_tokens, total_tokens, node_count, error_message
- NodeLogs: id, run_id, node_id, node_label, node_type (start/codergen/conditional/tool/wait.human/parallel/fan_in/exit), status, attempt_num, start_time, end_time, duration_ms, model, prompt_tokens, completion_tokens, total_tokens, notes, failure_reason, input_text (full LLM prompt or tool command), output_text (full LLM response or tool stdout)

API endpoints:
- GET /api/pipelines - list all pipelines
- GET /api/pipelines/:id - single pipeline
- GET /api/pipelines/:id/runs - runs for a pipeline
- GET /api/pipelines/:id/stats - pipeline stats
- POST /api/runs - create a run
- GET /api/runs - list recent runs
- GET /api/runs/:id - single run with node_logs inline
- GET /api/runs/:id/nodes - node logs for a run
- GET /api/models - available LLM models
- GET /api/stats - global stats

Requirements:
1. Built with SolidJS and solid-ui component library
2. Dark mode color scheme throughout
3. Dashboard home with global stats, recent runs, pipeline list
4. Pipeline detail view with run history and stats
5. Run detail view: drill down into every node, see timing, token counts, status
6. Node detail: full input_text and output_text displayed clearly with syntax highlighting or markdown rendering
7. Visual pipeline graph rendering showing node execution flow
8. Real-time status indicators for running pipelines

Produce a detailed requirements document covering all pages, components, data flows, and user interactions.