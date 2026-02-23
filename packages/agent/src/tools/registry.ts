import type { ExecutionEnvironment } from '../environment/interface.js'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface RegisteredTool {
  definition: ToolDefinition
  executor: (args: Record<string, unknown>, env: ExecutionEnvironment) => Promise<string>
}

export class ToolRegistry {
  private _tools: Map<string, RegisteredTool> = new Map()

  register(tool: RegisteredTool): void {
    this._tools.set(tool.definition.name, tool)
  }

  unregister(name: string): void {
    this._tools.delete(name)
  }

  get(name: string): RegisteredTool | undefined {
    return this._tools.get(name)
  }

  definitions(): ToolDefinition[] {
    return [...this._tools.values()].map(t => t.definition)
  }

  names(): string[] {
    return [...this._tools.keys()]
  }
}
