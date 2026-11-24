# 财务内部报表系统演示

## 从仓库启动（先读）

建议使用 Node.js 22，包管理器为 npm。仓库不包含商业许可证、环境密钥、运行数据库、备份和录屏原文件。

1. 执行 `npm ci` 和 `npm --prefix server ci` 安装锁定版本依赖。
2. 授权只从环境变量读取：前端构建设置 `SPREADJS_LICENSE`、`DESIGNER_LICENSE`，后端运行时设置 `SERVER_LICENSE`。本地可写入不提交的 `.env.showcase.local` 和 `server/.env`；仓库不再提供 `LICENSE.js` 或示例文件。
3. 执行 `npm run media:download` 获取 Guide 所需的 8 段录屏，再执行 `npm run media:prepare` 复制为 `guide-media/*.mp4`。录屏不进入前端构建；开发/预览时由 Vite 的 `/media` 中间件提供，生产由 Nginx/CDN 提供。也可以从原项目复制同名 MP4 到根目录。录屏源依赖演示站点可用，迁移媒体时需同步更新清单。
4. 执行 `npm run start:all` 启动前后端；或执行 `npm run build` 生成前端产物。数据库在首次启动时初始化，不包含线上业务记录。

生产环境应单独设置 `JWT_SECRET`、存储路径和授权，参考 `server/deploy/demo-reset.env.example` 与 `docs/demo/每日演示数据重置.md`。服务器规格、域名/HTTPS 和授权申请清单见 [服务器申请清单](docs/demo/服务器申请清单.md)。构建目录含前端运行所需的许可证，不应提交到 Git。缺少原始季度考核 Excel 样例时，完整接口验收会在该样例校验处中断。

本次 Gitee 初始提交是当前代码的干净快照，不包含本地旧提交历史（旧版本曾内嵌许可证）。后续应基于 Gitee 分支提交，避免合并或推送含旧许可证的本地历史。

## 项目导览（Guide）

直接访问 `/guide` 即可查看，无需登录；旧地址 `/portal/guide` 和门户侧栏「项目导览」会进入同一公开页面。页面面向客户演示，按模板设计、数据绑定、规则配置、任务发布、协同填报、校验提交、审核定稿、报表输出八步纵向展示 SpreadJS 的价值，并提供项目分层架构、8 段录屏和官方能力文档。点击「登录体验」进入业务系统，业务页面仍校验登录与角色权限。

部署使用浏览器 History 路由，Web 服务需将 `/guide` 等前端页面路径回退到 `index.html`（例如 Nginx 的前端 location 配置 `try_files $uri $uri/ /index.html;`），并保留独立的 API / WebSocket 转发配置，确保直接打开和刷新地址均可用。

内容与录屏索引维护在 `src/content/guide.js`。8 段 MP4 作为外部媒体存放在 `guide-media/` 或独立 CDN，不参与 Vite 构建；页面按需加载视频。生产环境需把 `/media/` 指向实际媒体目录，或通过后端公开配置 `server/config/showcase.json` 的 `guideMediaBaseUrl` 指向 CDN。业务功能入口沿用原权限校验，Guide 不执行数据库重置。页面设计与内容依据见 `docs/design/guide.md`。

## 项目概述

这是一个基于 Vue 3 + SpreadJS + Express + SQLite 构建的企业级财务内部报表管理系统，专为上市企业设计。系统实现了报表模板搭建、月度报表管理、审核流程、数据源绑定、公式计算和勾稽分析等完整功能。

## 核心功能

### 1. 用户权限管理

- **三级权限体系**：
  - **管理员（admin）**：全部权限（template, edit, formula, comment, review）
  - **财务人员（finance）**：报表权限（report, comment, view）
  - **查看用户（viewer）**：查看权限（view）
- **快捷登录**：预置测试账号，一键登录
- **权限控制**：基于路由守卫和权限验证

### 2. 报表模板搭建

- **可视化设计器**：集成 SpreadJS Designer，提供类 Excel 的编辑体验
- **数模分离**：模板结构与数据源分离存储
- **数据绑定**：
  - 工作表级别数据绑定（setDataSource）
  - 表格级别列绑定（bindColumn）
  - 单元格绑定（CellBindingSource）
- **自定义公式**：支持 QUERY 自定义异步函数，实现跨报表数据查询
- **模板版本管理**：支持草稿和已发布状态
- **变更同步机制**：记录模板变更命令，可选择同步到子报表

### 3. 月度报表管理

- **基于模板创建**：选择已发布模板创建月度报表
- **数据编辑**：在模板基础上填入实际业务数据
- **状态流转**：草稿 → 审核中 → 已完成/已驳回
- **公式自动计算**：支持复杂公式计算和级联数据更新

### 4. 报表审核流程

- **审核列表**：查看所有待审核报表
- **审核详情**：在 SpreadJS 中查看报表内容
- **审核操作**：
  - 通过：将报表状态改为"已完成"
  - 驳回：将报表状态改为"已驳回"，并记录驳回原因
- **审核历史**：记录完整的审核操作历史

### 5. 报表中心（查看）

- **模板列表**：展示所有已发布的报表模板
- **多期数据查看**：选择不同月份查看已完成报表数据
- **只读保护**：工作表保护模式，禁止编辑
- **勾稽分析**：
  - 追踪引用单元格（Precedents）
  - 追踪从属单元格（Dependents）
  - 树形图展示依赖关系（使用 ECharts）
  - 点击节点快速定位到对应单元格

### 6. 批注协作

- **用户管理器**：集成 SpreadJS UserManager
- **@提及功能**：支持在批注中 @其他用户
- **批注同步**：批注数据随模板/报表一起保存

### 7. 系统管理

- **数据库统计**：查看用户、模板、报表、数据源等数量
- **数据管理**：
  - 清空报表数据（保留用户和模板）
  - 重置数据库（完全重置）
- **快速操作**：初始化默认用户、跳转功能页面

## 技术架构

### 前端技术栈

- **Vue 3**：渐进式 JavaScript 框架
- **Vue Router 4**：路由管理
- **Element Plus**：UI 组件库
- **SpreadJS 19.1.0**：
  - spread-sheets：核心表格引擎
  - spread-sheets-designer：可视化设计器
  - spread-sheets-io：导入/导出功能
  - spread-sheets-tablesheet：表格工作表
  - spread-sheets-pivot-addon：数据透视表
  - spread-sheets-charts：图表功能
  - spread-sheets-print：打印功能
  - spread-sheets-pdf：PDF 导出
  - spread-sheets-shapes：形状功能
  - spread-sheets-slicers：切片器
  - spread-sheets-barcode：条形码
  - spread-sheets-resources-zh：中文资源
  - spread-sheets-designer-resources-cn：设计器中文资源
  - spread-sheets-languagepackages：语言包
  - spread-sheets-formula-panel：公式面板
  - spread-sheets-reportsheet-addon：报表工作表
- **ECharts 6.1.0**：数据可视化（用于勾稽分析树形图）
- **Vite 5.0**：构建工具

### 后端技术栈

- **Express 4.18**：Web 应用框架
- **SQLite 3**：嵌入式数据库
- **JWT**：身份认证
- **bcryptjs**：密码加密
- **multer**：文件上传
- **cors**：跨域支持

## 项目结构

```
成本指标demo/
├── src/                          # 前端源码
│   ├── api/                      # API 接口封装
│   │   └── index.js             # 统一导出 authApi, templateApi, reportApi, databaseApi
│   ├── components/               # 公共组件
│   │   ├── Sidebar.vue          # 侧边导航栏
│   │   └── TopHeader.vue        # 顶部导航栏
│   ├── router/                   # 路由配置
│   │   └── index.js             # 路由定义和权限守卫
│   ├── template/                 # SpreadJS 模板、绑定与权限模块
│   ├── utils/                    # 工具函数
│   │   └── userManager.js       # SpreadJS 用户管理器初始化
│   ├── views/                    # 页面组件
│   │   ├── Login.vue            # 登录页
│   │   ├── Portal.vue           # 门户布局页
│   │   ├── Home.vue             # 门户首页
│   │   ├── Template.vue         # 模板列表页
│   │   ├── TemplateEdit.vue     # 模板编辑页（核心功能）
│   │   ├── MonthlyReports.vue   # 月度报表管理页
│   │   ├── MonthlyReportEdit.vue # 月度报表编辑页
│   │   ├── ReportReview.vue     # 报表审核页
│   │   ├── ReportViewer.vue     # 报表查看页（含勾稽分析）
│   │   ├── ReportList.vue       # 报表中心页
│   │   ├── SystemSettings.vue   # 系统设置页
│   │   └── PlaceholderPage.vue   # 占位页面
│   ├── App.vue                   # 根组件
│   └── main.js                   # 入口文件（含 QUERY 自定义函数注册）
├── server/                       # 后端源码
│   ├── src/
│   │   ├── app.js               # Express 应用入口
│   │   ├── config/
│   │   │   └── database.js      # 数据库连接和表初始化
│   │   ├── controllers/         # 业务逻辑控制器
│   │   │   ├── authController.js       # 认证控制器
│   │   │   ├── templateController.js   # 模板控制器
│   │   │   ├── reportController.js     # 报表控制器
│   │   │   ├── databaseController.js   # 数据库管理控制器
│   │   │   └── dataQueryController.js  # 数据查询控制器
│   │   ├── middleware/
│   │   │   └── auth.js         # JWT 认证中间件
│   │   └── routes/              # 路由定义
│   │       ├── authRoutes.js           # 认证路由
│   │       ├── templateRoutes.js       # 模板路由
│   │       ├── reportRoutes.js         # 报表路由
│   │       ├── databaseRoutes.js       # 数据库管理路由
│   │       └── dataQueryRoutes.js      # 数据查询路由
│   ├── data/                     # SQLite 数据库文件目录
│   ├── templates/                # 模板文件存储目录
│   └── package.json             # 后端依赖配置
├── index.html                    # HTML 入口
├── vite.config.js               # Vite 配置
├── package.json                 # 前端依赖配置
└── README.md                    # 项目说明文档
```

## 数据库设计

### 表结构

以下列出仍保留的早期表。当前数据库结构以 [SQLite Schema Contract](docs/database-schema-v1.md) 和 `server/src/config/database.js` 中的迁移定义为准。

1. **users（用户表）**
   - id、username、password、name、permissions、created_at、updated_at

2. **templates（模板表）**
   - id、name、description、factory、status、created_by、template_file_path、datasource_type、datasource_id、created_at、updated_at

3. **datasources（数据源表）**
   - id、name、type、data、created_by、created_at、updated_at

4. **reports（报表表）**
   - id、title、period、status、template_id、template_file_path、datasource_id、created_by、created_at、updated_at

5. **audit_logs（审核记录表）**
   - id、report_id、action、old_status、new_status、created_by、created_at、comment

迁移 24 已移除无业务读写入口的 `template_changes`、`template_syncs`、`indicator_scores`、`score_adjustments`。升级已有数据库前，应完成数据库备份及上述表的历史记录导出。

## 安装与运行

### 前置要求

- Node.js 10.0.0+
- npm 或 yarn

### 安装依赖

```bash
# 安装前端依赖
npm install

# 安装后端依赖
cd server
npm install
cd ..
```

### 运行项目

### 首次启动自动生成演示内容

仓库不提交 `server/data`，但后端启动时会自动准备展示基线：

- `server/config/seed/showcase-content.json`：字段、组件、模板、报表模板、规则和报表类型；
- `server/scripts/seed-demo-users.cjs`：演示账号和组织；
- `server/config/showcase.json` 的 `seedDemoContent` 默认为 `true`。

数据库内容为空时，启动后端会写入这些默认数据；已有内容时只补充缺失的演示账号，不覆盖已有字段、模板或报表模板。需要关闭自动初始化时：

```json
{ "seedDemoContent": false }
```

首次启动仍会自动创建数据库表结构，但 `server/data` 里的运行时数据目录应放在持久磁盘上。

默认使用已迁入项目的演示数据：业务库 `server/data/demo/business.db`、协同库 `server/data/demo/collaboration.db`，模板、报表文件和备份分别位于同目录的 `templates/`、`artifacts/`、`backups/`。原 `server/data/cost_report.db` 已备份退役。`npm run server`、`npm run start:all`、后端 `npm start` 和维护工具均使用这套默认路径。

如终端曾设置 `COST_REPORT_DB_PATH`、`COST_REPORT_COLLAB_DB_PATH`、`COST_REPORT_TEMPLATE_DIR`、`COST_REPORT_ARTIFACT_DIR`、`COST_REPORT_BACKUP_DIR`，请清除这些旧值后再默认启动；这些变量仍可为隔离测试覆盖路径。备份时须同时保存两库和配套文件，不能只复制业务库。

```bash
# 方式一：同时启动前端和后端
npm run start:all

# 方式二：分别启动
# 终端1：启动前端（默认端口 5173）
npm run dev

# 终端2：启动后端（默认端口 3000）
npm run server
```

### 本地打包验证（展示模式）

开发模式验证后，再按接近生产的方式跑一遍构建产物：

```bash
# 1. 安装锁定依赖（首次或依赖变化时）
npm ci
npm --prefix server ci

# 2. 确认 SPREADJS_LICENSE / DESIGNER_LICENSE 已设置（本地可放在 .env.showcase.local）
#    准备外部录屏目录（不进入构建产物）
npm run media:prepare

# 3. 构建展示模式前端
npm run build:showcase

# 4. 启动后端（本地 server/.env 会把端口设为 3001）
cd server
npm start

# 5. 另开终端，在项目根目录预览构建产物
#    5199 端口同时代理 /api、/collaboration 到 3001，并提供 /media 录屏
npm run preview:showcase
```

浏览器访问 `http://localhost:5199` 可验证页面、接口和视频；涉及协同填报时仍应通过 `http://test.com`（Caddy → 5199）访问，因为客户端授权按域名校验。预览前请先停止 `npm run dev:showcase`，两者都占用 5199。

生产构建会把 `SPREADJS_LICENSE` 和 `DESIGNER_LICENSE` 注入前端产物，所以必须用正式域名对应的授权构建；授权只通过环境变量传入，不要把真实授权写进 `.env.showcase` 或提交到 Git。

### 部署到域名子路径

如果站点地址是 `https://demo.grapecity.com.cn/spreadjs/cost-report/`，构建时设置：

```bash
VITE_BASE_PATH=/spreadjs/cost-report/ npm run build:showcase
```

Windows PowerShell：

```powershell
$env:VITE_BASE_PATH = "/spreadjs/cost-report/"
npm run build:showcase
```

`VITE_BASE_PATH` 必须以 `/` 开头和结尾。代码会自动使用 `BASE_URL` 生成路由和默认的 `${BASE_URL}api` 接口地址。

Nginx 需要把子路径的静态资源、`api` 和 WebSocket 转发分别配置，示例见 [子路径部署](docs/demo/子路径部署.md)。构建产物仍然是 `dist/`。

### 运行时视频地址和内置清理

视频地址是公开配置，直接提交在仓库：

```text
server/config/showcase.json
```

```json
{
  "guideMediaBaseUrl": "https://media.example.com/"
}
```

前端启动时从 `/api/app-config` 读取，不需要在构建时注入。修改后刷新页面即可。

内置清理的默认值也在 `server/config/showcase.json`：

```json
{
  "showcaseReset": {
    "enabled": true,
    "idleHours": 2,
    "backupRetain": 7
  }
}
```

后端启动和存储路径仍需环境变量。模板见 `server/config/env.example`，复制为 `server/.env`（本地）或合并到 systemd 的 `EnvironmentFile`（生产）：

```bash
PORT=3000
HOST=0.0.0.0
JWT_SECRET=...

COST_REPORT_DB_PATH=...
COST_REPORT_COLLAB_DB_PATH=...
COST_REPORT_TEMPLATE_DIR=...
COST_REPORT_ARTIFACT_DIR=...
COST_REPORT_BACKUP_DIR=...
COST_REPORT_RESET_BACKUP_DIR=...

```

`JWT_SECRET` 不要提交 Git。内置清理默认开启，在**连续 2 小时没有 HTTP/API 请求、也没有打开的协同连接**后执行一次；重新开始下一次空闲计时。立即清理接口不需要鉴权：

```bash
curl -X POST  https://demo.grapecity.com.cn/spreadjs/cost-report/api/system-operations/showcase-reset
```

## 演示环境定期清理

`server/scripts/reset-demo.cjs` 是离线演示维护脚本，不通过业务接口删除正式数据。默认仅预览；不会自动启动定时任务。

```bash
# 预览每张表清理前后的数量、文件范围和实际存储路径，不写数据库
npm run demo:reset

# 停止所有连接这两个库的后端实例/工作进程后，才执行
npm run demo:reset -- --apply --confirm-offline --retain 7

# 验证清理脚本（使用自动创建的隔离测试库）
npm run test:demo-reset
```

### 展示模式每日清理

官网展示部署使用 `--showcase` 方案（systemd 定时任务已默认带上该参数）：

```bash
# 预览展示模式会保留和清理的内容
npm run demo:reset -- --showcase

# 如果确实要连报表工作室模板一起清空
npm run demo:reset -- --showcase --apply --confirm-offline --clear-report-templates
```

保留：9 个演示账号、演示组织与角色授权、业务字段目录、组件库、业务模板、**报表工作室模板**、报表类型和规则。清理：周期包、任务、业务修订与数值、审核/定稿记录、协同房间、通知、审计日志、报表生成记录及 `templates/`、`artifacts/`、`backups/` 下的体验文件。这样每天访客从干净的任务列表开始，但模板和报表配置不用重建。

普通模式仍使用默认方案，保留内容如下。

保留内容：6 个固定演示账号（密码不重置）、其当前有效角色授权及必需的组织/上下级关系；`test_header` 测试表头、`test_footer` 测试表尾各自最新已发布版本；4 个 `BROWSER_CURRENT/PRIOR_REVENUE/PROFIT` 已批准字段及当前正式版本；5 条 `DEFAULT_*` 内置预警和 `CONTROL_LOSS_FORMULA` 的系统发布版本。保留数据库迁移记录，通知消费游标重置为 0。只有被保留账号实际使用的自定义角色才会保留。

同时保留 3 种基础报表类型：`BROWSER_MONTHLY_PERIOD`、`BROWSER_HISTORICAL_IMPORT`、`BROWSER_QUARTERLY_ACCEPTANCE`。它们为历史导入、周期配置等页面提供类型选项，不能按体验记录删除；缺失或停用时脚本会中止，要求先恢复配置。“手工体验月报 A”（`EXPERIENCE_MONTHLY_A`）已移出保留名单，会随其他体验类型清理。

清理内容：其他账号和组织、体验中新建的报表类型、表体及完整模板、旧组件版本、字段审批草稿及历史版本、手工规则（包括 `BROWSER_FIELD_REQUIRED`、`MYFUNCTION`）、周期配置包与人员分工、填报任务与数值、审核/定稿/评分、协同历史、报表工作室模板及生成任务、通知/审计/导出/检查点记录，以及配置指向的模板、成果、旧检查点三个目录下的文件。字段版本的草稿来源、组件/规则版本的前序引用会解除。清理不会重置自增 ID，也不会改账号密码。

备份默认放在业务库目录旁的 `demo-reset-backups/`（当前为 `server/data/demo-reset-backups/`），可通过 `COST_REPORT_RESET_BACKUP_DIR` 指定独立目录。其余路径沿用 `server/src/config/storage.js` 和 `COST_REPORT_*` 环境变量。每次执行先备份两库及三个文件目录，并核验哈希，再清理；默认只保留最近 7 次成功备份。失败或未完成备份不会自动删除，需要排查后人工处理。旧库退役时的归档在本脚本范围之外。

`--confirm-offline` 是操作者对“服务已停”的确认，并不会自动停止服务。两个 SQLite 库须处于 DELETE 日志模式；脚本通过双库独占事务执行，遇到未知表、版本变化、缺少保留对象、链接目录、路径重叠或并发清理会拒绝执行。保留对象引用了将被删除的数据时，外键检查失败并回滚。若在数据库提交后的文件阶段失败，脚本返回非零退出码，保留完整备份，请保持后端停止，排查后重试。只读预览期间若有人修改数据，最终执行时会重新计算范围。

恢复时保持全部后端停止，按备份 `manifest.json` 中的原路径整套恢复 `business.db`、`collaboration.db`、`templates/`、`artifacts/`、`checkpoints/`，先核验文件哈希，不能只恢复其中一个库。该备份格式与检查点 `.tar.gz` 不同，不能传给 `restore-checkpoint.cjs`。清理进程若被强制终止可能留下 `.reset.lock`，确认进程已退出并核对备份状态后才能移除锁。

Linux/systemd 定时重置现已提供项目安装器：每天 **北京时间 02:00** 检查后端状态和清理条件，停后端、按展示模式备份清理，成功后启动。预检失败不停止服务；停服后的任何失败都不会自动启动后端。错过凌晨执行不在白天补跑。安装器仅在实际 Linux/systemd 服务器上启用任务，不给 Windows 开发环境添加清库任务。

先将 `server/deploy/demo-reset.env.example` 中的设置合并到后端正在使用的环境文件，填写实际绝对路径，并明确设置 `COST_REPORT_DEMO_RESET_ENABLED=true`。环境文件必须存在、由 root 持有且不允许组或其他用户写入；不能另有内联存储路径覆盖。后端须由单个 systemd 服务管理所有进程，使用非 root 账号及 `KillMode=control-group`。完整步骤见 [每日演示数据重置部署说明](docs/demo/每日演示数据重置.md)。

```bash
# 预览配置，不安装、不停服、不重置（路径和账号换成实际部署值）
npm run demo:timer -- --app-dir /srv/cost-report --user costreport --service cost-report.service --environment-file /etc/cost-report.env

# 在实际部署目录运行：只读预检通过后安装并启用；不会立即执行重置
sudo /usr/bin/node server/scripts/install-demo-reset.cjs --user costreport --service cost-report.service --environment-file /etc/cost-report.env --install --confirm-single-backend
systemctl list-timers cost-report-demo-reset.timer
journalctl -u cost-report-demo-reset.service
```

定时模式使用 `--scheduled`，缺少开关或任一显式存储路径时拒绝执行。清理前创建 `business.db.reset-recovery.json` 恢复标记；完整成功或确认回滚才移除。数据库提交后的失败会保留标记，阻止次日自动重试；恢复核对后才可人工归档该标记。不要用定时删除锁/标记来绕过失败保护。

时间表达式和不补跑策略参照 systemd 官方 [时间语法](https://github.com/systemd/systemd/blob/main/man/systemd.time.xml) 与 [定时器文档](https://github.com/systemd/systemd/blob/main/man/systemd.timer.xml)。本例 `Persistent=false`，错过凌晨清理时不会在白天开机后补跑。

## Acceptance checks

The acceptance harness uses temporary databases and storage for every run. It must not use `server/data/demo/`.

```bash
npm run test:api
npx playwright install chromium
npm run test:browser
npm run test:acceptance
```

The API check covers registration, login, authenticated identity lookup, and report listing through HTTP endpoints. The browser check starts the actual Express and Vite applications, then verifies login, navigation to monthly report management, and rendering a report returned by the API. Browser acceptance requires the Playwright Chromium browser installed once with the command above.

### 访问系统

- **前端地址**：http://localhost:5173
- **后端 API**：http://localhost:3000/api

## 测试账号

当前默认演示库保留以下 6 个账号，密码沿用现有演示配置。旧库的 `admin`、`finance`、`viewer` 已随旧库退役；不要重新初始化账号。

| 账号 | 演示用途 |
| --- | --- |
| browser-user | 系统管理员 |
| browser-designer | 模板设计 |
| 组织填报人一 | 组织内协同填报 |
| browser-scoped-user-2 | 第二位组织填报人 |
| browser-quarter-reviewer | 季度部门审核 |
| evidence-outsider | 组织范围外的权限边界验证 |

当前操作方式见 [系统手工体验操作手册](docs/demo/系统手工体验操作手册.md)。下方流程保留旧版背景说明，以当前界面和手册为准。

## 操作流程

### 1. 模板搭建流程（管理员）

1. 登录系统（使用 admin 账号）
2. 进入"报表模板搭建"页面
3. 点击"新建模板"，填写模板信息
4. 进入模板编辑器，设计报表结构：
   - 设计工作表布局
   - 绑定数据源（Sheet 绑定 / Table 绑定 / Cell 绑定）
   - 设置公式（可使用 QUERY 自定义函数）
   - 设置样式
5. 点击"保存"保存草稿
6. 点击"发布模板"发布模板（发布后财务人员可见）

### 2. 月度报表填报流程（财务人员）

1. 登录系统（使用 finance 账号）
2. 进入"月度报表管理"页面
3. 点击"创建月度报表"
4. 选择已发布的模板和报表月份
5. 进入报表编辑器，填入实际数据：
   - 基于模板结构自动加载
   - 修改数据源内容
   - 公式自动计算
6. 点击"保存"保存草稿
7. 点击"提交审核"提交审核（提交后不可编辑）

### 3. 报表审核流程（管理员/审核人）

1. 登录系统（使用 admin 账号）
2. 进入"报表审核"页面
3. 查看"审核中"状态的报表列表
4. 点击"审核详情"查看报表内容
5. 填写审核意见，选择"通过"或"驳回"
6. 系统记录审核历史，更新报表状态

### 4. 报表查看流程（所有用户）

1. 进入"报表中心"页面
2. 查看所有已发布的报表模板
3. 点击"查看报表"
4. 选择查看的月份
5. 以只读模式查看报表数据
6. 可选：使用"勾稽分析"功能查看数据依赖关系

## 核心技术实现

### QUERY 自定义函数

在 `main.js` 中注册了全局自定义函数 `QUERY`，用于跨报表数据查询：

```javascript
// 用法：QUERY(模板ID, 月份, 项目1, 项目2, 字段名)
=QUERY(1, "2026-06", "生产指标", "产量", "currentMonth")
```

### 数模分离

- **模板数据（templateData）**：只保存结构（布局、样式、公式），不保存数据源
- **数据源数据（dataSourceData）**：单独保存数据内容
- **保存时**：`spread.toJSON({ includeBindingSource: false })`
- **加载时**：先加载模板结构，再通过 `setDataSource` 绑定数据

### 模板变更同步

旧版模板命令同步功能及相关接口已下线，`template_changes` 和 `template_syncs` 在迁移 24 中移除。当前模板版本管理使用 `templates`、`template_versions` 等表，协同编辑使用独立协同数据库。

### 用户管理器集成

在 `userManager.js` 中实现 SpreadJS 批注功能的用户信息注入：

```javascript
initUserManager(userInfo, GC);
```

## API 接口文档

### 认证接口

- `POST /api/auth/register` - 用户注册
- `POST /api/auth/login` - 用户登录
- `GET /api/auth/me` - 获取当前用户信息
- `POST /api/auth/init-default-users` - 初始化默认用户

### 模板接口

- `GET /api/templates` - 获取模板列表
- `GET /api/templates/:id` - 获取模板详情
- `POST /api/templates` - 创建模板
- `PUT /api/templates/:id` - 更新模板
- `DELETE /api/templates/:id` - 删除模板
- `POST /api/templates/submit-changes` - 提交模板变更
- `POST /api/templates/sync-changes` - 同步变更到报表

### 报表接口

- `GET /api/reports` - 获取报表列表
- `GET /api/reports/:id` - 获取报表详情
- `POST /api/reports` - 创建报表
- `PUT /api/reports/:id` - 更新报表
- `POST /api/reports/:id/submit` - 提交报表审核
- `POST /api/reports/:id/audit` - 审核报表
- `DELETE /api/reports/:id` - 删除报表
- `GET /api/reports/:id/audit-logs` - 获取审核历史

### 数据库管理接口

- `GET /api/database/stats` - 获取数据库统计信息
- `POST /api/database/clear-reports` - 清空报表数据
- `POST /api/database/reset` - 重置数据库

### 数据查询接口

- `GET /api/data/query` - 查询 tableData 数据（供 QUERY 函数使用）
- `GET /api/data/project1` - 获取 project1 列表
- `GET /api/data/project2` - 获取 project2 列表

## 环境变量

分两类，不能混用：

**前端构建时（Vite）**：`npm run build:showcase` 执行时读取，值会写死进 `dist`，部署后再改服务器环境变量不会生效。

- 只有 `VITE_` 前缀的变量会通过 `import.meta.env` 暴露给浏览器代码；`VITE_SHOWCASE`、`VITE_BASE_PATH`、`VITE_API_URL` 属于这一类。
- `vite.config.js` 自身读取的变量（`VITE_BASE_PATH`、`SPREADJS_LICENSE`、`DESIGNER_LICENSE` 等）通过 `loadEnv(mode)` 从 `.env.showcase`、`.env.showcase.local` 或 CI 环境变量读取；新增配置变量要加入 `CONFIG_ENV_KEYS` 列表，否则配置阶段拿不到。
- CI 传入的真实环境变量优先于 `.env.showcase`。完整清单见 `.env.showcase`。

**后端运行时（Node）**：进程启动时读取，修改后重启后端即可，模板见 `server/config/env.example`。

- `APP_BASE_PATH`、`PORT`、`HOST`、`JWT_SECRET`、`SERVER_LICENSE`、`COST_REPORT_*` 存储路径等。
- 视频和 PDF 字体地址不走前端构建，由 `/api/app-config` 在页面运行时下发；修改 `server/config/showcase.json` 或 `GUIDE_MEDIA_BASE_URL` 后重启后端、刷新页面即可，不需要重新构建前端。

## 许可证

MIT

## 联系方式

如有问题，请联系开发团队。
