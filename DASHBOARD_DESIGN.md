# Attractor Dashboard Implementation Specification

## Overview

The Attractor Dashboard is a web-based UI designed to visualize and manage data pipelines using a combination of interactive components. It is built using modern frontend technologies like SolidJS, solid-ui, and @solidjs/router, styled with Tailwind CSS for a responsive and theme-friendly design. The dashboard includes features such as pipeline graph visualization, node input/output displays, and a dark mode theme.

### Tech Stack

- **SolidJS**: A reactive UI library for building performant and flexible web components.
- **solid-ui**: A component library that provides reusable UI elements compatible with SolidJS.
- **@solidjs/router**: A router library for handling client-side routing in SolidJS applications.
- **tailwindcss**: A utility-first CSS framework that enables customizable and fluid styling, including dark mode support.

---

## Setup & Configuration

### Dependencies

To set up the project, the following dependencies are specified in `package.json`:

```json
{
  "name": "attractor-dashboard",
  "version": "1.0.0",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "serve": "vite preview"
  },
  "dependencies": {
    "solid-js": "^1.x",
    "solid-ui": "^0.x",
    "@solidjs/router": "^0.x",
    "tailwindcss": "^3.x"
  },
  "devDependencies": {
    "vite": "^3.x",
    "postcss": "^8.x",
    "autoprefixer": "^10.x"
  }
}
```

### Vite Configuration

`vite.config.js`:

```js
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

export default defineConfig({
  plugins: [solidPlugin()],
  css: {
    postcss: {
      plugins: [tailwindcss, autoprefixer],
    },
  },
});
```

### Tailwind Configuration

`tailwind.config.js`:

```js
module.exports = {
  darkMode: 'class', // Enables dark mode support
  theme: {
    extend: {
      colors: {
        background: {
          base: '#121212',
          surface: '#1D1D1D',
          elevated: '#292929',
        },
        text: {
          primary: '#FFFFFF',
          secondary: '#B3B3B3',
          muted: '#8A8A8A',
        },
        accent: {
          success: '#00C853',
          failed: '#D32F2F',
          running: {
            DEFAULT: '#2196F3',
            amber: '#FFC107',
          },
        },
        border: '#333333',
        divider: '#1F1F1F',
        codeBackground: '#2E2E2E',
      },
    },
  },
  plugins: [],
};
```

## Dark Mode Theme

The application's dark mode theme uses a carefully chosen color palette. Here are the hex values for each color category:

- **Background Colors**
  - Base: `#121212`
  - Surface: `#1D1D1D`
  - Elevated: `#292929`
  
- **Text Colors**
  - Primary: `#FFFFFF`
  - Secondary: `#B3B3B3`
  - Muted: `#8A8A8A`

- **Accent Colors for Status**
  - Success: `#00C853`
  - Failed: `#D32F2F`
  - Running: `#2196F3`
  - Amber (Running): `#FFC107`

- **Border and Divider Colors**
  - Border: `#333333`
  - Divider: `#1F1F1F`

- **Code Block Background Colors**
  - Code Background: `#2E2E2E`

---

## Project Structure

The project's file tree organizes components, pages, and utilities coherently:

```
src/
|-- components/
|   |-- AppShell.tsx
|   |-- Header.tsx
|   |-- Sidebar.tsx
|   |-- Graph.tsx
|   `-- NodeDetail.tsx
|-- pages/
|   |-- DashboardPage.tsx
|   `-- NodeDetailPage.tsx
|-- api/
|   `-- ApiClient.ts
|-- App.tsx
|-- index.tsx
tailwind.config.js
vite.config.js
package.json
```

---

## API Client

The API client is responsible for data fetching and communication with the backend. It is implemented in `ApiClient.ts` using TypeScript:

```ts
export interface Pipeline {
  id: string;
  name: string;
  status: 'success' | 'failed' | 'running';
}

export class ApiClient {
  private baseUrl: string;

  constructor(baseEndpoint: string) {
    this.baseUrl = baseEndpoint;
  }

  async fetchPipelines(): Promise<Pipeline[]> {
    const response = await fetch(`${this.baseUrl}/pipelines`);
    return response.json();
  }

  async fetchPipeline(id: string): Promise<Pipeline> {
    const response = await fetch(`${this.baseUrl}/pipelines/${id}`);
    return response.json();
  }
}
```

---

## Routing

In `App.tsx`, we define the routing for the application:

```tsx
import { Router, Route } from '@solidjs/router';
import DashboardPage from './pages/DashboardPage';
import NodeDetailPage from './pages/NodeDetailPage';

function App() {
  return (
    <Router>
      <Route path="/" component={DashboardPage} />
      <Route path="/node/:id" component={NodeDetailPage} />
    </Router>
  );
}

export default App;
```

---

## Components

### AppShell / Layout

`AppShell.tsx`:

```tsx
import { JSX } from 'solid-js';
import Header from './Header';
import Sidebar from './Sidebar';

type AppShellProps = {
  children: JSX.Element;
};

export default function AppShell({ children }: AppShellProps) {
  return (
    <div class="flex h-screen dark:bg-background-base">
      <Sidebar />
      <div class="flex-1 flex flex-col">
        <Header />
        <main class="flex-1 p-8 dark:bg-background.surface">
          {children}
        </main>
      </div>
    </div>
  );
}
```

### Header Component

`Header.tsx`:

```tsx
export default function Header() {
  return (
    <header class="shadow-md dark:bg-background.elevated p-4">
      <h1 class="text-2xl dark:text-text.primary">Attractor Dashboard</h1>
    </header>
  );
}
```

### Sidebar Component

`Sidebar.tsx`:

```tsx
import { NavLink } from '@solidjs/router';

export default function Sidebar() {
  return (
    <nav class="w-64 dark:bg-background.surface h-full shadow-md">
      <ul>
        <li>
          <NavLink
            href="/"
            class="block p-4 dark:text-text.primary hover:bg-background.elevated"
          >
            Dashboard
          </NavLink>
        </li>
      </ul>
    </nav>
  );
}
```

### Graph Component

`Graph.tsx`:

```tsx
import { createEffect, onCleanup } from 'solid-js';
import * as d3 from 'd3';

export default function Graph() {
  let ref: HTMLDivElement | undefined;

  createEffect(() => {
    if (!ref) return;

    const svg = d3.select(ref).append('svg');
    // Initial setup of the graph here

    onCleanup(() => {
      svg.remove();
    });
  });

  return <div ref={el => (ref = el)} class="h-full"></div>;
}
```

### NodeDetail Component

`NodeDetail.tsx`:

```tsx
import { createSignal } from 'solid-js';

export default function NodeDetail() {
  const [isCollapsed, setCollapsed] = createSignal(false);

  return (
    <div class="p-4 dark:bg-background.surface shadow">
      <button
        onClick={() => setCollapsed(!isCollapsed())}
        class="dark:text-text.primary"
      >
        Toggle Details
      </button>
      <div
        class="transition-all duration-300"
        classList={{ hidden: isCollapsed() }}
      >
        <p class="dark:text-text.secondary">Node Input/Output here...</p>
      </div>
    </div>
  );
}
```

## Pages

### Dashboard Page

`DashboardPage.tsx`:

```tsx
import AppShell from '../components/AppShell';
import Graph from '../components/Graph';

export default function DashboardPage() {
  return (
    <AppShell>
      <Graph />
    </AppShell>
  );
}
```

### Node Detail Page

`NodeDetailPage.tsx`:

```tsx
import { useParams } from '@solidjs/router';
import AppShell from '../components/AppShell';
import NodeDetail from '../components/NodeDetail';

export default function NodeDetailPage() {
  const params = useParams();

  return (
    <AppShell>
      <NodeDetail />
    </AppShell>
  );
}
```

---

## Pipeline Graph Visualization

The `Graph` component uses D3.js to render pipeline graphs. The DOT format can be processed and transformed into SVG elements, interactively displayed within the component.

### Example D3 Implementation

```ts
createEffect(() => {
  if (!ref) return;

  const svg = d3.select(ref).append('svg');
  // Assume we parse DOT into a JSON format suitable for D3 rendering
  const data = {}; // Parsed graph data
  const layout = d3.layout.force()
    .size([width, height])
    .nodes(data.nodes)
    .links(data.links);

  layout.start();
  svg.append('g').selectAll('line').data(data.links)
    .enter()
    .append('line')
    .attr('stroke', 'gray');
  // Continue setting up nodes and labels...

  onCleanup(() => {
    svg.remove();
  });
});
```

---

## Node Input/Output Display

The `NodeDetail` component allows users to view and manipulate node data with features like collapsible sections, copy-to-clipboard, and markdown rendering.

### Detailed Interface

```tsx
export default function NodeDetail() {
  const [isCollapsed, setCollapsed] = createSignal(false);

  return (
    <div class="p-4 dark:bg-background.surface shadow-md">
      <button
        type="button"
        onClick={() => setCollapsed(!isCollapsed())}
        class="dark:text-text.primary"
      >
        Toggle Details
      </button>
      <div
        class="transition-all duration-300 mt-4"
        classList={{ hidden: isCollapsed() }}
      >
        <div>
          <h3 class="dark:text-text.secondary font-bold">Input:</h3>
          <pre class="dark:bg-codeBackground p-2 rounded">input_text</pre>
        </div>
        <div>
          <h3 class="dark:text-text.secondary font-bold">Output:</h3>
          <pre class="dark:bg-codeBackground p-2 rounded">output_text</pre>
        </div>
      </div>
    </div>
  );
}
```

These detailed sections, combined with rich interaction styles, make navigating and managing pipeline data intuitive and effective.
