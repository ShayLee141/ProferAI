import type { SDKMessage } from '@profer/shared'

export interface AgentHistoryPageLike {
  messages: SDKMessage[]
  startIndex?: number
  hasMore?: boolean
}

export interface AgentHistoryCursorState {
  startIndex: number
  hasMore: boolean
}

export interface AgentHistoryLoadResult {
  messages: SDKMessage[]
  cursor: AgentHistoryCursorState
  isPage: boolean
}

/** 兼容分页对象与旧版纯数组返回值。旧数组由调用方的 hasMore 状态函数决定是否继续。 */
export function normalizeAgentHistoryResult(
  value: unknown,
  previous: AgentHistoryCursorState,
  legacyHasMore?: boolean,
): AgentHistoryLoadResult {
  const isPage = !Array.isArray(value) && value !== null && typeof value === 'object' && 'messages' in value
  if (!isPage) {
    return {
      messages: Array.isArray(value) ? value as SDKMessage[] : [],
      cursor: {
        startIndex: Math.max(0, previous.startIndex - (Array.isArray(value) ? value.length : 0)),
        hasMore: typeof legacyHasMore === 'boolean' ? legacyHasMore : previous.hasMore,
      },
      isPage: false,
    }
  }

  const page = value as AgentHistoryPageLike
  const messages = Array.isArray(page.messages) ? page.messages : []
  const startIndex = typeof page.startIndex === 'number'
    ? page.startIndex
    : Math.max(0, previous.startIndex - messages.length)
  return {
    messages,
    cursor: {
      startIndex,
      // Older page objects may omit hasMore; a positive cursor still proves there is history.
      hasMore: page.hasMore === true || startIndex > 0,
    },
    isPage: true,
  }
}
