/**
 * electron-builder afterPack hook (A1 hardening; S64 P6 made it identity-neutral).
 *
 * 1. Flips Electron fuses on the packed app (BOTH identities):
 *    - RunAsNode OFF                 — ELECTRON_RUN_AS_NODE can't turn the app
 *                                      into a Node REPL that reads the token vault
 *    - NodeOptions env OFF           — no NODE_OPTIONS=--require injection
 *    - Node CLI inspect args OFF     — no --inspect debugger attach
 *    - OnlyLoadAppFromAsar ON        — app code only from the sealed asar
 *    - EmbeddedAsarIntegrityValidation ON — asar hash checked against Info.plist
 *
 * 2. AD-HOC identity only (no CSC_LINK): re-signs the whole bundle ad-hoc WITH
 *    the hardened runtime (`--options runtime`) + entitlements, INSIDE-OUT
 *    (nested Mach-O → helper apps → framework → main app), because
 *    `codesign --deep` does NOT apply entitlements to nested code and the
 *    Renderer helper needs the JIT entitlement on its own signature. Hardened
 *    runtime blocks DYLD_INSERT_LIBRARIES injection and debugger attach on the
 *    running process — which matters once the TokenVault holds decrypted OAuth
 *    tokens. electron-builder itself signs nothing here (`mac.identity: null`
 *    in electron-builder.yml).
 *
 *    A first open on macOS 15/26 goes through System Settings → Privacy &
 *    Security → "Open Anyway" (the right-click → Open bypass is gone).
 *
 * 3. DEVELOPER ID identity (CSC_LINK + CSC_KEY_PASSWORD set, e.g. by
 *    .github/workflows/release.yml with electron-builder.release.yml): this
 *    hook stops after the fuse flip. electron-builder signs every nested
 *    component with the same hardened runtime + entitlements (declared under
 *    `mac:` in electron-builder.yml) and notarizes when `mac.notarize` is on.
 *    A manual pass here would be overwritten — or worse, leave a mixed-identity
 *    bundle that notarization rejects.
 *
 * Fuses left at their defaults on purpose: GrantFileProtocolExtraPrivileges
 * stays ON because the renderer is loaded from file:// (index.ts loadFile);
 * turning it off requires moving the renderer to a custom app:// protocol.
 */
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/**
 * The entitlements come from the builder config (mac.entitlements) so the two
 * identities can never drift apart; the file path is the fallback for a caller
 * that runs this hook outside electron-builder.
 */
const DEFAULT_ENTITLEMENTS = path.join(__dirname, '..', 'build', 'entitlements.mac.plist')

function entitlementsFor(context) {
  const fromConfig = context.packager && context.packager.platformSpecificBuildOptions
    ? context.packager.platformSpecificBuildOptions.entitlements
    : undefined
  if (typeof fromConfig === 'string' && fromConfig.length > 0) {
    return path.isAbsolute(fromConfig) ? fromConfig : path.join(context.packager.projectDir, fromConfig)
  }
  return DEFAULT_ENTITLEMENTS
}

function adHocSign(target, entitlements) {
  execFileSync(
    'codesign',
    ['--force', '--options', 'runtime', '--entitlements', entitlements, '--sign', '-', target],
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

/** Inside-out ad-hoc signing: loose Mach-O → helper apps → framework → main app. */
function adHocSignBundle(appPath, entitlements) {
  const contents = path.join(appPath, 'Contents')
  const frameworks = path.join(contents, 'Frameworks')
  // 1. Loose Mach-O (native addons + dylibs), incl. app.asar.unpacked/*.node.
  for (const f of findMachO(contents)) adHocSign(f, entitlements)
  // 2. Helper apps (RDS Desktop Helper (Renderer|GPU|Plugin).app).
  const entries = fs.existsSync(frameworks) ? fs.readdirSync(frameworks) : []
  for (const name of entries.filter((n) => n.endsWith('.app'))) {
    adHocSign(path.join(frameworks, name), entitlements)
  }
  // 3. Electron Framework bundle.
  for (const name of entries.filter((n) => n.endsWith('.framework'))) {
    adHocSign(path.join(frameworks, name), entitlements)
  }
  // 4. Main app bundle last.
  adHocSign(appPath, entitlements)
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  // Universal builds pack x64 and arm64 into "<out>-<arch>-temp" first (with
  // signing, fuses and asar integrity disabled) and merge them with
  // @electron/universal, which requires both halves' non-binary files to be
  // byte-identical — a per-half signature breaks the merge. The hook is called
  // again on the merged app, so do everything there and nothing here.
  if (/-(x64|arm64)-temp$/.test(context.appOutDir)) {
    console.log(`afterPack: skipping per-arch temp pack ${context.appOutDir}`)
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  await flipFuses(appPath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true
  })

  if (!process.env.CSC_LINK) {
    const entitlements = entitlementsFor(context)
    adHocSignBundle(appPath, entitlements)
    console.log(`afterPack: fuses flipped + hardened-runtime ad-hoc signed ${appPath}`)
    return
  }

  console.log(`afterPack: fuses flipped on ${appPath}; CSC_LINK set → electron-builder signs (and notarizes if configured)`)
}
