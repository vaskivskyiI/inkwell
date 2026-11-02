// Pages made with "New" that their maker leaves without writing anything are thrown away, so clicking New twice or
// changing one's mind leaves no empty "Untitled" pages behind. The server checks again before deleting.
import * as Y from 'yjs';
import { removeNotes } from './store.js';

const fresh = new Set();
export const markFresh = (id) => fresh.add(id);
export const isFresh = (id) => fresh.has(id);

const emptyBlock = (el) => el instanceof Y.XmlElement && el.nodeName === 'paragraph' && el.toArray().every((c) => c instanceof Y.XmlText && !c.length);
export const emptyBody = (frag) => frag.toArray().every(emptyBlock);

export function blankDoc(doc) {
  if (doc.getText('title').toString().trim()) return false;
  if (!emptyBody(doc.getXmlFragment('default'))) return false;
  if ([...doc.getMap('ink').values()].some((a) => a instanceof Y.Array && a.length)) return false;
  return !doc.getMap('images').size && !doc.getMap('boxes').size;
}

/** Called when a page is closed (another page opened, or the tab closed). */
export function leavePage(id, doc) {
  if (!fresh.has(id)) return;
  fresh.delete(id);
  if (!blankDoc(doc)) return;
  fetch(`/api/notes/${id}/discard`, { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then((r) => r.json()).then((r) => { if (r.deleted) removeNotes([id]); }).catch(() => {});
}
