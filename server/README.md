# 成本报表后端服务

基于 Node.js + Express + SQLite 的后端服务。

## 安装依赖

\`\`\`bash
cd server
npm install
\`\`\`

普通模式的后端报表生成和函数试炼场会启动无头浏览器渲染 SpreadJS；首次部署后还需安装一次 Playwright Chromium。展示模式的报表改为浏览器内生成后上传后端保存，不需要服务端 Chromium：

\`\`\`bash
cd server
npx playwright install chromium
\`\`\`

## 启动服务

开发模式（自动重启）：
\`\`\`bash
npm run dev
\`\`\`

生产模式：
\`\`\`bash
npm start
\`\`\`

服务默认运行在 `http://localhost:3000`

## 默认用户

首次运行后，访问以下接口初始化默认用户：

\`\`\`bash
POST http://localhost:3000/api/auth/init-default-users
\`\`\`

默认用户列表：
- 管理员：admin / admin123（全部权限）
- 财务人员：finance / finance123（查看+报表权限）
- 审核人员：reviewer / reviewer123（查看+审核权限）

## 数据库

SQLite 数据库文件位于 `data/cost_report.db`

## 数据结构

### users（用户表）
- id: 用户ID
- username: 用户名
- password: 密码（加密）
- name: 姓名
- permissions: 权限数组（JSON字符串）

### templates（模板表）
- id: 模板ID
- name: 模板名称
- description: 描述
- factory: 工厂
- status: 状态（draft/published）
- created_by: 创建者ID
- template_file_path: 模板文件路径
- datasource_type: 数据源类型
- datasource_id: 数据源ID

### datasources（数据源表）
- id: 数据源ID
- name: 名称
- type: 类型（tableData/sheetData）
- data: 数据（JSON字符串）
- created_by: 创建者ID

### reports（报表表）
- id: 报表ID
- title: 标题
- period: 期间
- status: 状态（draft/reviewing/completed/rejected）
- template_id: 模板ID
- template_file_path: 报表模板文件路径
- datasource_id: 数据源ID
- created_by: 创建者ID

### audit_logs（审核日志表）
- id: 日志ID
- report_id: 报表ID
- action: 操作（submit/approve/reject）
- old_status: 旧状态
- new_status: 新状态
- created_by: 操作者ID
- comment: 备注
