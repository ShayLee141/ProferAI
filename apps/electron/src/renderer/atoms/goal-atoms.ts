import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { AgentGoalState } from '@profer/shared'

export const agentGoalsAtom = atom<Map<string, AgentGoalState>>(new Map())

export const agentGoalAtomFamily = atomFamily((sessionId: string) => atom(
  (get) => get(agentGoalsAtom).get(sessionId),
  (_get, set, state: AgentGoalState | null) => {
    set(agentGoalsAtom, (previous) => {
      const next = new Map(previous)
      if (state) next.set(sessionId, state)
      else next.delete(sessionId)
      return next
    })
  },
))
