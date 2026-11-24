import { defineComponent, Fragment, h, ref, computed, watch } from 'vue'
import { ElTable, ElPagination, ElPopover, ElSelectV2, ElButton } from 'element-plus'
import { Filter, Sort, SortDown, SortUp } from '@element-plus/icons-vue'
import { columnFilters, columnValue, compareValues, valueKey } from './dataTableValues'
import './app-data-table.css'

// Keep native columns/slots intact: grouped headers, fixed columns, expansion,
// row events and dialog tables all share the same data controls and appearance.
export default defineComponent({
  name: 'AppDataTable',
  inheritAttrs: false,
  emits: ['filtered-count', 'filters-active'],
  props: { data: { type: Array, default: () => [] }, accessible: Boolean, responsive: Boolean, virtualFilters: Boolean, filterClassName: { type: String, default: '' }, tableLabel: { type: String, default: '数据表格' } },
  setup(props, { attrs, slots, emit, expose }) {
    const table = ref()
    const expandedTable = ref(false)
    const sort = ref({ prop: null, order: null })
    const filtered = ref({})
    const page = ref(1), pageSize = 50, readers = new Map()
    const filterCache = new Map()
    let renderedFilterKeys = new Set()
    const processed = computed(() => {
      const activeFilters = filtered.value
      // Readers are registered by the first render, after the immediate count watch.
      // Track sorting even when that first computation sees an empty reader map.
      const activeSort = sort.value
      const filters = [...readers].filter(([key]) => activeFilters[key]?.length)
        .map(([key, reader]) => ({ readValue: reader.readValue, values: new Set(activeFilters[key]) }))
      let rows = filters.length ? props.data.filter(row => filters.every(filter =>
        filter.values.has(valueKey(filter.readValue(row))))) : props.data
      const reader = [...readers.values()].find(reader => reader.property === activeSort.prop)
      if (reader && activeSort.order) rows = [...rows].sort((a, b) =>
        compareValues(reader.readValue(a), reader.readValue(b)) * (activeSort.order === 'descending' ? -1 : 1))
      return rows
    })
    // Report all matching rows, not just the current page, to accessible callers.
    watch(() => props.accessible ? processed.value.length : null, count => {
      if (count !== null) emit('filtered-count', count)
    }, { immediate: true, flush: 'post' })
    watch(() => Object.values(filtered.value).some(values => values?.length), active => {
      emit('filters-active', active)
    }, { immediate: true, flush: 'post' })
    function clearFilters() {
      table.value?.clearFilter()
      filtered.value = {}
      page.value = 1
      for (const cached of filterCache.values()) {
        cached.draft.value = []
        cached.open.value = false
      }
    }
    expose?.({ clearFilters })

    // Vertical scrolling belongs to the named region; Element Plus owns the
    // horizontal viewport. Forward only keys pressed on the region itself.
    function onScrollKeydown(event) {
      if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const viewport = event.currentTarget.querySelector('.el-scrollbar__wrap')
      if (!viewport || viewport.scrollWidth <= viewport.clientWidth) return
      const end = viewport.scrollWidth - viewport.clientWidth
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? end : viewport.scrollLeft + (event.key === 'ArrowRight' ? 80 : -80)
      viewport.scrollLeft = Math.max(0, Math.min(end, next))
      event.preventDefault()
    }

    const decorate = (nodes, prefix = '') => (nodes || []).map((node, index) => {
      const key = `${prefix}${node.key ?? index}`
      if (node.type === Fragment) {
        return h(Fragment, node.props, decorate(node.children, `${key}.`))
      }
      if (node.type?.name !== 'ElTableColumn') return node
      const original = node.props || {}
      const readValue = original['column-value'] || original.columnValue ||
        (original.prop ? row => columnValue(row, original.prop) : null)
      if (!readValue || ['expand', 'selection', 'index'].includes(original.type)) {
        if (!original.type && !readValue && original['column-group']) {
          const groupProps = { ...original }
          delete groupProps['column-group']
          return h(node.type, groupProps, { default: (...args) => decorate(node.children.default(...args), `${key}.`) })
        }
        return node
      }
      const property = original.prop || `__column_${key}`
      const columnKey = `column_${key}`
      readers.set(columnKey, { property, readValue })
      renderedFilterKeys.add(columnKey)
      // A page/sort change does not change the available filter values. Computed
      // still tracks row edits, array replacement and reactive custom readers.
      const source = original['column-value'] || original.columnValue || original.prop
      let cached = filterCache.get(columnKey)
      if (!cached || cached.source !== source) {
        const options = computed(() => columnFilters(props.data, readValue))
        cached = { source, options, selectOptions: computed(() => options.value.map(({text, value}) => ({label:text, value}))), draft: ref([]), open: ref(false) }
        filterCache.set(columnKey, cached)
      }
      const virtualFilter = props.accessible && props.virtualFilters && cached.options.value.length > 200
      const label = original.label || ''
      const enhancedProps = {
        ...original,
        prop: property,
        columnKey,
        sortable: true,
        sortMethod: (a, b) => compareValues(readValue(a), readValue(b)),
        filters: virtualFilter ? undefined : cached.options.value,
        filterMethod: virtualFilter ? undefined : (value, row) => valueKey(readValue(row)) === value,
        filterClassName: [props.accessible ? 'app-data-table-filter dashboard-table-filter' : 'app-data-table-filter', props.filterClassName].filter(Boolean).join(' '),
        // Leave enough space for a label and the two keyboard-accessible controls.
        ...(original.width ? { width: Math.max(Number(original.width), 116) } : {}),
        minWidth: Math.max(Number(original.minWidth || original['min-width']) || 0, 116)
      }
      const originalSlots = Object.fromEntries(Object.entries(node.children || {}).filter(([name, slot]) => !name.startsWith('_') && typeof slot === 'function'))
      delete enhancedProps['column-value']
      delete enhancedProps.columnValue
      const enhancedSlots = {
        ...originalSlots,
        header: scope => {
          const order = sort.value.prop === property ? sort.value.order : null
          return h('span', { class: 'app-column-heading' }, [
            h('span', { class: 'app-column-label' }, node.children?.header?.(scope) || label),
            h('button', {
              type: 'button', class: ['app-column-control', { active: order }],
              'aria-label': `${label}排序：${order === 'ascending' ? '升序' : order === 'descending' ? '降序' : '默认'}`,
              title: '切换升序、降序、默认顺序',
              onClick: event => {
                event.stopPropagation()
                const next = order === 'ascending' ? 'descending' : order === 'descending' ? null : 'ascending'
                if (next) table.value.sort(property, next)
                else { table.value.clearSort(); sort.value = { prop: null, order: null }; page.value = 1 }
              }
            }, [h(order === 'ascending' ? SortUp : order === 'descending' ? SortDown : Sort)]),
            virtualFilter ? h(ElPopover, {
              visible: cached.open.value, 'onUpdate:visible': value => {
                if (value && !cached.open.value) cached.draft.value = [...(filtered.value[columnKey] || [])]
                cached.open.value = value
              },
              trigger: 'click', role: 'dialog', placement: 'bottom-start', width: 300, persistent: false,
              popperClass: ['app-virtual-filter', props.filterClassName].filter(Boolean).join(' ')
            }, {
              reference: () => h('button', { type:'button', class:['app-column-control', {active:filtered.value[columnKey]?.length}],
                'aria-label':`筛选${label}`, 'aria-expanded':cached.open.value, onClick:event=>event.stopPropagation() }, [h(Filter)]),
              default: () => [h('div', {class:'app-virtual-filter-header'}, [h('p', {class:'app-virtual-filter-label'}, `筛选${label}`),
                h('div', {class:'app-virtual-filter-actions'}, [
                  h(ElButton, {onClick:()=>{
                    cached.draft.value=[];filtered.value={...filtered.value,[columnKey]:[]};page.value=1;cached.open.value=false
                    attrs.onFilterChange?.({[columnKey]:[]})
                  }}, ()=>'重置'),
                  h(ElButton, {type:'primary',onClick:()=>{
                    const values=[...cached.draft.value];filtered.value={...filtered.value,[columnKey]:values};page.value=1;cached.open.value=false
                    attrs.onFilterChange?.({[columnKey]:values})
                  }}, ()=>'确定')])]),
                h(ElSelectV2, { modelValue:cached.draft.value, 'onUpdate:modelValue':value=>{cached.draft.value=value},
                  options:cached.selectOptions.value, multiple:true, filterable:true, clearable:true, collapseTags:true,
                  teleported:false, persistent:false,
                  'aria-label':`搜索并选择${label}`, placeholder:'搜索并选择', style:{width:'100%'} })]
            }) : null
          ])
        },
        'filter-icon': () => h('span', {
          class: ['app-column-control', { active: filtered.value[columnKey]?.length }],
          'aria-hidden': 'true', title: `筛选${label}`
        }, [h(Filter)])
      }
      return h(node.type, enhancedProps, enhancedSlots)
    })

    return () => {
      renderedFilterKeys = new Set()
      const columns = decorate(slots.default?.())
      for (const key of filterCache.keys()) if (!renderedFilterKeys.has(key)) filterCache.delete(key)
      const forwarded = { ...attrs }
      const maxHeight = forwarded['max-height'] || forwarded.maxHeight
      if (props.accessible) {
        // Element Plus max-height forces separate header/body tables even in auto layout.
        delete forwarded['max-height']; delete forwarded.maxHeight
        forwarded.tableLayout = 'auto'
      }
      const currentPage = props.accessible ? Math.min(page.value, Math.max(1, Math.ceil(processed.value.length / pageSize))) : 1
      const pageRows = props.accessible ? processed.value.slice((currentPage - 1) * pageSize, currentPage * pageSize) : props.data
      const content = h(ElTable, {
      ...forwarded, ref: table, data: pageRows, stripe: false, border: false, size: 'default',
      class: [attrs.class, 'app-data-table'],
      onSortChange: event => { sort.value = event; page.value = 1; attrs.onSortChange?.(event) },
      onFilterChange: event => { filtered.value = { ...filtered.value, ...event }; page.value = 1; attrs.onFilterChange?.(event) }
      }, { ...slots, default: () => columns })
      return props.accessible ? h('div', {
        class: ['accessible-data-table', { 'has-responsive-summary': props.responsive && slots.compact, 'table-expanded': expandedTable.value }]
      }, [h('div', { class: 'accessible-table-scroll', role: 'region', 'aria-label': props.tableLabel, tabindex: 0,
        onKeydown: onScrollKeydown,
        style: { maxHeight: maxHeight ? `${Number(maxHeight)}px` : undefined, overflow: 'auto' }
      }, [content]), ...(props.responsive && slots.compact ? [h(ElButton, {
        class: 'compact-table-toggle', 'aria-expanded': expandedTable.value,
        onClick: () => { expandedTable.value = !expandedTable.value }
      }, () => expandedTable.value ? '返回摘要列表' : Object.values(filtered.value).some(values => values?.length) ? '展开表格（已筛选）' : '展开表格（筛选／排序）')] : []),
      ...(slots.compact?.({ rows: pageRows, total: processed.value.length, expanded: expandedTable.value }) || []), processed.value.length > pageSize ? h(ElPagination, {
        currentPage, pageSize, total: processed.value.length, layout: 'prev, pager, next', pagerCount: 5,
        'aria-label': `${props.tableLabel}分页`,
        'onUpdate:currentPage': value => { page.value = value }
      }) : null]) : content
    }
  }
})
