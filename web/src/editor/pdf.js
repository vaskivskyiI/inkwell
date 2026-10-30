// A PDF becomes drawing blocks: every page rendered to a picture you can write on, with its text kept for search.
// pdf.js loads only when a PDF is opened.
import { put, upload } from '../api.js';
import { sid } from '../ink/geometry.js';

const MAX_PAGES = 150;

export async function pdfToBlocks(file, target, onProgress) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = Math.min(pdf.numPages, MAX_PAGES);
  const blocks = [];
  for (let i = 1; i <= pages; i++) {
    onProgress?.(i, pages);
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 1600 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    const a = await upload(new File([blob], `${file.name} p${i}.jpg`, { type: 'image/jpeg' }), target);
    const text = (await page.getTextContent()).items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    if (text) await put(`/api/assets/${a.id}/text`, { text });
    blocks.push({ type: 'inkBlock', attrs: { id: sid(), height: Math.round((1000 * canvas.height) / canvas.width), bg: a.url, width: 100 } });
  }
  return { blocks, pages, total: pdf.numPages };
}
