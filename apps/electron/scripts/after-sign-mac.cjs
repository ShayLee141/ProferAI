/**
 * electron-builder afterSign hook — 补做 macOS ad-hoc 签名并钉死 designated requirement。
 *
 * electron-builder 在 mac 上没有可用身份时会完全跳过签名，产物连 `codesign --verify`
 * 都过不去，进而让 Squirrel.Mac 静默拒绝所有自更新。这里在签名阶段之后、DMG/ZIP
 * 打包之前补签，保证归档里就是可验证的包。
 *
 * 契约与约束见 macos-signature.cjs 顶部注释。要点：
 * - 已有真实 Developer ID 签名时直接跳过，绝不覆盖；
 * - 一旦以本契约发布，后续版本必须保持同一 DR，否则用户必须手动重装一次。
 */
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const {
  PRODUCT_APP_NAME,
  assertMacSignatureContract,
  readSignatureInfo,
  signMacAppWithPinnedRequirement,
} = require('./macos-signature.cjs')

function resolveAppBundlePath(context) {
  const productFilename = context.packager?.appInfo?.productFilename
  const candidates = [
    productFilename ? join(context.appOutDir, `${productFilename}.app`) : null,
    join(context.appOutDir, PRODUCT_APP_NAME),
  ].filter(Boolean)
  return candidates.map((candidate) => resolve(candidate)).find((candidate) => existsSync(candidate)) ?? null
}

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = resolveAppBundlePath(context)
  if (!appPath) {
    throw new Error(
      `[afterSign] 未找到 macOS App 产物，无法补做签名：${join(context.appOutDir, PRODUCT_APP_NAME)}`,
    )
  }

  const current = readSignatureInfo(appPath)
  if (current.teamIdentifier && current.teamIdentifier !== 'not set') {
    console.log(
      `  [afterSign] 检测到真实签名（TeamIdentifier=${current.teamIdentifier}），` +
      '保留 Developer ID 签名，跳过 ad-hoc 补签',
    )
    assertMacSignatureContract(appPath)
    return
  }

  console.log(`  [afterSign] 补做 macOS ad-hoc 签名并钉死 designated requirement：${appPath}`)
  const { bundleId, requirement } = await signMacAppWithPinnedRequirement(appPath)
  const result = assertMacSignatureContract(appPath)
  console.log(
    `  [afterSign] 签名完成：bundleId=${bundleId}，DR=${requirement}，` +
    `嵌套 App ${result.nestedAppCount} 个`,
  )
}
