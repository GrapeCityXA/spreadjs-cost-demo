// 部署后自检：确认 sqlite3 原生模块能在目标平台加载。
// Windows 托管环境上不能用 `node -e "..."`（cmd 里引号太脆），所以单独放一个脚本。
const path = require('node:path')

const moduleDir = path.resolve(__dirname, '..', 'node_modules', 'sqlite3')
const binary = path.join(moduleDir, 'build', 'Release', 'node_sqlite3.node')

const sqlite3 = require(moduleDir)
console.log('sqlite3 ok:', typeof sqlite3.Database, '| binary:', binary)
