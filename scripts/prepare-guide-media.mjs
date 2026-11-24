#!/usr/bin/env node
// Copy the separately downloaded recordings into the external media directory.
// The build never imports these files; dev/preview serve them at /media, and
// guide-media is served by Nginx or an external CDN. Nothing is added to dist.
import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const targetDir = path.join(root, 'guide-media')

const files = {
  'full.mp4': '协同填报完整流程.mp4',
  'import.mp4': '模板制作1-直接导入模板.mp4',
  'composition.mp4': '模板制作2-模块化管理.mp4',
  'data.mp4': '模板制作3-对接其他系统数据.mp4',
  'collaboration.mp4': '协同填报.mp4',
  'analysis.mp4': '勾稽分析.mp4'
}

async function size(file) {
  try { return (await stat(file)).size } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

await mkdir(targetDir, { recursive: true })
const missing = []
for (const [target, source] of Object.entries(files)) {
  const sourceFile = path.join(root, source)
  const targetFile = path.join(targetDir, target)
  const sourceSize = await size(sourceFile)
  const targetSize = await size(targetFile)
  if (targetSize && (!sourceSize || targetSize === sourceSize)) {
    console.log(`已存在：guide-media/${target}`)
    continue
  }
  if (!sourceSize) {
    missing.push(source)
    continue
  }
  await copyFile(sourceFile, targetFile)
  console.log(`已复制：${source} -> guide-media/${target}`)
}
if (missing.length) {
  console.error('\n缺少录屏源文件：')
  for (const name of missing) console.error(`  ${name}`)
  console.error('\n先执行 npm run media:download，或从原项目复制同名 MP4 到项目根目录。')
  process.exitCode = 1
} else {
  console.log('\n外部录屏目录已就绪：guide-media/（不会进入前端构建产物）')
}
