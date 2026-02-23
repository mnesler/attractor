/**
 * Human-in-the-loop Interviewer pattern.
 */

import * as readline from 'node:readline'

// ---------------------------------------------------------------------------
// Question / Answer model
// ---------------------------------------------------------------------------

export type QuestionType = 'yes_no' | 'multiple_choice' | 'freeform' | 'confirmation'
export type AnswerValue = 'yes' | 'no' | 'skipped' | 'timeout'

export interface Option {
  key: string
  label: string
}

export interface Question {
  text: string
  type: QuestionType
  options?: Option[]
  default?: Answer
  timeout_seconds?: number
  stage: string
  metadata?: Record<string, unknown>
}

export interface Answer {
  value: string | AnswerValue
  selected_option?: Option
  text?: string
}

// ---------------------------------------------------------------------------
// Interviewer interface
// ---------------------------------------------------------------------------

export interface Interviewer {
  ask(question: Question): Promise<Answer>
  ask_multiple(questions: Question[]): Promise<Answer[]>
  inform(message: string, stage: string): Promise<void>
}

// ---------------------------------------------------------------------------
// AutoApproveInterviewer
// ---------------------------------------------------------------------------

export class AutoApproveInterviewer implements Interviewer {
  async ask(question: Question): Promise<Answer> {
    if (question.type === 'yes_no' || question.type === 'confirmation') {
      return { value: 'yes' }
    }
    if (question.type === 'multiple_choice' && question.options && question.options.length > 0) {
      const opt = question.options[0]!
      return { value: opt.key, selected_option: opt }
    }
    return { value: 'auto-approved', text: 'auto-approved' }
  }

  async ask_multiple(questions: Question[]): Promise<Answer[]> {
    return Promise.all(questions.map(q => this.ask(q)))
  }

  async inform(_message: string, _stage: string): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// ConsoleInterviewer
// ---------------------------------------------------------------------------

export class ConsoleInterviewer implements Interviewer {
  async ask(question: Question): Promise<Answer> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

    return new Promise<Answer>((resolve) => {
      const prompt = buildConsolePrompt(question)
      rl.question(prompt, (response) => {
        rl.close()
        resolve(parseConsoleResponse(response, question))
      })

      if (question.timeout_seconds) {
        setTimeout(() => {
          rl.close()
          if (question.default) {
            resolve(question.default)
          } else {
            resolve({ value: 'timeout' })
          }
        }, question.timeout_seconds * 1000)
      }
    })
  }

  async ask_multiple(questions: Question[]): Promise<Answer[]> {
    const answers: Answer[] = []
    for (const q of questions) {
      answers.push(await this.ask(q))
    }
    return answers
  }

  async inform(message: string, stage: string): Promise<void> {
    console.log(`[${stage}] ${message}`)
  }
}

function buildConsolePrompt(question: Question): string {
  let prompt = `\n[?] ${question.text}\n`
  if (question.type === 'multiple_choice' && question.options) {
    for (const opt of question.options) {
      prompt += `  [${opt.key}] ${opt.label}\n`
    }
    prompt += 'Select: '
  } else if (question.type === 'yes_no' || question.type === 'confirmation') {
    prompt += '[Y/N]: '
  } else {
    prompt += '> '
  }
  return prompt
}

function parseConsoleResponse(response: string, question: Question): Answer {
  const r = response.trim()
  if (question.type === 'yes_no' || question.type === 'confirmation') {
    const lower = r.toLowerCase()
    return { value: lower === 'y' || lower === 'yes' ? 'yes' : 'no' }
  }
  if (question.type === 'multiple_choice' && question.options) {
    const match = findMatchingOption(r, question.options)
    if (match) return { value: match.key, selected_option: match }
    return { value: question.options[0]?.key ?? r, selected_option: question.options[0] }
  }
  return { text: r, value: r }
}

function findMatchingOption(response: string, options: Option[]): Option | undefined {
  const r = response.trim().toLowerCase()
  return options.find(o =>
    o.key.toLowerCase() === r ||
    o.label.toLowerCase().startsWith(r) ||
    normalizeLabel(o.label).startsWith(r),
  )
}

// ---------------------------------------------------------------------------
// CallbackInterviewer
// ---------------------------------------------------------------------------

export class CallbackInterviewer implements Interviewer {
  constructor(private callback: (question: Question) => Promise<Answer>) {}

  async ask(question: Question): Promise<Answer> {
    return this.callback(question)
  }

  async ask_multiple(questions: Question[]): Promise<Answer[]> {
    return Promise.all(questions.map(q => this.ask(q)))
  }

  async inform(_message: string, _stage: string): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// QueueInterviewer
// ---------------------------------------------------------------------------

export class QueueInterviewer implements Interviewer {
  private answers: Answer[]
  private idx = 0

  constructor(answers: Answer[]) {
    this.answers = [...answers]
  }

  async ask(_question: Question): Promise<Answer> {
    if (this.idx < this.answers.length) {
      return this.answers[this.idx++]!
    }
    return { value: 'skipped' }
  }

  async ask_multiple(questions: Question[]): Promise<Answer[]> {
    return Promise.all(questions.map(q => this.ask(q)))
  }

  async inform(_message: string, _stage: string): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// RecordingInterviewer
// ---------------------------------------------------------------------------

export class RecordingInterviewer implements Interviewer {
  readonly recordings: Array<{ question: Question; answer: Answer }> = []

  constructor(private inner: Interviewer) {}

  async ask(question: Question): Promise<Answer> {
    const answer = await this.inner.ask(question)
    this.recordings.push({ question, answer })
    return answer
  }

  async ask_multiple(questions: Question[]): Promise<Answer[]> {
    return Promise.all(questions.map(q => this.ask(q)))
  }

  async inform(message: string, stage: string): Promise<void> {
    return this.inner.inform(message, stage)
  }
}

// ---------------------------------------------------------------------------
// Accelerator key parsing
// ---------------------------------------------------------------------------

export function parseAcceleratorKey(label: string): string {
  // [K] Label
  const m1 = /^\[([A-Za-z0-9])\]\s/.exec(label)
  if (m1) return m1[1]!.toUpperCase()

  // K) Label
  const m2 = /^([A-Za-z0-9])\)\s/.exec(label)
  if (m2) return m2[1]!.toUpperCase()

  // K - Label
  const m3 = /^([A-Za-z0-9])\s*-\s/.exec(label)
  if (m3) return m3[1]!.toUpperCase()

  // First character
  return label.charAt(0).toUpperCase()
}

/** Normalize a label: lowercase, trim, strip accelerator prefixes. */
export function normalizeLabel(label: string): string {
  let s = label.trim().toLowerCase()
  // Strip [K] prefix
  s = s.replace(/^\[[a-z0-9]\]\s+/, '')
  // Strip K) prefix
  s = s.replace(/^[a-z0-9]\)\s+/, '')
  // Strip K - prefix
  s = s.replace(/^[a-z0-9]\s*-\s+/, '')
  return s.trim()
}
