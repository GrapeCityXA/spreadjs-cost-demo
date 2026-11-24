import { createReadStream } from 'node:fs'
import { readFile, stat, rename, rm, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(new URL('../docs/demo/media-manifest.json', import.meta.url), 'utf8'))
async function checksum(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}
for (const item of manifest.files) {
  if (path.basename(item.name) !== item.name || !item.name.endsWith('.mp4')) throw new Error('Invalid media filename')
  const destination = path.join(root, item.name)
  const existing = await stat(destination).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (existing) {
    if (existing.size !== item.bytes || await checksum(destination) !== item.sha256) {
      throw new Error(`本地录屏与清单不一致，请人工核对（不会覆盖）：${item.name}`)
    }
    console.log(`已校验：${item.name}`)
    continue
  }
  const temporary = `${destination}.download`
  let temporaryFile
  try {
    temporaryFile = await open(temporary, 'wx')
    console.log(`正在下载：${item.name}`)
    const response = await fetch(item.url, { signal: AbortSignal.timeout(600_000) })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    await pipeline(Readable.fromWeb(response.body), temporaryFile.createWriteStream())
    if ((await stat(temporary)).size !== item.bytes || await checksum(temporary) !== item.sha256) {
      throw new Error(`录屏校验失败：${item.name}`)
    }
    await rename(temporary, destination)
    console.log(`已下载并校验：${item.name}`)
  } catch (error) {
    // Never remove a pre-existing temporary file from another run.
    if (temporaryFile) {
      await temporaryFile.close()
      await rm(temporary, { force: true })
    }
    throw error
  }
}
