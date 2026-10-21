/**
 * App icon from build/icon.svg → build/icon.png (1024²) → build/icon.icns.
 *
 *   npm run icon            (= electron scripts/make-icon.cjs)
 *
 * Rasterises with Electron's own Chromium so the result matches what the
 * renderer draws and nothing beyond the dev dependencies is needed (no rsvg,
 * no ImageMagick; QuickLook's `qlmanage` renders SVG inconsistently). The
 * iconset sizes come from `sips` and the .icns from `iconutil`, both macOS
 * built-ins. S68: written when the accent moved from amber to LD blue — the
 * S64 icon had been produced by hand with no record of how.
 */
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { Buffer } = require('node:buffer')
const { setTimeout } = require('node:timers')

const SIZE = 1024
const buildDir = resolve(__dirname, '..', 'build')
const svgPath = join(buildDir, 'icon.svg')
const pngPath = join(buildDir, 'icon.png')
const icnsPath = join(buildDir, 'icon.icns')

async function main() {
  const svg = readFileSync(svgPath, 'utf8')
  const html =
    `<!doctype html><html><body style="margin:0;background:transparent">` +
    `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" ` +
    `width="${SIZE}" height="${SIZE}" style="display:block"></body></html>`

  const win = new BrowserWindow({
    show: false,
    width: SIZE,
    height: SIZE,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true }
  })
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'))
  await new Promise((r) => setTimeout(r, 150)) // let the <img> decode
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  win.destroy()
  if (image.getSize().width !== SIZE) throw new Error(`captured ${image.getSize().width}px, expected ${SIZE}`)
  writeFileSync(pngPath, image.toPNG())

  // iconset: Apple's required names/sizes, then iconutil packs the .icns.
  const iconset = mkdtempSync(join(tmpdir(), 'rds-iconset-')) + '.iconset'
  execFileSync('mkdir', ['-p', iconset])
  for (const [name, px] of [
    ['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64],
    ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512],
    ['icon_512x512', 512], ['icon_512x512@2x', 1024]
  ]) {
    execFileSync('sips', ['-z', String(px), String(px), pngPath, '--out', join(iconset, `${name}.png`)], { stdio: 'ignore' })
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icnsPath])
  rmSync(iconset, { recursive: true, force: true })
  console.log(`✓ ${pngPath} (${SIZE}²) and ${icnsPath} written from icon.svg`)
}

app.whenReady().then(main).then(() => app.exit(0)).catch((e) => { console.error(e); app.exit(1) })
