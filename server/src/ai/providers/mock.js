// Deterministic offline provider for tests and demo mode: plausible structured output derived from the prompt, and
// bag-of-words embeddings so semantic search behaves sensibly.
import crypto from 'node:crypto';

const DIM = 64;
const words = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];

export function mock() {
  return {
    async chat({ system = '', messages, json, onToken }) {
      const last = messages[messages.length - 1] || {};
      const input = String(last.content || '');
      let text;
      if (json && /HANDWRITING/.test(system)) {
        const n = (input.match(/strokes: (\d+)/) || [])[1] || '?';
        text = JSON.stringify({ text: `Handwritten note (${n} strokes)\n- [ ] call Ana about the budget`, todos: ['call Ana about the budget'], dates: [], headings: ['Handwritten note'], drawings: '', language: 'en', confidence: 0.9, images: last.images?.length || 0 });
      } else if (json && /IMAGE/.test(system)) {
        text = JSON.stringify({ description: 'A picture (mock description)', text: '' });
      } else if (json && /ANALYSE/.test(system)) {
        const body = input.slice(input.indexOf('\n') + 1);
        const firstLine = body.split('\n').find((l) => l.trim() && !l.startsWith('TITLE:')) || '';
        const actions = [...body.matchAll(/^\s*- \[ \] (.+)$/gm)].map((m) => ({ text: m[1].trim(), due: null }));
        const tags = [...new Set(words(body).filter((w) => w.length > 5))].slice(0, 3);
        text = JSON.stringify({ title: firstLine.replace(/[#*_>]/g, '').trim().slice(0, 60) || 'Untitled', summary: `Summary: ${firstLine.replace(/[#*_>]/g, '').trim().slice(0, 120)}`, tags, actions });
      } else if (json && /LINKS/.test(system)) {
        const ids = [...input.matchAll(/^\[(\w+:[^\]]+)\]/gm)].map((m) => m[1]).slice(0, 1);
        text = JSON.stringify({ links: ids.map((ref) => ({ ref, reason: 'mock match' })) });
      } else if (/ASSISTANT/.test(system)) {
        const src = (input.match(/\[(\d+)\]/) || [])[1];
        text = src ? `From your notes [${src}]: ${(input.match(/QUESTION: (.+)/) || [])[1] || ''}` : 'I could not find this in your notes.';
      } else {
        const sel = (input.match(/<text>\n?([\s\S]*?)\n?<\/text>/) || [])[1] ?? input;
        text = `AI: ${sel.trim().slice(0, 400)}`;
      }
      if (onToken) for (const part of text.match(/.{1,12}/gs) || []) onToken(part);
      return { text, usage: { input: input.length, output: text.length } };
    },
    async embed({ input }) {
      return input.map((s) => {
        const v = new Array(DIM).fill(0);
        for (const w of words(s)) v[crypto.createHash('md5').update(w).digest()[0] % DIM] += 1;
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
    async listModels() { return [{ id: 'mock' }]; },
  };
}
