/** Tiny RFC 4180 CSV parser and serializer. */

/** Parse CSV text into rows of strings (handles quotes, commas, CRLF). */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let i = 0
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  while (i < src.length) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"') {
      quoted = true
      i += 1
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      continue
    }
    field += ch
    i += 1
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

/** Parse CSV with a header row into objects keyed by header name. */
export function parseCsvObjects(text) {
  const rows = parseCsv(text)
  if (rows.length === 0) return []
  const header = rows[0]
  return rows.slice(1).map((cells) => {
    const obj = {}
    header.forEach((name, index) => {
      obj[name] = cells[index] ?? ''
    })
    return obj
  })
}

function escapeCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** Serialize rows (first row is the header) to CSV text with a BOM for Excel. */
export function toCsv(rows) {
  return `\ufeff${rows.map((row) => row.map(escapeCell).join(',')).join('\r\n')}\r\n`
}
