import { describe, expect, test } from 'bun:test'
import { GoalController } from './goal-controller'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

describe('GoalController', () => {
  test('runs one turn and schedules the next turn after continue', async () => {
    const runs: string[] = []
    const completions = deferred<void>()
    const controller = new GoalController({
      runTurn: async ({ iteration }) => { runs.push(`run-${iteration}`); await completions.promise; return { status: 'continue', summary: '继续', evidence: ['已执行'] } },
      stopTurn: async () => {},
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })

    await controller.start('session-1', '完成目标')
    expect(runs).toEqual(['run-1'])
    completions.resolve()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runs.length).toBeGreaterThan(1)
    await controller.stop('session-1')
    expect(controller.get('session-1')?.status).toBe('stopped')
  })

  test('stop prevents a completed turn from scheduling another turn', async () => {
    const completions = deferred<void>()
    let runCount = 0
    const controller = new GoalController({
      runTurn: async () => { runCount++; await completions.promise; return { status: 'continue', summary: '继续', evidence: ['已执行'] } },
      stopTurn: async () => { completions.resolve() },
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })

    await controller.start('session-1', '停止目标')
    await controller.stop('session-1')
    await Promise.resolve()
    expect(runCount).toBe(1)
    expect(controller.get('session-1')?.status).toBe('stopped')
  })
})
