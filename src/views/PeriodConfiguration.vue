<template>
  <main class="period-page portal-workbench" aria-labelledby="period-title">
    <header class="page-head">
      <div>
        <h1 id="period-title">发起填报</h1>
        <p class="subtitle">{{ showcase ? '为报告周期配置模板和期限，激活后生成填报任务。未填完可先保存草稿。' : '为报告周期配置模板和参与组织，激活后生成填报任务。未填完可先保存草稿。' }}</p>
      </div>
      <div class="head-actions">
        <el-button v-if="!showcase || !monthlyReportTypes.length" plain :disabled="!ready || loading || !!loadError || busy" @click="openType">新建报告类型</el-button>
        <el-button type="primary" :disabled="!ready || loading || !!loadError || busy" @click="openNew">新建填报计划</el-button>
      </div>
    </header>

    <DemoNextStep :text="showcase ? '激活填报计划后会生成填报任务。' : '激活填报计划后会为每个参与组织生成填报任务。'" label="下一步：去填报" to="/portal/monthly-filling" />

    <section v-if="ready" class="summary-strip" aria-label="填报计划统计">
      <div><span>填报计划</span><strong>{{ packages.length }}</strong></div>
      <div><span>待校验草稿</span><strong>{{ packages.filter(item => item.status === 'draft').length }}</strong></div>
      <div><span>已激活</span><strong>{{ packages.filter(item => item.status === 'active').length }}</strong></div>
      <div class="summary-note">默认截止时间按上海时区，设为周期结束后次月 2 日 23:59。</div>
    </section>

    <section class="package-list" :aria-busy="loading">
      <div class="section-heading"><div><h2>填报计划</h2></div><el-button text :loading="loading" :disabled="busy" @click="load">刷新列表</el-button></div>
      <div v-if="loadError" class="error-box" role="alert"><p>{{ ready ? '刷新失败，以下为上次读取的数据。' : '暂时无法读取填报计划。' }} {{ loadError }}</p><el-button :loading="loading" :disabled="busy" @click="load">重新加载</el-button></div>
      <div v-if="actionError" ref="actionFeedback" class="error-box" role="alert" tabindex="-1">{{ actionError }}</div>
      <div v-if="loading" class="empty-state" role="status">正在读取填报计划…</div>
      <div v-else-if="ready && !loadError && !packages.length" class="empty-state">{{ showcase ? '还没有填报计划。点击“新建填报计划”开始。' : '还没有填报计划。点击“新建填报计划”开始；如无可选报告类型，请先新建报告类型。' }}</div>
      <article v-for="item in packages" :key="item.id" class="package-card">
        <div class="package-mark" :class="item.cadence">{{ item.cadence === 'monthly' ? '月' : item.cadence === 'quarterly' ? '季' : '稿' }}</div>
        <div class="package-main">
          <div class="package-title"><h3>{{ item.report_type_name }}</h3><span class="period-code">{{ item.period_code }}</span><el-tag :type="statusType(item.status)" effect="plain">{{ statusLabel(item.status) }}</el-tag></div>
          <p class="package-meta"><span>{{ item.template_name }}<template v-if="item.template_version"> · v{{ item.template_version }}</template></span><span v-if="!showcase">{{ item.organizations.length }} 个参与组织</span><span>{{ item.task_count }} 个已生成任务</span><span>配置版本 {{ item.version }}</span></p>
          <div v-if="!showcase" class="org-chips"><span v-for="org in item.organizations.slice(0, 5)" :key="org.organization_id">{{ org.organization_name }}</span><span v-if="item.organizations.length > 5">+{{ item.organizations.length - 5 }}</span></div>
        </div>
        <div class="package-actions">
          <el-button text :aria-label="`查看 ${item.report_type_name} ${item.period_code}`" @click="inspect(item)">查看</el-button>
          <el-button v-if="['draft','validated'].includes(item.status)" text :disabled="busy || loading || !!loadError" @click="openEdit(item)">编辑</el-button>
          <el-button v-if="['draft','validated'].includes(item.status)" text :disabled="busy || loading || !!loadError" @click="validate(item)">校验配置</el-button>
          <el-button v-if="['draft','validated'].includes(item.status)" type="primary" plain :disabled="busy || loading || !!loadError" @click="activate(item)">激活并发起</el-button>
        </div>
      </article>
    </section>

    <el-dialog v-model="editorOpen" :title="editingId ? '编辑填报计划' : '新建填报计划'" width="min(1080px, calc(100vw - 16px))" top="4vh" class="package-dialog" :before-close="requestEditorClose" :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving">
      <el-form :disabled="saving" @submit.prevent>
      <div class="editor-layout">
        <nav class="step-rail" aria-label="发起步骤"><button v-for="(label,index) in stepLabels" :key="label" type="button" :disabled="saving" :class="{ active: wizardStep === index }" :aria-current="wizardStep === index ? 'step' : undefined" @click="goToStep(index)">0{{ index + 1 }} <small>{{ label }}</small></button></nav>
        <div ref="editorContent" class="editor-content">
          <p v-if="resourceError" class="error-box" role="alert">{{ resourceError }}</p>
          <el-alert title="未填完也可保存草稿。激活前需通过配置校验；激活后生成填报任务，配置不可修改。" type="info" :closable="false" show-icon />
          <section v-show="wizardStep === 0" class="form-section">
            <div class="form-section-head"><span>01</span><div><h3>报告周期与模板</h3><p>{{ showcase ? '激活前请选择报告周期和已发布模板版本。' : '激活前请选择报告类型、报告周期和已发布模板版本。' }}</p></div></div>
            <div class="form-grid">
              <label v-if="!hideReportTypeSelect">报告类型<el-select v-model="form.reportTypeId" placeholder="选择报告类型" :disabled="saving || periodIdentityLocked" @change="changeReportType"><el-option v-for="type in reportTypes" :key="type.id" :label="`${type.displayName} · ${type.cadence === 'monthly' ? '月度' : '季度'}`" :value="type.id" /></el-select></label>
              <ReportingPeriodPicker v-if="editorOpen" :key="editingId || 'new'" v-model="form.periodCode" :cadence="cadence" :disabled="saving || periodIdentityLocked || !form.reportTypeId" :disabled-hint="saving ? '正在保存配置，请稍候。' : periodIdentityLocked ? '该填报计划的报告类型和报告期间已锁定，无法修改。' : '请先选择报告类型，再选择报告期间。'" />
              <label class="wide">已发布模板版本<el-select v-model="form.templateVersionId" filterable placeholder="选择模板版本" @change="resetReferenceMappings"><el-option v-for="template in resources.templates" :key="template.versionId" :label="`${template.templateName} · v${template.version}${templateBlocked(template) ? ' · 财务区域可写，不适用于季度' : ''}`" :value="template.versionId" :disabled="templateBlocked(template)" /></el-select></label>
            </div>
            <div v-if="cadence === 'quarterly'" class="quarterly-compatibility" role="status">
              <el-alert :title="quarterlyTemplateWarning ? '当前模板不能用于季度激活' : '季度财务数据来自月度定稿'" :type="quarterlyTemplateWarning ? 'warning' : 'info'" :closable="false" show-icon />
              <p>{{ quarterlyTemplateWarning || '模板中的营收、利润区域须为只读。此处仅检查模板财务权限，激活前仍需校验月报来源、责任人等配置。' }}</p>
              <ul v-if="quarterlyTemplateWarning"><li v-for="(conflict, index) in selectedTemplate.quarterlyCompatibility.conflicts" :key="index">{{ conflict.sheetName }} / {{ conflict.fieldName }}<small>命名区域：{{ conflict.namedArea }}</small></li></ul>
              <p v-if="!hasQuarterlyTemplate">目前没有财务权限兼容的已发布模板。可以先保存草稿，请模板管理员准备新版本后再选择。</p>
              <details><summary>如何准备季度模板</summary><p>在“模板与组件”中为相关组件选择“新版本设计”，将营收、利润映射设为只读，完成组件审核发布；再为模板“创建新版本”，引用修正后的组件并审核发布。也可使用季度参考工作簿导入入口。</p></details>
              <router-link to="/portal/template" target="_blank" rel="noopener">打开模板与组件（新窗口）</router-link>
              <el-button text :loading="refreshingResources" @click="refreshTemplateResources">刷新可选模板</el-button>
            </div>
            <div v-if="isQuarterlyReference" class="reference-mapping">
              <div><strong>公司工作表映射</strong><small>显式选择参考模板中的公司页；不会按组织名称自动匹配。</small></div>
              <div v-for="org in selectedOrganizations" :key="`sheet-${org.id}`" class="reference-mapping-row">
                <span>{{ org.code }} · {{ org.name }}</span>
                <el-select v-model="form.configuration.referenceCompanySheets[org.id]" :aria-label="`${org.name}的公司工作表`" filterable placeholder="选择公司工作表">
                  <el-option v-for="sheet in selectedTemplate?.companySheets || []" :key="sheet.code" :label="`${sheet.name} · ${sheet.code}`" :value="sheet.code" />
                </el-select>
              </div>
            </div>
          </section>

          <section v-show="wizardStep === 1" class="form-section">
            <div class="form-section-head"><span>02</span><div><h3>{{ showcase ? '截止时间' : '参与组织与截止时间' }}</h3><p>{{ showcase ? '截止时间按上海时区填写；留空时采用周期结束后次月 2 日 23:59。' : '激活前至少选择一个组织。截止时间按上海时区填写；留空时采用周期结束后次月 2 日 23:59。' }}</p></div></div>
            <label v-if="!showcase">参与组织<el-select v-model="form.organizationIds" aria-label="参与组织" multiple filterable collapse-tags collapse-tags-tooltip placeholder="添加参与组织" class="full-select"><el-option v-for="org in selectableOrganizations" :key="org.id" :label="org.name" :value="org.id" /></el-select></label>
            <div v-if="selectedOrganizations.length" class="selected-orgs">
              <div v-for="org in selectedOrganizations" :key="org.id" :class="['selected-org-row', { 'is-single': showcase }]"><template v-if="!showcase"><span class="org-code">{{ org.code }}</span><strong>{{ org.name }}</strong></template><label>截止时间（上海时间） <el-date-picker v-model="form.deadlines[org.id]" :aria-label="`${showcase ? '任务' : org.name}的截止时间（上海时间）`" type="datetime" value-format="YYYY-MM-DDTHH:mm" format="YYYY-MM-DD HH:mm" placeholder="选择日期和时间" class="deadline-picker" /></label></div>
            </div>
            <div v-if="cadence === 'quarterly'" class="quarter-source"><label>月度定稿数据来源（激活前填写）<el-select v-model="form.configuration.monthlySourceReportTypeId" placeholder="选择月度报告类型"><el-option v-for="type in monthlyReportTypes" :key="type.id" :label="type.displayName" :value="type.id" /></el-select></label><small>用于季度营收、利润汇总；草稿阶段可暂不选择。</small></div>
            <el-collapse><el-collapse-item title="目标、指标与评分（选填）" name="metrics">
            <div class="subheading"><strong>目标定义（选填）</strong><el-button size="small" plain @click="addTarget">添加目标</el-button></div>
            <div v-for="(target, index) in form.targets" :key="index" class="repeat-row target-row">
              <label v-if="!showcase" class="repeat-field"><span>组织</span><el-select v-model="target.organizationId" :aria-label="'目标 ' + (index + 1) + '：组织'" placeholder="组织"><el-option v-for="org in selectedOrganizations" :key="org.id" :label="org.name" :value="org.id" /></el-select></label>
              <label class="repeat-field"><span>数值字段</span><el-select v-model="target.fieldDefinitionId" :aria-label="'目标 ' + (index + 1) + '：数值字段'" filterable placeholder="数值字段"><el-option v-for="field in numericFields" :key="field.id" :label="`${field.displayName} (${field.code})`" :value="field.id" /></el-select></label>
              <label class="repeat-field"><span>阶段</span><el-select v-model="target.phase" :aria-label="'目标 ' + (index + 1) + '：阶段'" placeholder="阶段"><el-option v-for="phase in phaseOptions" :key="phase.value" :label="phase.label" :value="phase.value" /></el-select></label>
              <label class="repeat-field"><span>目标期间</span><el-input v-model="target.phasePeriod" :aria-label="'目标 ' + (index + 1) + '：目标期间'" :placeholder="target.phase === 'annual' ? '如 2026' : target.phase === 'quarterly' ? '如 2026-Q4' : '如 2026-10'" /></label>
              <label class="repeat-field"><span>目标值</span><el-input v-model="target.amount" :aria-label="'目标 ' + (index + 1) + '：目标值'" placeholder="目标值" /></label>
              <el-button text type="danger" :aria-label="'移除目标 ' + (index + 1)" @click="form.targets.splice(index, 1)">移除</el-button>
              <el-checkbox v-if="target.phase === 'annual' && cadence === 'monthly'" v-model="target.generateMonthly" class="annual-generation">均分生成 12 个月度目标</el-checkbox>
            </div>
            <div v-if="cadence === 'monthly' && hasEconomicFields" class="monthly-weights">
              <div><strong>月度经营评分权重</strong><span>收入与利润两项合计须为 100%。</span></div>
              <label>营业收入权重（%） <el-input v-model.number="form.metricWeights.revenue" type="number" min="0" max="100" step="5" /></label>
              <label>利润总额权重（%） <el-input v-model.number="form.metricWeights.profit" type="number" min="0" max="100" step="5" /></label>
            </div>
            <div v-if="cadence === 'quarterly'" class="subheading"><strong>季度指标与权重</strong><el-button size="small" plain @click="addIndicator">添加指标</el-button></div>
            <div v-if="cadence === 'quarterly'" v-for="(indicator, index) in form.indicators" :key="`ind-${index}`" class="repeat-row indicator-row">
              <label v-if="!showcase" class="repeat-field"><span>组织</span><el-select v-model="indicator.organizationId" :aria-label="'指标 ' + (index + 1) + '：组织'" placeholder="组织"><el-option v-for="org in selectedOrganizations" :key="org.id" :label="org.name" :value="org.id" /></el-select></label>
              <label class="repeat-field"><span>指标类别</span><el-select v-model="indicator.category" :aria-label="'指标 ' + (index + 1) + '：指标类别'" placeholder="指标类别"><el-option label="重点业务" value="key_business" /><el-option label="重点工作" value="key_work" /></el-select></label>
              <label class="repeat-field"><span>指标编码</span><el-input v-model="indicator.code" :aria-label="'指标 ' + (index + 1) + '：指标编码'" placeholder="指标编码" /></label>
              <label class="repeat-field"><span>指标名称</span><el-input v-model="indicator.displayName" :aria-label="'指标 ' + (index + 1) + '：指标名称'" placeholder="指标名称" /></label>
              <label class="repeat-field"><span>权重百分比</span><el-input v-model="indicator.weight" :aria-label="'指标 ' + (index + 1) + '：权重百分比'" placeholder="权重 %" /></label>
              <label class="repeat-field"><span>最高分</span><el-input v-model="indicator.maximumScore" :aria-label="'指标 ' + (index + 1) + '：最高分'" type="number" min="0.01" placeholder="最高分" /></label>
              <label class="repeat-field"><span>审核归属部门</span><el-select v-model="indicator.ownerOrganizationId" :aria-label="'指标 ' + (index + 1) + '：审核归属部门'" placeholder="审核归属部门" @change="indicator.reviewerUserId = null"><el-option v-for="org in departments" :key="org.id" :label="org.name" :value="org.id" /></el-select></label>
              <label class="repeat-field"><span>指标审核人</span><el-select v-model="indicator.reviewerUserId" :aria-label="'指标 ' + (index + 1) + '：指标审核人'" placeholder="指标审核人"><el-option v-for="user in departmentUsers(indicator.ownerOrganizationId)" :key="user.id" :label="user.name" :value="user.id" /></el-select></label>
              <label class="repeat-field"><span>命名区域</span><el-input v-model="indicator.namedArea" :aria-label="'指标 ' + (index + 1) + '：命名区域'" placeholder="如 SUMMARY_TABLE_KEY_BUSINESS" /></label>
              <label class="repeat-field"><span>上级指标</span><el-select v-model="indicator.parentCode" :aria-label="'指标 ' + (index + 1) + '：上级指标'" clearable placeholder="上级指标"><el-option v-for="parent in form.indicators.slice(0, index).filter(item => item.organizationId === indicator.organizationId && item.code)" :key="parent.code" :label="parent.displayName || parent.code" :value="parent.code" /></el-select></label>
              <el-button text type="danger" :aria-label="'移除指标 ' + (index + 1)" @click="form.indicators.splice(index, 1)">移除</el-button>
              <label class="repeat-field"><span>评分方式</span><el-select v-model="indicator.scoringMode" :aria-label="'指标 ' + (index + 1) + '：评分方式'" class="scoring-mode" placeholder="评分方式"><el-option label="人工定性评分" value="manual" /><el-option label="业务公式自动评分" value="formula" /><el-option label="豁免，按满分" value="exempt" /></el-select></label>
              <el-select v-if="indicator.scoringMode === 'formula'" v-model="indicator.scoreFormulaVersionId" :aria-label="'指标 ' + (index + 1) + '：评分公式'" class="scoring-formula" filterable placeholder="选择已发布的评分公式"><el-option v-for="rule in publishedFormulas" :key="rule.versionId" :label="`${rule.displayName} · v${rule.version}`" :value="rule.versionId" /></el-select>
            </div>
            <p v-if="cadence === 'quarterly'" class="form-hint">指标可不添加；没有指标的组织跳过指标校验。添加后，该组织的指标权重须合计 100%，并补齐审核人等信息。草稿阶段可暂不填完整。</p>
            </el-collapse-item></el-collapse>
          </section>

          <section v-show="wizardStep === 2" class="form-section">
            <div class="form-section-head"><span>03</span><div><h3>责任分配与规则</h3><p>{{ showcase ? '分配流程责任人。激活后，责任分配及所选规则、公式版本固定。' : '为各组织分配流程责任人。激活后，责任分配及所选规则、公式版本固定。' }}</p></div></div>
            <el-alert v-if="missingFillers.length" type="warning" :closable="false" show-icon :title="showcase ? '尚未分配填报人' : `还有 ${missingFillers.length} 个组织未分配填报人`" :description="fillerHint" />
            <div class="subheading"><strong>任务责任人</strong><el-button size="small" plain @click="addAssignment">分配责任</el-button></div>
            <div v-for="(assignment, index) in form.assignments" :key="`assignment-${index}`" class="repeat-row assignment-row">
              <label v-if="!showcase" class="repeat-field"><span>组织</span><el-select v-model="assignment.organizationId" :aria-label="'责任分配 ' + (index + 1) + '：组织'" placeholder="组织" @change="syncAssignmentUser(assignment)"><el-option v-for="org in selectedOrganizations" :key="org.id" :label="org.name" :value="org.id" /></el-select></label>
              <label class="repeat-field"><span>职责</span><el-select v-model="assignment.responsibility" :aria-label="'责任分配 ' + (index + 1) + '：职责'" placeholder="职责" @change="syncAssignmentUser(assignment)"><el-option v-for="role in responsibilityOptions" :key="role.value" :label="role.label" :value="role.value" /></el-select></label>
              <label class="repeat-field"><span>责任人</span><el-select v-model="assignment.userId" :aria-label="'责任分配 ' + (index + 1) + '：责任人'" filterable placeholder="责任人" no-data-text="该组织下没有持有此职责的用户"><el-option v-for="user in assignableUsers(assignment)" :key="user.id" :label="assignmentUserLabel(user)" :value="user.id" /></el-select></label>
              <label class="repeat-field"><span>分配说明</span><el-input v-model="assignment.reason" :aria-label="'责任分配 ' + (index + 1) + '：分配说明'" placeholder="分配说明（可选）" /></label>
              <el-button text type="danger" :aria-label="'移除责任分配 ' + (index + 1)" @click="form.assignments.splice(index, 1)">移除</el-button>
            </div>
            <p v-if="form.assignments.length" class="form-hint">{{ showcase ? '责任人从演示账号中选择；列表为空时请检查账号职责。' : '责任人只能选择在所选组织下持有对应职责的用户；列表为空时，请先在「组织与用户」分配角色。' }}</p>
            <el-collapse><el-collapse-item title="规则、公式与预警（选填）" name="rules">
            <label class="rule-label">使用已发布规则与公式<el-select v-model="form.ruleVersionIds" multiple filterable collapse-tags collapse-tags-tooltip placeholder="选择规则版本"><el-option v-for="rule in resources.rules.filter(item => item.expression?.engine !== 'spreadjs-validator')" :key="rule.versionId" :label="`${rule.displayName} · ${{ validation: '校验规则', anomaly: '异常规则', formula: '业务公式' }[rule.ruleType] || rule.ruleType} v${rule.version}`" :value="rule.versionId" /></el-select></label>
            <div v-if="hasEconomicFields" class="threshold-editor">
              <div class="subheading"><strong>预警比例</strong><span>可按本周期调整；激活后不可修改。</span></div>
              <div class="threshold-grid">
                <label>同比变化预警线（%）<el-input-number v-model="form.ruleThresholds.yoyChangePercent" :min="0" :max="1000" :step="1" :precision="2" controls-position="right" /><small>绝对变化达到该比例时预警</small></label>
                <label>环比变化预警线（%）<el-input-number v-model="form.ruleThresholds.momChangePercent" :min="0" :max="1000" :step="1" :precision="2" controls-position="right" /><small>绝对变化达到该比例时预警</small></label>
                <label>目标完成率下限（%）<el-input-number v-model="form.ruleThresholds.targetCompletionMinPercent" :min="0" :max="1000" :step="1" :precision="2" controls-position="right" /><small>低于该比例时预警</small></label>
                <label>目标完成率上限（%）<el-input-number v-model="form.ruleThresholds.targetCompletionMaxPercent" :min="0" :max="1000" :step="1" :precision="2" controls-position="right" /><small>高于该比例时预警</small></label>
              </div>
              <p class="form-hint">新建填报计划使用系统默认值。比例范围为 0% 至 1000%；目标完成率下限必须低于上限。</p>
            </div>
            </el-collapse-item></el-collapse>
          </section>
          <section v-show="wizardStep === 3" class="form-section">
            <div class="form-section-head"><span>04</span><div><h3>检查并发起</h3></div></div>
            <el-descriptions class="review-summary" :column="1" border>
              <el-descriptions-item label="报告周期">{{ reportTypes.find(item => item.id === form.reportTypeId)?.displayName || '未选择' }} · {{ form.periodCode || '未填写' }}</el-descriptions-item>
              <el-descriptions-item label="模板">{{ selectedTemplate?.templateName || '未选择' }}</el-descriptions-item>
              <el-descriptions-item v-if="!showcase" label="参与组织">{{ selectedOrganizations.map(item => item.name).join('、') || '未选择' }}</el-descriptions-item>
              <el-descriptions-item label="期限">{{ showcase ? '未填写时使用周期结束后次月 2 日 23:59（上海时间）。' : '各组织已填写的期限优先；未填写时使用周期结束后次月 2 日 23:59（上海时间）。' }}</el-descriptions-item>
              <el-descriptions-item label="流程">填报 → 提交 → 部门审核{{ cadence === 'quarterly' ? ' → 评分' : '' }} → 定稿</el-descriptions-item>
            </el-descriptions>
            <el-alert v-if="missingResponsibilities.length" type="warning" :closable="false" show-icon :title="`还有 ${missingResponsibilities.length} 项职责未分配`" :description="missingResponsibilityHint" />
            <p class="review-note">点击“激活并发起”后，系统先保存并校验配置，通过后生成填报任务。责任人可在流程中心的“我的待办”办理；未通过时可按提示修改后重试。</p>
          </section>
          <div v-if="errorText" ref="editorFeedback" class="error-box" role="alert" tabindex="-1">{{ errorText }}</div>
        </div>
      </div>
      </el-form>
      <template #footer><div class="dialog-footer"><span>保存草稿不会生成填报任务。</span><div><el-button :disabled="saving" @click="requestEditorClose()">取消</el-button><el-button v-if="wizardStep > 0" :disabled="saving" @click="goToStep(wizardStep - 1)">上一步</el-button><el-button :loading="saving" @click="saveDraft">保存草稿</el-button><el-button v-if="wizardStep < 3" type="primary" :disabled="saving" @click="goToStep(wizardStep + 1)">下一步</el-button><el-button v-else type="primary" :loading="saving" @click="saveAndActivate">激活并发起</el-button></div></div></template>
    </el-dialog>

    <el-dialog v-model="typeDialog" title="新建报告类型" width="min(460px, calc(100vw - 32px))" class="period-type-dialog" :before-close="requestTypeClose" :close-on-click-modal="false" :close-on-press-escape="!typeSaving" :show-close="!typeSaving">
      <el-form :disabled="typeSaving" @submit.prevent>
      <div class="type-form"><label>类型编码（必填）<el-input v-model="typeForm.code" aria-label="类型编码（必填）" aria-describedby="report-type-code-hint" placeholder="例如 MONTHLY_ECONOMIC" /><small id="report-type-code-hint">2–40 位，以大写字母开头，仅限大写字母、数字和下划线。</small></label><label>显示名称（必填）<el-input v-model="typeForm.displayName" aria-label="显示名称（必填）" aria-describedby="report-type-name-hint" placeholder="例如 月度经营分析" /><small id="report-type-name-hint">最多 120 个字符，将显示在报告类型选项和填报计划列表中。</small></label><label>报告周期与流程<el-select v-model="typeForm.cadence"><el-option label="月度流程" value="monthly" /><el-option label="季度流程" value="quarterly" /></el-select></label><p>创建后不能切换月度或季度流程，请在创建前确认。</p></div>
      <p v-if="typeError" ref="typeFeedback" class="error-box" role="alert" tabindex="-1">{{ typeError }}</p>
      </el-form>
      <template #footer><el-button :disabled="typeSaving" @click="requestTypeClose()">取消</el-button><el-button type="primary" :loading="typeSaving" @click="createType">创建报告类型</el-button></template>
    </el-dialog>

    <el-drawer v-model="detailOpen" title="填报计划详情" size="min(540px, 100vw)" class="period-detail">
      <template v-if="detailPackage"><div class="detail-banner"><span>{{ detailPackage.period_code }}</span><el-tag :type="statusType(detailPackage.status)">{{ statusLabel(detailPackage.status) }}</el-tag></div><h3>{{ detailPackage.report_type_name }}</h3><p class="detail-muted">{{ detailPackage.template_name }} · 模板 v{{ detailPackage.template_version }} · 配置 v{{ detailPackage.version }}</p><template v-if="!showcase"><h4>参与组织</h4><div v-for="org in detailPackage.organizations" :key="org.organization_id" class="detail-row"><strong>{{ org.organization_name }}</strong><span>{{ org.deadline_at }} (UTC+08:00)</span></div></template><h4>目标与责任</h4><p>{{ detailPackage.targets.length }} 条目标，{{ detailPackage.assignments.length }} 项责任分配。</p><pre>{{ JSON.stringify(detailPackage.configuration, null, 2) }}</pre></template>
    </el-drawer>
  </main>
</template>

<script>
import { returnToWorkflow } from '@/utils/workflowNavigation'
import { ElMessage, ElMessageBox } from 'element-plus'
import { periodConfigurationApi } from '../api'
import ReportingPeriodPicker from '@/components/ReportingPeriodPicker.vue'
import DemoNextStep from '@/components/DemoNextStep.vue'
import { readPeriodResources, readPeriodList, restorePeriodForm, periodError, periodValidationErrors } from '@/utils/periodConfigurationState'
import { SHOWCASE, demoOrganization, DEMO_IDENTITIES } from '@/config/showcase'

const DEMO_USERNAMES = new Set(DEMO_IDENTITIES.map(item => item.username))

const ASSIGNMENT_ROLE_CODES = {
  filler: 'subsidiary_filler',
  submitter: 'subsidiary_submitter',
  department_reviewer: 'department_reviewer',
  scorer: 'score_editor',
  approver: 'management',
  finalizer: 'report_finalizer'
}

const emptyForm = (ruleThresholdDefaults = {}) => ({ reportTypeId: null, periodCode: '', templateVersionId: null, organizationIds: [], deadlines: {}, targets: [], indicators: [], metricWeights: { revenue: 50, profit: 50 }, assignments: [], ruleVersionIds: [], ruleThresholds: { ...ruleThresholdDefaults }, configuration: { referenceCompanySheets: {} } })

export default {
  name: 'PeriodConfiguration',
  components: { ReportingPeriodPicker, DemoNextStep },
  data() {
    return { showcase: SHOWCASE, showcaseOrganization: null, ready: false, loadError: '', actionError: '', resourceError: '', refreshingResources: false, typeError: '', typeSaving: false, rowBusy: false, editorSession: 0, typeSession: 0, formBaseline: '', typeBaseline: '', closing: false, wizardStep: 0, loading: false, saving: false, packages: [], reportTypes: [], resources: { organizations: [], users: [], templates: [], fields: [], rules: [], ruleThresholdDefaults: {} }, editorOpen: false, typeDialog: false, detailOpen: false, detailPackage: null, editingId: null, errorText: '', form: emptyForm(), typeForm: { code: '', displayName: '', cadence: 'monthly' }, responsibilityOptions: [
      { value: 'filler', label: '填报人' }, { value: 'submitter', label: '提交人' }, { value: 'department_reviewer', label: '部门审核人' }, { value: 'scorer', label: '评分人' }, { value: 'approver', label: '审批人' }, { value: 'finalizer', label: '定稿人' }
    ] }
  },
  computed: {
    busy() { return this.saving || this.typeSaving || this.rowBusy },
    editorDirty() { return this.editorOpen && JSON.stringify(this.form) !== this.formBaseline },
    typeDirty() { return this.typeDialog && JSON.stringify(this.typeForm) !== this.typeBaseline },
    hasEconomicFields() { return (this.selectedTemplate?.fieldCodes || []).some(code => /(?:REVENUE|PROFIT|INCOME)/i.test(code)) },
    missingResponsibilities() {
      return this.selectedOrganizations.flatMap(org => this.responsibilityOptions
        .filter(role => (this.cadence === 'quarterly' || role.value !== 'scorer') && !this.form.assignments.some(item => item.organizationId === org.id && item.responsibility === role.value && item.userId))
        .map(role => this.showcase ? role.label : `${org.name}：${role.label}`))
    },
    missingFillers() {
      return this.selectedOrganizations
        .filter(org => !this.form.assignments.some(item => Number(item.organizationId) === Number(org.id) && item.responsibility === 'filler' && item.userId))
        .map(org => this.showcase ? '当前任务' : org.name)
    },
    stepLabels() {
      return this.showcase ? ['周期与模板', '期限', '责任与规则', '检查并发起'] : ['周期与模板', '组织与期限', '责任与规则', '检查并发起']
    },
    fillerHint() {
      if (this.showcase) return '填报人负责实际录入；提交人、审核人和定稿人必须选择持有对应职责的用户。'
      return this.resources.defaultAdministrator
        ? '填报人负责实际录入；提交、审核、定稿必须选择持有对应职责的用户，未分配不能激活。'
        : '当前没有可用的系统管理员，请为每个组织补齐填报人、提交人、审核人、审批人和定稿人。'
    },
    missingResponsibilityHint() {
      return this.resources.defaultAdministrator
        ? '请为每项职责选择实际持有该职责的用户；未分配的职责不能激活。审批人留空时可自动由系统管理员承担。'
        : '请为每项职责选择实际持有该职责的用户；未分配的职责不能激活。'
    },
    periodIdentityLocked() { return Boolean(this.editingId && (!String(this.editingId).startsWith('draft-') || this.packages.find(item => item.id === this.editingId)?.originalPackageId)) },
    cadence() { return this.reportTypes.find(item => item.id === this.form.reportTypeId)?.cadence || 'monthly' },
    monthlyReportTypes() { return this.reportTypes.filter(item => item.cadence === 'monthly' && item.status === 'active') },
    hideReportTypeSelect() { return this.showcase && this.monthlyReportTypes.length === 1 },
    showcaseDefaultReportType() { return this.monthlyReportTypes.find(item => item.code === 'MONTHLY_REPORT') || this.monthlyReportTypes[0] || null },
    selectedTemplate() { return this.resources.templates.find(item => Number(item.versionId) === Number(this.form.templateVersionId)) || null },
    quarterlyTemplateWarning() { return this.cadence === 'quarterly' && this.selectedTemplate?.quarterlyCompatibility?.compatible === false ? this.selectedTemplate.quarterlyCompatibility.message : '' },
    hasQuarterlyTemplate() { return this.resources.templates.some(item => item.quarterlyCompatibility?.compatible === true) },
    isQuarterlyReference() { return this.cadence === 'quarterly' && Boolean(this.selectedTemplate?.isQuarterlyReference) },
    selectableOrganizations() { return this.isQuarterlyReference ? this.resources.organizations.filter(item => item.organizationType === 'subsidiary') : this.resources.organizations },
    departments() { return this.resources.organizations.filter(item => item.organizationType === 'department') },
    publishedFormulas() { return this.resources.rules.filter(item => item.ruleType === 'formula') },
    selectedOrganizations() { return this.resources.organizations.filter(item => this.form.organizationIds.includes(item.id)) },
    numericFields() { return this.resources.fields.filter(item => this.selectedTemplate?.fieldCodes?.includes(item.code) && ['integer', 'decimal'].includes(item.dataType)) },
    phaseOptions() { return this.cadence === 'monthly' ? [{ value: 'annual', label: '年度' }, { value: 'monthly', label: '月度' }, { value: 'cumulative', label: '累计' }] : [{ value: 'annual', label: '年度' }, { value: 'quarterly', label: '季度' }, { value: 'cumulative', label: '累计' }] }
  },
  watch: {
    'form.organizationIds'(ids) {
      for (const id of ids) if (!this.form.deadlines[id]) this.form.deadlines[id] = ''
      this.form.targets = this.form.targets.filter(item => item.organizationId == null || ids.includes(item.organizationId))
      this.form.indicators = this.form.indicators.filter(item => item.organizationId == null || ids.includes(item.organizationId))
      this.form.assignments = this.form.assignments.filter(item => item.organizationId == null || ids.includes(item.organizationId))
      const sheetMappings = this.form.configuration.referenceCompanySheets || (this.form.configuration.referenceCompanySheets = {})
      for (const organizationId of Object.keys(sheetMappings)) if (!ids.includes(Number(organizationId))) delete sheetMappings[organizationId]
    }
  },
  async mounted() {
    this._alive = true; this._loadSequence = 0
    window.addEventListener('beforeunload', this.beforeUnload)
    if (await this.load()) this.openRequestedPackage()
  },
  beforeUnmount() { this._alive = false; this._loadSequence++; this.editorSession++; this.typeSession++; window.removeEventListener('beforeunload', this.beforeUnload) },
  async beforeRouteLeave() { return this.canLeave() },
  methods: {
    goToStep(step) {
      if (this.saving || step < 0 || step > 3) return
      this.wizardStep = step
      this.$nextTick(() => { if (this.$refs.editorContent) this.$refs.editorContent.scrollTop = 0 })
    },
    beforeUnload(event) { if (this.busy || this.editorDirty || this.typeDirty) { event.preventDefault(); event.returnValue = '' } },
    async confirmDiscard() {
      if (this.closing) return false
      this.closing = true
      try { await ElMessageBox.confirm(this.typeDirty ? '报告类型尚未创建。放弃后将丢失本次填写；也可以继续填写并创建报告类型。' : '本次修改尚未保存。放弃后将丢失这些修改；也可以继续填写并保存草稿。', '放弃未保存的填写？', { confirmButtonText: '放弃填写', cancelButtonText: '继续填写', type: 'warning', closeOnClickModal: false, customClass: 'period-discard-confirm' }); return this._alive }
      catch { return false }
      finally { this.closing = false }
    },
    async canLeave() {
      if (this.busy) { ElMessage.info('正在处理配置，请等待结果后再离开。'); return false }
      if (!this.editorDirty && !this.typeDirty) return true
      return this.confirmDiscard()
    },
    async requestEditorClose(done) {
      if (this.saving) return
      const session = this.editorSession
      if (this.editorDirty && !await this.confirmDiscard()) return
      if (!this._alive || session !== this.editorSession || this.saving) return
      this.editorSession++; this.editorOpen = false
      if (typeof done === 'function') done()
    },
    async requestTypeClose(done) {
      if (this.typeSaving) return
      const session = this.typeSession
      if (this.typeDirty && !await this.confirmDiscard()) return
      if (!this._alive || session !== this.typeSession || this.typeSaving) return
      this.typeSession++; this.typeDialog = false
      if (typeof done === 'function') done()
    },
    feedback(ref) { this.$nextTick(() => { if (this._alive) this.$refs[ref]?.focus() }) },
    openType() {
      if (!this.ready || this.busy || this.editorOpen || this.typeDialog) return
      this.typeSession++; this.typeError = ''; this.typeForm = { code: '', displayName: '', cadence: 'monthly' }
      this.typeBaseline = JSON.stringify(this.typeForm); this.typeDialog = true
    },
    openRequestedPackage() {
      if (this._requestHandled || !this.ready || !this._alive) return
      this._requestHandled = true
      if (this.$route.query.start === 'new') this.openNew()
      else if (this.$route.query.packageId) {
        const item = this.packages.find(p => String(p.id) === String(this.$route.query.packageId))
        if (item && ['draft', 'validated'].includes(item.status)) this.openEdit(item)
        else if (item) this.inspect(item)
        else { this.actionError = '未找到指定填报计划，请刷新列表后重试。'; this.feedback('actionFeedback') }
      }
    },
    changeReportType() {
      const pattern = this.cadence === 'monthly' ? /^\d{4}-(0[1-9]|1[0-2])$/ : /^\d{4}-Q[1-4]$/
      if (this.form.periodCode && !pattern.test(this.form.periodCode)) this.form.periodCode = ''
      this.errorText = ''
    },
    templateBlocked(template) { return this.cadence === 'quarterly' && template.quarterlyCompatibility?.compatible === false },
    async refreshTemplateResources() {
      if (this.refreshingResources || this.saving) return
      const session = this.editorSession
      this.refreshingResources = true; this.resourceError = ''
      try {
        const resources = readPeriodResources(await periodConfigurationApi.getResources())
        if (!this._alive || session !== this.editorSession) return
        this.resources = resources; ElMessage.success('可选模板已刷新，当前草稿内容已保留')
      } catch (error) { if (this._alive && session === this.editorSession) this.resourceError = periodError(error, '可选模板刷新失败，请重试。') }
      finally { if (this._alive) this.refreshingResources = false }
    },
    async load() {
      const sequence = ++this._loadSequence
      this.loading = true
      try {
        const [types, rawResources, rawPackages] = await Promise.all([periodConfigurationApi.getReportTypes(), periodConfigurationApi.getResources(), periodConfigurationApi.getPackages()])
        let resources = readPeriodResources(rawResources)
        if (SHOWCASE) {
          this.showcaseOrganization = demoOrganization(resources.organizations)
          resources = { ...resources, organizations: this.showcaseOrganization ? [this.showcaseOrganization] : [] }
        }
        const packages = readPeriodList(rawPackages?.packages)
        if (!Array.isArray(types?.reportTypes) || types.reportTypes.some(item => !item || typeof item !== 'object')) throw new Error('报告类型返回不完整，请重新加载。')
        if (!this._alive || sequence !== this._loadSequence) return false
        this.reportTypes = types.reportTypes; this.resources = resources; this.packages = packages
        this.ready = true; this.loadError = ''
        this.openRequestedPackage()
        return true
      } catch (error) {
        if (this._alive && sequence === this._loadSequence) this.loadError = periodError(error, '网络连接失败，请重新加载。')
        return false
      } finally { if (this._alive && sequence === this._loadSequence) this.loading = false }
    },
    statusLabel(status) { return ({ draft: '草稿', validated: '已校验', active: '已激活', closed: '已结束' })[status] || status },
    statusType(status) { return status === 'active' ? 'success' : status === 'closed' ? 'info' : status === 'validated' ? 'warning' : '' },
    openNew() { if (!this.ready || this.busy || this.editorOpen || this.typeDialog) return; this.editorSession++; this.wizardStep = 0; this.form = emptyForm(this.resources.ruleThresholdDefaults); if (this.showcase && this.monthlyReportTypes.length === 1) this.form.reportTypeId = this.showcaseDefaultReportType?.id || null; this.restrictToDemoOrganization(); if (this.showcase) this.form.assignments = this.showcaseAssignments(); this.editingId = null; this.errorText = ''; this.resourceError = ''; this.formBaseline = JSON.stringify(this.form); this.editorOpen = true },
    addTarget() { this.form.targets.push({ organizationId: this.form.organizationIds[0] || null, fieldDefinitionId: null, phase: this.cadence === 'quarterly' ? 'quarterly' : 'monthly', phasePeriod: this.form.periodCode, amount: '' }) },
    departmentUsers(organizationId) { return this.resources.users.filter(user => Number(user.organizationId) === Number(organizationId)) },
    assignmentRoleCode(responsibility) { return ASSIGNMENT_ROLE_CODES[responsibility] || '' },
    userMatchesAssignment(user, assignment) {
      const code = this.assignmentRoleCode(assignment.responsibility)
      if (!assignment.organizationId || !code) return true
      const roles = user.roles || []
      if (assignment.responsibility === 'approver'
        && roles.some(role => role.code === 'system_admin' && role.organizationId == null)) return true
      return roles.some(role => role.code === code && (
        (role.organizationId == null && code === 'management')
        || Number(role.organizationId) === Number(assignment.organizationId)
        || (code === 'department_reviewer' && Number(role.organizationId) === Number(user.organizationId))
      ))
    },
    assignableUsers(assignment) {
      return (this.resources.users || []).filter(user => (!this.showcase || DEMO_USERNAMES.has(user.username))
        && this.userMatchesAssignment(user, assignment))
    },
    userOrganizationName(user) {
      if (user.organizationId == null) return '全局'
      return (this.resources.organizations || []).find(org => Number(org.id) === Number(user.organizationId))?.name || '未归属组织'
    },
    assignmentUserLabel(user) { return this.showcase ? user.name : `${user.name} · ${user.username} · ${this.userOrganizationName(user)}` },
    restrictToDemoOrganization() {
      if (!this.showcase || !this.showcaseOrganization) return
      const id = this.showcaseOrganization.id
      this.form.organizationIds = [id]
      this.form.deadlines = { [id]: this.form.deadlines?.[id] || '' }
      const belongs = item => item.organizationId == null || Number(item.organizationId) === Number(id)
      this.form.targets = (this.form.targets || []).filter(belongs)
      this.form.indicators = (this.form.indicators || []).filter(belongs)
      this.form.assignments = (this.form.assignments || []).filter(belongs)
      this.form.configuration.referenceCompanySheets = {}
    },
    showcaseAssignments() {
      if (!this.showcase || !this.showcaseOrganization) return []
      const id = this.showcaseOrganization.id
      const userId = username => (this.resources.users || []).find(user => user.username === username)?.id
      const fillerOne = userId('组织填报人一'), fillerTwo = userId('browser-scoped-user-2'), reviewer = userId('demo-reviewer')
      const assignments = []
      if (fillerOne) assignments.push({ organizationId: id, responsibility: 'filler', userId: fillerOne, reason: '' })
      if (fillerTwo) assignments.push({ organizationId: id, responsibility: 'filler', userId: fillerTwo, reason: '' })
      if (fillerOne) assignments.push({ organizationId: id, responsibility: 'submitter', userId: fillerOne, reason: '' })
      if (reviewer) for (const responsibility of ['department_reviewer', 'approver', 'finalizer'])
        assignments.push({ organizationId: id, responsibility, userId: reviewer, reason: '' })
      return assignments
    },
    syncAssignmentUser(assignment) {
      if (!assignment.userId) return
      if (!this.assignableUsers(assignment).some(user => Number(user.id) === Number(assignment.userId))) assignment.userId = null
    },
    normalizeAssignments() { (this.form.assignments || []).forEach(item => this.syncAssignmentUser(item)) },
    addIndicator() { this.form.indicators.push({ organizationId: this.form.organizationIds[0] || null, category: 'key_business', code: '', displayName: '', weight: '', maximumScore: '', ownerOrganizationId: null, reviewerUserId: null, namedArea: 'QUARTERLY_TABLE_KEY_BUSINESS', type: 'qualitative', scoringMode: 'manual', scoreFormulaVersionId: null, exempt: false }) },
    addAssignment() { this.form.assignments.push({ organizationId: this.form.organizationIds[0] || null, responsibility: 'filler', userId: null, reason: '' }) },
    resetReferenceMappings() {
      this.form.configuration.referenceCompanySheets = {}
      if (this.isQuarterlyReference) this.form.organizationIds = this.form.organizationIds.filter(id => this.selectableOrganizations.some(org => org.id === id))
    },
    apiDeadline(value) { return value ? `${value}:00+08:00` : null },
    payload() { return { draftOnly: true, editorState: JSON.parse(JSON.stringify(this.form)), reportTypeId: this.form.reportTypeId, periodCode: this.form.periodCode, templateVersionId: this.form.templateVersionId,
      organizations: this.selectedOrganizations.map(org => ({ organizationId: org.id, deadlineAt: this.apiDeadline(this.form.deadlines[org.id]) })),
      targets: this.form.targets.map(({ generateMonthly, ...target }) => target),
      generateMonthlyTargetsFromAnnual: this.form.targets.filter(target => target.generateMonthly).map(target => ({ organizationId: target.organizationId, fieldDefinitionId: target.fieldDefinitionId, year: target.phasePeriod })),
      indicators: this.form.indicators.map(item => ({ ...item, weight: Number(item.weight), maximumScore: Number(item.maximumScore),
        scoreFormulaVersionId: item.scoringMode === 'formula' ? Number(item.scoreFormulaVersionId) || null : null,
        exempt: item.scoringMode === 'exempt' })), metricWeights: this.hasEconomicFields ? this.form.metricWeights : null, assignments: this.form.assignments.filter(item => item.organizationId && item.userId),
      ruleVersionIds: [...new Set([...this.form.ruleVersionIds, ...this.form.indicators.filter(item => item.scoringMode === 'formula').map(item => Number(item.scoreFormulaVersionId)).filter(Number.isSafeInteger)])], ruleThresholds: this.form.ruleThresholds, configuration: this.form.configuration } },
    async saveDraft() { return this.persistPackage(false) },
    async saveAndActivate() { return this.persistPackage(true) },
    async persistPackage(activate) {
      if (this.saving || !this.editorOpen || !this.ready) return
      if (activate && (!this.form.reportTypeId || !(this.cadence === 'monthly' ? /^\d{4}-(0[1-9]|1[0-2])$/ : /^\d{4}-Q[1-4]$/).test(this.form.periodCode))) {
        this.wizardStep = 0
        this.errorText = !this.form.reportTypeId ? '请先选择报告类型。' : '请选择有效的报告期间，再发起填报。'
        this.feedback('editorFeedback'); return
      }
      const session = this.editorSession
      const current = () => this._alive && session === this.editorSession && this.editorOpen
      this.errorText = ''; this.saving = true
      try {
        const payload = this.payload(), baseline = JSON.stringify(this.form)
        const saved = this.editingId ? await periodConfigurationApi.updatePackage(this.editingId, payload) : await periodConfigurationApi.createPackage(payload)
        if (!current()) return
        if (saved?.package?.id == null) throw new Error('服务器未返回填报计划标识，请重新加载列表核对保存结果。')
        this.editingId = saved.package.id; this.formBaseline = baseline
        if (activate) {
          const checked = await periodConfigurationApi.validatePackage(this.editingId)
          if (!current()) return
          this.editingId = checked.packageId || this.editingId
          if (checked.valid !== true) { this.errorText = periodValidationErrors(checked); this.feedback('editorFeedback'); return }
          const result = await periodConfigurationApi.activatePackage(this.editingId)
          if (!current()) return
          ElMessage.success('已激活，生成 ' + result.taskCount + ' 个填报任务')
        } else ElMessage.success('填报计划草稿已保存')
        this.editorOpen = false; this.saving = false
        if (returnToWorkflow(this)) return
        await this.load()
      } catch (error) { if (current()) { this.errorText = periodError(error); this.feedback('editorFeedback') } }
      finally { if (this._alive && session === this.editorSession) this.saving = false }
    },
    async createType() {
      if (this.typeSaving || !this.typeDialog) return
      this.typeError = ''
      if (!this.typeForm.code.trim() || !this.typeForm.displayName.trim()) { this.typeError = '请填写类型编码和显示名称。'; this.feedback('typeFeedback'); return }
      const session = this.typeSession
      this.typeSaving = true
      try {
        await periodConfigurationApi.createReportType({ ...this.typeForm, code: this.typeForm.code.trim(), displayName: this.typeForm.displayName.trim() })
        if (!this._alive || session !== this.typeSession) return
        this.typeDialog = false; this.typeSaving = false
        ElMessage.success('报告类型已创建'); await this.load()
      } catch (error) { if (this._alive && session === this.typeSession) { this.typeError = periodError(error); this.feedback('typeFeedback') } }
      finally { if (this._alive && session === this.typeSession) this.typeSaving = false }
    },
    openEdit(item) {
      if (!this.ready || this.busy || this.editorOpen || this.typeDialog || !['draft', 'validated'].includes(item.status)) return
      this.editorSession++; this.resourceError = ''
      try {
      this.wizardStep = 0
      this.editingId = item.id
      this.errorText = ''
      if (item.draftInput?.editorState) {
        this.form = restorePeriodForm(emptyForm(this.resources.ruleThresholdDefaults), item.draftInput.editorState)
        this.restrictToDemoOrganization()
        this.editorOpen = true
        this.$nextTick(() => { this.normalizeAssignments(); this.formBaseline = JSON.stringify(this.form) })
        return
      }
      this.form = { reportTypeId: item.report_type_id, periodCode: item.period_code, templateVersionId: item.template_version_id,
        organizationIds: item.organizations.map(org => org.organization_id), deadlines: Object.fromEntries(item.organizations.map(org => [org.organization_id, String(org.deadline_at || '').slice(0, 16)])),
        targets: item.targets.filter(target => !target.generated_from_annual).map(target => ({ organizationId: target.organization_id, fieldDefinitionId: target.field_definition_id, phase: target.target_phase, phasePeriod: target.phase_period, amount: target.amount_decimal,
          generateMonthly: target.target_phase === 'annual' && item.targets.some(month => month.organization_id === target.organization_id && month.field_definition_id === target.field_definition_id && month.generated_from_annual) })),
        indicators: (item.configuration.indicators || []).map(indicator => ({ ...indicator,
          scoringMode: indicator.exempt || indicator.isExempt ? 'exempt' : indicator.scoreFormulaVersionId || indicator.formulaVersionId ? 'formula' : 'manual' })), metricWeights: item.configuration.metricWeights || { revenue: 50, profit: 50 }, assignments: item.assignments.map(assignment => ({ organizationId: assignment.organization_id, responsibility: assignment.responsibility, userId: assignment.user_id, reason: assignment.reason || '' })),
        ruleVersionIds: item.configuration.ruleVersionIds || [], ruleThresholds: { ...this.resources.ruleThresholdDefaults, ...(item.configuration.ruleThresholds || {}) }, configuration: { referenceCompanySheets: {}, ...item.configuration } }
      this.restrictToDemoOrganization()
      this.editorOpen = true
      this.$nextTick(() => { this.normalizeAssignments(); this.formBaseline = JSON.stringify(this.form) })
      } catch (error) { this.actionError = periodError(error); this.feedback('actionFeedback') }
    },
    inspect(item) { this.detailPackage = item; this.detailOpen = true },
    async validate(item) {
      if (this.busy) return
      this.rowBusy = true; this.actionError = ''
      try {
        const result = await periodConfigurationApi.validatePackage(item.id)
        if (!this._alive) return
        await this.load()
        if (!this._alive) return
        if (result.valid === true) ElMessage.success('配置校验通过，可激活并发起填报')
        else {
          await ElMessageBox.alert(periodValidationErrors(result), '激活前需补充', { confirmButtonText: '继续编辑', type: 'info', customClass: 'period-discard-confirm' })
          if (this._alive) { this.rowBusy = false; this.openEdit(this.packages.find(candidate => candidate.id === (result.packageId || item.id)) || item) }
        }
      }
      catch (error) { if (this._alive && error !== 'cancel' && error !== 'close') { this.actionError = periodError(error); this.feedback('actionFeedback') } }
      finally { if (this._alive) this.rowBusy = false }
    },
    async activate(item) {
      if (this.busy) return
      this.rowBusy = true; this.actionError = ''
      try {
        await ElMessageBox.confirm(`激活“${item.report_type_name} ${item.period_code}”将为 ${item.organizations.length} 个组织一次性生成任务，激活后配置不可修改。`, '确认激活填报计划', { confirmButtonText: '激活并生成任务', cancelButtonText: '返回检查', type: 'warning', customClass: 'period-discard-confirm' })
        if (!this._alive) return
        const checked = await periodConfigurationApi.validatePackage(item.id)
        if (!this._alive) return
        if (checked.valid !== true) { await ElMessageBox.alert(periodValidationErrors(checked), '激活前需补充', { confirmButtonText: '继续编辑', type: 'info', customClass: 'period-discard-confirm' }); if (this._alive) { this.rowBusy = false; this.openEdit(item) }; return }
        const result = await periodConfigurationApi.activatePackage(checked.packageId || item.id)
        if (!this._alive) return
        ElMessage.success(`已激活，生成 ${result.taskCount} 个填报任务`)
        this.rowBusy = false
        if (returnToWorkflow(this)) return
        await this.load()
      } catch (error) { if (this._alive && error !== 'cancel' && error !== 'close') { this.actionError = periodError(error); this.feedback('actionFeedback') } }
      finally { if (this._alive) this.rowBusy = false }
    }
  }
}
</script>

<style scoped>
.period-page.period-page {
  --portal-primary: #941966;
  --el-color-primary: #941966;
  --el-color-primary-light-3: #7a1454;
  --el-color-primary-dark-2: #6f114b;
  --el-text-color-placeholder: #6d5a65;
  overflow-wrap: anywhere;
}
.period-page :deep(.el-alert--info.is-light) { color: #6d5a65; }
.period-page :deep(.el-alert--warning.is-light) { color: #8a5300; }
.period-page :deep(.el-tag--success) { --el-tag-text-color: #326b1b; }
.period-page :deep(.el-tag--warning) { --el-tag-text-color: #8a5300; }
.period-page :deep(.el-button--danger.is-text) { --el-button-text-color: #b42318; }
.period-page :is(button, [tabindex]):focus-visible { outline: 2px solid #941966; outline-offset: 2px; }
.period-page .error-box { color: #922419; background: #fff5f4; border-color: #e8b4ae; font-size: 14px; line-height: 1.6; }
.error-box p { margin: 0 0 12px; }
.period-page .package-title { flex-wrap: wrap; }
.period-page .package-title h3 { min-width: 0; }
.period-code, .package-title .el-tag { flex-shrink: 0; }
.period-page .repeat-row > *, .period-page .form-grid > * { min-width: 0; }
.period-page .dialog-footer > div { display: flex; flex-wrap: wrap; gap: 8px; }
.period-page .dialog-footer .el-button + .el-button { margin-left: 0; }
.period-page :deep(.el-button) { min-height: 44px; height: auto; white-space: normal; }
.period-page .demo-next :deep(.el-button) { min-height: 24px; height: auto; padding: 5px 11px; font-size: 12px; }
.period-page .form-hint, .period-page .quarter-source small, .period-page .reference-mapping small { color: #6d5a65; }
@media (max-width: 600px) {
  .period-page .package-card { flex-wrap: wrap; }
  .period-page .package-main { flex-basis: calc(100% - 60px); }
  .period-page .package-actions { flex-basis: 100%; flex-wrap: wrap; justify-content: flex-end; }
  .period-page .form-grid, .period-page .repeat-row, .period-page .monthly-weights, .period-page .threshold-grid { grid-template-columns: minmax(0, 1fr); }
  .period-page .editor-content { padding-inline: 12px; }
  .period-page :deep(.el-input__inner), .period-page :deep(.el-select__wrapper) { font-size: 16px; }
}

.step-rail button { display:flex; flex-direction:column; gap:4px; background:transparent; border:1px solid transparent; border-radius:4px; text-align:left; padding:12px; margin-bottom:8px; width:100%; cursor:pointer; color:var(--portal-muted); font:inherit; } .step-rail button.active { color:var(--portal-primary); border-color:var(--portal-primary); background:var(--portal-accent-surface); font-weight:600; } .step-rail button:focus-visible { outline:2px solid var(--green); }
.quarterly-compatibility { margin-top: 14px; padding: 14px; background: var(--portal-paper); border: 1px solid var(--portal-line); border-radius: 8px; font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; }
.quarterly-compatibility p { margin: 10px 0; }
.quarterly-compatibility small { display: block; color: var(--portal-muted); }
.quarterly-compatibility a { color: var(--portal-primary); }
.quarterly-compatibility summary { cursor: pointer; }

.page-head{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;padding-bottom:27px;border-bottom:1px solid var(--line)}.page-head h1{margin:0}.subtitle{margin:8px 0 0;color:var(--portal-muted);font-size:14px;line-height:1.6}.head-actions{display:flex;gap:10px}.head-actions :deep(.el-button--primary){--el-button-bg-color:var(--green);--el-button-border-color:var(--green);font-weight:600}.summary-strip{display:grid;grid-template-columns:140px 160px 140px 1fr;align-items:center;margin:20px 0 24px;padding:16px 20px;background:#fff;border:1px solid var(--line);border-radius:9px}.summary-strip>div:not(.summary-note){display:flex;flex-direction:column;gap:3px;border-right:1px solid var(--line)}.summary-strip span{color:var(--muted);font-size:12px}.summary-strip strong{font:600 22px Arial,"Microsoft YaHei",sans-serif}.summary-note{text-align:right;color:var(--muted);font-size:12px}.section-heading{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px}.section-heading h2{margin:0;font:500 23px Arial,"Microsoft YaHei",sans-serif}.package-card{display:flex;align-items:center;gap:17px;margin:9px 0;padding:17px 18px;background:#fff;border:1px solid var(--line);border-radius:9px;transition:box-shadow .18s,border-color .18s}.package-card:hover{border-color:var(--portal-line)}.package-mark{display:grid;place-items:center;width:43px;height:43px;flex:none;border-radius:8px;background:#f8ebf3;color:var(--green);font:600 20px Arial,"Microsoft YaHei",sans-serif}.package-mark.quarterly{background:#f7f0e4;color:#9a6c2b}.package-main{flex:1;min-width:0}.package-title{display:flex;align-items:center;gap:11px}.package-title h3{margin:0;font-size:15px}.period-code{color:var(--green);font:600 13px ui-monospace,monospace}.package-main p{margin:7px 0;color:var(--muted);font-size:12px}.org-chips{display:flex;gap:6px;flex-wrap:wrap}.org-chips span{padding:3px 7px;background:var(--portal-paper);border-radius:4px;color:var(--portal-muted);font-size:12px}.package-actions{display:flex;align-items:center;flex:none}.empty-state{padding:64px 20px;text-align:center;color:var(--muted);border:1px dashed var(--portal-line);border-radius:9px;background:#ffffff80}.editor-layout{display:grid;grid-template-columns:162px minmax(0,1fr);max-height:70vh}.step-rail{padding:26px 16px;background:var(--portal-paper);border-right:1px solid var(--line)}.step-rail small{font:500 12px "Microsoft YaHei",sans-serif}.editor-content{overflow:auto;padding:8px 26px 25px}.form-section{padding:24px 0}.form-section-head{display:flex;gap:12px;align-items:flex-start;margin-bottom:16px}.form-section-head>span{color:var(--portal-primary);font:600 14px Arial,sans-serif;line-height:24px;font-variant-numeric:tabular-nums}.form-section-head h3{margin:0;font-size:15px}.form-section-head p{margin:5px 0 0;color:var(--muted);font-size:12px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px 16px;align-items:start}.form-grid .wide{grid-column:1/-1}.form-section label,.type-form label,.rule-label{display:flex;flex-direction:column;gap:6px;color:var(--portal-muted);font-size:12px}.form-grid :deep(.el-select),.form-grid :deep(.el-input),.full-select,.rule-label :deep(.el-select){width:100%}.selected-orgs{margin-top:10px;border:1px solid var(--line);border-radius:6px;overflow:hidden}.selected-org-row{display:grid;grid-template-columns:80px minmax(90px,1fr) minmax(260px,1fr);align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--portal-line);font-size:12px}.selected-org-row:last-child{border:0}.org-code{color:var(--green);font:12px ui-monospace,monospace}.selected-org-row label{display:flex;align-items:center;gap:8px}.selected-org-row :deep(.el-input),.selected-org-row :deep(.deadline-picker){width:195px}.selected-org-row.is-single{grid-template-columns:1fr}.selected-org-row.is-single label{flex-direction:column;align-items:stretch}.selected-org-row.is-single :deep(.el-input),.selected-org-row.is-single :deep(.deadline-picker){width:100%}.subheading{display:flex;justify-content:space-between;align-items:center;margin:16px 0 9px;color:var(--portal-ink);font-size:12px}.repeat-row{display:grid;gap:7px;align-items:center;margin:7px 0}.target-row{grid-template-columns:1.1fr 1.5fr 1fr 1.2fr .7fr auto}.indicator-row{grid-template-columns:1.1fr .8fr 1.2fr .65fr 1fr auto}.assignment-row{grid-template-columns:1fr 1fr 1.3fr 1.2fr auto}.repeat-row :deep(.el-select),.repeat-row :deep(.el-input){width:100%}.form-hint{margin:7px 0 0;color:var(--portal-muted);font-size:12px}.rule-label{margin-top:17px}.error-box{margin:16px 0;padding:12px 14px;color:#922419;background:#fff5f4;border:1px solid #e8b4ae;border-radius:6px;font-size:12px}.dialog-footer{display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:12px}.type-form{display:grid;gap:15px}.type-form p{margin:0;color:var(--muted);font-size:12px}.detail-banner{display:flex;justify-content:space-between;align-items:center;color:var(--green);font:600 20px Arial,"Microsoft YaHei",sans-serif}.detail-muted{color:var(--muted);font-size:12px}.detail-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);font-size:12px}.detail-row span{color:var(--muted);font-size:12px}.period-page h4{margin:24px 0 9px}.period-page pre{overflow:auto;padding:14px;background:var(--portal-paper);border-radius:8px;color:var(--portal-muted);font-size:12px}@media(max-width:850px){.summary-strip{grid-template-columns:repeat(3,1fr);gap:10px}.summary-note{grid-column:1/-1;text-align:left}.page-head{align-items:flex-start;flex-direction:column}.editor-layout{grid-template-columns:1fr}.step-rail{display:none}.repeat-row{grid-template-columns:1fr 1fr}.selected-org-row{grid-template-columns:70px 1fr}.selected-org-row label{grid-column:1/-1}.selected-org-row :deep(.el-input),.selected-org-row :deep(.deadline-picker){width:100%}.dialog-footer{align-items:flex-start;gap:10px;flex-direction:column}}
.quarter-source{display:grid;grid-template-columns:minmax(240px,360px) 1fr;align-items:end;gap:14px;margin:12px 0;padding:12px 14px;background:var(--portal-paper);border:1px solid var(--portal-line);border-radius:8px}.quarter-source label{display:flex;flex-direction:column;gap:6px;color:var(--portal-muted);font-size:12px}.quarter-source small{padding-bottom:8px;color:var(--portal-muted);font-size:12px;line-height:1.5}.indicator-row{grid-template-columns:repeat(5,minmax(105px,1fr)) auto}
@media(max-width:850px){.quarter-source{grid-template-columns:1fr}.quarter-source small{padding:0}.indicator-row{grid-template-columns:1fr 1fr}}
.monthly-weights{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;align-items:center;margin:17px 0 5px;padding:12px 14px;background:var(--portal-paper);border:1px solid var(--line);border-radius:8px}.monthly-weights>div{display:flex;flex-direction:column;gap:4px}.monthly-weights strong{font-size:12px}.monthly-weights span{color:var(--muted);font-size:12px}.monthly-weights label{display:flex;flex-direction:column;gap:5px;color:var(--portal-muted);font-size:12px}.monthly-weights :deep(.el-input){width:100%}
.threshold-editor{margin-top:20px;padding:14px;background:var(--portal-paper);border:1px solid var(--line);border-radius:8px}.threshold-editor .subheading{margin:0 0 12px}.threshold-editor .subheading span{color:var(--muted);font-size:12px}.threshold-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.threshold-grid label{display:flex;flex-direction:column;gap:6px;color:var(--portal-muted);font-size:12px}.threshold-grid :deep(.el-input-number){width:100%}.threshold-grid small{color:var(--muted);font-size:12px}
.editor-layout{min-height:0;overflow:hidden}.editor-content{min-height:0}
.reference-mapping{display:grid;gap:9px;margin-top:14px;padding:13px 15px;background:var(--portal-paper);border:1px solid var(--portal-line);border-radius:8px}.reference-mapping>div:first-child{display:flex;flex-direction:column;gap:4px;color:var(--portal-ink);font-size:12px}.reference-mapping small{color:var(--portal-muted);font-size:12px}.reference-mapping-row{display:grid;grid-template-columns:minmax(180px,1fr) minmax(220px,1fr);gap:12px;align-items:center;color:var(--portal-muted);font-size:12px}.reference-mapping-row :deep(.el-select){width:100%}@media(max-width:850px){.reference-mapping-row{grid-template-columns:1fr}}

/* Reflow the list by usable workspace width, including the navigation rail. */
.period-page { container: period-page / inline-size; }
.period-page .package-card { align-items: flex-start; }
.period-page .package-meta { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 14px; }
.period-page .package-meta > span { min-width: 0; }
.period-page .package-title { gap: 8px 12px; }
.period-page .package-actions { flex-wrap: wrap; gap: 8px; }
.period-page .package-actions .el-button + .el-button { margin-left: 0; }
.period-page .org-chips span { max-width: 100%; }
.period-page .section-heading { gap: 16px; }
.period-page .section-heading > div { min-width: 0; }
.period-page .section-heading > .el-button { flex-shrink: 0; }
.period-page .repeat-row { gap: 12px; align-items: end; padding-block: 16px; border-bottom: 1px solid var(--portal-line); }
.period-page .repeat-field { min-width: 0; font-size: 14px; }
.period-page .repeat-row > .el-button { align-self: end; }
.period-page .annual-generation { grid-column: 1 / -1; white-space: normal; height: auto; min-height: 44px; }
.period-page .annual-generation :deep(.el-checkbox__label) { white-space: normal; }
.period-page .detail-row { gap: 12px; flex-wrap: wrap; }
.period-page .detail-row > * { min-width: 0; }
.period-page .detail-row span { overflow-wrap: anywhere; }
.period-page .period-detail pre { white-space: pre-wrap; overflow-wrap: anywhere; }
@container period-page (max-width: 960px) {
  .period-page .page-head { align-items: flex-start; flex-direction: column; gap: 16px; }
  .period-page .summary-strip { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .period-page .summary-note { grid-column: 1 / -1; text-align: start; }
  .period-page .summary-strip > div:nth-child(3) { border: 0; }
}
@container period-page (max-width: 640px) {
  .period-page .head-actions { width: 100%; }
  .period-page .head-actions .el-button { flex: 1 1 120px; }
  .period-page .summary-strip { padding: 16px; margin-block: 20px 24px; }
  .period-page .package-card { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; padding: 16px; }
  .period-page .package-mark { width: 32px; height: 32px; font-size: 16px; }
  .period-page .package-title h3 { flex-basis: 100%; font-size: 16px; }
  .period-page .package-actions { grid-column: 1 / -1; justify-content: flex-end; }
  .period-page .package-meta { gap: 4px 12px; }
  .period-page .subtitle { font-size: 14px; }

}
@media (max-width: 600px) {
  .portal-layout .portal-main .portal-content > .period-page { padding: 16px; }
}
</style>

<style>
.period-discard-confirm.el-message-box { width: min(420px, calc(100vw - 32px)); --el-color-primary: #941966; --el-color-primary-light-3: #7a1454; }
.period-discard-confirm .el-message-box__btns { flex-wrap: wrap; gap: 8px; }
.period-discard-confirm .el-button { min-height: 44px; }
</style>

<style>
/* Dialog chrome remains visible while only the form content scrolls. */
.package-dialog.el-dialog {
  display: flex; flex-direction: column; padding: 0; margin: 24px auto;
  height: min(820px, calc(100vh - 48px)); height: min(820px, calc(100dvh - 48px));
  overflow: hidden;
}
.package-dialog.el-dialog > .el-dialog__header { flex: none; margin: 0; padding: 16px 48px 16px 20px; }
.package-dialog.el-dialog > .el-dialog__body { flex: 1; min-height: 0; padding: 0; display: flex; }
.package-dialog.el-dialog > .el-dialog__body > .el-form { display: flex; flex: 1; min-height: 0; min-width: 0; }
.package-dialog .editor-layout { flex: 1; min-width: 0; height: auto; max-height: none; }
.package-dialog .editor-content { min-width: 0; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 16px 24px; }
.package-dialog.el-dialog > .el-dialog__footer { flex: none; padding: 12px 20px max(12px, env(safe-area-inset-bottom)); border-top: 1px solid var(--portal-line, #e8d9e1); }
.package-dialog .step-rail { overflow-y: auto; padding: 16px 12px; }
.package-dialog .step-rail button { min-height: 56px; }
.package-dialog .step-rail button:disabled { cursor: wait; }
.package-dialog .form-section { padding-top: 16px; }
.package-dialog .el-collapse-item__header { height: auto; min-height: 48px; padding-block: 8px; line-height: 1.6; gap: 8px; }
.package-dialog .el-alert__content { min-width: 0; }
.package-dialog .el-input__wrapper, .package-dialog .el-select__wrapper { min-height: 44px; }
.package-dialog .subheading { gap: 12px; flex-wrap: wrap; }
.package-dialog .dialog-footer { gap: 12px; }
.package-dialog .dialog-footer > span { flex: 1; }
.package-dialog .dialog-footer > div { flex-shrink: 0; }
.period-type-dialog.el-dialog { max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px); display: flex; flex-direction: column; }
.period-type-dialog.el-dialog > .el-dialog__body { overflow-y: auto; min-height: 0; }
.period-type-dialog.el-dialog > .el-dialog__footer { flex: none; }
/* Match the portal's form typography without changing shared components. */
.package-dialog.el-dialog, .period-type-dialog.el-dialog {
  --el-text-color-secondary: #6d5a65;
  --el-text-color-placeholder: #6d5a65;
  color: var(--portal-ink, #2c1b26);
  border-radius: var(--portal-radius-panel, 8px);
}
.package-dialog.el-dialog .el-dialog__title, .period-type-dialog.el-dialog .el-dialog__title {
  font-size: 20px; font-weight: 600; line-height: 1.5;
}
.package-dialog.el-dialog > .el-dialog__header { border-bottom: 1px solid var(--portal-line, #e8d9e1); }
.package-dialog.el-dialog .form-section-head { margin-bottom: 20px; }
.package-dialog.el-dialog .form-section-head h3 { font-size: 16px; line-height: 1.5; }
.package-dialog.el-dialog .form-section-head p { font-size: 14px; line-height: 1.6; margin-top: 8px; }
.package-dialog.el-dialog .form-section label, .package-dialog.el-dialog .reporting-period-picker label,
.period-type-dialog.el-dialog .type-form label { font-size: 14px; color: var(--portal-ink, #2c1b26); line-height: 1.5; gap: 8px; }
.package-dialog.el-dialog .form-section label > :is(.el-select, .el-input) { flex: none; }
.package-dialog.el-dialog .el-date-editor.el-input { height: 44px; line-height: 44px; }
.package-dialog .selected-org-row .deadline-picker { width: 195px; }
.package-dialog .selected-org-row.is-single .deadline-picker { width: 100%; }
@media (max-width: 850px) {
  .package-dialog .selected-org-row .deadline-picker { width: 100%; }
}
.package-dialog.el-dialog .period-hint { color: var(--portal-muted, #6d5a65); }
.package-dialog.el-dialog .period-hint, .package-dialog.el-dialog .form-hint,
.period-type-dialog.el-dialog .type-form :is(p, small) { font-size: 14px; line-height: 1.6; }
.period-type-dialog.el-dialog .type-form { gap: 20px; }
.period-type-dialog.el-dialog .type-form small { color: var(--portal-muted, #6d5a65); }
.period-type-dialog.el-dialog .el-input__wrapper, .period-type-dialog.el-dialog .el-select__wrapper { min-height: 44px; }
.period-type-dialog.el-dialog .el-button { min-height: 44px; }
.package-dialog.el-dialog .subheading { font-size: 14px; margin-block: 20px 12px; }
.package-dialog.el-dialog .el-alert__title, .package-dialog.el-dialog .el-alert__description { font-size: 14px; line-height: 1.6; }
.package-dialog.el-dialog .el-alert + .form-section { padding-top: 24px; }
.package-dialog.el-dialog .review-summary .el-descriptions__label { width: 104px; color: var(--portal-muted, #6d5a65); background: var(--portal-paper, #f8f3f6); }
.package-dialog.el-dialog .review-summary .el-descriptions__cell { padding: 12px 16px; line-height: 1.6; overflow-wrap: anywhere; }
.package-dialog.el-dialog .review-note { margin: 16px 0 0; font-size: 14px; line-height: 1.7; color: var(--portal-muted, #6d5a65); }
.package-dialog.el-dialog .step-rail button:not(:disabled):hover { background: var(--portal-accent-surface, #f8ebf3); color: var(--portal-primary, #941966); }
.package-dialog.el-dialog :is(.quarter-source, .reference-mapping, .monthly-weights, .threshold-editor) { background: var(--portal-paper, #f8f3f6); border-color: var(--portal-line, #e8d9e1); }
.package-dialog.el-dialog .editor-content, .period-type-dialog.el-dialog .el-dialog__body { scrollbar-color: #909399 #f8f3f6; }
:is(.period-page, .package-dialog, .period-type-dialog) ::selection { background: #f8ebf3; color: #6f114b; }
:is(.package-dialog, .period-type-dialog) input { caret-color: #941966; }
:is(.package-dialog, .period-type-dialog) button:focus-visible { outline: 2px solid #941966; outline-offset: 2px; }
@media (max-width: 600px) {
  .package-dialog.el-dialog .review-summary .el-descriptions__label { width: 84px; }
  .package-dialog.el-dialog .review-summary .el-descriptions__cell { padding: 10px; }
}
@media (max-width: 1100px) {
  .package-dialog .target-row, .package-dialog .assignment-row, .package-dialog .indicator-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 850px) {
  .package-dialog.el-dialog { margin: 8px auto; height: calc(100vh - 16px); height: calc(100dvh - 16px); }
  .package-dialog .editor-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .package-dialog .step-rail { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; padding: 8px; border-right: 0; border-bottom: 1px solid var(--portal-line, #e8d9e1); }
  .package-dialog .step-rail button { align-items: center; justify-content: center; text-align: center; padding: 6px 2px; margin: 0; border: 1px solid transparent; border-radius: 4px; gap: 2px; }
  .package-dialog .step-rail button.active { border-color: var(--portal-primary, #941966); }
  .package-dialog .step-rail small { line-height: 1.4; }
  .package-dialog .dialog-footer { flex-direction: row; flex-wrap: wrap; align-items: center; }
  .package-dialog .dialog-footer > div { margin-left: auto; }
  .package-dialog .editor-content { padding: 12px 16px; }
  .package-dialog .el-input__wrapper, .package-dialog .el-select__wrapper { min-height: 44px; }
}
@media (max-width: 600px) {
  .package-dialog.el-dialog > .el-dialog__header { padding-left: 16px; }
  .package-dialog.el-dialog > .el-dialog__footer { padding-inline: 12px; }
  .package-dialog.el-dialog .dialog-footer > span { flex-basis: 100%; font-size: 12px; text-align: start; }
  .package-dialog.el-dialog .dialog-footer > div { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  .package-dialog.el-dialog .dialog-footer > div > .el-button:last-child:nth-child(3) { grid-column: 1 / -1; }
  .package-dialog .target-row, .package-dialog .assignment-row, .package-dialog .indicator-row { grid-template-columns: minmax(0, 1fr); }
  .package-dialog .repeat-row > .el-button { justify-self: end; }
  .package-dialog .form-section label, .period-type-dialog .type-form label { font-size: 14px; }
  .package-dialog .el-input__inner, .package-dialog .el-select__wrapper, .period-type-dialog .el-input__inner, .period-type-dialog .el-select__wrapper { font-size: 16px; }
}
@media (max-height: 500px) and (min-width: 601px) {
  .package-dialog.el-dialog { margin: 8px auto; height: calc(100vh - 16px); height: calc(100dvh - 16px); }
  .package-dialog .dialog-footer > span { max-width: 30%; }
  .period-type-dialog.el-dialog { margin-top: 16px; }
}
</style>
