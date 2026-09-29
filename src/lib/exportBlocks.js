import { escapeHtml } from './textExtract.js'

// ---------- Markdown ----------

function inlineHtmlToMarkdown(html) {
  if (!html) return ''
  return html
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**')
    .replace(/<(?:i|em)>([\s\S]*?)<\/(?:i|em)>/gi, '_$1_')
    .replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, '==$1==')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function listItemMarkdown(item, style, depth, counter) {
  const indent = '  '.repeat(depth)
  const bullet =
    style === 'ordered' ? `${counter}.` : style === 'checklist' ? `- [${item.meta?.checked ? 'x' : ' '}]` : '-'
  const lines = [`${indent}${bullet} ${inlineHtmlToMarkdown(item.content)}`]
  ;(item.items ?? []).forEach((child, i) => lines.push(listItemMarkdown(child, style, depth + 1, i + 1)))
  return lines.join('\n')
}

function blockToMarkdown(block) {
  const data = block?.data ?? {}
  switch (block?.type) {
    case 'header': {
      const level = Math.min(Math.max(data.level ?? 2, 1), 6)
      return `${'#'.repeat(level)} ${inlineHtmlToMarkdown(data.text)}`
    }
    case 'paragraph':
      return inlineHtmlToMarkdown(data.text)
    case 'list':
      return (data.items ?? []).map((item, i) => listItemMarkdown(item, data.style, 0, i + 1)).join('\n')
    case 'quote': {
      const text = `> ${inlineHtmlToMarkdown(data.text)}`
      return data.caption ? `${text}\n> — ${inlineHtmlToMarkdown(data.caption)}` : text
    }
    case 'code':
      return `\`\`\`\n${data.code ?? ''}\n\`\`\``
    case 'table': {
      const rows = (data.content ?? []).map((row) => row.map((cell) => inlineHtmlToMarkdown(cell)))
      if (rows.length === 0) return ''
      const [header, ...rest] = rows
      const sep = header.map(() => '---')
      return [header, sep, ...rest].map((row) => `| ${row.join(' | ')} |`).join('\n')
    }
    case 'delimiter':
      return '---'
    case 'image':
      return `![${inlineHtmlToMarkdown(data.caption)}](${data.file?.url ?? ''})`
    case 'callout':
      return `> ${data.icon ?? ''} ${inlineHtmlToMarkdown(data.text)}`
    case 'toggle':
      return `<details>\n<summary>${inlineHtmlToMarkdown(data.text)}</summary>\n\n${inlineHtmlToMarkdown(data.body)}\n\n</details>`
    default:
      return ''
  }
}

export function toMarkdown(blocks = [], title = '') {
  const body = blocks
    .map(blockToMarkdown)
    .filter((s) => s !== '')
    .join('\n\n')
  return title ? `# ${title}\n\n${body}\n` : `${body}\n`
}

// ---------- HTML ----------

function listItemHtml(item, style) {
  const checkbox =
    style === 'checklist'
      ? `<input type="checkbox" disabled ${item.meta?.checked ? 'checked' : ''}> `
      : ''
  const nested = (item.items ?? []).length > 0 ? listHtml(item.items, style) : ''
  return `<li>${checkbox}${item.content ?? ''}${nested}</li>`
}

function listHtml(items, style) {
  const tag = style === 'ordered' ? 'ol' : 'ul'
  const attrs = style === 'checklist' ? ' style="list-style:none;padding-left:1.2em"' : ''
  return `<${tag}${attrs}>${items.map((item) => listItemHtml(item, style)).join('')}</${tag}>`
}

function blockToHtml(block) {
  const data = block?.data ?? {}
  switch (block?.type) {
    case 'header': {
      const level = Math.min(Math.max(data.level ?? 2, 1), 6)
      return `<h${level}>${data.text ?? ''}</h${level}>`
    }
    case 'paragraph':
      return `<p>${data.text ?? ''}</p>`
    case 'list':
      return listHtml(data.items ?? [], data.style)
    case 'quote':
      return `<blockquote><p>${data.text ?? ''}</p>${data.caption ? `<footer>${data.caption}</footer>` : ''}</blockquote>`
    case 'code':
      return `<pre><code>${escapeHtml(data.code)}</code></pre>`
    case 'table': {
      const rows = data.content ?? []
      if (rows.length === 0) return ''
      const cellTag = data.withHeadings ? 'th' : 'td'
      const [header, ...rest] = rows
      const headRow = `<tr>${header.map((c) => `<${cellTag}>${c}</${cellTag}>`).join('')}</tr>`
      const bodyRows = rest.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')
      return `<table border="1" cellpadding="6" cellspacing="0">${data.withHeadings ? `<thead>${headRow}</thead><tbody>${bodyRows}</tbody>` : `<tbody>${headRow}${bodyRows}</tbody>`}</table>`
    }
    case 'delimiter':
      return '<hr>'
    case 'image':
      return `<figure><img src="${escapeHtml(data.file?.url)}" alt="">${data.caption ? `<figcaption>${data.caption}</figcaption>` : ''}</figure>`
    case 'callout':
      return `<div style="display:flex;gap:12px;background:#fdf6e3;border-radius:8px;padding:12px 16px"><span>${data.icon ?? ''}</span><div>${data.text ?? ''}</div></div>`
    case 'toggle':
      return `<details><summary>${data.text ?? ''}</summary><div style="margin-top:6px">${data.body ?? ''}</div></details>`
    default:
      return ''
  }
}

export function toHtml(blocks = [], title = '') {
  const body = blocks.map(blockToHtml).filter(Boolean).join('\n')
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title || 'Sin título')}</title>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`
}

// ---------- Import Markdown básico ----------
// Soporta encabezados (#/##/###), listas (- o *), citas (>) y párrafos.
// No cubre tablas, código con fences ni formato inline complejo.

export function parseMarkdown(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^#{1,3}\s+/.test(line)) {
      const level = line.match(/^#+/)[0].length
      blocks.push({ type: 'header', data: { text: escapeHtml(line.replace(/^#{1,3}\s+/, '').trim()), level } })
      i++
    } else if (/^[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push({ content: escapeHtml(lines[i].replace(/^[-*]\s+/, '').trim()), items: [] })
        i++
      }
      blocks.push({ type: 'list', data: { style: 'unordered', items } })
    } else if (/^>\s?/.test(line)) {
      const quoteLines = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ type: 'quote', data: { text: escapeHtml(quoteLines.join(' ').trim()), caption: '' } })
    } else if (line.trim() === '') {
      i++
    } else {
      blocks.push({ type: 'paragraph', data: { text: escapeHtml(line.trim()) } })
      i++
    }
  }
  return blocks
}
