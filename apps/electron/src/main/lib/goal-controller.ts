import {
  createGoalState,
  DEFAULT_GOAL_LIMITS,
  evaluateGoalContinuation,
  stopGoalForProcessExit,
} from './goal-loop'
import type { AgentGoalIterationResult, AgentGoalState } from '@profer/shared'

type TimerHandle = unknown

type GoalControllerDependencies = {
  runTurn: (input: { sessionId: string; goal: AgentGoalState['goal']; iteration: number; previousSummary?: string }) => Promise<AgentGoalIterationResult>
  stopTurn: (sessionId: string) => Promise<void>
  onStateChange?: (state: AgentGoalState) => void
  schedule?: (callback: () => void) => TimerHandle
  cancelSchedule?: (handle: TimerHandle) => void
}

type Runtime = {
  state: AgentGoalState
  schedule?: TimerHandle
  stopping: boolean
}

export class GoalController {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly schedule: (callback: () => void) => TimerHandle
  private readonly cancelSchedule: (handle: TimerHandle) => void

  constructor(private readonly deps: GoalControllerDependencies) {
    this.schedule = deps.schedule ?? ((callback) => setTimeout(callback, 0))
    this.cancelSchedule = deps.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  get(sessionId: string): AgentGoalState | undefined {
    return this.runtimes.get(sessionId)?.state
  }

  async start(sessionId: string, goal: string, now = Date.now()): Promise<AgentGoalState> {
    if (this.runtimes.has(sessionId)) throw new Error('该会话已有正在运行的 Goal')
    const runtime: Runtime = { state: createGoalState(sessionId, goal, now, DEFAULT_GOAL_LIMITS), stopping: false }
    this.runtimes.set(sessionId, runtime)
    this.emit(runtime.state)
    this.scheduleNext(sessionId, runtime, 0)
    return runtime.state
  }

  async pause(sessionId: string): Promise<AgentGoalState> {
    const runtime = this.require(sessionId)
    runtime.stopping = true
    this.cancelPending(runtime)
    await this.deps.stopTurn(sessionId)
    runtime.state = { ...runtime.state, status: 'paused', updatedAt: Date.now() }
    this.emit(runtime.state)
    return runtime.state
  }

  async resume(sessionId: string): Promise<AgentGoalState> {
    const runtime = this.require(sessionId)
    if (runtime.state.status !== 'paused') throw new Error('只有暂停中的 Goal 才能恢复')
    runtime.stopping = false
    runtime.state = { ...runtime.state, status: 'active', updatedAt: Date.now() }
    this.emit(runtime.state)
    this.scheduleNext(sessionId, runtime, 0)
    return runtime.state
  }

  async stop(sessionId: string): Promise<AgentGoalState> {
    const runtime = this.require(sessionId)
    runtime.stopping = true
    this.cancelPending(runtime)
    await this.deps.stopTurn(sessionId)
    runtime.state = { ...runtime.state, status: 'stopped', stopReason: 'user', updatedAt: Date.now() }
    this.emit(runtime.state)
    return runtime.state
  }

  clear(sessionId: string): void {
    const runtime = this.require(sessionId)
    if (runtime.state.status === 'active') throw new Error('运行中的 Goal 不能直接清除')
    this.cancelPending(runtime)
    this.runtimes.delete(sessionId)
    this.deps.onStateChange?.({ ...runtime.state, status: 'stopped', stopReason: 'cleared', updatedAt: Date.now() })
  }

  stopAll(): void {
    for (const [sessionId, runtime] of this.runtimes) {
      runtime.stopping = true
      this.cancelPending(runtime)
      runtime.state = stopGoalForProcessExit(runtime.state)
      this.emit(runtime.state)
      void this.deps.stopTurn(sessionId)
    }
  }

  private require(sessionId: string): Runtime {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) throw new Error('当前会话没有 Goal')
    return runtime
  }

  private cancelPending(runtime: Runtime): void {
    if (runtime.schedule !== undefined) {
      this.cancelSchedule(runtime.schedule)
      runtime.schedule = undefined
    }
  }

  private scheduleNext(sessionId: string, runtime: Runtime, delay: number): void {
    runtime.schedule = this.schedule(() => {
      runtime.schedule = undefined
      void this.runTurn(sessionId, runtime)
    })
    if (delay > 0) {
      // 默认调度器已经是异步的；自定义测试调度器无需额外等待。
    }
  }

  private async runTurn(sessionId: string, runtime: Runtime): Promise<void> {
    if (runtime.stopping || runtime.state.status !== 'active') return
    const iteration = runtime.state.iteration + 1
    runtime.state = { ...runtime.state, iteration, updatedAt: Date.now() }
    this.emit(runtime.state)
    try {
      const result = await this.deps.runTurn({ sessionId, goal: runtime.state.goal, iteration, previousSummary: runtime.state.lastSummary })
      if (runtime.stopping || runtime.state.status !== 'active') return
      const decision = evaluateGoalContinuation(result, {
        iteration,
        consecutiveFailures: runtime.state.consecutiveFailures,
        startedAt: runtime.state.startedAt,
        now: Date.now(),
        limits: runtime.state.limits,
      })
      const nextStatus = decision.action === 'continue' ? 'active' : decision.action === 'complete' ? 'completed' : decision.action === 'blocked' ? 'blocked' : decision.action === 'failed' ? 'failed' : 'paused'
      runtime.state = {
        ...runtime.state,
        status: nextStatus,
        consecutiveFailures: decision.consecutiveFailures,
        lastSummary: result.summary,
        lastEvidence: result.evidence,
        stopReason: 'reason' in decision ? decision.reason : undefined,
        updatedAt: Date.now(),
      }
      this.emit(runtime.state)
      if (decision.action === 'continue') this.scheduleNext(sessionId, runtime, 0)
    } catch (error) {
      if (runtime.stopping) return
      runtime.state = { ...runtime.state, status: 'failed', stopReason: error instanceof Error ? error.message : 'Goal 执行失败', updatedAt: Date.now() }
      this.emit(runtime.state)
    }
  }

  private emit(state: AgentGoalState): void {
    this.deps.onStateChange?.(state)
  }
}
