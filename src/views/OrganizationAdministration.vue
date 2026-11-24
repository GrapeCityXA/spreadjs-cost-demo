<template>
  <main class="org-admin portal-workbench">
    <header class="page-heading">
      <div>
        <h1>组织与用户</h1>
        <p>维护组织、用户和角色。系统管理员可创建自定义角色、组合职责权限，再分配给用户；角色配置及分配均保留审计记录。</p>
      </div>
      <div class="heading-actions">
        <el-button :loading="loading" @click="refreshPage">刷新数据</el-button>
        <el-button v-if="activeTab === 'organizations'" type="primary" :disabled="!hasLoaded || saving" @click="openOrganization()">新建组织</el-button>
        <el-button v-else-if="activeTab === 'users'" type="primary" :disabled="!hasLoaded || saving" @click="openUser()">新建用户</el-button>
        <el-button v-else-if="activeTab === 'roles' && canManageRoles" type="primary" :disabled="!hasLoaded || saving" @click="openRoleDefinition()">新建角色</el-button>
      </div>
    </header>

    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon class="admin-feedback"><p>{{ hasLoaded ? '刷新失败，以下保留上次成功读取的数据。' : '尚未取得管理数据，请重试。' }}</p><el-button :loading="loading" @click="refreshAll">重试加载</el-button></el-alert>
    <p v-if="!hasLoaded && loading" role="status">正在读取组织、用户和角色…</p>
    <section v-if="hasLoaded" class="summary-strip">
      <div><span class="summary-label">组织单元</span><strong>{{ organizations.length }}</strong><small>含停用记录</small></div>
      <div><span class="summary-label">正常账户</span><strong>{{ activeUserCount }}</strong><small>共 {{ users.length }} 个账户</small></div>
      <div><span class="summary-label">角色分配</span><strong>{{ roleCount }}</strong><small>按用户、角色和范围计数</small></div>
      <div class="summary-note"><span class="status-dot"></span><span>账户与角色状态在每次请求时校验</span></div>
    </section>

    <el-tabs v-if="hasLoaded" v-model="activeTab" class="admin-tabs" @tab-change="onTabChange">
      <el-tab-pane name="organizations" label="组织架构">
        <div class="toolbar">
          <el-input v-model="organizationSearch" clearable aria-label="搜索组织名称、编码或别名" placeholder="搜索组织名称、编码或别名" class="search-box">
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <div class="table-hint">组织编码创建后不可修改；名称和别名保留有效日期</div>
        </div>
        <app-data-table accessible responsive table-label="组织架构" :data="filteredOrganizations" row-key="id" v-loading="loading" class="data-table" :empty-text="organizations.length ? '没有匹配的组织，请调整搜索或表头筛选。' : '暂无组织，请点击“新建组织”添加。'">
          <template #compact="{ rows }"><div class="admin-compact-list" aria-label="组织摘要">
            <p v-if="!rows.length" class="admin-empty">{{ organizations.length ? '没有匹配的组织，请调整搜索或表头筛选。' : '暂无组织，请点击“新建组织”添加。' }}</p>
            <article v-for="row in rows" :key="row.id" class="admin-summary-row">
              <div class="admin-row-heading"><h3>{{ row.name }}</h3><span :class="['state-pill', row.status]">{{ row.status === 'active' ? '有效' : '已停用' }}</span></div>
              <p class="admin-row-meta">{{ row.code }}</p>
              <dl><dt>上级组织</dt><dd>{{ organizationName(row.parentOrganizationId) || '—' }}</dd><dt>别名</dt><dd>{{ row.aliases?.map(item => item.alias).join('、') || '未设置' }}</dd><dt>有效期</dt><dd>{{ row.effective_from }} 至 {{ row.effective_to || '长期有效' }}</dd></dl>
              <div class="admin-row-actions"><el-button :disabled="saving" @click="openOrganization(row)">编辑组织</el-button></div>
            </article>
          </div></template>
          <el-table-column :column-value="row => row.name" label="组织" min-width="230">
            <template #default="{ row }"><div class="org-name"><span class="org-mark">{{ row.organization_type === 'department' ? '部' : '组' }}</span><div><strong>{{ row.name }}</strong><small>{{ row.code }}</small></div></div></template>
          </el-table-column>
          <el-table-column :column-value="row => organizationName(row.parentOrganizationId) || '—'" label="上级组织" min-width="160"><template #default="{ row }">{{ organizationName(row.parentOrganizationId) || '—' }}</template></el-table-column>
          <el-table-column :column-value="row => row.aliases?.map(item => item.alias).join('、') || '未设置'" label="别名" min-width="200"><template #default="{ row }"><span v-if="row.aliases?.length" class="alias-list">{{ row.aliases.map(item => item.alias).join('、') }}</span><span v-else class="muted">未设置</span></template></el-table-column>
          <el-table-column :column-value="row => row.effective_from + ' 至 ' + (row.effective_to || '长期有效')" label="有效期" min-width="190"><template #default="{ row }">{{ row.effective_from }} 至 {{ row.effective_to || '长期有效' }}</template></el-table-column>
          <el-table-column :column-value="row => row.status === 'active' ? '有效' : '已停用'" label="状态" width="115"><template #default="{ row }"><span :class="['state-pill', row.status]">{{ row.status === 'active' ? '有效' : '已停用' }}</span></template></el-table-column>
          <el-table-column label="操作" width="108" fixed="right"><template #default="{ row }"><el-button link type="primary" :disabled="!hasLoaded || saving" @click="openOrganization(row)">编辑</el-button></template></el-table-column>
        </app-data-table>
      </el-tab-pane>

      <el-tab-pane name="users" label="用户账户">
        <div class="toolbar">
          <el-input v-model="userSearch" clearable aria-label="搜索姓名、登录名或所属组织" placeholder="搜索姓名、登录名或所属组织" class="search-box">
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <div class="table-hint">每个账户有一个所属组织；通过“分配角色”设置职责及其组织范围。</div>
        </div>
        <app-data-table accessible responsive table-label="用户账户" :data="filteredUsers" row-key="id" v-loading="loading" class="data-table" :empty-text="users.length ? '没有匹配的用户，请调整搜索或表头筛选。' : '暂无用户，请点击“新建用户”添加。'">
          <template #compact="{ rows }"><div class="admin-compact-list" aria-label="用户摘要">
            <p v-if="!rows.length" class="admin-empty">{{ users.length ? '没有匹配的用户，请调整搜索或表头筛选。' : '暂无用户，请点击“新建用户”添加。' }}</p>
            <article v-for="row in rows" :key="row.id" class="admin-summary-row">
              <div class="admin-row-heading"><h3>{{ row.name }}</h3><span :class="['state-pill', row.status]">{{ row.status === 'active' ? '正常' : '已停用' }}</span></div>
              <p class="admin-row-meta">{{ row.username }}</p><p>所属组织：{{ row.organizationName || '—' }}</p>
              <details v-if="row.roles?.length" class="admin-row-details"><summary>职责角色（{{ row.roles.length }}）</summary><ul><li v-for="role in row.roles" :key="`${role.code}:${role.organizationId}`">{{ roleLabel(role.code) }} · {{ organizationName(role.organizationId) || '全局' }}</li></ul></details><p v-else class="admin-row-meta">未分配角色</p>
              <div class="admin-row-actions"><el-button :disabled="saving" @click="openUser(row)">编辑用户</el-button><el-button :disabled="saving" @click="openRoles(row)">分配角色</el-button><el-button :disabled="saving" @click="openPassword(row)">重置密码</el-button></div>
            </article>
          </div></template>
          <el-table-column :column-value="row => row.name" label="用户" min-width="210"><template #default="{ row }"><div class="user-cell"><span class="avatar">{{ row.name?.slice(0, 1) }}</span><div><strong>{{ row.name }}</strong><small>{{ row.username }}</small></div></div></template></el-table-column>
          <el-table-column prop="organizationName" label="所属组织" min-width="155" />
          <el-table-column :column-value="row => row.roles?.map(role => roleLabel(role.code) + ' · ' + (organizationName(role.organizationId) || '全局')).join('、') || '未分配'" label="职责角色" min-width="300"><template #default="{ row }"><div class="role-chips"><span v-for="role in row.roles" :key="`${role.code}:${role.organizationId}`" class="role-chip">{{ roleLabel(role.code) }}<i>{{ organizationName(role.organizationId) || '全局' }}</i></span><span v-if="!row.roles?.length" class="muted">未分配</span></div></template></el-table-column>
          <el-table-column :column-value="row => row.status === 'active' ? '正常' : '已停用'" label="状态" width="110"><template #default="{ row }"><span :class="['state-pill', row.status]">{{ row.status === 'active' ? '正常' : '已停用' }}</span></template></el-table-column>
          <el-table-column label="操作" width="210" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button link type="primary" :disabled="!hasLoaded || saving" @click="openUser(row)">编辑</el-button><el-button link type="primary" :disabled="!hasLoaded || saving" @click="openRoles(row)">分配角色</el-button><el-button link :disabled="saving" @click="openPassword(row)">重置密码</el-button></div></template></el-table-column>
        </app-data-table>
      </el-tab-pane>

      <el-tab-pane name="roles" label="角色管理">
        <div class="toolbar"><span class="table-hint">自定义角色可组合多项职责；组织职责还需在周期配置中分配具体任务。</span></div>
        <app-data-table accessible responsive table-label="角色管理" :data="roleDefinitions" row-key="code" v-loading="loading" class="data-table" :empty-text="roleDefinitions.length ? '没有匹配的角色，请调整表头筛选。' : '暂无角色'">
          <template #compact="{ rows }"><div class="admin-compact-list" aria-label="角色摘要">
            <p v-if="!rows.length" class="admin-empty">{{ roleDefinitions.length ? '没有匹配的角色，请调整表头筛选。' : '暂无角色' }}</p>
            <article v-for="row in rows" :key="row.code" class="admin-summary-row">
              <div class="admin-row-heading"><h3>{{ row.name }}</h3><span :class="['state-pill', row.status]">{{ row.status === 'active' ? '启用' : '停用' }}</span></div>
              <p class="admin-row-meta">{{ row.code }} · {{ row.builtin ? '内置' : '自定义' }} · {{ row.scopeType === 'global' ? '系统级' : '指定组织' }}</p>
              <p>{{ row.description || '暂无说明' }}</p><p>职责权限：{{ row.capabilities?.map(code => roleLabel(code)).join('、') || '—' }}</p>
              <div v-if="!row.builtin && canManageRoles" class="admin-row-actions"><el-button :disabled="saving" @click="openRoleDefinition(row)">编辑角色</el-button></div><p v-else class="admin-row-meta">{{ row.builtin ? '系统内置' : '只读' }}</p>
            </article>
          </div></template>
          <el-table-column :column-value="row => row.name" label="角色" min-width="190"><template #default="{ row }"><strong>{{ row.name }}</strong><small class="audit-subline">{{ row.code }}</small></template></el-table-column>
          <el-table-column :column-value="row => (row.builtin ? '内置' : '自定义') + ' · ' + (row.scopeType === 'global' ? '系统级' : '指定组织')" label="类型 / 范围" width="155"><template #default="{ row }">{{ row.builtin ? '内置' : '自定义' }} · {{ row.scopeType === 'global' ? '系统级' : '指定组织' }}</template></el-table-column>
          <el-table-column :column-value="row => row.capabilities?.map(code => roleLabel(code)).join('、')" label="职责权限" min-width="250"><template #default="{ row }"><div class="role-chips"><span v-for="code in row.capabilities" :key="code" class="role-chip">{{ roleLabel(code) }}</span></div></template></el-table-column>
          <el-table-column prop="description" label="说明" min-width="190" />
          <el-table-column :column-value="row => row.status === 'active' ? '启用' : '停用'" label="状态" width="100"><template #default="{ row }"><span :class="['state-pill', row.status]">{{ row.status === 'active' ? '启用' : '停用' }}</span></template></el-table-column>
          <el-table-column label="操作" width="105" fixed="right"><template #default="{ row }"><el-button v-if="!row.builtin && canManageRoles" link type="primary" :disabled="!hasLoaded || saving" @click="openRoleDefinition(row)">编辑</el-button><span v-else class="muted">{{ row.builtin ? '系统内置' : '只读' }}</span></template></el-table-column>
        </app-data-table>
      </el-tab-pane>

      <el-tab-pane name="audit" label="业务审计">
        <div class="audit-filters">
          <label class="audit-field audit-field-actorId"><span>操作人</span><el-select v-model="auditFilters.actorId" clearable filterable aria-label="操作人" placeholder="全部操作人" class="audit-select">
            <el-option v-for="user in users" :key="user.id" :label="`${user.name} · ${user.username}`" :value="String(user.id)" />
          </el-select></label>
          <label class="audit-field audit-field-organizationId"><span>组织</span><el-select v-model="auditFilters.organizationId" clearable filterable aria-label="组织" placeholder="全部组织" class="audit-select">
            <el-option v-for="org in organizations" :key="org.id" :label="org.name" :value="String(org.id)" />
          </el-select></label>
          <label class="audit-field audit-field-objectType"><span>对象类型</span><el-input v-model="auditFilters.objectType" clearable aria-label="对象类型" placeholder="例如：user" aria-describedby="audit-filter-help" class="audit-small" /></label>
          <label class="audit-field audit-field-objectId"><span>对象编号</span><el-input v-model="auditFilters.objectId" clearable aria-label="对象编号" placeholder="例如：123" aria-describedby="audit-filter-help" class="audit-small" /></label>
          <label class="audit-field audit-field-action"><span>操作代码</span><el-input v-model="auditFilters.action" clearable aria-label="操作代码" placeholder="例如：user.update" aria-describedby="audit-filter-help" class="audit-small" /></label>
          <label class="audit-field audit-field-from"><span>开始日期</span><el-date-picker v-model="auditFilters.from" type="date" value-format="YYYY-MM-DD" aria-label="开始日期" placeholder="不限开始日期" class="audit-date" /></label>
          <label class="audit-field audit-field-to"><span>结束日期</span><el-date-picker v-model="auditFilters.to" type="date" value-format="YYYY-MM-DD" aria-label="结束日期" placeholder="不限结束日期" class="audit-date" /></label>
          <div class="audit-filter-actions"><el-button type="primary" :loading="auditLoading" @click="refreshAudit">查询</el-button>
          <el-button :disabled="!auditLoaded || auditDirty || auditLoading || !!auditError || !auditEvents.length" :loading="exporting" @click="exportAudit">导出查询结果</el-button></div>
        </div>
        <p id="audit-filter-help" class="audit-hint">对象类型、编号和操作代码支持部分匹配；日期按 UTC 计算，包含开始和结束当天。</p>
        <p class="audit-hint">列表最多显示最近 100 条记录。CSV 导出包含上次查询的全部匹配记录，不受表头筛选或分页影响。</p>
        <p v-if="auditDirty" class="admin-feedback" role="status">筛选条件已修改，请点击“查询”更新列表后再导出。当前显示上次查询结果。</p>
        <el-alert v-if="auditError" :title="auditError" type="error" :closable="false" show-icon class="admin-feedback"><p>{{ auditLoaded ? '以下保留上次成功查询的记录。' : '尚未取得审计记录。' }}</p><el-button :loading="auditLoading" @click="refreshAudit">重试查询</el-button></el-alert>
        <el-alert v-if="exportError" :title="exportError" type="error" :closable="false" class="admin-feedback" />
        <app-data-table v-if="auditLoaded" accessible responsive table-label="业务审计" :data="auditEvents" v-loading="auditLoading" class="data-table" empty-text="没有匹配的审计记录，请调整查询条件或表头筛选。">
          <template #compact="{ rows }"><div class="admin-compact-list" aria-label="审计记录摘要">
            <p v-if="!rows.length" class="admin-empty">没有匹配的审计记录，请调整查询条件或表头筛选。</p>
            <article v-for="(row, index) in rows" :key="row.id || index" class="admin-summary-row">
              <div class="admin-row-heading"><h3>{{ row.action }}</h3><span :class="['outcome-pill', row.outcome]">{{ row.outcome === 'success' ? '成功' : row.outcome === 'denied' ? '拒绝' : '失败' }}</span></div>
              <p class="admin-row-meta">{{ row.occurredAt }}（UTC）</p>
              <dl><dt>操作人</dt><dd>{{ row.actorName || '系统' }}<small v-if="row.actorUsername">{{ row.actorUsername }}</small></dd><dt>组织</dt><dd>{{ row.organizationName || '—' }}</dd><dt>对象</dt><dd>{{ row.objectType }} · {{ row.objectId || '—' }}</dd><dt>原因</dt><dd>{{ row.reason || '未填写' }}</dd></dl>
              <details class="audit-details"><summary>查看变更前后内容</summary><strong>变更前</strong><pre>{{ row.beforeSummary ? JSON.stringify(row.beforeSummary, null, 2) : '—' }}</pre><strong>变更后</strong><pre>{{ row.afterSummary ? JSON.stringify(row.afterSummary, null, 2) : '—' }}</pre></details>
            </article>
          </div></template>
          <el-table-column prop="occurredAt" label="发生时间（UTC）" min-width="170" />
          <el-table-column :column-value="row => row.actorName || '系统'" label="操作人" min-width="150"><template #default="{ row }">{{ row.actorName || '系统' }}<small v-if="row.actorUsername" class="audit-subline">{{ row.actorUsername }}</small></template></el-table-column>
          <el-table-column prop="organizationName" label="组织" min-width="130" />
          <el-table-column :column-value="row => row.action + ' · ' + row.objectType + ' · ' + (row.objectId || '—')" label="操作 / 对象" min-width="190"><template #default="{ row }"><strong>{{ row.action }}</strong><small class="audit-subline">{{ row.objectType }} · {{ row.objectId || '—' }}</small></template></el-table-column>
          <el-table-column :column-value="row => row.outcome === 'success' ? '成功' : row.outcome === 'denied' ? '拒绝' : '失败'" label="结果" width="100"><template #default="{ row }"><span :class="['outcome-pill', row.outcome]">{{ row.outcome === 'success' ? '成功' : row.outcome === 'denied' ? '拒绝' : '失败' }}</span></template></el-table-column>
          <el-table-column :column-value="row => JSON.stringify(row.beforeSummary) + ' → ' + JSON.stringify(row.afterSummary)" label="变更摘要" min-width="300"><template #default="{ row }"><details class="audit-details"><summary>查看变更前后内容</summary><strong>变更前</strong><pre>{{ row.beforeSummary ? JSON.stringify(row.beforeSummary, null, 2) : '—' }}</pre><strong>变更后</strong><pre>{{ row.afterSummary ? JSON.stringify(row.afterSummary, null, 2) : '—' }}</pre></details></template></el-table-column>
          <el-table-column prop="reason" label="原因" min-width="150" show-overflow-tooltip />
        </app-data-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="organizationDialog" :before-close="() => requestClose('organization')" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving" :title="organizationForm.id ? '编辑组织' : '新建组织'" width="620px" class="admin-dialog">
      <p v-if="formError" class="admin-form-error" role="alert">{{ formError }}</p>
      <el-form :disabled="saving" :model="organizationForm" label-position="top" class="form-grid">
        <el-form-item :error="fieldErrors.code" data-field="code" label="组织编码" required><el-input :aria-invalid="Boolean(fieldErrors.code)" aria-describedby="organization-code-help" v-model="organizationForm.code" :disabled="!!organizationForm.id" placeholder="例如：HB-WH-01" /><p id="organization-code-help" class="admin-field-help">创建后不可修改。</p></el-form-item>
        <el-form-item :error="fieldErrors.name" data-field="name" label="组织名称" required><el-input :aria-invalid="Boolean(fieldErrors.name)" v-model="organizationForm.name" placeholder="输入正式名称" /></el-form-item>
        <el-form-item :error="fieldErrors.organizationType" data-field="organizationType" label="组织类型"><el-select :aria-invalid="Boolean(fieldErrors.organizationType)" v-model="organizationForm.organizationType"><el-option v-for="item in organizationTypes" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <el-form-item :error="fieldErrors.parentOrganizationId" data-field="parentOrganizationId" label="上级组织"><el-select :aria-invalid="Boolean(fieldErrors.parentOrganizationId)" v-model="organizationForm.parentOrganizationId" clearable placeholder="无上级组织"><el-option v-for="org in parentCandidates" :key="org.id" :label="`${org.name} · ${org.code}`" :value="org.id" /></el-select></el-form-item>
        <el-form-item :error="fieldErrors.effectiveFrom" data-field="effectiveFrom" label="生效日期" required><el-date-picker :aria-invalid="Boolean(fieldErrors.effectiveFrom)" v-model="organizationForm.effectiveFrom" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item :error="fieldErrors.effectiveTo" data-field="effectiveTo" label="失效日期"><el-date-picker :aria-invalid="Boolean(fieldErrors.effectiveTo)" v-model="organizationForm.effectiveTo" type="date" value-format="YYYY-MM-DD" clearable placeholder="留空表示长期有效" /></el-form-item>
        <el-form-item :error="fieldErrors.alias" data-field="alias" label="新增历史别名（选填）"><el-input :aria-invalid="Boolean(fieldErrors.alias)" v-model="organizationForm.alias" placeholder="每次填写一个别名" /></el-form-item>
        <el-form-item :error="fieldErrors.status" data-field="status" label="组织状态"><el-select :aria-invalid="Boolean(fieldErrors.status)" v-model="organizationForm.status"><el-option label="有效" value="active" /><el-option label="停用" value="disabled" /></el-select></el-form-item>
        <el-form-item :error="fieldErrors.reason" data-field="reason" v-if="organizationForm.id" label="变更原因" class="full-row"><el-input :aria-invalid="Boolean(fieldErrors.reason)" v-model="organizationForm.reason" placeholder="说明本次组织信息调整" /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="saving" @click="requestClose('organization')">取消</el-button><el-button type="primary" :loading="saving" @click="saveOrganization">保存组织</el-button></template>
    </el-dialog>

    <el-dialog v-model="userDialog" :before-close="() => requestClose('user')" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving" :title="userForm.id ? '编辑用户' : '新建用户'" width="600px" class="admin-dialog">
      <p v-if="formError" class="admin-form-error" role="alert">{{ formError }}</p>
      <el-form :disabled="saving" :model="userForm" label-position="top" class="form-grid">
        <el-form-item :error="fieldErrors.username" data-field="username" label="登录名" required><el-input :aria-invalid="Boolean(fieldErrors.username)" v-model="userForm.username" maxlength="64" /></el-form-item>
        <el-form-item :error="fieldErrors.name" data-field="name" label="姓名" required><el-input :aria-invalid="Boolean(fieldErrors.name)" v-model="userForm.name" autocomplete="off" /></el-form-item>
        <el-form-item :error="fieldErrors.password" data-field="password" v-if="!userForm.id" label="初始密码" required><el-input :aria-invalid="Boolean(fieldErrors.password)" aria-describedby="initial-password-help" v-model="userForm.password" autocomplete="new-password" type="password" show-password /><p id="initial-password-help" class="admin-field-help">至少 10 位。</p></el-form-item>
        <el-form-item :error="fieldErrors.organizationId" data-field="organizationId" label="所属组织" required><el-select :aria-invalid="Boolean(fieldErrors.organizationId)" v-model="userForm.organizationId" filterable><el-option v-for="org in activeOrganizations" :key="org.id" :label="`${org.name} · ${org.code}`" :value="org.id" /></el-select></el-form-item>
        <el-form-item :error="fieldErrors.email" data-field="email" label="邮箱（选填）"><el-input :aria-invalid="Boolean(fieldErrors.email)" v-model="userForm.email" /></el-form-item>
        <el-form-item :error="fieldErrors.status" data-field="status" v-if="userForm.id" label="账户状态"><el-select :aria-invalid="Boolean(fieldErrors.status)" aria-describedby="account-status-help" v-model="userForm.status"><el-option label="正常" value="active" /><el-option label="停用" value="disabled" /></el-select><p id="account-status-help" class="admin-field-help">停用会撤销已分配的角色；重新启用后需重新分配。</p></el-form-item>
        <el-form-item :error="fieldErrors.reason" data-field="reason" v-if="userForm.id" :required="userForm.status === 'disabled' || userForm.username.trim() !== originalUsername.trim()" label="调整原因" class="full-row"><el-input :aria-invalid="Boolean(fieldErrors.reason)" aria-describedby="user-reason-help" v-model="userForm.reason" placeholder="说明此次账户调整" /><p id="user-reason-help" class="admin-field-help">修改登录名或将账户设为停用时必填。</p></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="saving" @click="requestClose('user')">取消</el-button><el-button type="primary" :loading="saving" @click="saveUser">保存账户</el-button></template>
    </el-dialog>

    <el-dialog v-model="rolesDialog" :before-close="() => requestClose('roles')" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving" :title="`分配角色 · ${roleTarget?.name || ''}`" width="600px" class="admin-dialog">
      <p v-if="formError" class="admin-form-error" role="alert">{{ formError }}</p>
      <div class="role-dialog-intro">指定组织的角色需选择组织范围；系统级角色无需选择组织，仅系统管理员可授予。停用角色不再提供权限。</div>
      <el-form :disabled="saving" label-position="top">
        <p v-if="!roleAssignments.length" class="admin-field-help" role="status">尚未添加角色。保存后，该用户将没有任何角色权限。</p>
        <el-form-item label="职责与组织范围" :error="fieldErrors.assignments" data-field="assignments"><div class="assignment-list"><div v-for="(assignment, index) in roleAssignments" :key="index" class="assignment-row">
          <el-select v-model="assignment.code" filterable :aria-label="`角色 ${index + 1}`" placeholder="选择角色" @change="changeAssignmentScope(assignment)"><el-option v-for="role in roleDefinitions" :key="role.code" :label="`${role.name}${role.status === 'disabled' ? '（已停用）' : ''}`" :value="role.code" :disabled="role.status !== 'active'" /></el-select>
          <el-select v-if="roleScope(assignment.code) !== 'global'" v-model="assignment.organizationId" :aria-label="`组织范围 ${index + 1}`" placeholder="选择组织" filterable><el-option v-for="org in activeOrganizations" :key="org.id" :label="org.name" :value="org.id" /></el-select>
          <span v-else class="muted">系统级范围</span>
          <el-button link type="danger" :aria-label="`移除角色 ${index + 1}`" @click="roleAssignments.splice(index, 1)">移除</el-button>
        </div>
        </div></el-form-item><el-button class="add-assignment" @click="roleAssignments.push({ code: '', organizationId: roleTarget.organizationId })">添加角色</el-button>
        <el-form-item :error="fieldErrors.reason" data-field="reason" label="调整原因" required><el-input :aria-invalid="Boolean(fieldErrors.reason)" v-model="roleReason" placeholder="例如：负责本季度成本报表填报" /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="saving" @click="requestClose('roles')">取消</el-button><el-button type="primary" :loading="saving" @click="saveRoles">保存角色分配</el-button></template>
    </el-dialog>

    <el-dialog v-model="roleDefinitionDialog" :before-close="() => requestClose('roleDefinition')" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving" :title="roleDefinitionForm.editing ? '编辑角色' : '新建角色'" width="680px" top="6vh" class="admin-dialog role-definition-dialog">
      <p v-if="formError" class="admin-form-error" role="alert">{{ formError }}</p>
      <el-form :disabled="saving" label-position="top" class="form-grid">
        <el-form-item :error="fieldErrors.name" data-field="name" label="角色名称" required><el-input :aria-invalid="Boolean(fieldErrors.name)" v-model="roleDefinitionForm.name" maxlength="64" placeholder="例如：组织填报负责人" /></el-form-item>
        <el-form-item :error="fieldErrors.code" data-field="code" label="角色编码" required><el-input :aria-invalid="Boolean(fieldErrors.code)" aria-describedby="role-code-help" v-model="roleDefinitionForm.code" :disabled="roleDefinitionForm.editing" maxlength="64" placeholder="例如：org_reporting_owner" /><p id="role-code-help" class="admin-field-help">3–64 位小写字母、数字或下划线，以字母开头；创建后不可修改。</p></el-form-item>
        <el-form-item :error="fieldErrors.scopeType" data-field="scopeType" label="权限范围" required><el-select :aria-invalid="Boolean(fieldErrors.scopeType)" aria-describedby="role-scope-help" v-model="roleDefinitionForm.scopeType" :disabled="roleDefinitionForm.editing" @change="roleDefinitionForm.capabilities = []"><el-option label="指定组织" value="organization" /><el-option label="系统级" value="global" /></el-select><p id="role-scope-help" class="admin-field-help">创建后不可修改；指定组织的角色在分配给用户时选择具体组织。</p></el-form-item>
        <el-form-item :error="fieldErrors.status" data-field="status" label="状态"><el-select :aria-invalid="Boolean(fieldErrors.status)" v-model="roleDefinitionForm.status"><el-option label="启用" value="active" /><el-option label="停用" value="disabled" /></el-select></el-form-item>
        <el-form-item :error="fieldErrors.capabilities" data-field="capabilities" label="职责权限（可多选）" required class="full-row"><el-checkbox-group :aria-invalid="Boolean(fieldErrors.capabilities)" v-model="roleDefinitionForm.capabilities" class="capability-grid"><el-checkbox v-for="role in availableCapabilities" :key="role.code" :value="role.code"><span>{{ role.name }}<small>{{ role.description }}</small></span></el-checkbox></el-checkbox-group></el-form-item>
        <el-form-item :error="fieldErrors.description" data-field="description" label="角色说明（选填）" class="full-row"><el-input :aria-invalid="Boolean(fieldErrors.description)" v-model="roleDefinitionForm.description" type="textarea" maxlength="500" :rows="2" /></el-form-item>
        <el-form-item :error="fieldErrors.reason" data-field="reason" label="配置原因" required class="full-row"><el-input :aria-invalid="Boolean(fieldErrors.reason)" v-model="roleDefinitionForm.reason" placeholder="记录新建、调整权限或停用的业务原因" /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="saving" @click="requestClose('roleDefinition')">取消</el-button><el-button type="primary" :loading="saving" @click="saveRoleDefinition">保存角色配置</el-button></template>
    </el-dialog>

    <el-dialog v-model="passwordDialog" :before-close="() => requestClose('password')" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving" :title="`重置账户密码 · ${passwordTargetName}`" width="450px" class="admin-dialog">
      <p v-if="formError" class="admin-form-error" role="alert">{{ formError }}</p>
      <el-form :disabled="saving" label-position="top"><el-form-item :error="fieldErrors.password" data-field="password" label="新密码" required><el-input :aria-invalid="Boolean(fieldErrors.password)" aria-describedby="reset-password-help" v-model="passwordForm.password" autocomplete="new-password" type="password" show-password /><p id="reset-password-help" class="admin-field-help">至少 10 位。保存后，原密码将无法用于登录。</p></el-form-item><el-form-item :error="fieldErrors.reason" data-field="reason" label="重置原因" required><el-input :aria-invalid="Boolean(fieldErrors.reason)" v-model="passwordForm.reason" placeholder="记录重置原因" /></el-form-item></el-form>
      <template #footer><el-button :disabled="saving" @click="requestClose('password')">取消</el-button><el-button type="primary" :loading="saving" @click="resetPassword">重置密码</el-button></template>
    </el-dialog>
  </main>
</template>

<script>
import '@/styles/organization-admin-hardening.css'
import '@/styles/organization-admin-adaptation.css'
import { cleanAuditQuery, sameQuery, localDate, validateAdminForm } from '@/utils/organizationAdminState'
import { Search } from '@element-plus/icons-vue'
import { organizationAdminApi } from '../api'

const emptyOrg = () => ({ id: null, code: '', name: '', organizationType: 'subsidiary', status: 'active', effectiveFrom: localDate(), effectiveTo: null, parentOrganizationId: null, alias: '', reason: '' })
const emptyUser = () => ({ id: null, username: '', name: '', password: '', organizationId: null, email: '', status: 'active', reason: '' })
const emptyRole = () => ({ editing: false, code: '', name: '', scopeType: 'organization', capabilities: [], description: '', status: 'active', reason: '' })

export default {
  name: 'OrganizationAdministration',
  components: { Search },
  data() {
    return {
      activeTab: 'organizations', loading: false, saving: false,
      hasLoaded: false, loadError: '', auditLoaded: false, auditError: '', appliedAuditFilters: {},
      exporting: false, exportError: '', fieldErrors: {}, formError: '', baseline: '', editingKind: '', originalUsername: '', passwordTargetName: '',
      disposed: false, loadSequence: 0, auditSequence: 0, closePending: false,
      organizations: [], users: [], roleDefinitions: [], canManageRoles: false,
      roleDefinitionDialog: false, roleDefinitionForm: emptyRole(), roleAssignments: [],
      auditEvents: [], auditLoading: false,
      auditFilters: { actorId: '', organizationId: '', objectType: '', objectId: '', action: '', from: '', to: '' },
      organizationSearch: '', userSearch: '',
      organizationDialog: false, userDialog: false, rolesDialog: false, passwordDialog: false,
      organizationForm: emptyOrg(), userForm: emptyUser(), roleTarget: null,
      roleReason: '',
      passwordForm: { userId: null, password: '', reason: '' },
      organizationTypes: [
        { value: 'group', label: '集团' }, { value: 'subsidiary', label: '子公司' },
        { value: 'department', label: '管理部门' }, { value: 'company', label: '公司' }, { value: 'other', label: '其他' }
      ]
    }
  },
  computed: {
    auditDirty() { return !sameQuery(this.auditFilters, this.appliedAuditFilters) },
    draftDirty() { return Boolean(this.editingKind) && JSON.stringify(this.draft(this.editingKind)) !== this.baseline },
    availableCapabilities() { return this.roleDefinitions.filter(role => role.builtin && role.code !== 'system_admin' && role.scopeType === this.roleDefinitionForm.scopeType) },
    activeOrganizations() { return this.organizations.filter(org => org.status === 'active') },
    parentCandidates() { return this.activeOrganizations.filter(org => org.id !== this.organizationForm.id) },
    activeUserCount() { return this.users.filter(user => user.status === 'active').length },
    roleCount() { return this.users.reduce((total, user) => total + (user.roles?.length || 0), 0) },
    filteredOrganizations() {
      const q = this.organizationSearch.trim().toLowerCase()
      return q ? this.organizations.filter(org => [org.name, org.code, ...(org.aliases || []).map(alias => alias.alias)].join(' ').toLowerCase().includes(q)) : this.organizations
    },
    filteredUsers() {
      const q = this.userSearch.trim().toLowerCase()
      return q ? this.users.filter(user => [user.name, user.username, user.organizationName].join(' ').toLowerCase().includes(q)) : this.users
    }
  },
  watch: {
    organizationForm: { deep: true, handler() { this.updateValidation('organization') } },
    userForm: { deep: true, handler() { this.updateValidation('user') } },
    roleDefinitionForm: { deep: true, handler() { this.updateValidation('roleDefinition') } },
    roleAssignments: { deep: true, handler() { this.updateValidation('roles') } },
    roleReason() { this.updateValidation('roles') },
    passwordForm: { deep: true, handler() { this.updateValidation('password') } }
  },
  mounted() { this.refreshAll(); window.addEventListener('beforeunload', this.guardUnload) },
  beforeUnmount() {
    this.disposed = true; this.loadSequence++; this.auditSequence++
    this.loadController?.abort(); this.auditController?.abort(); this.exportController?.abort()
    window.removeEventListener('beforeunload', this.guardUnload)
  },
  async beforeRouteLeave() { return this.editingKind ? this.requestClose(this.editingKind) : true },
  methods: {
    updateValidation(kind) {
      if (this.editingKind !== kind || !Object.keys(this.fieldErrors).length) return
      this.fieldErrors = validateAdminForm(kind, this.draft(kind), { originalUsername: this.originalUsername, scope: code => this.roleScope(code) })
      if (!Object.keys(this.fieldErrors).length) this.formError = ''
    },
    draft(kind) {
      return kind === 'roles' ? { assignments: this.roleAssignments, reason: this.roleReason } : this[`${kind}Form`]
    },
    beginEdit(kind) {
      this.editingKind = kind; this.fieldErrors = {}; this.formError = ''
      this.baseline = JSON.stringify(this.draft(kind))
      this[`${kind}Dialog`] = true
    },
    guardUnload(event) {
      if (this.saving || this.draftDirty) { event.preventDefault(); event.returnValue = '' }
    },
    async requestClose(kind) {
      if (this.saving || this.closePending) return false
      this.closePending = true
      try {
        if (this.draftDirty) await this.$confirm('填写的内容尚未保存，放弃后无法恢复。', '放弃本次修改？', {
          confirmButtonText: '放弃修改', cancelButtonText: '继续填写', type: 'warning', customClass: 'org-admin-confirm', closeOnClickModal: false
        })
        this.finishEdit(kind)
        return true
      } catch { return false }
      finally { this.closePending = false }
    },
    finishEdit(kind) {
      this[`${kind}Dialog`] = false; this.editingKind = ''; this.baseline = ''; this.fieldErrors = {}; this.formError = ''
      this.userForm.password = ''; this.passwordForm.password = ''
    },
    async validate(kind) {
      this.fieldErrors = validateAdminForm(kind, this.draft(kind), { originalUsername: this.originalUsername, scope: code => this.roleScope(code) })
      this.formError = Object.keys(this.fieldErrors).length ? '请修正下方标出的内容后再保存。' : ''
      if (!this.formError) return true
      this.saving = false
      await this.$nextTick()
      this.$el.querySelector(`[data-field="${Object.keys(this.fieldErrors)[0]}"] input, [data-field="${Object.keys(this.fieldErrors)[0]}"] textarea`)?.focus()
      return false
    },
    async refreshPage() { await this.refreshAll(); if (this.activeTab === 'audit') await this.refreshAudit() },
    async refreshAll() {
      const sequence = ++this.loadSequence
      this.loadController?.abort(); this.loadController = new AbortController()
      this.loading = true; this.loadError = ''
      try {
        const signal = this.loadController.signal
        const [orgResult, userResult, roleResult] = await Promise.all([organizationAdminApi.getOrganizations(signal), organizationAdminApi.getUsers(signal), organizationAdminApi.getRoles(signal)])
        if (this.disposed || sequence !== this.loadSequence) return
        if (![orgResult.organizations, userResult.users, roleResult.roles].every(Array.isArray)) throw new Error('管理数据格式异常，请重新加载。')
        this.organizations = orgResult.organizations; this.users = userResult.users
        this.roleDefinitions = [...roleResult.roles].sort((a, b) => Number(a.builtin) - Number(b.builtin))
        this.canManageRoles = Boolean(roleResult.canManage); this.hasLoaded = true
      } catch (error) {
        if (this.disposed || sequence !== this.loadSequence || error.name === 'AbortError') return
        this.loadError = error.message || '读取管理数据失败'
        if ([401,403].includes(error.status)) { this.hasLoaded = false; this.organizations = []; this.users = []; this.roleDefinitions = []; this.canManageRoles = false }
      } finally { if (!this.disposed && sequence === this.loadSequence) this.loading = false }
    },
    onTabChange(tab) { if (tab === 'audit') this.refreshAudit() },
    auditQuery() { return cleanAuditQuery(this.auditFilters) },
    async refreshAudit() {
      const query = this.auditQuery()
      const sequence = ++this.auditSequence
      this.auditController?.abort()
      this.auditLoading = false; this.auditError = ''; this.exportError = ''
      if (query.from && query.to && query.from > query.to) { this.auditError = '结束日期不得早于开始日期。'; return }
      this.auditController = new AbortController(); this.auditLoading = true
      try {
        const result = await organizationAdminApi.getAuditEvents(query, this.auditController.signal)
        if (this.disposed || sequence !== this.auditSequence) return
        if (!Array.isArray(result.events)) throw new Error('审计记录格式异常，请重新查询。')
        this.auditEvents = result.events; this.appliedAuditFilters = query; this.auditLoaded = true
      } catch (error) {
        if (this.disposed || sequence !== this.auditSequence || error.name === 'AbortError') return
        this.auditError = error.message || '读取审计记录失败'
        if ([401,403].includes(error.status)) { this.auditEvents = []; this.auditLoaded = false }
      } finally { if (!this.disposed && sequence === this.auditSequence) this.auditLoading = false }
    },
    async exportAudit() {
      if (this.exporting || this.auditLoading || this.auditDirty || this.auditError || !this.auditLoaded || !this.auditEvents.length) return
      this.exporting = true; this.exportError = ''; this.exportController = new AbortController()
      try {
        const blob = await organizationAdminApi.exportAuditEvents({ ...this.appliedAuditFilters }, this.exportController.signal)
        if (this.disposed) return
        const url = URL.createObjectURL(blob), link = document.createElement('a')
        link.href = url; link.download = `业务审计-${localDate()}.csv`
        document.body.appendChild(link); link.click(); link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      } catch (error) { if (!this.disposed && error.name !== 'AbortError') this.exportError = error.message || '导出审计记录失败，请重试。' }
      finally { if (!this.disposed) this.exporting = false }
    },
    organizationName(id) { return this.organizations.find(org => Number(org.id) === Number(id))?.name || '' },
    roleLabel(code) {
      return this.roleDefinitions.find(role => role.code === code)?.name || code
    },
    roleScope(code) { return this.roleDefinitions.find(role => role.code === code)?.scopeType },
    changeAssignmentScope(assignment) { assignment.organizationId = this.roleScope(assignment.code) === 'global' ? null : (assignment.organizationId || this.roleTarget.organizationId) },
    openRoleDefinition(row) { this.roleDefinitionForm = row ? { ...row, capabilities: [...row.capabilities], editing: true, reason: '' } : emptyRole(); this.beginEdit('roleDefinition') },
    async saveRoleDefinition() {
      if (this.saving) return
      this.saving = true
      try {
        if (!await this.validate('roleDefinition')) return
        const form = JSON.parse(JSON.stringify(this.roleDefinitionForm))
        if (form.editing) await organizationAdminApi.updateRole(form.code, form)
        else await organizationAdminApi.createRole(form)
        if (this.disposed) return
        this.$message.success(form.editing ? '角色配置已更新' : '角色已创建，请到用户账户分配')
        this.finishEdit('roleDefinition')
        await this.refreshAll()
      } catch (error) { this.formError = error.message || '保存角色失败' }
      finally { this.saving = false }
    },
    openOrganization(row) {
      this.organizationForm = row ? {
        id: row.id, code: row.code, name: row.name, organizationType: row.organization_type,
        status: row.status, effectiveFrom: row.effective_from, effectiveTo: row.effective_to,
        parentOrganizationId: row.parentOrganizationId, alias: '', reason: ''
      } : emptyOrg()
      this.beginEdit('organization')
    },
    async saveOrganization() {
      if (this.saving) return
      this.saving = true
      try {
        if (!await this.validate('organization')) return
        const payload = { ...this.organizationForm }
        if (payload.id) await organizationAdminApi.updateOrganization(payload.id, payload)
        else await organizationAdminApi.createOrganization(payload)
        if (this.disposed) return
        this.$message.success(payload.id ? '组织信息已更新' : '组织已创建')
        this.finishEdit('organization')
        await this.refreshAll()
      } catch (error) { this.formError = error.message || '保存组织失败' }
      finally { this.saving = false }
    },
    openUser(row) {
      this.userForm = row ? { id: row.id, username: row.username, name: row.name, password: '', organizationId: row.organizationId, email: row.email || '', status: row.status, reason: '' } : emptyUser()
      this.originalUsername = row?.username || ''; this.beginEdit('user')
    },
    async saveUser() {
      if (this.saving) return
      this.saving = true
      try {
        if (!await this.validate('user')) return
        const form = JSON.parse(JSON.stringify(this.userForm))
        if (form.id) await organizationAdminApi.updateUser(form.id, form)
        else await organizationAdminApi.createUser(form)
        if (this.disposed) return
        this.$message.success(form.id ? '账户信息已更新' : '账户已创建，请通过“分配角色”设置职责')
        this.finishEdit('user')
        await this.refreshAll()
      } catch (error) { this.formError = error.message || '保存账户失败' }
      finally { this.saving = false }
    },
    openRoles(user) {
      this.roleTarget = user
      this.roleAssignments = (user.roles || []).map(role => ({ code: role.code, organizationId: role.organizationId }))
      this.roleReason = ''
      this.beginEdit('roles')
    },
    async saveRoles() {
      if (this.saving) return
      this.saving = true
      try {
        if (!await this.validate('roles')) return
        const roles = this.roleAssignments.map(role => ({ code: role.code, organizationId: this.roleScope(role.code) === 'global' ? null : role.organizationId }))
        await organizationAdminApi.replaceRoles(this.roleTarget.id, roles, this.roleReason)
        if (this.disposed) return
        this.$message.success('角色分配已更新')
        this.finishEdit('roles')
        await this.refreshAll()
      } catch (error) { this.formError = error.message || '更新用户角色失败' }
      finally { this.saving = false }
    },
    openPassword(user) { this.passwordForm = { userId: user.id, password: '', reason: '' }; this.passwordTargetName = user.name || user.username; this.beginEdit('password') },
    async resetPassword() {
      if (this.saving) return
      this.saving = true
      try {
        if (!await this.validate('password')) return
        await organizationAdminApi.resetPassword(this.passwordForm.userId, this.passwordForm.password, this.passwordForm.reason)
        if (this.disposed) return
        this.$message.success('密码已重置')
        this.finishEdit('password')
      } catch (error) { this.formError = error.message || '重置密码失败' }
      finally { this.saving = false }
    }
  }
}
</script>

<style scoped>
.org-admin { --ink:#2c1b26; --muted:#6d5a65; --line:#e8d9e1; --teal:#941966; padding:30px 34px 44px; color:var(--ink); max-width:1500px; margin:0 auto; }
.page-heading { display:flex; justify-content:space-between; align-items:flex-end; gap:28px; margin:0 0 25px; }
h1 { margin:8px 0 7px; font-size:28px; letter-spacing:-.035em; font-weight:680; }
.page-heading p { margin:0; color:#75858a; font-size:13px; }
.heading-actions { display:flex; gap:9px; flex-shrink:0; }
.summary-strip { display:grid; grid-template-columns:1fr 1fr 1fr 1.6fr; border:1px solid var(--line); border-radius:9px; background:linear-gradient(105deg,#f5f8f6 0%,#fdf8fb 100%); margin-bottom:23px; overflow:hidden; }
.summary-strip>div { min-height:76px; display:grid; grid-template-columns:auto 1fr; align-content:center; column-gap:12px; padding:12px 19px; border-right:1px solid var(--line); }
.summary-label { grid-column:1/-1; color:#6d5a65; font-size:12px; margin-bottom:3px; }
.summary-strip strong { font-size:22px; line-height:1.2; font-variant-numeric:tabular-nums; }
.summary-strip small { align-self:end; padding-bottom:2px; color:#88969a; font-size:12px; }
.summary-note { display:flex!important; align-items:center; gap:10px; border:0!important; color:var(--portal-muted); font-size:12px; }
.status-dot { width:6px; height:6px; background:var(--portal-muted); border-radius:50%; }
.admin-tabs { background:#fff; border:1px solid var(--line); border-radius:9px; padding:0 20px 16px; box-shadow:0 8px 24px #153b3610; }
.toolbar { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:17px 0 14px; }
.search-box { max-width:370px; }
.table-hint { color:#869397; font-size:12px; }
.audit-filters { display:flex; flex-wrap:wrap; align-items:center; gap:9px; padding:17px 0 14px; }
.audit-select { width:190px; }
.audit-small { width:130px; }
.audit-date { width:150px; }
.audit-subline { display:block; margin-top:3px; color:#6d5a65; font-size:12px; }
.outcome-pill { display:inline-flex; border-radius:20px; padding:4px 9px; font-size:12px; }
.outcome-pill.success { color:#28796c; background:#e7f4ed; }
.outcome-pill.denied { color:#945b36; background:#fbf0e3; }
.outcome-pill.failed { color:#8b4642; background:#f8e9e7; }
.audit-hint { margin:0 0 8px; color:var(--portal-muted); font-size:13px; line-height:1.6; }
.audit-hint + .data-table { margin-top:16px; }
.table-actions { display:flex; align-items:center; gap:8px; }
.table-actions :deep(.el-button) { margin:0; padding-inline:0; min-width:44px; min-height:44px; flex-shrink:0; white-space:nowrap; }
.data-table { width:100%; }
.org-name,.user-cell { display:flex; align-items:center; gap:11px; }
.org-name strong,.user-cell strong { display:block; font-size:13px; font-weight:620; }
.org-name small,.user-cell small { display:block; margin-top:3px; color:#6d5a65; font-size:12px; }
.org-mark { width:30px; height:30px; display:grid; place-items:center; color:var(--portal-focus); background:var(--portal-accent-surface); border-radius:4px; font-size:12px; font-weight:700; }
.avatar { width:30px; height:30px; border-radius:50%; display:grid; place-items:center; background:#e9eef0; color:#35545c; font-weight:700; }
.alias-list { color:#526a70; font-size:12px; }
.muted { color:#9aa5a7; font-size:12px; }
.state-pill { display:inline-flex; align-items:center; border-radius:20px; padding:4px 9px; font-size:12px; }
.state-pill.active { color:#28796c; background:#e7f4ed; }
.state-pill.disabled { color:#8b6460; background:#f7ece8; }
.role-chips { display:flex; flex-wrap:wrap; gap:5px; }
.role-chip { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--portal-line); background:var(--portal-paper); border-radius:4px; padding:3px 6px; color:var(--portal-ink); font-size:12px; }
.role-chip i { color:var(--portal-muted); font-style:normal; border-left:1px solid var(--portal-line); padding-left:5px; }
.form-grid { display:grid; grid-template-columns:1fr 1fr; column-gap:18px; }
.form-grid :deep(.el-select),.form-grid :deep(.el-date-editor) { width:100%; }
.full-row { grid-column:1/-1; }
.role-dialog-intro { margin:0 0 20px; padding:12px; color:var(--el-text-color-secondary); background:var(--el-fill-color-light); border:1px solid var(--el-border-color-light); border-radius:4px; font-size:14px; line-height:1.6; }
.assignment-row { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr) 44px; gap:10px; align-items:center; margin-bottom:12px; }
.add-assignment { margin-bottom:20px; }
.capability-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; width:100%; }
.capability-grid :deep(.el-checkbox) { margin:0; height:auto; align-items:flex-start; white-space:normal; }
.capability-grid :deep(.el-checkbox__input) { margin-top:4px; }
.capability-grid small { display:block; color:#6d5a65; font-size:12px; line-height:1.6; margin-top:4px; }
.admin-tabs :deep(.el-tabs__header) { margin-bottom:0; }
.admin-tabs :deep(.el-tabs__item) { height:53px; font-size:13px; }
.admin-tabs :deep(.el-tabs__active-bar) { background:var(--el-color-primary); }



@media(max-width:850px) { .org-admin{padding:22px 16px}.page-heading{align-items:flex-start;flex-direction:column}.summary-strip{grid-template-columns:1fr 1fr}.summary-strip>div:nth-child(2){border-right:0}.summary-note{grid-column:1/-1;border-top:1px solid var(--line)!important}.toolbar{align-items:flex-start;flex-direction:column}.search-box{max-width:none;width:100%}.table-hint{display:none}.admin-tabs{padding:0 10px 12px} }
</style>

<style src="@/styles/organization-admin-table-layout.css"></style>
