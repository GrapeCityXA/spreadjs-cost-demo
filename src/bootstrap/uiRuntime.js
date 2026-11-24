import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import '../styles/fonts.css'
import '../styles/brand.css'
import AppDataTable from '../components/AppDataTable'

export function install(app) {
  for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
    app.component(key, component)
  }
  app.use(ElementPlus, { locale: zhCn })
  app.component('AppDataTable', AppDataTable)
}
