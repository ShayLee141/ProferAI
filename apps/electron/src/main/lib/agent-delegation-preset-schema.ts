type ZodModule = typeof import('zod')

export function buildZodDelegationPresetReferenceSchema(z: ZodModule['z']) {
  const nonBlankString = z.string().trim().min(1)
  return z.object({
    presetId: nonBlankString,
    presetScope: z.enum(['builtin-meta', 'user-global', 'workspace']),
    workspaceSlug: nonBlankString.optional(),
    presetVersion: nonBlankString.optional(),
  }).optional().describe('可选目标预设；不传则继承父会话预设')
}

export function buildTypeBoxDelegationPresetReferenceSchema(
  Type: typeof import('typebox').Type,
) {
  return Type.Optional(Type.Object({
    presetId: Type.String({ minLength: 1 }),
    presetScope: Type.Union([
      Type.Literal('builtin-meta'),
      Type.Literal('user-global'),
      Type.Literal('workspace'),
    ]),
    workspaceSlug: Type.Optional(Type.String({ minLength: 1 })),
    presetVersion: Type.Optional(Type.String({ minLength: 1 })),
  }, { description: '可选目标预设；不传则继承父会话预设' }))
}
