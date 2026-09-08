import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Type } from 'typebox'
import {
  buildTypeBoxDelegationPresetReferenceSchema,
  buildZodDelegationPresetReferenceSchema,
} from './agent-delegation-preset-schema'

describe('delegation presetReference schema parity', () => {
  test('Claude schema accepts all supported stable reference fields', () => {
    const schema = buildZodDelegationPresetReferenceSchema(z)
    expect(schema.safeParse({
      presetId: 'review',
      presetScope: 'workspace',
      workspaceSlug: 'workspace-a',
      presetVersion: 'v3',
    }).success).toBe(true)
  })

  test('Claude schema rejects blank ID and unknown scope', () => {
    const schema = buildZodDelegationPresetReferenceSchema(z)
    expect(schema.safeParse({ presetId: ' ', presetScope: 'workspace' }).success).toBe(false)
    expect(schema.safeParse({ presetId: 'review', presetScope: 'unknown' }).success).toBe(false)
  })

  test('Pi schema exposes the same fields and scope enum', () => {
    const schema = buildTypeBoxDelegationPresetReferenceSchema(Type) as {
      properties: Record<string, unknown>
    }
    expect(schema.properties).toHaveProperty('presetId')
    expect(schema.properties).toHaveProperty('presetScope')
    expect(schema.properties).toHaveProperty('workspaceSlug')
    expect(schema.properties).toHaveProperty('presetVersion')
  })
})
