// electron-builder afterPack hook: put Sparkle.framework into Contents/Frameworks before signing.
// electron-builder signs after this hook, so nested code is signed inside-out, never with --deep.
// Symlinks (Versions/Current) must survive the copy or codesign reports unsealed contents.
const { cpSync, existsSync, mkdirSync } = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const src = path.join(context.packager.projectDir, 'vendor', 'khsparkle', 'Sparkle.framework')
  const dest = path.join(appPath, 'Contents', 'Frameworks', 'Sparkle.framework')

  if (!existsSync(src)) throw new Error(`after-pack: no Sparkle.framework at ${src}`)
  if (!existsSync(appPath)) throw new Error(`after-pack: no app bundle at ${appPath}`)

  mkdirSync(path.dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true, verbatimSymlinks: true })
  console.log(`after-pack: copied Sparkle.framework -> ${path.relative(context.appOutDir, dest)}`)
}
