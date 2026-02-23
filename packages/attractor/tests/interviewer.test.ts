import { describe, it, expect } from 'vitest'
import {
  AutoApproveInterviewer,
  QueueInterviewer,
  RecordingInterviewer,
  CallbackInterviewer,
  parseAcceleratorKey,
  normalizeLabel,
} from '../src/interviewer/index.js'
import type { Question, Answer } from '../src/interviewer/index.js'

function makeQuestion(opts: Partial<Question> = {}): Question {
  return {
    text: 'Choose:',
    type: 'multiple_choice',
    options: [
      { key: 'Y', label: '[Y] Yes' },
      { key: 'N', label: '[N] No' },
    ],
    stage: 'test',
    ...opts,
  }
}

describe('AutoApproveInterviewer', () => {
  it('returns yes for yes_no questions', async () => {
    const interviewer = new AutoApproveInterviewer()
    const answer = await interviewer.ask(makeQuestion({ type: 'yes_no' }))
    expect(answer.value).toBe('yes')
  })

  it('returns first option for multiple_choice', async () => {
    const interviewer = new AutoApproveInterviewer()
    const answer = await interviewer.ask(makeQuestion())
    expect(answer.value).toBe('Y')
    expect(answer.selected_option?.key).toBe('Y')
  })

  it('returns auto-approved for freeform', async () => {
    const interviewer = new AutoApproveInterviewer()
    const answer = await interviewer.ask(makeQuestion({ type: 'freeform', options: [] }))
    expect(answer.text).toBe('auto-approved')
  })
})

describe('QueueInterviewer', () => {
  it('returns answers from queue in order', async () => {
    const answers: Answer[] = [
      { value: 'Y', selected_option: { key: 'Y', label: '[Y] Yes' } },
      { value: 'N', selected_option: { key: 'N', label: '[N] No' } },
    ]
    const interviewer = new QueueInterviewer(answers)
    const a1 = await interviewer.ask(makeQuestion())
    const a2 = await interviewer.ask(makeQuestion())
    expect(a1.value).toBe('Y')
    expect(a2.value).toBe('N')
  })

  it('returns skipped when queue is exhausted', async () => {
    const interviewer = new QueueInterviewer([])
    const answer = await interviewer.ask(makeQuestion())
    expect(answer.value).toBe('skipped')
  })
})

describe('CallbackInterviewer', () => {
  it('delegates to the callback function', async () => {
    const interviewer = new CallbackInterviewer(async (q) => ({
      value: 'custom',
      text: `answer for ${q.stage}`,
    }))
    const answer = await interviewer.ask(makeQuestion({ stage: 'my_stage' }))
    expect(answer.value).toBe('custom')
    expect(answer.text).toBe('answer for my_stage')
  })
})

describe('RecordingInterviewer', () => {
  it('records all question-answer pairs', async () => {
    const inner = new AutoApproveInterviewer()
    const recording = new RecordingInterviewer(inner)
    const q1 = makeQuestion({ text: 'First?' })
    const q2 = makeQuestion({ text: 'Second?' })
    await recording.ask(q1)
    await recording.ask(q2)
    expect(recording.recordings).toHaveLength(2)
    expect(recording.recordings[0]!.question.text).toBe('First?')
    expect(recording.recordings[1]!.question.text).toBe('Second?')
  })
})

describe('parseAcceleratorKey', () => {
  it('parses [K] Label pattern', () => {
    expect(parseAcceleratorKey('[Y] Yes, deploy')).toBe('Y')
    expect(parseAcceleratorKey('[A] Approve')).toBe('A')
  })

  it('parses K) Label pattern', () => {
    expect(parseAcceleratorKey('Y) Yes, deploy')).toBe('Y')
  })

  it('parses K - Label pattern', () => {
    expect(parseAcceleratorKey('Y - Yes')).toBe('Y')
  })

  it('falls back to first character', () => {
    expect(parseAcceleratorKey('Yes, deploy')).toBe('Y')
    expect(parseAcceleratorKey('Fix it')).toBe('F')
  })
})

describe('normalizeLabel', () => {
  it('strips [K] prefix', () => {
    expect(normalizeLabel('[Y] Yes')).toBe('yes')
    expect(normalizeLabel('[A] Approve')).toBe('approve')
  })

  it('strips K) prefix', () => {
    expect(normalizeLabel('Y) Yes')).toBe('yes')
  })

  it('lowercases and trims', () => {
    expect(normalizeLabel('  Hello World  ')).toBe('hello world')
  })
})
