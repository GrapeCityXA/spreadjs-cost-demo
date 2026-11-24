import '@grapecity-software/spread-sheets-collaboration-addon'
import { type } from '@grapecity-software/spread-sheets-collaboration-client'

// Reuse the live filling loader for native OT snapshots. Ordinary SSJSON keeps
// its own loader; the two representations encode formulas differently.
export async function restoreRevisionWorkbook(workbook, source) {
  const json = JSON.parse(JSON.stringify(source))
  if (json.collaborationInfo) {
    workbook.collaboration.registerCollaborationType(type)
    workbook.collaboration.fromSnapshot(json)
  } else {
    if (json.activeSheetId) throw new Error('提交快照缺少协作格式信息，请重新加载后重试')
    await workbook.fromJSON(json)
  }
}
