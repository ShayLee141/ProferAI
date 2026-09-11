import { describe, expect, test } from 'bun:test'
import { resolveReasoningProfile } from './reasoning-profile'

describe('GLM-5.3 reasoning profile', () => {
  test('Given GPT-6 Astra When resolving Then exposes five supported effort levels', () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-6-astra', transport: 'openai-responses' })

    expect(profile?.id).toBe('openai-reasoning-astra')
    expect(profile?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(profile?.encodings['openai-responses']?.effortMap.off).toBeNull()
    expect(profile?.encodings['openai-responses']?.effortMap.minimal).toBe('low')
  })
  test('Given the Zhipu OpenAI protocol When resolving GLM-5.3 Then exposes only off/high with the official toggle encoding', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'openai-completions' })

    expect(profile?.id).toBe('glm-5.3')
    expect(profile?.levels).toEqual(['off', 'high'])
    expect(profile?.normalize('max')).toBe('high')
    expect(profile?.encodings['openai-completions']).toEqual({
      kind: 'zai-toggle',
      effortMap: { minimal: null, low: null, medium: null, xhigh: null, max: null },
    })
  })

  test('Given the Zhipu Coding Plan Anthropic protocol When resolving GLM-5.3 Then does not opt into adaptive effort', () => {
    expect(resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'anthropic-messages' })?.encodings['anthropic-messages']?.kind)
      .toBe('anthropic-manual')
  })

  test('Given GLM-5.2 When resolving Then preserves its existing high/max effort semantics', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.2', transport: 'openai-completions' })

    expect(profile?.levels).toEqual(['off', 'high', 'max'])
    expect(profile?.encodings['openai-completions']?.kind).toBe('zai-thinking-effort')
  })

  test('Given DeepSeek 官方短名 When resolving Then 与同代正式 ID 得到同一档位协议', () => {
    const flashAlias = resolveReasoningProfile({ modelId: 'deepseek-flash', transport: 'anthropic-messages' })
    const flashOfficial = resolveReasoningProfile({ modelId: 'deepseek-v4-flash', transport: 'anthropic-messages' })
    const proAlias = resolveReasoningProfile({ modelId: 'deepseek-pro', transport: 'anthropic-messages' })

    expect(flashAlias?.id).toBe('deepseek-v4-flash')
    expect(flashAlias?.encodings['anthropic-messages']?.kind).toBe('deepseek-output-effort')
    expect(flashAlias).toEqual(flashOfficial)
    expect(proAlias?.id).toBe('deepseek-v4-pro')
  })

  test('Given DeepSeek 旧世代模型 When resolving Then 短名别名不误扩档位', () => {
    expect(resolveReasoningProfile({ modelId: 'deepseek-chat', transport: 'anthropic-messages' })).toBeUndefined()
    expect(resolveReasoningProfile({ modelId: 'deepseek-reasoner', transport: 'anthropic-messages' })).toBeUndefined()
  })
})
