import { describe, expect, test } from 'bun:test'
import { normalizeAgentHistoryResult } from './agent-history-pagination'

const message = (id: string) => ({ type: 'user', uuid: id } as never)

describe('Agent history pagination compatibility', () => {
  test('legacy arrays preserve cursor and use the legacy hasMore signal', () => {
    const result = normalizeAgentHistoryResult(
      [message('older')],
      { startIndex: 60, hasMore: true },
      true,
    )
    expect(result.messages.map((item) => (item as { uuid: string }).uuid)).toEqual(['older'])
    expect(result.cursor).toEqual({ startIndex: 59, hasMore: true })
    expect(result.isPage).toBe(false)
  })

  test('legacy empty arrays stop when the compatibility signal says no more', () => {
    const result = normalizeAgentHistoryResult([], { startIndex: 0, hasMore: true }, false)
    expect(result.cursor).toEqual({ startIndex: 0, hasMore: false })
  })

  test('page cursor advances backwards and missing cursor falls back by page length', () => {
    expect(normalizeAgentHistoryResult(
      { messages: [message('a')], startIndex: 20, hasMore: true },
      { startIndex: 60, hasMore: true },
    ).cursor).toEqual({ startIndex: 20, hasMore: true })
    expect(normalizeAgentHistoryResult(
      { messages: [message('a'), message('b')], hasMore: true },
      { startIndex: 20, hasMore: true },
    ).cursor).toEqual({ startIndex: 18, hasMore: true })
  })

  test('cursor at zero stops even if page omits hasMore', () => {
    expect(normalizeAgentHistoryResult(
      { messages: [message('a')], startIndex: 0 },
      { startIndex: 20, hasMore: true },
    ).cursor.hasMore).toBe(false)
  })
})
