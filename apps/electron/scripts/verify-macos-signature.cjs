#!/usr/bin/env node
/**
 * 验证 macOS 签名契约（ad-hoc + 钉死 designated requirement）。
 *
 * 这是 Squirrel.Mac 自更新能否安装的**唯一**硬门槛：包必须完整有效，且满足
 * `identifier "<bundleId>"` 这个跨版本稳定的 DR。发布前必须通过。
 *
 * 不校验 notarization / Gatekeeper（spctl）——ad-hoc 签名必然 `rejected`，
 * 而 Squirrel.Mac 安装更新不依赖 spctl。
 *
 * 用法：node scripts/verify-macos-signature.cjs
 *      PROFER_ELECTRON_OUTPUT_DIR=<outDir> node scripts/verify-macos-signature.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { PRODUCT_APP_NAME, assertMacSignatureContract } = require('./macos-signature.cjs')

if (process.platform !== 'darwin') {
  throw new Error(`verify:mac-signature 仅支持 macOS，当前为 ${process.platform}`)
}

const appRoot = path.resolve(__dirname, '..')
const outputDir = process.env.PROFER_ELECTRON_OUTPUT_DIR
  ? path.resolve(appRoot, process.env.PROFER_ELECTRON_OUTPUT_DIR)
  : path.join(appRoot, 'out')

function findAppBundle() {
  const direct = path.join(outputDir, PRODUCT_APP_NAME)
  if (fs.existsSync(direct)) return direct
  if (!fs.existsSync(outputDir)) return null
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(outputDir, entry.name, PRODUCT_APP_NAME)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const appBundle = findAppBundle()
if (!appBundle) throw new Error(`未找到 macOS Profer.app 解包产物: ${outputDir}`)

console.log(JSON.stringify(assertMacSignatureContract(appBundle), null, 2))
