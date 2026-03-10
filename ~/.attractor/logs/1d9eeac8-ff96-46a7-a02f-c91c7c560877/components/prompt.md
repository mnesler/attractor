Based on the architecture below, design every UI component for the Attractor dashboard in detail.

Architecture:
{{last_response}}

For each component specify:
1. Component name and file path
2. Props interface
3. Internal signals/state
4. Child components used
5. solid-ui components used (Card, Table, Badge, Button, Tabs, Dialog, etc.)
6. Dark mode styling approach
7. Data fetching strategy
8. Key user interactions

Components needed:
- AppShell / Layout with sidebar navigation
- DashboardHome: stats cards, recent runs table, pipeline cards
- PipelineList: sortable/filterable table of pipelines
- PipelineDetail: pipeline info, run history, stats charts
- RunList: table of runs with status badges, duration, token counts
- RunDetail: header with run metadata, node execution timeline
- NodeTimeline: visual timeline of node executions with status indicators
- NodeDetail: expandable panel showing full input_text and output_text
- NodeInputOutput: split-pane or tabbed view for input/output with copy button, markdown rendering, syntax highlighting
- PipelineGraph: visual DOT graph rendering showing node types with color coding
- StatsCards: token usage, success rates, avg duration
- StatusBadge: color-coded status indicator
- TokenCounter: formatted token count display
- DurationDisplay: human-readable duration
- ModelBadge: model name display
- RunProgressBar: progress indicator for running pipelines