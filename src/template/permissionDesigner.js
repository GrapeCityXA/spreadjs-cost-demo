import { templateGovernanceApi } from '@/api'
import { editKeys, hasLegacy, ruleToForm, formToRule, convertLegacy, validateRule, validateEntries, entriesForSheet } from './permissionPolicy.js'
import { permissionKeys, permissionTargets } from './permissionRules'
import { SHOWCASE } from '@/config/showcase'

const clone = value => JSON.parse(JSON.stringify(value))
const parse = raw => { try { return (typeof raw === 'string' ? JSON.parse(raw) : raw) || {} } catch { return {} } }
const read = (sheet, target) => target.row === -1 && target.col === -1 ? sheet.tag() : sheet.getTag(target.row, target.col)
const write = (sheet, target, tag) => target.row === -1 && target.col === -1 ? sheet.tag(tag) : sheet.setTag(target.row, target.col, tag)
const selectionKey = (sheet, scope, targets) => JSON.stringify([sheet.name(), scope, targets])
const labels = { sheet: '工作表', row: '行', column: '列', cell: '单元格' }

export default {
  data: () => ({ permissionScope: 'cell', permissionSelection: [], permissionSelectionRanges: [], permissionMixed: false, permissionTargetLabel: '',
    permissionOptionsLoading: false, permissionOptionsError: '', permissionOptionsReady: false,
    permissionBaseline: '', permissionDraftKey: '', permissionDraftDetached: false, permissionValidation: '',
    permissionOptions: { users: [], roles: [], departments: [] } }),
  methods: {
    async loadPermissionOptions() {
      if (this.permissionOptionsLoading) return
      this.permissionOptionsLoading = true
      this.permissionOptionsError = ''
      this.permissionOptionsReady = false
      try {
        let options = await templateGovernanceApi.getPermissionOptions()
        if (!options || !['users', 'roles', 'departments'].every(key => Array.isArray(options[key]) && options[key].every(item => item && typeof item === 'object' && (key === 'users' ? Number.isSafeInteger(item.id) && item.id > 0 : typeof item.code === 'string' && item.code.trim())))) throw new Error('invalid options')
        if (SHOWCASE) {
          const roleCodes = new Set(['subsidiary_filler', 'subsidiary_submitter', 'department_reviewer', 'report_finalizer'])
          const usernames = new Set(['demo-admin', '组织填报人一', 'browser-scoped-user-2', 'demo-reviewer'])
          const personas = { 'demo-admin': '管理员', '组织填报人一': '填报人一', 'browser-scoped-user-2': '填报人二', 'demo-reviewer': '审核人' }
          options = {
            ...options,
            roles: options.roles.filter(role => roleCodes.has(role.code)),
            users: options.users.filter(user => usernames.has(user.username))
              .map(user => ({ ...user, name: personas[user.username] || user.name })),
            departments: []
          }
        }
        this.permissionOptions = options
        this.permissionOptionsReady = true
      } catch {
        this.permissionOptionsError = '无法读取人员、角色和部门。请重试，已填写的配置会保留。'
      } finally { this.permissionOptionsLoading = false }
    },
    hasPermissionDraft() {
      return Boolean(this.permissionBaseline && this.permissionForm && JSON.stringify(this.permissionForm) !== this.permissionBaseline)
    },
    discardPermissionDraft() {
      this.permissionBaseline = ''
      this.permissionValidation = ''
      this.loadCellPermissions()
    },
    returnToPermissionDraft() {
      const sheet = this.spread?.getActiveSheet()
      if (!sheet || !this.permissionSelection.length) return
      const scope = this.permissionScope
      if (scope === 'sheet') { this.loadCellPermissions(); return }
      const ranges = this.permissionSelectionRanges
      if (Array.isArray(ranges) && ranges.length) {
        // Restore every original range, not just a bounding box: Ctrl selections must keep the same targets.
        sheet.clearSelection()
        for (const range of ranges) {
          const row = Math.max(0, Number(range.row) || 0)
          const col = Math.max(0, Number(range.col) || 0)
          const rowCount = Math.max(1, Math.min(Number(range.rowCount) || 1, sheet.getRowCount() - row))
          const colCount = Math.max(1, Math.min(Number(range.colCount) || 1, sheet.getColumnCount() - col))
          sheet.addSelection(row, col, rowCount, colCount)
        }
      } else {
        const rows = this.permissionSelection.map(target => Number(target.row)).filter(row => row >= 0)
        const cols = this.permissionSelection.map(target => Number(target.col)).filter(col => col >= 0)
        if (scope === 'cell' && rows.length && cols.length) {
          const minRow = Math.min(...rows), maxRow = Math.max(...rows)
          const minCol = Math.min(...cols), maxCol = Math.max(...cols)
          sheet.setSelection(minRow, minCol, maxRow - minRow + 1, maxCol - minCol + 1)
        } else if (scope === 'row' && rows.length) {
          const min = Math.min(...rows), max = Math.max(...rows)
          sheet.setSelection(min, 0, max - min + 1, sheet.getColumnCount())
        } else if (scope === 'column' && cols.length) {
          const min = Math.min(...cols), max = Math.max(...cols)
          sheet.setSelection(0, min, sheet.getRowCount(), max - min + 1)
        }
      }
      this.loadCellPermissions()
    },
    permissionMenuCommands() {
      return Object.fromEntries([['cell', 'ClickViewport'], ['row', 'ClickRowHeader'], ['column', 'ClickColHeader'], ['sheet', 'TabStripSelected']]
        .map(([scope, visibleContext]) => {
          const commandName = `costReportPermissions_${scope}`
          return [commandName, { text: `${labels[scope]}填报权限`, commandName, visibleContext,
            execute: () => { this.openPermissions(scope); return true } }]
        }))
    },
    registerPermissionCommand() {
      this.spread.commandManager().register('costReportPermissionsEdit', { canUndo: true,
        execute: (spread, options, isUndo) => {
          const sheet = spread.getSheetFromName(options.sheetName)
          if (!sheet) return false
          if (sheet !== spread.getActiveSheet()) for (let index = 0; index < spread.getSheetCount(); index++) if (spread.getSheet(index) === sheet) spread.setActiveSheetIndex(index)
          spread.suspendPaint()
          try {
            for (const item of options.changes) write(sheet, item, isUndo ? item.before : item.after)
            this.mappings = clone(isUndo ? options.beforeMappings : options.afterMappings)
            this.reconcileMappings()
            this.permissionBaseline = ''
            this.loadCellPermissions()
            this.refreshHistoryState()
          } finally { spread.resumePaint() }
          return true
        } })
    },
    openPermissions(scope = 'cell') {
      const nextScope = typeof scope === 'string' ? scope : 'cell'
      if (nextScope !== this.permissionScope && this.hasPermissionDraft()) { this.$message.warning('请先应用或放弃当前权限修改，再切换层级'); this.switchInspector('permissions'); return }
      this.permissionScope = nextScope
      this.switchInspector('permissions')
    },
    setPermissionScope(scope) {
      if (!Object.hasOwn(labels, scope)) return
      if (scope !== this.permissionScope && this.hasPermissionDraft()) { this.$message.warning('请先应用或放弃当前权限修改，再切换层级'); return }
      this.permissionScope = scope
      this.loadCellPermissions()
    },
    loadCellPermissions() {
      const sheet = this.spread?.getActiveSheet()
      if (!sheet) { this.permissionDraftDetached = true; return }
      const targets = permissionTargets(sheet, this.permissionScope)
      const key = selectionKey(sheet, this.permissionScope, targets)
      if (this.hasPermissionDraft()) {
        this.permissionDraftDetached = key !== this.permissionDraftKey
        return
      }
      this.permissionDraftKey = key
      this.permissionDraftDetached = false
      this.permissionValidation = ''
      this.permissionSelection = targets
      this.permissionSelectionRanges = sheet.getSelections().map(range => ({ row: range.row, col: range.col, rowCount: range.rowCount, colCount: range.colCount }))
      const first = this.permissionSelection[0]
      if (!first) { this.permissionForm = null; this.permissionBaseline = ''; this.permissionTargetLabel = ''; return }
      const raw = read(sheet, first)
      this.permissionMixed = this.permissionSelection.some(target => JSON.stringify(read(sheet, target)) !== JSON.stringify(raw))
      this.permissionTargetLabel = `${sheet.name()} · ${this.permissionScope === 'sheet' ? '整个工作表' : `${this.permissionSelection.length} 个${labels[this.permissionScope]} · ${first.row >= 0 ? 'R' + (first.row + 1) : ''}${first.col >= 0 ? 'C' + (first.col + 1) : ''}`}`
      const mapping = this.permissionScope === 'cell' ? this.mappings.find(item => item.row === first.row && item.col === first.col) : null
      const form = { ...ruleToForm({ ...(mapping ? clone(mapping) : {}), ...parse(raw) }, this.permissionScope), ...first }
      // Normalize before recording the baseline, otherwise simply opening the panel counts as an edit.
      const dimensions = ['user', ...(!SHOWCASE ? ['role'] : []), ...((this.permissionOptions.departments || []).length ? ['department'] : [])]
      if (!dimensions.includes(form.editDimension)) form.editDimension = 'user'
      this.permissionForm = form
      this.permissionBaseline = JSON.stringify(form)
    },
    convertLegacyPermissions() {
      if (!this.permissionOptionsReady || this.permissionOptionsLoading || this.permissionDraftDetached) return
      this.permissionForm = { ...this.permissionForm, ...convertLegacy(this.permissionForm, this.permissionOptions.users, this.permissionScope) }
      // Drop the old restrictions from the draft; they remain on the sheet until Apply is clicked.
      for (const key of ['visibility', 'hiddenForRoles', 'maskedForRoles', 'denyEditForRoles', 'hiddenForDepartments', 'maskedForDepartments', 'denyEditForDepartments']) delete this.permissionForm[key]
      this.permissionValidation = ''
    },
    applyCellPermission() { this.saveScopePermission(false) },
    clearScopePermission() { this.saveScopePermission(true) },
    saveScopePermission(clear) {
      if (!this.canEdit || !this.permissionForm || !this.permissionSelection.length) return
      const sheet = this.spread.getActiveSheet(), form = this.permissionForm
      if (!sheet || selectionKey(sheet, this.permissionScope, permissionTargets(sheet, this.permissionScope)) !== this.permissionDraftKey) {
        this.permissionDraftDetached = true
        this.$message.warning('选区已改变，请返回原选区，或放弃未应用修改后配置新选区')
        return
      }
      if (!clear && (!this.permissionOptionsReady || this.permissionOptionsLoading || this.permissionOptionsError)) return
      this.permissionValidation = ''
      if (!clear && hasLegacy(form)) { this.permissionValidation = '此处包含旧版限制，请先转换为人员名单，再检查并应用。'; return }
      if (!clear && ['user', 'role', 'department'].includes(form.viewMode) && !(form[{ user: 'visibleUsers', role: 'visibleRoles', department: 'visibleDepartments' }[form.viewMode]] || []).length) {
        this.permissionValidation = '请选择至少一个可查看对象；如需全部隐藏，请选择“不允许查看”。'; return
      }
      const nextRule = clear ? null : formToRule(form)
      const error = nextRule && validateRule(nextRule, this.permissionOptions)
      if (error) { this.permissionValidation = error; return }
      const beforeMappings = clone(this.mappings), afterMappings = clone(this.mappings)
      if (!clear && this.permissionScope === 'cell' && form.permission === 'primary_input') {
        const selected = afterMappings.filter(mapping => this.permissionSelection.some(target => target.row === mapping.row && target.col === mapping.col))
        if (selected.some(mapping => mapping.kind === 'calc' || this.fields.find(field => Number(field.id) === Number(mapping.fieldDefinitionId))?.editable === false
          || afterMappings.some(other => other.id !== mapping.id && other.fieldCode === mapping.fieldCode && (other.primary || selected.includes(other))))) {
          this.$message.warning('选区包含计算字段、只读字段，或同一字段存在多处输入。请调整选区后重试。'); return
        }
      }
      const changes = this.permissionSelection.map(target => {
        const before = read(sheet, target) ?? null, oldTag = parse(before)
        const tag = { ...oldTag }
        for (const key of permissionKeys) delete tag[key]
        const mapping = this.permissionScope === 'cell' ? afterMappings.find(item => item.row === target.row && item.col === target.col) : null
        if (!clear) {
          Object.assign(tag, nextRule)
          tag.schemaVersion = 1
          tag.platform ||= 'cost-report-cell-permission-v1'
        }
        if (mapping) {
          // Cell-level input changes must keep the field's Primary Input contract consistent.
          const inputPermission = mapping.permission
          if (clear || form.permission === 'inherit' || mapping.kind === 'calc') tag.permission = inputPermission
          if ((clear || form.permission === 'inherit') && tag.permission === 'primary_input') {
            for (const key of Object.values(editKeys)) if (mapping[key] !== undefined) tag[key] = clone(mapping[key])
            if (!Object.values(editKeys).some(key => tag[key] !== undefined)) tag.editableForRoles = ['subsidiary_filler']
            tag.editDimension = mapping.editDimension || Object.keys(editKeys).find(key => tag[editKeys[key]]?.length) || 'role'
          }
          for (const key of permissionKeys) delete mapping[key]
          for (const key of permissionKeys) if (tag[key] !== undefined) mapping[key] = clone(tag[key])
          mapping.primary = tag.permission === 'primary_input'
          if (oldTag.platform === 'cost-report-mapping-v1') tag.primary = mapping.primary
        }
        const empty = Object.keys(tag).every(key => ['schemaVersion', 'platform'].includes(key))
        return { ...target, before, after: clear && empty ? null : JSON.stringify(tag) }
      })
      // Validate a proposed snapshot without writing into SpreadJS, so failures leave the design intact.
      const permissions = this.exportPermissionTags(sheet)
      const candidate = { rowCount: sheet.getRowCount(), columnCount: sheet.getColumnCount(),
        tag: permissions.sheet, rowTags: clone(permissions.rows), columnTags: clone(permissions.columns), cells: this.exportCells(sheet) }
      for (const change of changes) {
        if (change.row === -1 && change.col === -1) candidate.tag = change.after
        else if (change.col === -1) { candidate.rowTags = candidate.rowTags.filter(item => item.row !== change.row); candidate.rowTags.push({ row: change.row, tag: change.after }) }
        else if (change.row === -1) { candidate.columnTags = candidate.columnTags.filter(item => item.col !== change.col); candidate.columnTags.push({ col: change.col, tag: change.after }) }
        else {
          const cell = candidate.cells.find(item => item.row === change.row && (item.column ?? item.col) === change.col)
          if (cell) cell.tag = change.after
          else candidate.cells.push({ row: change.row, column: change.col, tag: change.after })
        }
      }
      const focus = changes.map(change => ({ row: Math.max(0, change.row), col: Math.max(0, change.col),
        rowCount: change.row === -1 ? candidate.rowCount : 1, colCount: change.col === -1 ? candidate.columnCount : 1 }))
      try {
        const conflict = validateEntries(entriesForSheet(candidate), this.permissionOptions, focus)
        if (conflict) { this.permissionValidation = conflict; return }
      } catch { this.permissionValidation = '存在无法识别的权限配置，请检查对应区域的权限后重试。'; return }
      const applied = this.spread.commandManager().execute({ cmd: 'costReportPermissionsEdit', sheetName: sheet.name(), changes, beforeMappings, afterMappings })
      if (applied === false) { this.$message.error('权限未能应用，请重新选择区域后重试'); return }
      this.$message.success(clear ? '已清除本级权限，请保存模板' : '权限已应用到当前设计，请保存模板')
    }
  }
}
