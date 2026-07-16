function padDatePart(value) {
  return String(value).padStart(2, '0')
}

export function crmDateOnly(value) {
  if (!value) return ''

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    return `${value.getFullYear()}-${padDatePart(value.getMonth() + 1)}-${padDatePart(value.getDate())}`
  }

  const text = String(value).trim()
  const datePrefix = /^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/.exec(text)
  if (datePrefix) return datePrefix[1]

  return ''
}
