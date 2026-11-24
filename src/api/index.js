// API基础配置
import { API_BASE_URL } from './base'

const LOGIN_PATH = `${import.meta.env.BASE_URL}login`;
let isRedirectingToLogin = false;

// 获取token
function getToken() {
  return localStorage.getItem("token");
}

// 通用请求方法
async function request(url, options = {}, responseType = 'json') {
  const token = getToken();
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...options.headers,
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${url}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let error = {};

    try {
      error = await response.json();
    } catch {
      // 反向代理等服务可能返回非 JSON 错误页，保留通用错误信息即可。
    }

    const tokenExpired =
      response.status === 401 ||
      (response.status === 403 && error.error === "令牌无效或已过期");

    if (tokenExpired && getToken() === token) {
      localStorage.removeItem("token");
      localStorage.removeItem("userInfo");

      if (
        typeof window !== "undefined" &&
        window.location.pathname !== LOGIN_PATH &&
        !isRedirectingToLogin
      ) {
        isRedirectingToLogin = true;
        window.location.replace(LOGIN_PATH);
      }
    }

    throw Object.assign(new Error(error.error || `请求失败 (${response.status})`), { status: response.status });
  }

  return responseType === 'blob' ? response.blob() : response.json();
}

// 认证API
export const functionPlaygroundApi = {
  sourceTools(payload, signal) {
    return request('/function-playground/source-tools', { method: 'POST', body: JSON.stringify(payload), signal });
  },
  serializationTemplate(code, signal) {
    return request('/function-playground/serialization-template', { method: 'POST', body: JSON.stringify({ code }), signal });
  },
  run(payload, signal) {
    return request('/function-playground/run', { method: 'POST', body: JSON.stringify(payload), signal });
  },
};

export const authApi = {
  // 登录
  async login(username, password, { signal } = {}) {
    return await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      signal,
    });
  },

  // 获取当前用户信息
  async getCurrentUser() {
    return await request("/auth/me");
  },
};

// 模板API
export const templateGovernanceApi = {
  getPermissionOptions() { return request('/template-governance/permission-options'); },
  async getComponents(signal) { return request('/template-governance/components', { signal }); },
  async createComponent(data) {
    return request('/template-governance/components', { method: 'POST', body: JSON.stringify(data) });
  },
  async createComponentVersion(id, data) {
    return request(`/template-governance/components/${id}/versions`, { method: 'POST', body: JSON.stringify(data) });
  },
  async updateComponentVersion(id, data) {
    return request(`/template-governance/components/versions/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  },
  async submitComponent(id, versionId) {
    return request(`/template-governance/components/${id}/versions/${versionId}/submit`, { method: 'POST', body: '{}' });
  },
  async reviewComponent(id, versionId, data) {
    return request(`/template-governance/components/${id}/versions/${versionId}/review`, { method: 'POST', body: JSON.stringify(data) });
  },
  async getTemplates(signal) { return request('/template-governance/templates', { signal }); },
  async createTemplate(data) {
    return request('/template-governance/templates', { method: 'POST', body: JSON.stringify(data) });
  },
  async importQuarterlyReferenceDraft(data) {
    return request('/template-governance/templates/import-quarterly-reference', { method: 'POST', body: JSON.stringify(data) });
  },
  async getTemplateVersion(id, signal) { return request(`/template-governance/templates/versions/${id}`, { signal }); },
  async validateTemplate(id, signal) { return request(`/template-governance/templates/versions/${id}/publication-checks`, { signal }); },
  async previewTemplateRole(id, role, signal) { return request(`/template-governance/templates/versions/${id}/role-preview?role=${encodeURIComponent(role)}`, { signal }); },
  async updateTemplateVersion(id, data) {
    return request(`/template-governance/templates/versions/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  },
  async createTemplateVersion(id, fromVersionId) {
    return request(`/template-governance/templates/${id}/versions`, { method: 'POST', body: JSON.stringify({ fromVersionId }) });
  },
  async submitTemplate(id, versionId) {
    return request(`/template-governance/templates/${id}/versions/${versionId}/submit`, { method: 'POST', body: '{}' });
  },
  async reviewTemplate(id, versionId, data) {
    return request(`/template-governance/templates/${id}/versions/${versionId}/review`, { method: 'POST', body: JSON.stringify(data) });
  }
};

export const monthlyReferenceReportApi = {
  async getVersions(periodCode, reportTypeId, { signal } = {}) {
    const query = new URLSearchParams({ periodCode, reportTypeId: String(reportTypeId), view: 'versions' });
    return request(`/collaboration/reference-report?${query}`, { signal });
  },
  async getReport(periodCode, reportTypeId, { signal, configurationPackageId } = {}) {
    const query = new URLSearchParams({ periodCode, reportTypeId: String(reportTypeId) });
    if (configurationPackageId != null) query.set('configurationPackageId', String(configurationPackageId));
    return request(`/collaboration/reference-report?${query}`, { signal });
  }
};

export const organizationAdminApi = {
  getRoles(signal) { return request('/admin/roles', { signal }); },
  createRole(data) { return request('/admin/roles', { method: 'POST', body: JSON.stringify(data) }); },
  updateRole(code, data) { return request(`/admin/roles/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify(data) }); },
  getOrganizations(signal) { return request('/admin/organizations', { signal }); },
  createOrganization(data) { return request('/admin/organizations', { method: 'POST', body: JSON.stringify(data) }); },
  updateOrganization(id, data) { return request(`/admin/organizations/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); },
  getUsers(signal) { return request('/admin/users', { signal }); },
  createUser(data) { return request('/admin/users', { method: 'POST', body: JSON.stringify(data) }); },
  updateUser(id, data) { return request(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); },
  replaceRoles(id, roles, reason) { return request(`/admin/users/${id}/roles`, { method: 'PUT', body: JSON.stringify({ roles, reason }) }); },
  resetPassword(id, password, reason) { return request(`/admin/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ password, reason }) }); },
  getAuditEvents(params = {}, signal) { const query = new URLSearchParams(params).toString(); return request(`/admin/audit-events${query ? `?${query}` : ''}`, { signal }); },
  async exportAuditEvents(params = {}, signal) {
    const query = new URLSearchParams(params).toString();
    const token = getToken();
    const response = await fetch(`${API_BASE_URL}/admin/audit-events/export${query ? `?${query}` : ''}`, {
      signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!response.ok) {
      let error = {};
      try { error = await response.json(); } catch {}
      throw new Error(error.error || `请求失败 (${response.status})`);
    }
    return response.blob();
  }
};

export const fieldCatalogApi = {
  getCatalog(signal) { return request('/fields/catalog', { signal }); },
  getDrafts(signal) { return request('/fields/drafts', { signal }); },
  createDraft(data, signal) { return request('/fields/drafts', { method: 'POST', body: JSON.stringify(data), signal }); },
  correctDraft(id, data, signal) { return request(`/fields/drafts/${id}`, { method: 'PATCH', body: JSON.stringify(data), signal }); },
  approveDraft(id, reason) { return request(`/fields/admin/drafts/${id}/approve`, { method: 'POST', body: JSON.stringify({ reason }) }); },
  rejectDraft(id, reason) { return request(`/fields/admin/drafts/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); },
  supersedeField(id, data, signal) { return request(`/fields/admin/fields/${id}/supersede`, { method: 'POST', body: JSON.stringify(data), signal }); },
  getVersions(id, signal) { return request(`/fields/admin/fields/${id}/versions`, { signal }); }
};

export const ruleCatalogApi = {
  getCatalog(signal) { return request('/rules/catalog', { signal }); },
  getVersions(ruleId) { return request(`/rules/${ruleId}/versions`); },
  create(data, signal) { return request('/rules', { method: 'POST', body: JSON.stringify(data), signal }); },
  createVersion(ruleId, data, signal) { return request(`/rules/${ruleId}/versions`, { method: 'POST', body: JSON.stringify(data), signal }); },
  updateDraft(versionId, data, signal) { return request(`/rules/versions/${versionId}`, { method: 'PATCH', body: JSON.stringify(data), signal }); },
  test(versionId, testCases, signal) { return request(`/rules/versions/${versionId}/test`, { method: 'POST', body: JSON.stringify({ testCases }), signal }); },
  submit(versionId, signal) { return request(`/rules/versions/${versionId}/submit`, { method: 'POST', body: JSON.stringify({}), signal }); },
  publish(versionId, reason) { return request(`/rules/versions/${versionId}/publish`, { method: 'POST', body: JSON.stringify({ reason }) }); },
  reject(versionId, reason) { return request(`/rules/versions/${versionId}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); },
  evaluate(versionId, input) { return request(`/rules/evaluate/${versionId}`, { method: 'POST', body: JSON.stringify({ input }) }); }
};

export const periodConfigurationApi = {
  getResources() { return request('/period-configuration/resources'); },
  getReportTypes({ signal } = {}) { return request('/period-configuration/report-types', { signal }); },
  createReportType(data) { return request('/period-configuration/report-types', { method: 'POST', body: JSON.stringify(data) }); },
  getPackages() { return request('/period-configuration/packages'); },
  createPackage(data) { return request('/period-configuration/packages', { method: 'POST', body: JSON.stringify(data) }); },
  updatePackage(id, data) { return request(`/period-configuration/packages/${id}`, { method: 'PUT', body: JSON.stringify(data) }); },
  validatePackage(id) { return request(`/period-configuration/packages/${id}/validate`, { method: 'POST', body: '{}' }); },
  activatePackage(id) { return request(`/period-configuration/packages/${id}/activate`, { method: 'POST', body: '{}' }); }
};

export const taskOperationsApi = {
  getProgress({ signal } = {}) { return request('/task-operations/progress', { signal }); },
  getAssignees(taskId, responsibility, { signal } = {}) {
    return request(`/task-operations/tasks/${taskId}/assignees?responsibility=${encodeURIComponent(responsibility)}`, { signal });
  },
  updateReminderSchedule(reportTypeId, schedule) { return request(`/task-operations/report-types/${reportTypeId}/reminders`, {
    method: 'PUT', body: JSON.stringify({ schedule })
  }); },
  reassign(taskId, responsibility, userId, reason, previousUserId) { return request(`/task-operations/tasks/${taskId}/reassign`, {
    method: 'POST', body: JSON.stringify({ responsibility, userId, reason, previousUserId })
  }); },
  extendDeadline(taskId, deadlineAt, reason) { return request(`/task-operations/tasks/${taskId}/extend-deadline`, {
    method: 'POST', body: JSON.stringify({ deadlineAt, reason })
  }); },
  cancel(taskId, reason) { return request(`/task-operations/tasks/${taskId}/cancel`, {
    method: 'POST', body: JSON.stringify({ reason })
  }); },
  getNotifications(signal) { return request('/task-operations/notifications', { signal }); },
  markNotificationRead(id, signal) { return request(`/task-operations/notifications/${id}/read`, { method: 'POST', body: '{}', signal }); }
};

export const collaborationApi = {
  getTaskHistory(taskId) { return request(`/collaboration/tasks/${taskId}/history`); },
  getMonthlyTasks() { return request('/collaboration/tasks'); },
  getMonthlyReviewTasks(options = {}) { return request('/collaboration/review-tasks', options); },
  getMonthlyReview(taskId, options = {}) { return request(`/collaboration/tasks/${taskId}/review`, options); },
  async finalizeMonthlyTask(taskId, xlsxBlob, pdfBlob) {
    const form = new FormData();
    form.append('xlsx', xlsxBlob, `report-${taskId}.xlsx`);
    form.append('pdf', pdfBlob, `report-${taskId}.pdf`);
    const response = await fetch(`${API_BASE_URL}/collaboration/tasks/${taskId}/finalize`, {
      method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: form
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `定稿失败 (${response.status})`);
    return payload;
  },
  getFinalizedRevisions(taskId, options = {}) { return request(`/collaboration/tasks/${taskId}/revisions`, options); },
  getFinalizedRevision(taskId, revisionId, options = {}) { return request(`/collaboration/tasks/${taskId}/revisions/${revisionId}`, options); },
  getFinalizedTasks(options = {}) { return request('/collaboration/finalized-tasks', options); },
  async downloadFinalizedArtifact(taskId, revisionId, artifactType) {
    const response = await fetch(`${API_BASE_URL}/collaboration/tasks/${taskId}/revisions/${revisionId}/artifacts/${encodeURIComponent(artifactType)}`, {
      headers: { Authorization: `Bearer ${getToken()}` }
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `下载失败 (${response.status})`);
    }
    return response.blob();
  },
  getMonthlyTask(taskId) { return request(`/collaboration/tasks/${taskId}/room`); },
  async uploadEvidenceAttachment(taskId, file, indicatorCode = '') {
    const form = new FormData(); form.append('file', file); form.append('indicatorCode', indicatorCode);
    const response = await fetch(`${API_BASE_URL}/collaboration/tasks/${taskId}/attachments`, {
      method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: form
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `上传失败 (${response.status})`);
    return payload;
  },
  async downloadEvidenceAttachment(taskId, attachmentId) {
    const response = await fetch(`${API_BASE_URL}/collaboration/tasks/${taskId}/attachments/${attachmentId}/download`, {
      headers: { Authorization: `Bearer ${getToken()}` }
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `下载失败 (${response.status})`);
    }
    return response.blob();
  },
  submitTask(taskId, data, idempotencyKey) { return request(`/collaboration/tasks/${taskId}/submit`, {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(data)
  }); },
  withdrawTask(taskId, reason) { return request(`/collaboration/tasks/${taskId}/withdraw`, { method: 'POST', body: JSON.stringify({ reason }) }); },
  getAdjustmentFields(taskId) { return request(`/collaboration/tasks/${taskId}/adjustment-fields`); },
  startMonthlyAdjustment(taskId, data) { return request(`/collaboration/tasks/${taskId}/adjustments`, { method: 'POST', body: JSON.stringify(data) }); },
  decideMonthlyAdjustment(taskId, data) { return request(`/collaboration/tasks/${taskId}/adjustment-decision`, { method: 'POST', body: JSON.stringify(data) }); },
  confirmQuarterlyAdjustmentImpact(taskId, impactId) { return request(`/collaboration/tasks/${taskId}/adjustment-impacts/${impactId}/confirm`, { method: 'POST', body: '{}' }); },
  saveReviewOpinion(taskId, data) { return request(`/collaboration/tasks/${taskId}/review-opinions`, { method: 'POST', body: JSON.stringify(data) }); },
  saveAnomalyDisposition(taskId, anomalyId, disposition) { return request(`/collaboration/tasks/${taskId}/anomalies/${anomalyId}/disposition`, { method: 'POST', body: JSON.stringify({ disposition }) }); }
};

export const quarterlyReviewApi = {
  getTasks({ signal } = {}) { return request('/quarterly-review/tasks', { signal }); },
  getTask(taskId, { signal, includeWorkbook = true } = {}) {
    return request(`/quarterly-review/tasks/${taskId}${includeWorkbook ? '' : '?includeWorkbook=false'}`, { signal });
  },
  getPackageReport(packageId, { signal } = {}) { return request(`/quarterly-review/packages/${packageId}/official-report`, { signal }); },
  saveReview(taskId, indicatorId, data) { return request(`/quarterly-review/tasks/${taskId}/indicators/${indicatorId}/review`, { method: 'POST', body: JSON.stringify(data) }); },
  saveScore(taskId, indicatorId, data) { return request(`/quarterly-review/tasks/${taskId}/indicators/${indicatorId}/score`, { method: 'POST', body: JSON.stringify(data) }); },
  addAdjustment(taskId, data) { return request(`/quarterly-review/tasks/${taskId}/adjustments`, { method: 'POST', body: JSON.stringify(data) }); },
  decideAdjustment(taskId, adjustmentId, data) { return request(`/quarterly-review/tasks/${taskId}/adjustments/${adjustmentId}/decision`, { method: 'POST', body: JSON.stringify(data) }); },
  finalize(taskId, artifacts) { return request(`/quarterly-review/tasks/${taskId}/finalize`, { method: 'POST', body: artifacts }); }
};

export const managementDashboardApi = {
  getDashboard({ period, organizationId, category } = {}, { signal } = {}) {
    const query = new URLSearchParams();
    if (period) query.set('period', period);
    if (organizationId) query.set('organizationId', organizationId);
    if (category) query.set('category', category);
    return request(`/management-dashboard${query.size ? `?${query}` : ''}`, { signal, cache: 'no-store' });
  },

  overview({ signal } = {}) { return request('/management-dashboard/overview', { signal, cache: 'no-store' }); },
  snapshot(taskId, revisionId, { signal } = {}) { return request(`/management-dashboard/tasks/${taskId}/snapshot?revisionId=${encodeURIComponent(revisionId)}`, { signal, cache: 'no-store' }); }
};

export const historicalImportApi = {
  getOptions({ signal } = {}) { return request('/historical-imports/options', { signal }); },
  async preview({ reportTypeId, periodCode, file, rows }, { signal } = {}) {
    const form = new FormData();
    form.append('reportTypeId', String(reportTypeId));
    form.append('periodCode', periodCode);
    form.append('rows', JSON.stringify(rows));
    form.append('file', file, file.name);
    return request('/historical-imports/preview', { method: 'POST', body: form, signal });
  },
  confirm(batchId, { signal } = {}) { return request(`/historical-imports/${batchId}/confirm`, { method: 'POST', body: '{}', signal }); }
};

export const originalDataExportApi = {
  getPeriods(signal) { return request('/exports/periods', { signal }); },
  getOrganizations(packageId, signal) { return request(`/exports/packages/${packageId}/organizations`, { signal }); },
  async downloadRawData(params = {}, signal) {
    const query = new URLSearchParams(params).toString();
    return request(`/exports/raw-data.xlsx?${query}`, { signal }, 'blob');
  },
  createJob(packageId, signal) { return request('/exports/jobs', { method: 'POST', body: JSON.stringify({ packageId }), signal }); },
  getJobs(signal) { return request('/exports/jobs', { signal }); },
  retryJob(jobId, signal) { return request(`/exports/jobs/${jobId}/retry`, { method: 'POST', body: '{}', signal }); },
  async downloadJob(jobId, signal) {
    return request(`/exports/jobs/${jobId}/download`, { signal }, 'blob');
  }
};

export default {
  authApi,
  organizationAdminApi,
  fieldCatalogApi,
  ruleCatalogApi,
  periodConfigurationApi,
  taskOperationsApi,
  collaborationApi,
  quarterlyReviewApi,
  managementDashboardApi,
  historicalImportApi,
  originalDataExportApi,
};

export const workflowApi = { list: (signal) => request('/workflows', { signal }) };

export const managedFunctionApi = {
  definitions: versionIds => request('/managed-functions/definitions', { method: 'POST', body: JSON.stringify({ versionIds }) }),
};
