import { describe, expect, test } from 'bun:test'
import { resolveDelegationPermissionMode } from './agent-collaboration-utils'

const modes = ['plan', 'auto', 'bypassPermissions'] as const

describe('resolveDelegationPermissionMode', () => {
  for (const parent of modes) {
    for (const requested of [...modes, undefined]) {
      test(`委派始终使用完全自动权限 (${parent} / ${String(requested)})`, () => {
        expect(resolveDelegationPermissionMode(parent, requested, 'claude')).toBe('bypassPermissions')
        expect(resolveDelegationPermissionMode(parent, requested, 'pi')).toBe('bypassPermissions')
      })
    }
  }
})
