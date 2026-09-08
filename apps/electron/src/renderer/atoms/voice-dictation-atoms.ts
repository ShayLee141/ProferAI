import { atom } from 'jotai'
import type { VoiceDictationSettings } from '../../types/settings'

/**
 * 语音输入配置的渲染进程缓存。
 *
 * null 表示尚未从主进程读取。输入工具栏据此延后渲染语音按钮，
 * 以确保只有用户明确启用语音输入后才出现入口。
 */
export const voiceDictationSettingsAtom = atom<VoiceDictationSettings | null>(null)

/** 当前是否已启用语音输入。 */
export const voiceDictationEnabledAtom = atom(
  (get) => get(voiceDictationSettingsAtom)?.enabled === true,
)
