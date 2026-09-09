import type { Automation, Recommendation } from '@profer/shared'
import { upsertRecommendation, listAllRecommendations } from './recommendation-manager'

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000
const SUCCESS_THRESHOLD = 3
const FAILURE_THRESHOLD = 3

function recentRuns(a: Automation, now: number) {
  return a.runHistory.filter((run) => run.runAt >= now - WINDOW_MS)
}

/** 从现有 Automation 运行历史生成建议；不创建、不修改 Automation。 */
export function refreshAutomationRecommendations(automations: Automation[], now = Date.now()): Recommendation[] {
  const existing = listAllRecommendations()
  const output: Recommendation[] = []
  for (const automation of automations) {
    if (automation.scheduleType === 'once' || !automation.active) continue
    const runs = recentRuns(automation, now)
    const successes = runs.filter((r) => r.status === 'success')
    const key = `schedule:${automation.id}:cadence`
    if (successes.length >= SUCCESS_THRESHOLD && !existing.some((r) => r.duplicateKey === key && r.status === 'dismissed')) {
      output.push(upsertRecommendation({
        kind: 'schedule',
        title: `继续自动化「${automation.name}」`,
        reason: `这个任务在最近 14 天成功运行了 ${successes.length} 次，已经形成稳定的重复流程。建议保留为明确的周期任务，并检查输出是否符合预期。`,
        confidence: Math.min(0.95, 0.65 + successes.length * 0.05),
        safetyLevel: 'runs_agent',
        duplicateKey: key,
        evidence: [{ label: '运行频率', detail: `最近 14 天成功 ${successes.length} 次`, sourceId: automation.id, sourceKind: 'automation' }],
        action: { type: 'edit_automation', automationId: automation.id },
        status: 'suggested',
      }))
    }
    const failures = runs.slice().sort((a, b) => b.runAt - a.runAt).slice(0, FAILURE_THRESHOLD)
    if (failures.length === FAILURE_THRESHOLD && failures.every((r) => r.status === 'error')) {
      const failureKey = `maintenance:${automation.id}:failures`
      if (!existing.some((r) => r.duplicateKey === failureKey && r.status === 'dismissed')) {
        output.push(upsertRecommendation({
          kind: 'maintenance',
          title: `检查定时任务「${automation.name}」`,
          reason: `该任务最近连续 ${FAILURE_THRESHOLD} 次运行失败，建议检查任务范围、权限、模型或外部数据源。Profer 不会自动修改任务。`,
          confidence: 0.9,
          safetyLevel: 'read_only',
          duplicateKey: failureKey,
          evidence: [{ label: '连续失败', detail: `最近 ${FAILURE_THRESHOLD} 次运行均失败`, sourceId: automation.id, sourceKind: 'automation' }],
          action: { type: 'edit_automation', automationId: automation.id },
          status: 'suggested',
        }))
      }
    }
  }
  return output
}
