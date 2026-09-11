/**
 * DeepSeek 官方模型短名 ↔ 正式 ID 的别名归一。
 *
 * 自 V4 代起，DeepSeek 官方端点在同一模型上同时提供两种写法：
 *   - 无版本号短名：`deepseek-flash` / `deepseek-pro`
 *   - 带版本号正式 ID：`deepseek-v4-flash` / `deepseek-v4-pro`
 *
 * 渠道里手填的往往是短名，而 catalog、reasoning profile、成本与最大输出都按正式 ID 登记。
 * 只要有一处没归一，同一个模型就会因写法不同拿到不同的窗口/价格/档位——
 * 因此凡是「按 V4 代 SKU 判定」或「取其元数据」的地方，都必须先过这里。
 *
 * 注意：本模块只做 ID 归一，不代表任何 provider 链路已验证过 1M 协商；
 * provider 侧能力仍由 context-window 的 supportsVerified1MContext 判定。
 */

/** DeepSeek 官方短名 → 等价正式模型 ID。 */
export const DEEPSEEK_V4_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'deepseek-flash': 'deepseek-v4-flash',
  'deepseek-pro': 'deepseek-v4-pro',
})

/**
 * 去掉 Claude SDK 私有的 `[1m]` 后缀与网关路径前缀，只保留最后一段小写模型名。
 * 语义必须与 context-window 的 normalizeContextModelId 保持一致（后者复用本函数）。
 */
export function normalizeModelIdTail(modelId?: string): string | undefined {
  const trimmed = modelId?.trim().toLowerCase().replace(/\[1m\]$/i, '')
  if (!trimmed) return undefined
  const segments = trimmed.split('/').filter(Boolean)
  return segments.at(-1) ?? trimmed
}

/**
 * 归一模型 ID，并把 DeepSeek 官方短名解析为等价正式 ID。
 * 非短名返回归一化后的原 ID；无法解析时返回 undefined。
 */
export function resolveDeepSeekV4ModelId(modelId?: string): string | undefined {
  const model = normalizeModelIdTail(modelId)
  if (!model) return undefined
  return DEEPSEEK_V4_MODEL_ALIASES[model] ?? model
}

/** 该 ID 是否为 DeepSeek 官方短名（含网关前缀与 `[1m]` 后缀写法）。 */
export function isDeepSeekV4Alias(modelId?: string): boolean {
  const model = normalizeModelIdTail(modelId)
  return model != null && Object.hasOwn(DEEPSEEK_V4_MODEL_ALIASES, model)
}
