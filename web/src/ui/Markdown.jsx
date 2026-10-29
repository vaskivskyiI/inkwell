// Small, safe Markdown → React renderer for AI output (no HTML injection). `cite(n)` renders [n] citations.
import { Fragment } from 'react';

function inline(text, cite, key = 0) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|`([^`]+)`|~~([^~]+)~~|\[(\d+)\](?!\()|\[([^\]]+)\]\((https?:[^)\s]+)\))/g;
  let last = 0, m, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[2]) out.push(<strong key={k}>{m[2]}</strong>);
    else if (m[3] || m[4]) out.push(<em key={k}>{m[3] || m[4]}</em>);
    else if (m[5]) out.push(<code key={k}>{m[5]}</code>);
    else if (m[6]) out.push(<s key={k}>{m[6]}</s>);
    else if (m[7]) out.push(cite ? <Fragment key={k}>{cite(Number(m[7]))}</Fragment> : `[${m[7]}]`);
    else if (m[8]) out.push(<a key={k} href={m[9]} target="_blank" rel="noopener noreferrer">{m[8]}</a>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, cite }) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let i = 0, k = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if (/^```/.test(l)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++}><code>{code.join('\n')}</code></pre>);
    } else if ((m = /^(#{1,6})\s+(.*)/.exec(l))) {
      const H = `h${Math.min(6, m[1].length + 2)}`;
      blocks.push(<H key={k++}>{inline(m[2], cite, k)}</H>);
      i++;
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const t = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        const task = /^\[( |x|X)\]\s*/.exec(t);
        items.push(<li key={i} className={task ? 'task' : ''}>{task && <input type="checkbox" readOnly checked={task[1] !== ' '} />}{inline(task ? t.slice(task[0].length) : t, cite, i)}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
    } else if (/^>/.test(l)) {
      const q = [];
      while (i < lines.length && /^>/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={k++}>{inline(q.join(' '), cite, k)}</blockquote>);
    } else if (/^\|.*\|\s*$/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = rows.filter((r) => !/^\|(\s*:?-+:?\s*\|)+\s*$/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      blocks.push(<table key={k++}><tbody>{cells.map((r, ri) => <tr key={ri}>{r.map((c, ci) => (ri ? <td key={ci}>{inline(c, cite)}</td> : <th key={ci}>{inline(c, cite)}</th>))}</tr>)}</tbody></table>);
    } else {
      const p = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*([-*+]|\d+[.)])\s|>|\|.*\|\s*$)/.test(lines[i])) p.push(lines[i++]);
      if (!p.length) p.push(lines[i++]); // always make progress
      blocks.push(<p key={k++}>{inline(p.join(' '), cite, k)}</p>);
    }
  }
  return <div className="md">{blocks}</div>;
}
