To design the UI components for the Attractor dashboard using SolidJS, let's break down each component, specify its detailed structure, and define its key aspects.

### 1. AppShell / Layout
- **File Path**: `src/components/AppShell.tsx`
- **Props Interface**: None
- **Internal Signals/State**: `darkMode`
- **Child Components Used**: `Sidebar`, `Header`
- **Solid-UI Components Used**: `Tabs`, `Button`
- **Dark Mode Styling Approach**: Use CSS classes toggled by `darkMode` signal.
- **Data Fetching Strategy**: None needed
- **Key User Interactions**: Toggle between dark/light mode, navigate between sections through sidebar.

### 2. DashboardHome
- **File Path**: `src/components/DashboardHome.tsx`
- **Props Interface**: None
- **Internal Signals/State**: `statsData`, `recentRuns`
- **Child Components Used**: `StatsCards`, `Table`, `PipelineCard`
- **Solid-UI Components Used**: `Card`, `Table`, `Button`
- **Dark Mode Styling Approach**: Color scheme based on CSS variables
- **Data Fetching Strategy**: On component mount, fetch stats from API.
- **Key User Interactions**: Clicks on stats cards may lead to detailed views, recent runs can be filtered.

### 3. PipelineList
- **File Path**: `src/components/PipelineList.tsx`
- **Props Interface**: None
- **Internal Signals/State**: `pipelines`, `sortOrder`, `filters`
- **Child Components Used**: None
- **Solid-UI Components Used**: `Table`, `Button`
- **Dark Mode Styling Approach**: Adjusted table header and row colors
- **Data Fetching Strategy**: Fetch pipelines on sort/filter change.
- **Key User Interactions**: Sort by columns, filter by status.

### 4. PipelineDetail
- **File Path**: `src/components/PipelineDetail.tsx`
- **Props Interface**: `{ id: string }`
- **Internal Signals/State**: `pipelineData`, `runHistory`
- **Child Components Used**: `RunList`, `StatsCharts`
- **Solid-UI Components Used**: `Card`, `Tabs`
- **Dark Mode Styling Approach**: Use CSS variables for card backgrounds and text
- **Data Fetching Strategy**: Fetch pipeline info and history when the component mounts.
- **Key User Interactions**: Click a run to view `RunDetail`.

### 5. RunList
- **File Path**: `src/components/RunList.tsx`
- **Props Interface**: `{ runs: Run[] }`
- **Internal Signals/State**: None
- **Child Components Used**: `StatusBadge`, `TokenCounter`, `DurationDisplay`
- **Solid-UI Components Used**: `Table`
- **Dark Mode Styling Approach**: Table row background based on dark mode
- **Data Fetching Strategy**: None; assumes data passed via props.
- **Key User Interactions**: Audibles like sorting or clicking rows for details.

### 6. RunDetail
- **File Path**: `src/components/RunDetail.tsx`
- **Props Interface**: `{ runId: string }`
- **Internal Signals/State**: `runDetails`
- **Child Components Used**: `NodeTimeline`
- **Solid-UI Components Used**: `Card`
- **Dark Mode Styling Approach**: Toggle CSS styles using theme classes
- **Data Fetching Strategy**: Fetch run details on mount using runId
- **Key User Interactions**: Navigate to specific nodes on the timeline.

### 7. NodeTimeline
- **File Path**: `src/components/NodeTimeline.tsx`
- **Props Interface**: `{ nodes: Node[] }`
- **Internal Signals/State**: None
- **Child Components Used**: `StatusBadge`
- **Solid-UI Components Used**: `Table`
- **Dark Mode Styling Approach**: Use dynamic colors for timeline based on mode
- **Data Fetching Strategy**: None; operates on passed `nodes` data.
- **Key User Interactions**: Hover nodes for additional info, click for node details.

### 8. NodeDetail
- **File Path**: `src/components/NodeDetail.tsx`
- **Props Interface**: `{ node: Node }`
- **Internal Signals/State**: `expanded`
- **Child Components Used**: `NodeInputOutput`
- **Solid-UI Components Used**: `Dialog`, `Button`
- **Dark Mode Styling Approach**: Styled based on dark mode signal
- **Data Fetching Strategy**: None
- **Key User Interactions**: Expand/collapse details.

### 9. NodeInputOutput
- **File Path**: `src/components/NodeInputOutput.tsx`
- **Props Interface**: `{ inputText: string, outputText: string }`
- **Internal Signals/State**: `viewMode`
- **Child Components Used**: None
- **Solid-UI Components Used**: `Tabs`, `Button`
- **Dark Mode Styling Approach**: Dark mode adjustments using CSS variables
- **Data Fetching Strategy**: None
- **Key User Interactions**: Toggle between input/output, copy text functionality.

### 10. PipelineGraph
- **File Path**: `src/components/PipelineGraph.tsx`
- **Props Interface**: `{ graphData: GraphData }`
- **Internal Signals/State**: None
- **Child Components Used**: None
- **Solid-UI Components Used**: Custom graph rendering
- **Dark Mode Styling Approach**: Adjust color coding
- **Data Fetching Strategy**: Prepares graph based on passed data.
- **Key User Interactions**: Zoom/pan to explore the graph.

### 11. StatsCards
- **File Path**: `src/components/StatsCards.tsx`
- **Props Interface**: `{ stats: Stats[] }`
- **Internal Signals/State**: None
- **Child Components Used**: `TokenCounter`, `DurationDisplay`
- **Solid-UI Components Used**: `Card`
- **Dark Mode Styling Approach**: Use theme-aware styles
- **Data Fetching Strategy**: None, data passed via props.
- **Key User Interactions**: Mouseover for more detailed stats.

### 12. StatusBadge
- **File Path**: `src/components/StatusBadge.tsx`
- **Props Interface**: `{ status: string }`
- **Internal Signals/State**: None
- **Child Components Used**: None
- **Solid-UI Components Used**: `Badge`
- **Dark Mode Styling Approach**: Badge colors adapt to mode
- **Data Fetching Strategy**: None
- **Key User Interactions**: Displays status inline with text.

### 13. TokenCounter
- **File Path**: `src/components/TokenCounter.tsx`
- **Props Interface**: `{ tokens: number }`
- **Internal Signals/State**: None
- **Child Components Used**: None
- **Solid-UI Components Used**: None, renders text
- **Dark Mode Styling Approach**: Style text based on theme
- **Data Fetching Strategy**: None
- **Key User Interactions**: Displays token count distinctly.

### 14. DurationDisplay
- **File Path**: `src/components/DurationDisplay.tsx`
- **Props Interface**: `{ duration: number }`
- **Internal Signals/State**: None
- **Child Components Used**: None
- **Solid-UI Components Used**: None, renders text
- **Dark Mode Styling Approach**: Text style adjusted for mode
- **Data Fetching Strategy**: None
- **Key User Interactions**: Displays formatted duration.

### 15. ModelBadge
- **File Path**: `src/components/ModelBadge.tsx`
- **Props Interface**: `{ modelName: string }`
- **Internal Signals/State**: None
- **Child Components Used**: None
- **Solid-UI Components Used**: `Badge`
- **Dark Mode Styling Approach**: Change color scheme based on mode
- **Data Fetching Strategy**: None
- **Key User Interactions**: Hover to display model details tooltip.

### 16. RunProgressBar
- **File Path**: `src/components/RunProgressBar.tsx`
- **Props Interface**: `{ progress: number }`
- **Internal Signals/State**: None
- **Child Components Used**: None
- **Solid-UI Components Used**: `ProgressBar`
- **Dark Mode Styling Approach**: Adjust bar fill color
- **Data Fetching Strategy**: None
- **Key User Interactions**: Displays the progress of a task visually.

Each component is crafted to be cohesive and reusable across the dashboard, ensuring seamless integration in a SolidJS application with support for dark mode and dynamic data fetching where necessary.