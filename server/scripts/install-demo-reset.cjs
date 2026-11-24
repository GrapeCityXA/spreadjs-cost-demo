#!/usr/bin/env node
// Install the project-owned systemd timer, never run a reset during installation.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const unitName = 'cost-report-demo-reset';
const managed = '# Managed by cost-report install-demo-reset.cjs';
const fail = message => { throw new Error(message); };

function absolute(value, name) {
  if (!value || !path.posix.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || path.posix.normalize(value) !== value || value === '/') fail(`${name} 必须是规范的 Linux 绝对路径`);
  return value;
}
function quoted(value, command = false) {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return '"' + (command ? escaped.replaceAll('$', () => '$$') : escaped) + '"';
}
function renderUnits({ appDir, user, service, envFile, node = '/usr/bin/node', runuser = '/usr/sbin/runuser', systemctl = '/usr/bin/systemctl' }) {
  for (const [key, value] of Object.entries({ appDir, envFile, node, runuser, systemctl })) absolute(value, key);
  if (!/^[a-z_][a-z0-9_-]*\$?$/.test(user || '') || user === 'root') fail('需指定非 root 的后端服务账号 --user');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/.test(service || '') || service === unitName + '.service') fail('需指定独立的后端服务名 --service');
  const control = `${quoted(systemctl, true)}`;
  const invoke = `${quoted(runuser, true)} --user ${user} --preserve-environment -- ${quoted(node, true)} ${quoted(appDir + '/server/scripts/reset-demo.cjs', true)}`;
  // These path directives do not use ExecStart's shell-style quote parsing.
  // Preserve literal spaces/quotes and only escape systemd percent specifiers.
  return {
    service: `${managed}\n[Unit]\nDescription=Offline reset of cost report demo (backup before cleanup)\n\n[Service]\nType=oneshot\nWorkingDirectory=${appDir.replaceAll('%', '%%')}\nEnvironmentFile=${envFile.replaceAll('%', '%%')}\nExecStart=${control} is-active --quiet ${service}\nExecStart=${invoke} --scheduled --showcase --dry-run\nExecStart=${control} stop ${service}\nExecStart=${invoke} --scheduled --showcase --apply --confirm-offline --retain 7\nExecStart=${control} start ${service}\nTimeoutStartSec=30min\nUMask=0077\n`,
    timer: `${managed}\n[Unit]\nDescription=Reset cost report demo daily at 02:00 Asia/Shanghai\n\n[Timer]\nOnCalendar=*-*-* 02:00:00 Asia/Shanghai\nAccuracySec=1s\nRandomizedDelaySec=0\nPersistent=false\nUnit=${unitName}.service\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

async function install(options, units) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) fail('安装须在实际 Linux/systemd 演示服务器上以 root 运行；当前未安装或启用任何任务');
  if (!options.confirmSingleBackend) fail('必须确认全部后端和后台作业归此服务管理：--confirm-single-backend');
  if (await fs.realpath(options.appDir) !== options.appDir || options.appDir !== await fs.realpath(repo)) fail('请在实际部署的项目目录执行，禁止跨项目安装');
  const envStat = await fs.lstat(options.envFile);
  if (!envStat.isFile() || envStat.uid !== 0 || (envStat.mode & 0o022)) fail('环境文件必须是 root 所有、不可被组/其他用户写入的普通文件');
  if (await fs.realpath(options.envFile) !== options.envFile) fail('环境文件路径不能含符号链接');
  for (const executable of [options.node, options.runuser, options.systemctl]) await fs.access(executable, 1);
  const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  const show = property => command(options.systemctl, ['show', options.service, '--property=' + property, '--value']).trim();
  if (show('LoadState') !== 'loaded' || show('User') !== options.user || show('WorkingDirectory') !== options.appDir) fail('后端服务未加载，或账号/工作目录与安装参数不一致');
  if (show('KillMode') !== 'control-group') fail('后端服务必须使用 KillMode=control-group，确保停止全部子进程');
  if (show('EnvironmentFiles') !== `${options.envFile} (ignore_errors=no)` || /COST_REPORT_/.test(show('Environment') + show('UnsetEnvironment'))) fail('后端必须只使用同一份必需环境文件，不能另有 COST_REPORT_* 内联覆盖或取消配置');
  if (show('TriggeredBy')) fail('后端不能由 socket/timer 等另行激活，防止清理期间自动启动');
  command(options.systemctl, ['is-active', '--quiet', options.service]);

  // Parse the environment using systemd itself, with the application identity.
  // This is read-only: it neither stops the backend nor applies the reset.
  command('/usr/bin/systemd-run', ['--quiet', '--wait', '--pipe', '--collect', '--unit=' + unitName + '-preflight',
    '--property=User=' + options.user, '--property=WorkingDirectory=' + options.appDir,
    '--property=EnvironmentFile=' + options.envFile, '--property=UMask=0077',
    options.node, options.appDir + '/server/scripts/reset-demo.cjs', '--scheduled', '--showcase', '--dry-run']);
  const targets = Object.entries(units).map(([extension, content]) => ({ target: `/etc/systemd/system/${unitName}.${extension}`, content }));
  for (const entry of targets) {
    const stat = await fs.lstat(entry.target).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
    if (stat && !stat.isFile()) fail(`拒绝覆盖非普通文件：${entry.target}`);
    entry.previous = stat ? await fs.readFile(entry.target, 'utf8') : null;
    if (entry.previous !== null && !entry.previous.startsWith(managed + '\n')) fail(`拒绝覆盖非本安装器管理的单元：${entry.target}`);
  }
  const timerState = command(options.systemctl, ['show', unitName + '.timer', '--property=ActiveState', '--value']).trim();
  if (timerState === 'active') fail('同名定时器已启用；若要更新，请先停用该 timer 并确认没有维护任务运行');
  if (['active', 'activating', 'deactivating'].includes(command(options.systemctl, ['show', unitName + '.service', '--property=ActiveState', '--value']).trim())) fail('重置任务正在运行，禁止替换');
  try {
    for (const { target, content } of targets) await fs.writeFile(target, content, { mode: 0o644 });
    command('/usr/bin/systemd-analyze', ['verify', ...targets.map(t => t.target)]);
    command(options.systemctl, ['daemon-reload']);
    command(options.systemctl, ['enable', '--now', unitName + '.timer']);
  } catch (error) {
    // A failed installation must not leave a newly enabled destructive timer.
    try {command(options.systemctl, ['disable', '--now', unitName + '.timer']);} catch {}
    for (const { target, previous } of targets) {
      if (previous === null) await fs.unlink(target).catch(e => {if(e.code !== 'ENOENT') throw e;});
      else await fs.writeFile(target, previous, { mode: 0o644 });
    }
    command(options.systemctl, ['daemon-reload']);
    throw error;
  }
  console.log(command(options.systemctl, ['list-timers', '--all', unitName + '.timer']));
  console.log('已启用北京时间每日 02:00 的重置任务；本次安装仅预检，未立即重置数据库。');
}

async function cli(args) {
  const options = { appDir: repo.replaceAll('\\', '/'), node: '/usr/bin/node', runuser: '/usr/sbin/runuser', systemctl: '/usr/bin/systemctl' };
  let apply = false;
  const flags = { '--app-dir': 'appDir', '--user': 'user', '--service': 'service', '--environment-file': 'envFile', '--node': 'node', '--runuser': 'runuser', '--systemctl': 'systemctl' };
  for (let i = 0; i < args.length; i++) {
    if (flags[args[i]]) {const flag=args[i];const value=args[++i];if(!value || value.startsWith('--')) fail(`缺少参数：${flag}`);options[flags[flag]]=value;}
    else if (args[i] === '--install') apply = true;
    else if (args[i] === '--confirm-single-backend') options.confirmSingleBackend = true;
    else if (args[i] === '--help') {console.log('预览：node server/scripts/install-demo-reset.cjs --app-dir /srv/cost-report --user costreport --service cost-report.service --environment-file /etc/cost-report.env\n部署服务器启用：在上述参数后添加 --install --confirm-single-backend\n定时任务使用展示模式策略：保留字段/组件/模板/报表模板，只清理任务、协同和生成记录。\n默认只输出单元文件；不会修改或启动服务。');return;}
    else fail(`未知参数：${args[i]}`);
  }
  const units = renderUnits(options);
  if (apply) await install(options, units);
  else for (const [extension, content] of Object.entries(units)) console.log(`# ${unitName}.${extension}\n${content}`);
}
if (require.main === module) cli(process.argv.slice(2)).catch(error => {
  // Do not print child stdout/stderr: service environment diagnostics may contain secrets.
  console.error('定时重置安装未完成：' + (error.status != null ? '系统预检/安装命令失败，请查看 systemd 日志；未自动绕过检查' : error.message));
  process.exitCode = 1;
});
module.exports = { renderUnits };
