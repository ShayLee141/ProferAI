import { filterDisabledTools } from '@profer/shared'
import { auditPptDelivery, planPptVisuals } from './ppt-delivery-audit-service'

type ToolResult = { content: Array<{ type: 'text'; text: string }> }
function result(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

/** Claude runtime 的 PPT 视觉计划与交付审计 MCP 工具。 */
export async function injectPptDeliveryMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  disabledTools?: string[],
): Promise<void> {
  let z: typeof import('zod').z
  try { ({ z } = await import('zod')) } catch { z = require('zod').z }

  const server = sdk.createSdkMcpServer({
    name: 'ppt-delivery', version: '1.0.0', tools: filterDisabledTools([
      sdk.tool(
        'plan_ppt_visuals',
        '在生成多页 PPT 前创建逐页视觉计划。每页必须指定真实图片、图表、图解或数据大字之一。',
        { deckIntent: z.string().min(1).max(300), slides: z.array(z.object({ slideNumber: z.number().int().positive().optional(), title: z.string().min(1).max(200), purpose: z.string().max(300).optional() })).min(1) },
        async ({ deckIntent, slides }) => result(planPptVisuals(deckIntent, slides)),
        { annotations: { readOnlyHint: true } },
      ),
      sdk.tool(
        'audit_ppt_delivery',
        'PPT 生成后必须调用。审计 PPTX 中逐页图片、图表、形状与文本；若视觉计划要求的主视觉未落地或整套无图片无图表，将返回 needsRevision=true，必须修订后再交付。',
        { filePath: z.string().min(1), visualPlan: z.object({ deckIntent: z.string(), slides: z.array(z.object({ slideNumber: z.number().int().positive(), slidePurpose: z.string(), heroVisual: z.enum(['real_image', 'chart', 'diagram', 'data_typography']), materialQuery: z.string().optional(), fallbackReason: z.string().optional() })) }).optional() },
        async ({ filePath, visualPlan }) => result(auditPptDelivery(filePath, visualPlan)),
        { annotations: { readOnlyHint: true } },
      ),
    ], disabledTools),
  })
  mcpServers['ppt-delivery'] = server as unknown as Record<string, unknown>
}
