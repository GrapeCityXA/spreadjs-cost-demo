const exportsService = require('../services/originalDataExports');

function handle(action) {
  return async (req, res, next) => {
    try { await action(req, res); }
    catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  };
}

exports.periods = handle(async (req, res) => {
  res.json({ periods: await exportsService.listPeriods(req.user) });
});

exports.organizations = handle(async (req, res) => {
  res.json({ organizations: await exportsService.listOrganizations(req.user, Number(req.params.packageId)) });
});

exports.rawData = handle(async (req, res) => {
  const result = await exportsService.exportRawData(req.user, req.query);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="original-data.xlsx"; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
  res.setHeader('X-Export-Row-Count', String(result.rowCount));
  res.send(Buffer.from(result.buffer));
});

exports.createJob = handle(async (req, res) => {
  const job = await exportsService.createJob(req.user, req.body?.packageId);
  res.status(202).json({ job });
});

exports.listJobs = handle(async (req, res) => {
  res.json({ jobs: await exportsService.listJobs(req.user) });
});

exports.retryJob = handle(async (req, res) => {
  const job = await exportsService.retryJob(Number(req.params.jobId), req.user);
  res.status(202).json({ job });
});

exports.downloadJob = handle(async (req, res) => {
  const file = await exportsService.downloadJob(Number(req.params.jobId), req.user);
  res.download(file.path, file.filename);
});
