### Attractor Web Dashboard Requirements Document

#### Overview
This document outlines the requirements for the Attractor Web Dashboard, an interface for managing and monitoring AI pipelines built with SolidJS and solid-ui. This dashboard will provide users with a comprehensive view of their pipelines, runs, and nodes, incorporating real-time status updates and data visualization.

---

### General Requirements

1. **Platform**: 
   - Built with SolidJS using the solid-ui component library.
   - Dark mode color scheme across the entire application for consistency and accessibility.

2. **Core Features**:
   - Global statistics display.
   - Pipeline management with detailed views.
   - Run history and detailed analysis.
   - Node log inspection with complete input/output visibility.
   - Real-time status updates for currently running pipelines.
   - Interactive visualizations for pipeline execution flows.

---

### Page Descriptions

#### 1. **Dashboard Home Page**

- **Components**:
  - **Global Stats Overview**: Fetch and display data from `/api/stats`.
  - **Recent Runs**: Display a summarized list of recent runs retrieved from `/api/runs`.
  - **Pipeline List**: Fetch and list all pipelines using `/api/pipelines`.

- **Layout/Interactions**:
  - Each section (Global Stats, Recent Runs, Pipeline List) should be collapsible.
  - Clicking a pipeline from the list navigates to the Pipeline Detail View.
  - Clicking a run takes the user to the Run Detail View.
  - Real-time updates for the status of running pipelines.

#### 2. **Pipeline Detail View**

- **Components**:
  - **Pipeline Information Section**: Display pipeline name and description using data from `/api/pipelines/:id`.
  - **Run History Table**: List all runs related to this pipeline from `/api/pipelines/:id/runs`.
  - **Pipeline Stats**: Display stats from `/api/pipelines/:id/stats`.

- **Layout/Interactions**:
  - Run History should include sortable columns: status, start time, duration.
  - Clicking a run in the history table navigates to the Run Detail View.
  - Stats section should be prominently displayed using solid-ui statistical components.

#### 3. **Run Detail View**

- **Components**:
  - **Run Overview**: Show run's metadata (status, duration, tokens) fetched from `/api/runs/:id`.
  - **Node Execution Timeline**: A visual timeline of node execution retrieved from `/api/runs/:id/nodes`.
  - **Node Logs Display**: List of all nodes associated with the run.

- **Layout/Interactions**:
  - Interactive Timeline using solid-ui visualization tools, highlighting current status.
  - Clicking a node in the timeline or list should expand a Node Detail view below or on a separate side panel.
  - Real-time status updates for long-running or ongoing runs.

#### 4. **Node Detail View**

- **Components**:
  - **Node Information**: Display metadata about the node, including types and attempt numbers.
  - **Full Input and Output Display**: Use markdown or syntax highlighting for text fields like `input_text` and `output_text`.

- **Layout/Interactions**:
  - Collapsible sections for `input_text` and `output_text`.
  - Allow users to toggle between plain text and marked-up/syntax-highlighted views.
  - Navigation buttons for previous/next nodes in the sequence.

---

### Component Details

#### **Global Stats Overview Component**
- **Functionality**: Fetch from `/api/stats` and display data points like total pipelines, runs, tokens processed.
- **UI Elements**: Cards or tiles representing different metrics using solid-ui components.

#### **Pipeline List Component**
- **Functionality**: List all pipelines with basic details using `/api/pipelines`.
- **UI Elements**: Card list with sorting and filtering capabilities. Includes search functionality.

#### **Run Summary Component**
- **Functionality**: Display recent runs and sort by status, start time, duration.
- **UI Elements**: Table with clickable rows to navigate to Run Detail.

#### **Node Execution Timeline Component**
- **Functionality**: Visual graph rendering node execution flow using solid-ui graph components.
- **UI Elements**: Interactive graph, real-time status updates, clickable nodes.

#### **Node Detail Component**
- **Functionality**: Show detailed node log information including timings and tokens.
- **UI Elements**: Expandable view, code blocks or markdown-rendered text for I/O.

---

### Data Flow

- **API Integration**: Ensure seamless data fetching and updates with AJAX calls to provided endpoints.
- **Real-Time Updates**: Utilize websockets or periodic polling for real-time updates on running processes.

### Technical Requirements

- **Performance**: Minimize load times and ensure smooth transitions and interaction.
- **Accessibility**: Ensure all UI components are accessible in dark mode.
- **Responsiveness**: Design must cater to various screen sizes, with a mobile-first approach.

### User Interactions

- **Navigation**: Use solid-ui for consistent and intuitive navigation components.
- **Feedback**: Provide user feedback upon actions such as initiating a run or viewing logs.
- **Error Handling**: Gracefully handle API call failures with appropriate user notifications.

---

### Final Notes

The goal of this dashboard is to provide an intuitive, informative, and responsive experience for monitoring and managing AI pipelines. Focus is placed on utilizing real-time data updates, interactive visualizations, and comprehensive task management capabilities, all while maintaining aesthetic consistency through dark mode design and solid-ui component integration.