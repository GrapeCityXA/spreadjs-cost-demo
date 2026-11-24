import { createApp } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index'
import 'element-plus/theme-chalk/base.css'
import 'element-plus/theme-chalk/el-message.css'
import './styles/fonts.css'
import App from './App.vue'
import router from './router'
import { createRouteRuntimeGuard } from './utils/routeRuntime'
import { loadRuntimeConfig } from './utils/runtimeConfig'

const app = createApp(App)
loadRuntimeConfig()

// The router's authorization guard runs first. Initialize business runtimes
// before lazy route components are imported or any workbook is created.
router.beforeEach(createRouteRuntimeGuard({
  loadUi: () => import('./bootstrap/uiRuntime').then(runtime => runtime.install(app)),
  loadWorkbook: () => import('./bootstrap/workbookRuntime'),
  onError: error => {
    console.error('页面资源加载失败', error)
    ElMessage.error('页面资源加载失败，请检查网络后刷新重试')
  },
}))

app.use(router)
app.mount('#app')
