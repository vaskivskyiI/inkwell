// A handwritten page's title, written with the pen and turned into text a moment after the last stroke. The ink is
// never stored: the browser's own handwriting recognizer reads it where there is one, otherwise the vision model.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { InkCanvas } from './InkCanvas.jsx';
import { post } from '../api.js';

async function readHere(strokes) {
  if (!navigator.createHandwritingRecognizer || typeof HandwritingStroke === 'undefined') return '';
  try {
    const r = await navigator.createHandwritingRecognizer({ languages: [(navigator.language || 'en').split('-')[0]] });
    const d = r.startDrawing({ recognitionType: 'text' });
    let t = 0;
    for (const s of strokes) {
      const hs = new HandwritingStroke(); // eslint-disable-line no-undef
      for (let i = 0; i + 1 < s.p.length; i += 3) hs.addPoint({ x: s.p[i], y: s.p[i + 1], t: (t += 8) });
      d.addStroke(hs);
    }
    const [best] = await d.getPrediction();
    r.finish?.();
    return best?.text?.trim() || '';
  } catch { return ''; }
}

export function InkTitle({ noteId, onText, onClose }) {
  const doc = useMemo(() => new Y.Doc(), []);
  const canvas = useRef(null);
  const timer = useRef(0);
  const [state, setState] = useState('');
  useEffect(() => () => { clearTimeout(timer.current); doc.destroy(); }, [doc]);

  async function read() {
    const strokes = canvas.current?.strokes() || [];
    if (!strokes.length) return;
    setState('Reading…');
    try {
      const text = (await readHere(strokes)) || (await post(`/api/notes/${noteId}/ink/read`, { strokes })).text;
      // More was written while it was being read: read again once that is done.
      if ((canvas.current?.strokes() || []).length !== strokes.length) return;
      if (!text) { setState('Could not read that — write it again, or type'); return; }
      onText(text);
      canvas.current?.clear();
      setState('');
    } catch (e) { setState(e.message); }
  }
  const onStrokes = (strokes) => { clearTimeout(timer.current); if (strokes.length) timer.current = setTimeout(read, 1200); };

  return (
    <div className="ink-title">
      <InkCanvas ref={canvas} doc={doc} canvasId="t" height={130} minHeight={130} zoomable={false} spaceable={false} toolOverride={{ tool: 'pen' }} onStrokesChange={onStrokes} />
      <span className="ink-title-hint">{state || 'Write the title here with the pen'}</span>
      {onClose && <button className="ink-title-close" onClick={onClose} aria-label="Type the title instead">×</button>}
    </div>
  );
}
