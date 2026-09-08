import { expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import {
  voiceDictationEnabledAtom,
  voiceDictationSettingsAtom,
} from './voice-dictation-atoms'

const settings = (enabled: boolean) => ({
  enabled,
  provider: 'doubao' as const,
  appId: '',
  accessToken: '',
  resourceId: 'volc.seedasr.sauc.duration',
  language: '',
  endpointMode: 'async' as const,
  outputMode: 'auto' as const,
  customHotwords: '',
})

test('仅在语音输入设置明确启用时显示工具栏入口', () => {
  const store = createStore()

  expect(store.get(voiceDictationEnabledAtom)).toBe(false)

  store.set(voiceDictationSettingsAtom, settings(false))
  expect(store.get(voiceDictationEnabledAtom)).toBe(false)

  store.set(voiceDictationSettingsAtom, settings(true))
  expect(store.get(voiceDictationEnabledAtom)).toBe(true)
})
