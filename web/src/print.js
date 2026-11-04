// Printing a page: the server's print view (A4, handwriting cut between lines), which opens the print dialog by
// itself — also where "Save as PDF" is. Phones print what is on screen, so there it opens in its own tab (the
// Android app hands it to Android's printing).
import { toast } from './store.js';
import { touchDevice } from './capture.js';

export function printPage(id, { pdf = false } = {}) {
  const url = `/api/notes/${id}/export?format=pdf`;
  if (touchDevice()) { window.open(url, '_blank'); return; }
  document.getElementById('print-frame')?.remove();
  const f = document.createElement('iframe');
  f.id = 'print-frame';
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  f.src = url;
  document.body.appendChild(f);
  toast(pdf ? 'Preparing the PDF…' : 'Preparing the page for printing…');
}
