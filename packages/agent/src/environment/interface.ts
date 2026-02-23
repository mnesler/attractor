export interface GrepOptions {
  glob_filter?: string
  case_insensitive?: boolean
  max_results?: number
}

export interface ExecResult {
  stdout: string
  stderr: string
  exit_code: number
  timed_out: boolean
  duration_ms: number
}

export interface DirEntry {
  name: string
  is_dir: boolean
  size?: number
}

export interface ExecutionEnvironment {
  // File operations
  read_file(path: string, offset?: number, limit?: number): Promise<string>
  write_file(path: string, content: string): Promise<void>
  file_exists(path: string): Promise<boolean>
  list_directory(path: string, depth: number): Promise<DirEntry[]>

  // Command execution
  exec_command(
    command: string,
    timeout_ms: number,
    working_dir?: string,
    env_vars?: Record<string, string>,
  ): Promise<ExecResult>

  // Search operations
  grep(pattern: string, path: string, options?: GrepOptions): Promise<string>
  glob(pattern: string, path: string): Promise<string[]>

  // Lifecycle
  initialize(): Promise<void>
  cleanup(): Promise<void>

  // Metadata
  working_directory(): string
  platform(): string   // "darwin" | "linux" | "windows"
  os_version(): string
}
