import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { createRequire } from 'node:module'
import { guideMediaPlugin } from './vite.guideMedia.js'
const localLicense = createRequire(import.meta.url)('./server/src/config/localSpreadjsLicense.cjs')

function localSpreadjsLicense() {
  const id = '\0virtual:spreadjs-license'
  return {
    name: 'local-spreadjs-license',
    resolveId(source) { if (source === 'virtual:spreadjs-license') return id },
    load(source) {
      if (source !== id) return
      const keys = localLicense.readLocalSpreadjsLicense()
      if (!keys.spreadjsLICENSE || !keys.designerLICENSE) {
        throw new Error('前端构建需要 SPREADJS_LICENSE 和 DESIGNER_LICENSE 环境变量')
      }
      // Never ship the server machine key to a browser.
      return `export const spreadjsLicense = ${JSON.stringify(keys.spreadjsLICENSE)};\nexport const designerLicense = ${JSON.stringify(keys.designerLICENSE)};`
    },
  }
}

// 配置阶段读取 .env.<mode>（Vite 默认只在插件运行后加载），让 .env.showcase
// 里配置的 base、端口和授权也能生效；真实 process.env 始终优先，CI 设置不会被覆盖。
const CONFIG_ENV_KEYS = [
  'VITE_BASE_PATH', 'VITE_API_URL', 'VITE_API_PORT', 'VITE_NO_OPEN',
  'SPREADJS_LICENSE', 'DESIGNER_LICENSE', 'SERVER_LICENSE'
]

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, __dirname, '')
  for (const key of CONFIG_ENV_KEYS) {
    if (process.env[key] === undefined && fileEnv[key] !== undefined) process.env[key] = fileEnv[key]
  }
  return {
    base: process.env.VITE_BASE_PATH || '/',
    plugins: [vue(), localSpreadjsLicense(), guideMediaPlugin()],
    cacheDir: '.scratch/vite-cache',
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          landing: resolve(__dirname, 'landing.html')
        }
      }
    },
    resolve: {
      dedupe: ['@grapecity-software/spread-sheets'],
      alias: {
        '@': resolve(__dirname, 'src')
      }
    },
    server: {
      fs: { deny: ['**/.env*', '**/*.{crt,pem}'] },
      port: 5173,
      open: process.env.VITE_NO_OPEN !== '1',
      proxy: {
        [`${process.env.VITE_BASE_PATH || '/'}collaboration`]: {
          ws: true,
          target: `http://localhost:${process.env.VITE_API_PORT || 3001}`,
          changeOrigin: false,
          secure: false
        },
        [`${process.env.VITE_BASE_PATH || '/'}api`]: {
          ws: true,
          target: `http://localhost:${process.env.VITE_API_PORT || 3001}`,
          changeOrigin: true,
          secure: false
        }
      }
    },
    preview: {
      port: 5199,
      proxy: {
        [`${process.env.VITE_BASE_PATH || '/'}collaboration`]: {
          ws: true,
          target: `http://localhost:${process.env.VITE_API_PORT || 3001}`,
          changeOrigin: false,
          secure: false
        },
        [`${process.env.VITE_BASE_PATH || '/'}api`]: {
          ws: true,
          target: `http://localhost:${process.env.VITE_API_PORT || 3001}`,
          changeOrigin: true,
          secure: false
        }
      }
    }
  }
})
