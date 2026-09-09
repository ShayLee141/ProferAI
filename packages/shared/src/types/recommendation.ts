/** 本地、可解释、需用户确认的主动建议。 */
export type RecommendationKind = 'schedule' | 'maintenance'
export type RecommendationStatus = 'suggested' | 'accepted' | 'dismissed' | 'snoozed'
export type RecommendationSafetyLevel = 'read_only' | 'runs_agent'

export interface RecommendationEvidence {
  label: string
  detail: string
  sourceId?: string
  sourceKind?: 'automation' | 'run'
}

export interface RecommendationAction {
  type: 'create_automation' | 'edit_automation'
  automationId?: string
  prefill?: {
    name: string
    prompt: string
    scheduleType: 'interval' | 'daily' | 'weekly' | 'monthly'
    intervalMinutes?: number
    timeOfDay?: string[]
    dayOfWeek?: number[]
    dayOfMonth?: number[]
  }
}

export interface Recommendation {
  id: string
  kind: RecommendationKind
  title: string
  reason: string
  confidence: number
  safetyLevel: RecommendationSafetyLevel
  duplicateKey: string
  evidence: RecommendationEvidence[]
  action: RecommendationAction
  status: RecommendationStatus
  createdAt: number
  updatedAt: number
  snoozedUntil?: number
}

export interface RecommendationFeedbackInput {
  id: string
  status: Extract<RecommendationStatus, 'accepted' | 'dismissed' | 'snoozed'>
  snoozedUntil?: number
}

export const RECOMMENDATION_IPC_CHANNELS = {
  LIST: 'recommendation:list',
  REFRESH: 'recommendation:refresh',
  FEEDBACK: 'recommendation:feedback',
  CHANGED: 'recommendation:changed',
} as const
