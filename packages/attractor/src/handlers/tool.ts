/**
 * ToolHandler — executes an external tool (shell command).
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { Handler } from './interface.js'
import type { Node, Graph } from '../types/graph.js'
import type { Context } from '../types/context.js'
import { successOutcome, failOutcome } from '../types/outcome.js'

const execAsync = promisify(exec)

export const toolHandler: Handler = {
  async execute(node: Node, _context: Context, _graph: Graph, _logs_root: string) {
    const command = node.attrs['tool_command'] as string | undefined
    if (!command) {
      return failOutcome('No tool_command specified')
    }

    const timeout = node.attrs.timeout as number | undefined

    try {
      const { stdout } = await execAsync(command, {
        timeout: timeout ?? 60_000,
        maxBuffer: 10 * 1024 * 1024,
      })
      return successOutcome({
        context_updates: { 'tool.output': stdout },
        notes: `Tool completed: ${command}`,
      })
    } catch (e) {
      return failOutcome(String(e))
    }
  },
}
