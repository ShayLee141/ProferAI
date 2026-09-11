import { describe, expect, test } from 'bun:test'
import {
  DEEPSEEK_V4_MODEL_ALIASES,
  isDeepSeekV4Alias,
  normalizeModelIdTail,
  resolveDeepSeekV4ModelId,
} from './deepseek-model-alias'

describe('DeepSeek 官方短名别名', () => {
  test('Given DeepSeek 官方短名 When 归一 Then 解析为等价正式 ID', () => {
    expect(resolveDeepSeekV4ModelId('deepseek-flash')).toBe('deepseek-v4-flash')
    expect(resolveDeepSeekV4ModelId('deepseek-pro')).toBe('deepseek-v4-pro')
    expect(DEEPSEEK_V4_MODEL_ALIASES['deepseek-flash']).toBe('deepseek-v4-flash')
  })

  test('Given 网关前缀、大小写或 SDK 后缀 When 归一 Then 仍能解析短名', () => {
    expect(normalizeModelIdTail(' Gateway/DeepSeek-Flash[1m] ')).toBe('deepseek-flash')
    expect(resolveDeepSeekV4ModelId('Gateway/DeepSeek-Pro')).toBe('deepseek-v4-pro')
    expect(resolveDeepSeekV4ModelId('deepseek-flash[1m]')).toBe('deepseek-v4-flash')
  })

  test('Given 非短名 When 归一 Then 原样返回，不误改写其它 DeepSeek 模型', () => {
    expect(resolveDeepSeekV4ModelId('deepseek-v4-pro')).toBe('deepseek-v4-pro')
    expect(resolveDeepSeekV4ModelId('deepseek-chat')).toBe('deepseek-chat')
    expect(resolveDeepSeekV4ModelId('deepseek-reasoner')).toBe('deepseek-reasoner')
    expect(resolveDeepSeekV4ModelId('deepseek-turbo')).toBe('deepseek-turbo')
    expect(resolveDeepSeekV4ModelId(undefined)).toBeUndefined()
    expect(resolveDeepSeekV4ModelId('   ')).toBeUndefined()
  })

  test('Given 各类写法 When 判断是否为短名 Then 只认两个官方短名', () => {
    expect(isDeepSeekV4Alias('deepseek-flash')).toBe(true)
    expect(isDeepSeekV4Alias('gateway/deepseek-pro[1m]')).toBe(true)
    expect(isDeepSeekV4Alias('deepseek-v4-flash')).toBe(false)
    expect(isDeepSeekV4Alias('deepseek-chat')).toBe(false)
  })
})
