// Page → standalone HTML (export and public read-only links). Ink blocks become inline SVG.
import * as Y from 'yjs';
import { strokesOf } from './docmodel.js';
import { strokesToSvg } from './ink/render.js';

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const safeUrl = (u) => (/^(https?:|mailto:|\/api\/(assets|public)\/)/i.test(String(u || '')) ? u : '#');

function inline(el, ctx) {
  let out = '';
  for (const c of el.toArray()) {
    if (c instanceof Y.XmlText) {
      for (const op of c.toDelta()) {
        if (typeof op.insert !== 'string') continue;
        let s = esc(op.insert);
        const a = op.attributes || {};
        if (a.code) s = `<code>${s}</code>`;
        if (a.bold) s = `<strong>${s}</strong>`;
        if (a.italic) s = `<em>${s}</em>`;
        if (a.underline) s = `<u>${s}</u>`;
        if (a.strike) s = `<s>${s}</s>`;
        if (a.highlight) s = `<mark>${s}</mark>`;
        if (a.link?.href) s = `<a href="${esc(safeUrl(a.link.href))}" rel="noopener">${s}</a>`;
        out += s;
      }
    } else if (c.nodeName === 'hardBreak') out += '<br>';
    else if (c.nodeName === 'pageMention') out += `<span class="mention">${esc(c.getAttribute('title'))}${c.getAttribute('anchor') ? ` › ${esc(c.getAttribute('anchor'))}` : ''}</span>`;
    else if (c.nodeName === 'image') out += img(c, ctx);
    else out += inline(c, ctx);
  }
  return out;
}

const img = (c, ctx) => `<img src="${esc(ctx.asset(safeUrl(c.getAttribute('src'))))}" alt="${esc(c.getAttribute('alt'))}"${c.getAttribute('width') ? ` style="width:${Number(c.getAttribute('width')) || 100}%"` : ''}>`;
const kids = (el, ctx) => el.toArray().map((c) => block(c, ctx)).join('\n');

function block(el, ctx) {
  if (el instanceof Y.XmlText) return esc(el.toString());
  switch (el.nodeName) {
    case 'paragraph': return `<p>${inline(el, ctx) || '<br>'}</p>`;
    case 'heading': { const l = Math.min(6, Number(el.getAttribute('level')) || 1); return `<h${l}>${inline(el, ctx)}</h${l}>`; }
    case 'blockquote': return `<blockquote>${kids(el, ctx)}</blockquote>`;
    case 'callout': return `<div class="callout"><span>${esc(el.getAttribute('emoji') || '💡')}</span><div>${kids(el, ctx)}</div></div>`;
    case 'bulletList': return `<ul>${kids(el, ctx)}</ul>`;
    case 'orderedList': return `<ol>${kids(el, ctx)}</ol>`;
    case 'taskList': return `<ul class="tasks">${kids(el, ctx)}</ul>`;
    case 'listItem': return `<li>${kids(el, ctx)}</li>`;
    case 'taskItem': return `<li><input type="checkbox" disabled${el.getAttribute('checked') ? ' checked' : ''}> ${kids(el, ctx)}</li>`;
    case 'codeBlock': return `<pre><code>${esc(el.toArray().map((t) => t.toString()).join(''))}</code></pre>`;
    case 'horizontalRule': return '<hr>';
    case 'image': return `<p>${img(el, ctx)}</p>`;
    case 'table': return `<table>${el.toArray().map((r) => `<tr>${r.toArray().map((c) => (c.nodeName === 'tableHeader' ? `<th>${kids(c, ctx)}</th>` : `<td>${kids(c, ctx)}</td>`)).join('')}</tr>`).join('')}</table>`;
    case 'audioBlock': return `<p><audio controls src="${esc(ctx.asset(safeUrl(el.getAttribute('src'))))}"></audio></p>`;
    case 'inkBlock': {
      const strokes = strokesOf(ctx.doc, el.getAttribute('id'));
      const h = Number(el.getAttribute('height')) || 240;
      const bg = el.getAttribute('bg');
      const svg = strokes.length ? strokesToSvg(strokes, { height: h, background: '' }) : '';
      if (bg) return `<figure class="ink photo"><img src="${esc(ctx.asset(safeUrl(bg)))}" alt="">${svg ? `<div class="over">${svg}</div>` : ''}</figure>`;
      return svg ? `<figure class="ink">${svg}</figure>` : '';
    }
    default: return el.toArray ? kids(el, ctx) : '';
  }
}

export function pageHtml(ydoc, { title, asset = (u) => u } = {}) {
  const ctx = { doc: ydoc, asset };
  const body = kids(ydoc.getXmlFragment('default'), ctx);
  const page = strokesOf(ydoc, 'page');
  const boxes = [...ydoc.getMap('boxes').values()].map((b) => `<p>${esc(b.get?.('text')?.toString() || '')}</p>`).join('');
  const journal = page.length ? `<figure class="ink">${strokesToSvg(page, { background: '' })}</figure>` : '';
  const over = strokesOf(ydoc, 'overlay');
  const overlay = over.length ? `<figure class="ink"><figcaption>Handwritten on the page</figcaption>${strokesToSvg(over, { background: '' })}</figure>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title || 'Untitled')}</title><style>
body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#1f2328;background:#fff}
img,svg{max-width:100%;height:auto}pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto}code{font-family:ui-monospace,monospace}
blockquote{border-left:3px solid #d0d7de;margin:0;padding-left:14px;color:#57606a}table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:6px 10px}
.callout{display:flex;gap:10px;background:#f6f8fa;border-radius:8px;padding:10px 14px}.tasks{list-style:none;padding-left:4px}mark{background:#fef08a}
.mention{color:#4f46e5}figure.ink{margin:12px 0}figure.photo{position:relative}figure.photo img{width:100%;display:block}figure.photo .over{position:absolute;inset:0}figure.photo .over svg{width:100%;height:auto}@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}pre,.callout{background:#161b22}figure.ink{background:#fff;border-radius:8px}}
</style></head><body><h1>${esc(title || 'Untitled')}</h1>
${body}${boxes}${journal}${overlay}</body></html>`;
}
