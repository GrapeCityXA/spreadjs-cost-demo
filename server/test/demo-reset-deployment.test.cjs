const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { renderUnits } = require('../scripts/install-demo-reset.cjs');
const options = { appDir: '/srv/cost report', user: 'costreport', service: 'cost-report.service', envFile: '/etc/cost report.env' };

test('timer is pinned to Shanghai 02:00, with no missed daytime catchup', () => {
  const { timer, service } = renderUnits(options);
  assert.match(timer, /^OnCalendar=\*-\*-\* 02:00:00 Asia\/Shanghai$/m);
  assert.match(timer, /^Persistent=false$/m);
  assert.match(service, /^EnvironmentFile=\/etc\/cost report.env$/m);
  const commands = service.split('\n').filter(line => line.startsWith('ExecStart='));
  assert.equal(commands.length, 5);
  assert.match(commands[0], /is-active --quiet cost-report.service$/);
  assert.match(commands[1], /--scheduled --showcase --dry-run$/);
  assert.match(commands[2], /stop cost-report.service$/);
  assert.match(commands[3], /--scheduled --showcase --apply --confirm-offline --retain 7$/);
  assert.match(commands[4], /start cost-report.service$/);
  assert.ok(commands.every(line => !line.startsWith('ExecStart=-')), 'failures must stop the sequence');
  assert.doesNotMatch(service, /ExecStopPost|ExecStop=|Restart=/, 'failure must never restart the backend');
});

test('unit renderer prevents injected directives and privileged/self-target reset', () => {
  for (const changes of [
    { appDir: '/srv/app\nExecStart=/bin/true' }, { appDir: '/' }, { appDir: '/srv/../other' },
    { envFile: 'relative.env' }, { user: 'root' }, { user: 'user --other' },
    { service: 'cost-report-demo-reset.service' }, { service: 'app.service\nOther=yes' },
  ]) assert.throws(() => renderUnits({ ...options, ...changes }));
  const { service } = renderUnits({ ...options, appDir: '/srv/report%_$x"name' });
  assert.match(service, /^WorkingDirectory=\/srv\/report%%_\$x"name$/m);
  assert.match(service, /report%%_\$\$x\\"name\/server\/scripts\/reset-demo.cjs/);
});

test('generated units are accepted by the actual Linux systemd parser', {
  skip: process.platform !== 'linux' || !fs.existsSync('/usr/bin/systemd-analyze'),
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-reset-unit-check-'));
  try {
    const units = renderUnits(options);
    const filenames = Object.entries(units).map(([extension, content]) => {
      const filename = path.join(directory, `cost-report-demo-reset.${extension}`);
      fs.writeFileSync(filename, content);
      return filename;
    });
    const result = spawnSync('/usr/bin/systemd-analyze', ['verify', ...filenames], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /path is not absolute|ignoring:/i);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('default installer invocation only renders units and cannot execute reset commands', () => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../scripts/install-demo-reset.cjs'),
    '--app-dir', '/srv/cost-report', '--user', 'costreport', '--service', 'cost-report.service', '--environment-file', '/etc/cost-report.env'], { encoding: 'utf8', windowsHide: true });
  assert.match(output, /OnCalendar=/);
  assert.match(output, /--scheduled --showcase --dry-run/);
  assert.doesNotMatch(output, /已启用北京时间/);
});
