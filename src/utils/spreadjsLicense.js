import GC from '@grapecity-software/spread-sheets'
import { spreadjsLicense, designerLicense } from 'virtual:spreadjs-license'

// Apply once before any workbook is created, including lazily loaded legacy views.
GC.Spread.Sheets.LicenseKey = spreadjsLicense
export { designerLicense }
