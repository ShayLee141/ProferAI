import { describe, expect, test } from 'bun:test'
import type { Automation } from '@profer/shared'
import { refreshAutomationRecommendations } from './recommendation-engine'
import { resetRecommendationCache } from './recommendation-manager'

function automation(overrides: Partial<Automation> = {}): Automation {
  const now = Date.now()
  return {
    id: 'a1', name: '每日汇总', prompt: '汇总工作', active: true, scheduleType: 'daily', intervalMinutes: 1440,
    channelId: 'channel', workspaceId: 'workspace', createdAt: now - 1000, updatedAt: now - 1000, nextRunAt: now + 1000,
    runHistory: [], ...overrides,
  }
}

describe('refreshAutomationRecommendations', () => {
  test('成功重复运行三次生成建议', () => {
    resetRecommendationCache()
    const now = Date.now()
    const result = refreshAutomationRecommendations([automation({ runHistory: [1, 2, 3].map((n) => ({ runAt: now - n * 86_400_000, sessionId: `s${n}`, status: 'success' as const })) })], now)
    expect(result).toHaveLength(1)
    expect(result[0]?.kind).toBe('schedule')
  })

  test('连续失败三次生成维护建议，once 不生成', () => {
    resetRecommendationCache()
    const now = Date.now()
    const runs = [1, 2, 3].map((n) => ({ runAt: now - n * 1000, sessionId: `s${n}`, status: 'error' as const }))
    const result = refreshAutomationRecommendations([automation({ runHistory: runs }), automation({ id: 'once', scheduleType: 'once', runHistory: runs })], now)
    expect(result).toHaveLength(1)
    expect(result[0]?.kind).toBe('maintenance')
  })
})
