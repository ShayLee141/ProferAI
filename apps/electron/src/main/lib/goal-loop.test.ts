import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_GOAL_LIMITS,
  createGoalState,
  evaluateGoalContinuation,
  parseGoalCommand,
  stopGoalForProcessExit,
} from './goal-loop'

describe('goal loop', () => {
  test('parses a goal command and control commands', () => {
    expect(parseGoalCommand('/goal 完成登录页')).toEqual({ type: 'start', goal: '完成登录页' })
    expect(parseGoalCommand('/goal status')).toEqual({ type: 'status' })
    expect(parseGoalCommand('/goal pause')).toEqual({ type: 'pause' })
    expect(parseGoalCommand('/goal resume')).toEqual({ type: 'resume' })
    expect(parseGoalCommand('/goal stop')).toEqual({ type: 'stop' })
    expect(parseGoalCommand('/goal clear')).toEqual({ type: 'clear' })
    expect(parseGoalCommand('普通消息')).toEqual({ type: 'not_goal' })
  })

  test('rejects an empty goal and unknown command', () => {
    expect(parseGoalCommand('/goal')).toEqual({ type: 'invalid', reason: '目标不能为空' })
    expect(parseGoalCommand('/goal maybe')).toEqual({ type: 'invalid', reason: '未知的 Goal 命令：maybe' })
  })

  test('creates an active goal with safe defaults', () => {
    const goal = createGoalState('session-1', '完成登录页', 1000)
    expect(goal).toMatchObject({
      sessionId: 'session-1',
      goal: '完成登录页',
      status: 'active',
      iteration: 0,
      startedAt: 1000,
      updatedAt: 1000,
      limits: DEFAULT_GOAL_LIMITS,
    })
    expect(goal.id).toBeString()
  })

  test('continues when the agent has not completed the goal', () => {
    const result = evaluateGoalContinuation({
      status: 'continue',
      summary: '已完成代码修改，准备运行测试',
      evidence: ['已修改 src/login.ts'],
    }, { iteration: 1, consecutiveFailures: 0, startedAt: 1000, now: 2000, limits: DEFAULT_GOAL_LIMITS })
    expect(result).toEqual({ action: 'continue', consecutiveFailures: 0 })
  })

  test('completes only with explicit evidence', () => {
    const result = evaluateGoalContinuation({
      status: 'complete',
      summary: '目标已完成',
      evidence: ['bun test passed'],
    }, { iteration: 2, consecutiveFailures: 0, startedAt: 1000, now: 2000, limits: DEFAULT_GOAL_LIMITS })
    expect(result).toEqual({ action: 'complete', consecutiveFailures: 0 })
  })

  test('pauses after repeated failures or limits', () => {
    const result = evaluateGoalContinuation({ status: 'continue', summary: '失败', evidence: [] }, {
      iteration: 1,
      consecutiveFailures: DEFAULT_GOAL_LIMITS.maxConsecutiveFailures - 1,
      startedAt: 1000,
      now: 2000,
      limits: DEFAULT_GOAL_LIMITS,
      turnFailed: true,
    })
    expect(result.action).toBe('failed')

    const timedOut = evaluateGoalContinuation({ status: 'continue', summary: '继续', evidence: [] }, {
      iteration: 1,
      consecutiveFailures: 0,
      startedAt: 1000,
      now: 1000 + DEFAULT_GOAL_LIMITS.maxDurationMs + 1,
      limits: DEFAULT_GOAL_LIMITS,
    })
    expect(timedOut.action).toBe('limit_reached')
  })

  test('process exit stops an active goal without pretending it completed', () => {
    const goal = createGoalState('session-1', '完成登录页', 1000)
    const stopped = stopGoalForProcessExit(goal, 2000)
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'process_exit', updatedAt: 2000 })
  })
})
