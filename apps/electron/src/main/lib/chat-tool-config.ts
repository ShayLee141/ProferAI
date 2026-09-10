/**
 * Chat 工具配置服务。
 *
 * 管理 ~/.profer/chat-tools.json 的工具开关和凭据。GPT Image 的 BYOK Key
 * 只以加密字段保存在主进程配置中，绝不通过 IPC 回传到 renderer。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getChatToolsConfigPath } from './config-paths'
import { decryptToken, encryptToken } from './token-crypto'
import type {
  ChatToolsFileConfig,
  ChatToolState,
  ChatToolMeta,
} from '@profer/shared'

export type GptImageMode = 'official' | 'byok'
export type GptImageProvider = 'openai' | 'xai'

export interface GptImageCredentials {
  provider: GptImageProvider
  mode: GptImageMode
  apiKey: string
  baseUrl: string
  model: string
}

/** 默认配置 */
const DEFAULT_CONFIG: ChatToolsFileConfig = {
  toolStates: {
    memory: { enabled: true },
    'agent-mode-recommend': { enabled: true },
    'web-search': { enabled: false },
    'gpt-image': { enabled: false },
  },
  toolCredentials: {},
  customTools: [],
}

function normalizeGptImageMode(value: string | undefined): GptImageMode {
  return value === 'byok' ? 'byok' : 'official'
}

function normalizeGptImageProvider(value: string | undefined): GptImageProvider {
  return value === 'xai' ? 'xai' : 'openai'
}

function providerField(provider: GptImageProvider, field: 'ApiKeyEncrypted' | 'BaseUrl' | 'Model'): string {
  return `${provider}${field}`
}

function getStoredProviderValue(
  raw: Record<string, string>,
  provider: GptImageProvider,
  field: 'BaseUrl' | 'Model',
): string {
  const providerValue = raw[providerField(provider, field)]
  if (providerValue !== undefined) return providerValue
  // 兼容旧版只有一套配置的 GPT Image 工具。
  return raw.provider === provider ? raw[field === 'BaseUrl' ? 'baseUrl' : 'model'] ?? '' : ''
}

function getStoredProviderApiKey(raw: Record<string, string>, provider: GptImageProvider): string {
  return raw[providerField(provider, 'ApiKeyEncrypted')] ?? (provider === 'openai' ? raw.apiKeyEncrypted : '') ?? ''
}

function decryptStoredProviderApiKey(raw: Record<string, string>, provider: GptImageProvider): string {
  const encrypted = getStoredProviderApiKey(raw, provider)
  if (!encrypted) return ''
  try {
    return decryptToken(encrypted)
  } catch (error) {
    console.error(`[Chat 工具配置] ${provider} 生图 Key 解密失败:`, error)
    return ''
  }
}

/** 将旧版明文 apiKey 升级为加密 apiKeyEncrypted；调用方负责保存。 */
function migrateGptImageCredentials(config: ChatToolsFileConfig): boolean {
  const raw = config.toolCredentials['gpt-image']
  if (!raw) return false
  let changed = false
  // 当前版本之前只有一套配置；若存在过渡版本写入的 provider，则保留它，
  // 否则按历史语义归入 OpenAI，避免迁移时把用户的 xAI Key 放错 provider。
  const legacyProvider: GptImageProvider = raw.provider === 'xai' ? 'xai' : 'openai'
  if (!raw.provider) {
    raw.provider = legacyProvider
    changed = true
  }
  if (!raw.mode) {
    // 老版本只有自带 Key 配置；保留其原有可用语义，而空配置才默认官方模式。
    const hasStoredKey = raw.apiKey || raw.apiKeyEncrypted || raw.openaiApiKeyEncrypted || raw.xaiApiKeyEncrypted
    raw.mode = hasStoredKey ? 'byok' : 'official'
    changed = true
  }
  const legacyApiKeyField = providerField(legacyProvider, 'ApiKeyEncrypted')
  if (raw.apiKey && !raw[legacyApiKeyField]) {
    raw[legacyApiKeyField] = encryptToken(raw.apiKey)
    changed = true
  }
  if (raw.apiKey) {
    delete raw.apiKey
    changed = true
  }
  if (raw.apiKeyEncrypted && !raw[legacyApiKeyField]) {
    raw[legacyApiKeyField] = raw.apiKeyEncrypted
    changed = true
  }
  if (raw.apiKeyEncrypted) {
    delete raw.apiKeyEncrypted
    changed = true
  }
  const legacyBaseUrlField = providerField(legacyProvider, 'BaseUrl')
  if (raw.baseUrl !== undefined) {
    if (raw[legacyBaseUrlField] === undefined) raw[legacyBaseUrlField] = raw.baseUrl
    delete raw.baseUrl
    changed = true
  }
  const legacyModelField = providerField(legacyProvider, 'Model')
  if (raw.model !== undefined) {
    if (raw[legacyModelField] === undefined) raw[legacyModelField] = raw.model
    delete raw.model
    changed = true
  }
  return changed
}

/** 读取工具配置 */
export function getChatToolsConfig(): ChatToolsFileConfig {
  const filePath = getChatToolsConfigPath()
  if (!existsSync(filePath)) return structuredClone(DEFAULT_CONFIG)

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Partial<ChatToolsFileConfig>
    const config: ChatToolsFileConfig = {
      toolStates: { ...DEFAULT_CONFIG.toolStates, ...data.toolStates },
      toolCredentials: data.toolCredentials ?? {},
      customTools: data.customTools ?? [],
    }
    // 读取旧配置时一次性迁移，迁移本身幂等。
    if (migrateGptImageCredentials(config)) saveChatToolsConfig(config)
    return config
  } catch (error) {
    console.error('[Chat 工具配置] 读取失败:', error)
    return structuredClone(DEFAULT_CONFIG)
  }
}

/** 保存工具配置 */
export function saveChatToolsConfig(config: ChatToolsFileConfig): void {
  const filePath = getChatToolsConfigPath()
  try {
    writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8')
    console.log('[Chat 工具配置] 已保存')
  } catch (error) {
    console.error('[Chat 工具配置] 保存失败:', error)
    throw new Error('保存 Chat 工具配置失败')
  }
}

/** 更新单个工具的开关状态 */
export function updateToolState(toolId: string, state: ChatToolState): void {
  const config = getChatToolsConfig()
  config.toolStates[toolId] = state
  saveChatToolsConfig(config)
}

/**
 * 更新工具凭据。GPT Image 是特例：apiKey 输入会在主进程立即加密；空 apiKey
 * 表示“不改动已保存 Key”，从而支持 renderer 不回显密钥的重新编辑体验。
 */
export function updateToolCredentials(
  toolId: string,
  credentials: Record<string, string>,
): void {
  const config = getChatToolsConfig()
  if (toolId !== 'gpt-image') {
    config.toolCredentials[toolId] = credentials
    saveChatToolsConfig(config)
    return
  }

  const existing = config.toolCredentials['gpt-image'] ?? {}
  const provider = normalizeGptImageProvider(credentials.provider ?? existing.provider)
  const next: Record<string, string> = {
    ...existing,
    provider,
    mode: normalizeGptImageMode(credentials.mode ?? existing.mode),
    [providerField(provider, 'BaseUrl')]: credentials.baseUrl?.trim() ?? getStoredProviderValue(existing, provider, 'BaseUrl'),
    [providerField(provider, 'Model')]: credentials.model?.trim() ?? getStoredProviderValue(existing, provider, 'Model'),
  }
  if (credentials.apiKey?.trim())
    next[providerField(provider, 'ApiKeyEncrypted')] = encryptToken(credentials.apiKey.trim())
  delete next.apiKey
  delete next.apiKeyEncrypted
  delete next.baseUrl
  delete next.model
  config.toolCredentials['gpt-image'] = next
  saveChatToolsConfig(config)
}

/** 获取工具开关状态（不存在时返回默认关闭） */
export function getToolState(toolId: string): ChatToolState {
  const config = getChatToolsConfig()
  return config.toolStates[toolId] ?? { enabled: false }
}

/** 主进程专用：取得已解密 GPT Image 凭据。 */
export function getGptImageCredentials(providerOverride?: string): GptImageCredentials {
  const raw = getChatToolsConfig().toolCredentials['gpt-image'] ?? {}
  const provider = normalizeGptImageProvider(providerOverride ?? raw.provider)
  return {
    provider,
    mode: normalizeGptImageMode(raw.mode),
    apiKey: decryptStoredProviderApiKey(raw, provider),
    baseUrl: getStoredProviderValue(raw, provider, 'BaseUrl'),
    model: getStoredProviderValue(raw, provider, 'Model'),
  }
}

/**
 * 获取工具凭据。GPT Image 的 Key 不可被 renderer 或通用 IPC 读取；仅返回
 * mode/地址/模型与 hasApiKey 状态。其他工具保持现有兼容行为。
 */
export function getToolCredentials(toolId: string, providerOverride?: string): Record<string, string> {
  if (toolId !== 'gpt-image')
    return getChatToolsConfig().toolCredentials[toolId] ?? {}
  const credentials = getGptImageCredentials(providerOverride)
  return {
    provider: credentials.provider,
    mode: credentials.mode,
    baseUrl: credentials.baseUrl,
    model: credentials.model,
    hasApiKey: credentials.apiKey ? 'true' : 'false',
  }
}

/** 添加自定义工具 */
export function addCustomTool(meta: ChatToolMeta): void {
  const config = getChatToolsConfig()
  config.customTools = config.customTools.filter((t) => t.id !== meta.id)
  config.customTools.push(meta)
  config.toolStates[meta.id] = { enabled: false }
  saveChatToolsConfig(config)
}

/** 删除自定义工具 */
export function deleteCustomTool(toolId: string): void {
  const config = getChatToolsConfig()
  config.customTools = config.customTools.filter((t) => t.id !== toolId)
  delete config.toolStates[toolId]
  delete config.toolCredentials[toolId]
  saveChatToolsConfig(config)
}
