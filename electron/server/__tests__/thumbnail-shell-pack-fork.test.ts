import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import JSZip from 'jszip'
import sharp from 'sharp'
import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { forkLegacyContentForEdit, readUserFork } from '../content-packs/user-forks.js'
import { loadTemplate, resolveTemplateShellImage } from '../services/thumbnail-template-loader.js'
import { useTempDataDir } from './_helpers.js'
import type { ThumbnailTemplate } from '../models/types.js'

const packId = 'com.storystudio.shell-fork-proof'
const itemId = `${packId}.layout`
const keyId = 'com.storystudio.key.shell-fork-proof'
const keys = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{keyId,publisherId:'com.storystudio',publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}).toString()}])
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const picture = (background: string) => sharp({create:{width:64,height:36,channels:3,background}}).png().toBuffer()

async function archive(version: string, note: string, image: Buffer) {
  const document = {
    kind:'thumbnail-recipe',schema_version:1,id:itemId,name:'Signed layout',description:'Isolated fork proof',
    layout:'hero',category:'proof',tags:['layout'],aspect_ratio:'16:9',title_mode:'ai',
    composition_guidance:'Clear layout zones.',required_elements:['clear focal zone'],avoid_elements:['clutter'],
    headline_mode:'short-hook',default_text_style:'none',default_font_style:'serif',default_text_position:'top',
    headline_formats:['short hook'],visual_style_guidance:'Neutral.',preview_assets:['assets/layout.png'],
    compatible_formula_ids:['com.storystudio.formula.proof'],shell_image:'assets/layout.png',layout_note:note,
  }
  const content = Buffer.from(JSON.stringify(document))
  const manifest = Buffer.from(JSON.stringify({
    pack_format:1,pack_id:packId,publisher_id:'com.storystudio',key_id:keyId,version,min_app_version:'1.0.0',lifecycle:'active',
    entitlement:{sku:`${packId}.sku`,family:`${packId}.family`},bundles:[],
    items:[{id:itemId,kind:'thumbnail-recipe',schema_version:1,path:'content/layout.json'}],
    files:[{path:'content/layout.json',sha256:hash(content),bytes:content.length,mime:'application/json'},
      {path:'assets/layout.png',sha256:hash(image),bytes:image.length,mime:'image/png'}],
  }))
  const zip = new JSZip()
  zip.file('manifest.json',manifest,{createFolders:false})
  zip.file('signature.ed25519',sign(null,manifest,keys.privateKey),{createFolders:false})
  zip.file('content/layout.json',content,{createFolders:false})
  zip.file('assets/layout.png',image,{createFolders:false})
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE',platform:'UNIX'})
}

test('a signed Shell fork keeps its own verified picture and note after the source pack updates', {timeout:15000}, async () => {
  const temp = await useTempDataDir()
  try {
    const options = {paths:getContentPackRuntimePaths(),policy,recoveryRoot:path.join(temp.dir,'recovery'),appVersion:'1.4.382'}
    await fs.mkdir(options.recoveryRoot,{recursive:true})
    await installContentPack({archiveBytes:await archive('1.0.0','Original note: subject left.',await picture('#223344')),source:'local-import'},options)
    const signed = await loadTemplate(itemId,options)
    assert.ok(signed)
    const originalPath = await resolveTemplateShellImage(signed,options)
    assert.ok(originalPath)
    const originalBytes = await fs.readFile(originalPath)
    const fork = await forkLegacyContentForEdit({kind:'thumbnail-recipe',legacyId:itemId},options)
    const record = await readUserFork(fork.fork_id,options)
    assert.ok(record)
    const document = record.document as ThumbnailTemplate
    assert.match(document.shellImage || '', /^shell\//)
    assert.equal(document.layoutNote,'Original note: subject left.')
    const forkImage = await resolveTemplateShellImage(document,options)
    assert.ok(forkImage)
    assert.notEqual(forkImage,originalPath)
    assert.deepEqual(await fs.readFile(forkImage),originalBytes)
    const secondFork = await forkLegacyContentForEdit({kind:'thumbnail-recipe',legacyId:itemId},options)
    const secondTemplate = await loadTemplate(secondFork.fork_id,options)
    assert.ok(secondTemplate)
    assert.equal(await resolveTemplateShellImage(secondTemplate,options),forkImage)
    await installContentPack({archiveBytes:await archive('1.0.1','Changed note: subject right.',await picture('#665544')),source:'local-import'},options)
    const unchanged = await loadTemplate(fork.fork_id,options)
    assert.ok(unchanged)
    assert.equal(unchanged.layoutNote,'Original note: subject left.')
    assert.deepEqual(await fs.readFile((await resolveTemplateShellImage(unchanged,options))!),originalBytes)
    assert.deepEqual(await fs.readFile(originalPath),originalBytes)
    assert.equal((await loadTemplate(itemId,options))?.layoutNote,'Changed note: subject right.')
  } finally {
    await temp.cleanup()
  }
})
