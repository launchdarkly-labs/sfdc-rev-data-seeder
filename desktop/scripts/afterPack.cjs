/**
 * electron-builder afterPack hook (A1 hardening).
 *
 * 1. Flips Electron fuses on the packed app:
 *    - RunAsNode OFF                 — ELECTRON_RUN_AS_NODE can't turn the app
 *                                      into a Node REPL that reads the token vault
 *    - NodeOptions env OFF           — no NODE_OPTIONS=--require injection
 *    - Node CLI inspect args OFF     — no --inspect debugger attach
 *    - OnlyLoadAppFromAsar ON        — app code only from the sealed asar
 *    - EmbeddedAsarIntegrityValidation ON — asar hash checked against Info.plist
 *
 * 2. Re-signs the whole bundle ad-hoc WITH the hardened runtime
 *    (`--options runtime`) + entitlements, INSIDE-OUT (nested Mach-O → helper
 *    apps → framework → main app), because `codesign --deep` does NOT apply
 *    entitlements to nested code and the Renderer helper needs the JIT
 *    entitlement on its own signature. Hardened runtime blocks
 *    DYLD_INSERT_LIBRARIES injection and debugger attach on the running process
 *    — which matters once A3's TokenVault holds decrypted OAuth tokens.
 *
 * Internal-tool decision 2026-07-23: ad-hoc identity, no Developer ID /
 * notarization; other Macs use right-click → Open once. Hardened runtime is
 * compatible with ad-hoc signing and is applied regardless.
 */
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ENTITLEMENTS = path.join(__dirname, '..', 'build', 'entitlements.mac.plist')

function sign(target) {
  execFileSync(
    'codesign',
    ['--force', '--options', 'runtime', '--entitlements', ENTITLEMENTS, '--sign', '-', target],
    { stdio: 'inherit' }
  )
}

/** Recursively collect Mach-O leaf files (.dylib/.node) under a dir. */
function findMachO(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) findMachO(full, out)
    else if (/\.(dylib|node)$/.test(entry.name)) out.push(full)
  }
  return out
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  const contents = path.join(appPath, 'Contents')
  const frameworks = path.join(contents, 'Frameworks')

  await flipFuses(appPath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true
  })

  // Inside-out signing order.
  // 1. Loose Mach-O (native addons + dylibs), incl. app.asar.unpacked/*.node.
  for (const f of findMachO(contents)) sign(f)
  // 2. Helper apps (RDS Desktop Helper (Renderer|GPU|Plugin).app).
  const entries = fs.existsSync(frameworks) ? fs.readdirSync(frameworks) : []
  for (const name of entries.filter((n) => n.endsWith('.app'))) {
    sign(path.join(frameworks, name))
  }
  // 3. Electron Framework bundle.
  for (const name of entries.filter((n) => n.endsWith('.framework'))) {
    sign(path.join(frameworks, name))
  }
  // 4. Main app bundle last.
  sign(appPath)

  console.log(`afterPack: fuses flipped + hardened-runtime ad-hoc signed ${appPath}`)
}
