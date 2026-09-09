import { randomUUID } from 'node:crypto'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { getRecommendationsPath } from './config-paths'
import type { Recommendation, RecommendationFeedbackInput } from '@profer/shared'

interface RecommendationIndex { version: 1; recommendations: Recommendation[] }
let cache: RecommendationIndex | null = null

function readIndex(): RecommendationIndex {
  if (cache) return cache
  const data = readJsonFileSafe<RecommendationIndex>(getRecommendationsPath())
  cache = data && data.version === 1 && Array.isArray(data.recommendations)
    ? data
    : { version: 1, recommendations: [] }
  return cache
}
function writeIndex(index: RecommendationIndex): void {
  cache = index
  writeJsonFileAtomic(getRecommendationsPath(), index)
}
export function listRecommendations(now = Date.now()): Recommendation[] {
  return readIndex().recommendations.filter((r) => r.status === 'suggested' || (r.status === 'snoozed' && (r.snoozedUntil ?? 0) <= now))
}
export function listAllRecommendations(): Recommendation[] { return [...readIndex().recommendations] }
export function upsertRecommendation(input: Omit<Recommendation, 'id' | 'createdAt' | 'updatedAt'>): Recommendation {
  const index = readIndex()
  const existing = index.recommendations.find((r) => r.duplicateKey === input.duplicateKey)
  if (existing) {
    if (existing.status === 'suggested' || existing.status === 'snoozed') {
      Object.assign(existing, input, { updatedAt: Date.now() })
      writeIndex(index)
    }
    return existing
  }
  const now = Date.now()
  const recommendation: Recommendation = { ...input, id: randomUUID(), createdAt: now, updatedAt: now }
  index.recommendations.push(recommendation)
  writeIndex(index)
  return recommendation
}
export function applyRecommendationFeedback(input: RecommendationFeedbackInput): Recommendation | undefined {
  const recommendation = readIndex().recommendations.find((r) => r.id === input.id)
  if (!recommendation) return undefined
  recommendation.status = input.status
  recommendation.snoozedUntil = input.status === 'snoozed' ? input.snoozedUntil : undefined
  recommendation.updatedAt = Date.now()
  writeIndex(readIndex())
  return recommendation
}
export function resetRecommendationCache(): void { cache = null }
