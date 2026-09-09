import type { AgentGoalIterationResult, AgentGoalState, AgentGoalLimits, AgentGoalCommand, AgentGoalContinuation } from '@profer/shared'

export const DEFAULT_GOAL_LIMITS: AgentGoalLimits = {
  maxIterations: 20,
  maxConsecutiveFailures: 3,
  maxDurationMs: 2 * 60 * 60 * 1000,
}

export function parseGoalCommand(input: string): AgentGoalCommand {
  const trimmed = input.trim()
  if (!/^\/goal(?:\s|$)/i.test(trimmed)) return { type: 'not_goal' }
  const rest = trimmed.replace(/^\/goal\s*/i, '').trim()
  if (!rest) return { type: 'invalid', reason: '目标不能为空' }
  const command = rest.toLowerCase()
  if (command === 'status') return { type: 'status' }
  if (command === 'pause') return { type: 'pause' }
  if (command === 'resume') return { type: 'resume' }
  if (command === 'stop') return { type: 'stop' }
  if (command === 'clear') return { type: 'clear' }
  if (/^[a-z]+$/.test(command) && ['status', 'pause', 'resume', 'stop', 'clear'].includes(command) === false) {
    return { type: 'invalid', reason: `未知的 Goal 命令：${rest}` }
  }
  return { type: 'start', goal: rest }
}

export function createGoalState(sessionId: string, goal: string, now = Date.now(), limits = DEFAULT_GOAL_LIMITS): AgentGoalState {
  return {
    id: crypto.randomUUID(),
    sessionId,
    goal: goal.trim(),
    status: 'active',
    iteration: 0,
    consecutiveFailures: 0,
    startedAt: now,
    updatedAt: now,
    limits,
  }
}

export function evaluateGoalContinuation(
  result: AgentGoalIterationResult,
  context: { iteration: number; consecutiveFailures: number; startedAt: number; now: number; limits: AgentGoalLimits; turnFailed?: boolean },
): AgentGoalContinuation {
  const failures = context.turnFailed ? context.consecutiveFailures + 1 : 0
  if (context.now - context.startedAt >= context.limits.maxDurationMs) return { action: 'limit_reached', consecutiveFailures: failures, reason: '已达到 Goal 最大运行时长' }
  if (context.iteration >= context.limits.maxIterations) return { action: 'limit_reached', consecutiveFailures: failures, reason: '已达到 Goal 最大迭代轮次' }
  if (failures >= context.limits.maxConsecutiveFailures) return { action: 'failed', consecutiveFailures: failures, reason: '连续执行失败次数达到上限' }
  if (result.status === 'complete' && result.evidence.length > 0) return { action: 'complete', consecutiveFailures: 0 }
  if (result.status === 'blocked') return { action: 'blocked', consecutiveFailures: failures, reason: result.summary }
  return { action: 'continue', consecutiveFailures: failures }
}

export function parseGoalIterationResult(text: string): AgentGoalIterationResult {
  const match = text.match(/<goal_result>\s*([\s\S]*?)\s*<\/goal_result>/i)
  if (!match) return { status: 'continue', summary: text.slice(-2000), evidence: [] }
  try {
    const parsed = JSON.parse(match[1] ?? '') as Partial<AgentGoalIterationResult>
    const status = parsed.status === 'complete' || parsed.status === 'blocked' ? parsed.status : 'continue'
    return { status, summary: typeof parsed.summary === 'string' ? parsed.summary : '', evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter((item): item is string => typeof item === 'string') : [] }
  } catch {
    return { status: 'continue', summary: 'Goal 结果协议解析失败，继续执行并要求下一轮重新汇报。', evidence: [] }
  }
}

export function stopGoalForProcessExit(goal: AgentGoalState, now = Date.now()): AgentGoalState {
  return { ...goal, status: 'stopped', stopReason: 'process_exit', updatedAt: now }
}
