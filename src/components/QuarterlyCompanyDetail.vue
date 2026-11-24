<template>
  <div class="company-detail">
    <section class="detail-block">
      <div class="detail-heading"><h3>指标审核与评分</h3><span>{{ company.indicators.length }} 项</span></div>
      <app-data-table :data="company.indicators" size="small" accessible responsive :table-label="`${company.task.organizationName}指标审核与评分`" class="indicator-table" empty-text="没有季度指标">
        <el-table-column prop="displayName" label="指标" min-width="270" />
        <el-table-column :column-value="row => format.categoryName(row.category)" label="类别" width="130"><template #default="{ row: item }">{{ format.categoryName(item.category) }}</template></el-table-column>
        <el-table-column :column-value="row => row.weight" label="权重" width="100" align="right"><template #default="{ row: item }">{{ format.percent(item.weight) }}</template></el-table-column>
        <el-table-column :column-value="row => format.reviewName(row.review?.status)" label="部门审核" width="120" align="center"><template #default="{ row: item }">{{ format.reviewName(item.review?.status) }}</template></el-table-column>
        <el-table-column :column-value="row => row.review?.opinion" label="审核意见" min-width="260" show-overflow-tooltip><template #default="{ row: item }">{{ item.review?.opinion || '—' }}</template></el-table-column>
        <el-table-column :column-value="row => row.scoring?.score" label="得分" width="100" align="right"><template #default="{ row: item }">{{ format.amount(item.scoring?.score) }}</template></el-table-column>
        <el-table-column :column-value="row => format.scoreSourceName(row.scoring?.source)" label="评分方式" width="120"><template #default="{ row: item }">{{ format.scoreSourceName(item.scoring?.source) }}</template></el-table-column>
        <template #compact="{ rows }">
          <div class="detail-summary">
            <article v-for="(item, index) in rows" :key="item.id ?? index" class="indicator-entry">
              <h4>{{ item.displayName }}</h4>
              <dl class="indicator-facts">
                <div><dt>类别</dt><dd>{{ format.categoryName(item.category) }}</dd></div>
                <div><dt>权重</dt><dd>{{ format.percent(item.weight) }}</dd></div>
                <div><dt>部门审核</dt><dd>{{ format.reviewName(item.review?.status) }}</dd></div>
                <div><dt>得分</dt><dd>{{ format.amount(item.scoring?.score) }}</dd></div>
                <div><dt>评分方式</dt><dd>{{ format.scoreSourceName(item.scoring?.source) }}</dd></div>
              </dl>
              <p class="review-opinion"><span>审核意见</span>{{ item.review?.opinion || '—' }}</p>
            </article>
            <p v-if="!rows.length" class="detail-empty">没有符合条件的季度指标</p>
          </div>
        </template>
      </app-data-table>
    </section>
    <section class="detail-block source-block">
      <div class="detail-heading"><h3>营业收入、利润总额来源</h3><span>年初至季度末，共 {{ company.monthlyDependencies.months.length }} 个月</span></div>
      <div class="month-grid">
        <article v-for="month in company.monthlyDependencies.months" :key="month.periodCode" class="month-card">
          <strong>{{ month.periodCode }}</strong><span>定稿修订 #{{ month.revisionId }}</span>
          <small>收入 {{ format.amount(month.metrics?.revenue) }} · 利润 {{ format.amount(month.metrics?.profit) }}</small>
        </article>
      </div>
      <div class="dependency-totals">
        <span>本季度收入 <strong>{{ format.amount(company.monthlyDependencies.currentQuarter.revenue.value) }}</strong></span>
        <span>本季度利润 <strong>{{ format.amount(company.monthlyDependencies.currentQuarter.profit.value) }}</strong></span>
        <span>年初至今收入 <strong>{{ format.amount(company.monthlyDependencies.yearToDate.revenue.value) }}</strong></span>
        <span>年初至今利润 <strong>{{ format.amount(company.monthlyDependencies.yearToDate.profit.value) }}</strong></span>
      </div>
    </section>
    <section v-if="company.adjustments?.length" class="detail-block">
      <div class="detail-heading"><h3>奖励与扣罚</h3><span>{{ company.adjustments.length }} 条</span></div>
      <app-data-table :data="company.adjustments" size="small" accessible responsive :table-label="`${company.task.organizationName}奖励与扣罚`" class="indicator-table">
        <el-table-column prop="adjustmentType" label="类型" width="120" />
        <el-table-column prop="amount" label="金额" width="110" align="right"><template #default="{ row: item }">{{ format.amount(item.amount) }}</template></el-table-column>
        <el-table-column prop="reason" label="原因" min-width="260" />
        <el-table-column prop="status" label="审批状态" width="120" />
        <template #compact="{ rows }">
          <div class="detail-summary">
            <article v-for="(item, index) in rows" :key="item.id ?? index" class="indicator-entry">
              <h4>{{ item.adjustmentType }} · {{ format.amount(item.amount) }}</h4>
              <p class="review-opinion"><span>原因</span>{{ item.reason || '—' }}</p>
              <p class="review-opinion"><span>审批状态</span>{{ item.status || '—' }}</p>
            </article>
            <p v-if="!rows.length" class="detail-empty">没有符合条件的奖励与扣罚</p>
          </div>
        </template>
      </app-data-table>
    </section>
  </div>

</template>

<script setup>
defineProps({ company: { type: Object, required: true }, format: { type: Object, required: true } })
</script>

<style scoped src="@/styles/quarterly-company-detail.css"></style>
