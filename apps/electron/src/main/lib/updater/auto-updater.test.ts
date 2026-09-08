import { describe, expect, mock, test } from 'bun:test'

// 禁止测试触发真实网络检查或下载；electron 由全局 preload 提供开发模式替身。
const check = mock(async () => null)
const download = mock(async () => [])
mock.module('electron-updater', () => ({
  autoUpdater: { checkForUpdates: check, downloadUpdate: download },
}))

const { checkForUpdates, getUpdateStatus } = await import('./auto-updater')

describe('开发版更新状态', () => {
  test('Given 未打包应用 When 获取初始状态 Then 明确禁用而非伪装已是最新', () => {
    expect(getUpdateStatus()).toEqual({ status: 'disabled' })
  })

  test('Given 开发版 When 手动或重复检查 Then 不联网且始终返回禁用状态', async () => {
    await checkForUpdates()
    await checkForUpdates()
    expect(getUpdateStatus()).toEqual({ status: 'disabled' })
    expect(check).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })
})
