# Nginx 部署与浏览器缓存

`nginx.conf` 是一份示例配置。部署到其他环境时，修改 `server_name`、`root` 和后端端口；`root` 必须指向实际发布版本的 `dist` 目录。配置中不包含 License 或服务器凭据。

每日演示数据清理（systemd timer）见 [每日演示数据重置部署说明](../../docs/demo/每日演示数据重置.md)。

## 发布顺序

1. 先上传新版本带内容哈希的 `assets` 文件，保留旧版本资源，避免已打开页面的延迟加载失败。
2. 用同一构建的 `index.html` 原子替换入口文件；不要覆盖同名哈希资源的内容。
3. 首次安装或修改 Nginx 配置时，备份现有配置，再安装此文件到 `/etc/nginx/conf.d/cost-report-demo.conf`。
4. 执行 `nginx -t`；通过后才执行 `systemctl reload nginx`。检查不通过时恢复备份，不要重启服务。

## 缓存规则

- `/` 返回不缓存的 `302`，跳转到 `/guide` 并保留查询参数，无需等待前端脚本加载。
- `/guide`、`/login` 和业务页面通过 Nginx 内部跳转读取 `/index.html`，统一返回 `Cache-Control: no-store, no-cache, max-age=0, must-revalidate`。
- HTML 关闭 ETag 和修改时间条件验证，避免发布时相同长度、时间戳造成入口被误判为未修改。入口只有几百字节，每次读取开销很小。
- `/assets/` 下带内容哈希的脚本、样式和媒体继续缓存 7 天；内容变化后文件名随之变化。
- API、WebSocket 和健康检查保留原有转发行为。

## 发布验收

用 `curl -I` 检查 `/`，应返回 `302`、指向 `/guide` 的 `Location` 和 `Cache-Control: no-store`。分别检查 `/guide`、`/login`、`/portal/template` 和 `/index.html`，应返回 HTML 的上述缓存头。携带旧 `If-None-Match` 或未来的 `If-Modified-Since` 再请求入口，也应得到 `200` 和完整新版 HTML。真实存在的哈希资源仍应返回缓存头，缺失资源应返回 `404`，不能返回 HTML。

在浏览器访问首页、宣传页并普通刷新，确认载入新版。当前路由：无论是否登录，首页都进入 `/guide`；宣传页可免登录访问，通过页面的登录体验入口进入业务系统。前端路由也保持同样的首页跳转行为，用于本地开发或没有 Nginx 的环境。

旧部署没有为 HTML 明确设置缓存规则；旧客户端可能仍持有旧入口，其中首页指向 `/guide`。服务器新规则只能在浏览器发起请求后生效，无法追溯清除浏览器已保存的缓存。受影响浏览器可能需要一次强制刷新；临时演示可使用带新查询参数的入口，例如 `/guide?v=20261016-cachefix`。这不是持续发布方案，也不保证清除原 URL 已有缓存。
