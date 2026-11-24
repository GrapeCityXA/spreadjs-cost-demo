function columnToNumber(column) {
  let value = 0;
  for (const char of column.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1;
}

function numberToColumn(number) {
  let value = number + 1;
  let output = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

const referencePattern = /(^|[^A-Za-z0-9_])((?:\[[^\]]+\])?(?:(?:'[^']*(?:''[^']*)*'|[A-Za-z_][A-Za-z0-9_.]*)!))?(\$?[A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_])(?!\s*\()/gi;

function shiftReferences(segment, rowOffset, columnOffset) {
  return segment.replace(referencePattern, (match, prefix, qualifier = '', columnToken, rowMarker, rowText) => {
    const sourceColumn = columnToNumber(columnToken.replace('$', ''));
    const sourceRow = Number(rowText) - 1;
    const targetColumn = columnToken.startsWith('$') ? sourceColumn : sourceColumn + columnOffset;
    const targetRow = rowMarker === '$' ? sourceRow : sourceRow + rowOffset;
    if (targetColumn < 0 || targetRow < 0) return match;
    const shiftedColumn = numberToColumn(targetColumn);
    const column = columnToken.startsWith('$') ? `$${shiftedColumn}` : shiftedColumn;
    const row = rowMarker === '$' ? `$${sourceRow + 1}` : String(targetRow + 1);
    const originalColumn = columnToken.replace('$', '');
    const renderedColumn = originalColumn === originalColumn.toLowerCase() ? column.toLowerCase() : column;
    return `${prefix}${qualifier}${renderedColumn}${row}`;
  });
}

/**
 * Move A1-style references in a formula while preserving absolute row/column
 * anchors. String literals are left untouched.
 */
function shiftFormula(formula, { rowOffset = 0, columnOffset = 0 } = {}) {
  if (typeof formula !== 'string' || !formula || (!rowOffset && !columnOffset)) return formula;
  let output = '';
  let cursor = 0;
  let stringStart = -1;
  for (let index = 0; index < formula.length; index += 1) {
    if (formula[index] !== '"') continue;
    if (stringStart < 0) {
      output += shiftReferences(formula.slice(cursor, index), rowOffset, columnOffset);
      stringStart = index;
    } else if (formula[index + 1] === '"') {
      index += 1;
    } else {
      output += formula.slice(stringStart, index + 1);
      cursor = index + 1;
      stringStart = -1;
    }
  }
  if (stringStart >= 0) output += formula.slice(stringStart);
  else output += shiftReferences(formula.slice(cursor), rowOffset, columnOffset);
  return output;
}

function shiftFormulaRows(formula, rowOffset) {
  return shiftFormula(formula, { rowOffset });
}

module.exports = { shiftFormula, shiftFormulaRows };

