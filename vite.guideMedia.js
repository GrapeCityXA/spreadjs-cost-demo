import { createReadStream, statSync } from 'node:fs'
import path from 'node:path'

const MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg' }

// Serve optional local recordings during `vite` and `vite preview`. Production
// builds never include these files; Nginx/CDN serves the same /media paths.
function handler(directory) {
  const root = path.resolve(process.cwd(), directory)
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    let pathname
    try { pathname = decodeURIComponent((req.url || '').split('?')[0]) } catch { return next() }
    const file = path.resolve(root, '.' + pathname)
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.statusCode = 403
      return res.end('Forbidden')
    }
    let stat
    try {
      stat = statSync(file)
      if (!stat.isFile()) throw new Error('not a file')
    } catch {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      return res.end('Media not found. Run npm run media:prepare first.')
    }
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    const range = req.headers.range
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!match) {
        res.statusCode = 416
        res.setHeader('Content-Range', `bytes */${stat.size}`)
        return res.end()
      }
      let start = match[1] ? Number(match[1]) : 0
      let end = match[2] ? Number(match[2]) : stat.size - 1
      if (!match[1] && match[2]) {
        start = Math.max(0, stat.size - Number(match[2]))
        end = stat.size - 1
      }
      if (start > end || start >= stat.size) {
        res.statusCode = 416
        res.setHeader('Content-Range', `bytes */${stat.size}`)
        return res.end()
      }
      end = Math.min(end, stat.size - 1)
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
      res.setHeader('Content-Length', end - start + 1)
      if (req.method === 'HEAD') return res.end()
      createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
      return
    }
    res.setHeader('Content-Length', stat.size)
    if (req.method === 'HEAD') return res.end()
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
  }
}

export function guideMediaPlugin({ dir = 'guide-media' } = {}) {
  return {
    name: 'guide-media',
    configureServer(server) {
      const base = server.config.base.replace(/\/$/, '')
      server.middlewares.use(`${base}/media`, handler(dir))
    },
    configurePreviewServer(server) {
      const base = server.config.base.replace(/\/$/, '')
      server.middlewares.use(`${base}/media`, handler(dir))
    }
  }
}
