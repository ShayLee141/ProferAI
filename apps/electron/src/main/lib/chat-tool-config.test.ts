import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let configPath = ''
mock.module('./config-paths', () => ({
  getChatToolsConfigPath: () => configPath,
}))
mock.module('./token-crypto', () => ({
  encryptToken: (value: string) => `encrypted:${value}`,
  decryptToken: (value: string) => value.startsWith('encrypted:') ? value.slice('encrypted:'.length) : value,
}))

const {
  getChatToolsConfig,
  getGptImageCredentials,
  getToolCredentials,
  updateToolCredentials,
} = await import('./chat-tool-config')

const roots: string[] = []

function makeConfig(raw: unknown): void {
  const root = mkdtempSync(join(tmpdir(), 'profer-chat-tool-config-'))
  roots.push(root)
  configPath = join(root, 'chat-tools.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(configPath, JSON.stringify(raw), 'utf-8')
}

afterEach(() => {
  configPath = ''
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('GPT Image provider credentials', () => {
  test('旧版单套 OpenAI 配置迁移后仍可读取，并不会保留明文 Key', () => {
    makeConfig({
      toolStates: { 'gpt-image': { enabled: true } },
      toolCredentials: {
        'gpt-image': { mode: 'byok', apiKey: 'sk-old', baseUrl: 'https://old.example', model: 'old-model' },
      },
      customTools: [],
    })

    expect(getGptImageCredentials()).toEqual({
      provider: 'openai', mode: 'byok', apiKey: 'sk-old', baseUrl: 'https://old.example', model: 'old-model',
    })
    const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as { toolCredentials: Record<string, Record<string, string>> }
    const raw = saved.toolCredentials['gpt-image']!
    expect(raw.openaiApiKeyEncrypted).toBe('encrypted:sk-old')
    expect(raw.apiKey).toBeUndefined()
    expect(raw.openaiBaseUrl).toBe('https://old.example')
    expect(raw.openaiModel).toBe('old-model')
  })

  test('OpenAI 与 xAI 凭据独立保存，切换 provider 不会覆盖另一套 Key', () => {
    makeConfig({ toolStates: {}, toolCredentials: {}, customTools: [] })

    updateToolCredentials('gpt-image', {
      provider: 'openai', mode: 'byok', apiKey: 'sk-openai', baseUrl: 'https://openai.example', model: 'gpt-image-2',
    })
    updateToolCredentials('gpt-image', {
      provider: 'xai', mode: 'byok', apiKey: 'xai-key', baseUrl: 'https://api.x.ai', model: 'grok-imagine-image-2.0',
    })

    expect(getGptImageCredentials('openai')).toMatchObject({ provider: 'openai', apiKey: 'sk-openai', baseUrl: 'https://openai.example', model: 'gpt-image-2' })
    expect(getGptImageCredentials('xai')).toMatchObject({ provider: 'xai', apiKey: 'xai-key', baseUrl: 'https://api.x.ai', model: 'grok-imagine-image-2.0' })
    expect(getToolCredentials('gpt-image')).toMatchObject({ provider: 'xai', hasApiKey: 'true' })
    expect(existsSync(configPath)).toBe(true)
  })

  test('带 provider 的过渡配置会把旧字段迁移到对应 provider', () => {
    makeConfig({
      toolStates: {},
      toolCredentials: {
        'gpt-image': { provider: 'xai', mode: 'byok', apiKey: 'xai-old', baseUrl: 'https://legacy.x.ai', model: 'grok-imagine-image' },
      },
      customTools: [],
    })

    expect(getGptImageCredentials()).toEqual({
      provider: 'xai', mode: 'byok', apiKey: 'xai-old', baseUrl: 'https://legacy.x.ai', model: 'grok-imagine-image',
    })
    const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as { toolCredentials: Record<string, Record<string, string>> }
    const raw = saved.toolCredentials['gpt-image']!
    expect(raw.xaiApiKeyEncrypted).toBe('encrypted:xai-old')
    expect(raw.openaiApiKeyEncrypted).toBeUndefined()
    expect(raw.apiKey).toBeUndefined()
  })
})
