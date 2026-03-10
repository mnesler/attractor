Based on the component designs below, write the complete implementation specification as a markdown document for the Attractor SolidJS dashboard.

Component designs:
{{last_response}}

The markdown document must include:

1. **Overview** - Project description, tech stack (SolidJS, solid-ui, @solidjs/router, tailwindcss)

2. **Setup & Configuration** - package.json dependencies, vite config, tailwind config with dark mode

3. **Dark Mode Theme** - Complete color palette specification:
   - Background colors (base, surface, elevated)
   - Text colors (primary, secondary, muted)
   - Accent colors for status (success=green, failed=red, running=blue/amber)
   - Border and divider colors
   - Code block background colors
   - Specific hex values for every color

4. **Project Structure** - Complete file tree

5. **API Client** - Full TypeScript code for the API client with types

6. **Routing** - Route definitions and layout

7. **Every Component** - Full SolidJS/TypeScript code for each component with:
   - Imports
   - Type definitions
   - Component implementation
   - Dark mode styles (using Tailwind classes)
   - solid-ui component usage

8. **Pages** - Full code for each page/route

9. **Pipeline Graph Visualization** - How to render DOT graphs visually

10. **Node Input/Output Display** - Detailed design for showing full input_text and output_text with:
    - Collapsible sections
    - Copy to clipboard
    - Markdown rendering for LLM responses
    - Monospace display for tool commands
    - Search/filter within long outputs

Make the document comprehensive enough that a developer can build the entire dashboard from it. Use real solid-ui component APIs. Every code block should be complete and working.