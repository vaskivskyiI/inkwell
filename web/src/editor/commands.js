// Slash-menu entries. `run(editor, ctx)` executes after the "/query" text was removed.
import { Heading1, Heading2, Heading3, List, ListOrdered, ListChecks, Quote, Code, Minus, Table, Image, PenLine, Lightbulb, Sparkles, FileText, Wand2, Languages, ListTodo } from 'lucide-react';
import { sid } from '../ink/geometry.js';

export const SLASH = [
  { id: 'ink', label: 'Handwriting / drawing', keys: 'ink pen draw handwriting sketch', icon: PenLine, run: (e) => e.chain().focus().insertContent([{ type: 'inkBlock', attrs: { id: sid(), height: 260 } }, { type: 'paragraph' }]).run() },
  { id: 'h1', label: 'Heading 1', keys: 'h1 title heading', icon: Heading1, run: (e) => e.chain().focus().setNode('heading', { level: 1 }).run() },
  { id: 'h2', label: 'Heading 2', keys: 'h2 heading subtitle', icon: Heading2, run: (e) => e.chain().focus().setNode('heading', { level: 2 }).run() },
  { id: 'h3', label: 'Heading 3', keys: 'h3 heading', icon: Heading3, run: (e) => e.chain().focus().setNode('heading', { level: 3 }).run() },
  { id: 'todo', label: 'To-do list', keys: 'todo task checkbox check', icon: ListChecks, run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: 'bullet', label: 'Bullet list', keys: 'bullet list ul unordered', icon: List, run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: 'number', label: 'Numbered list', keys: 'number ordered list ol', icon: ListOrdered, run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: 'quote', label: 'Quote', keys: 'quote blockquote', icon: Quote, run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: 'callout', label: 'Callout', keys: 'callout note info tip', icon: Lightbulb, run: (e) => e.chain().focus().wrapIn('callout').run() },
  { id: 'code', label: 'Code block', keys: 'code pre snippet', icon: Code, run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: 'table', label: 'Table', keys: 'table grid', icon: Table, run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'image', label: 'Image or file', keys: 'image picture photo upload file', icon: Image, run: (e, ctx) => ctx.pickFile() },
  { id: 'divider', label: 'Divider', keys: 'divider hr line rule', icon: Minus, run: (e) => e.chain().focus().setHorizontalRule().run() },
  { id: 'page', label: 'Link to page', keys: 'link page mention', icon: FileText, run: (e) => e.chain().focus().insertContent('[[').run() },
  { id: 'ai-continue', label: 'AI: continue writing', keys: 'ai continue write', icon: Sparkles, run: (e, ctx) => ctx.ai('continue', { wholePage: true }) },
  { id: 'ai-outline', label: 'AI: outline from the title', keys: 'ai outline structure', icon: Wand2, run: (e, ctx) => ctx.ai('outline', { titleOnly: true }) },
  { id: 'ai-summary', label: 'AI: summarise this page', keys: 'ai summary summarize tldr', icon: Sparkles, run: (e, ctx) => ctx.ai('summarize', { wholePage: true }) },
  { id: 'ai-actions', label: 'AI: extract action items', keys: 'ai actions tasks todo', icon: ListTodo, run: (e, ctx) => ctx.ai('actions', { wholePage: true }) },
  { id: 'ai-translate', label: 'AI: translate page', keys: 'ai translate language', icon: Languages, run: (e, ctx) => ctx.ai('translate', { wholePage: true, ask: 'Translate into which language?' }) },
  { id: 'ai-custom', label: 'AI: ask anything…', keys: 'ai ask prompt custom', icon: Sparkles, run: (e, ctx) => ctx.ai('custom', { wholePage: true, ask: 'What should AI do?' }) },
];

export const AI_ACTIONS = [
  ['improve', 'Improve writing'], ['fix', 'Fix spelling & grammar'], ['shorten', 'Make shorter'], ['expand', 'Make longer'],
  ['simplify', 'Simplify'], ['formal', 'More formal'], ['casual', 'More casual'], ['summarize', 'Summarise'], ['explain', 'Explain'],
  ['actions', 'Extract action items'], ['table', 'Turn into table'], ['list', 'Turn into list'], ['cleanup', 'Clean up notes'], ['translate', 'Translate…'], ['custom', 'Ask AI…'],
];

export function matchSlash(items, q) {
  const s = q.toLowerCase();
  return items.filter((i) => !s || i.label.toLowerCase().includes(s) || i.keys.includes(s)).slice(0, 12);
}
