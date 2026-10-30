// Tablets show the on-screen keyboard whenever editable text has focus, and canvases sit inside or on top of the
// editor. Drawing takes focus away from text and tells the browser not to offer a keyboard for the editor
// (inputmode="none"); touching the text itself gives the keyboard back.
export function keepKeyboardAway() {
  const a = document.activeElement;
  if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) a.blur();
  for (const el of document.querySelectorAll('.ProseMirror')) el.setAttribute('inputmode', 'none');
}

export const allowKeyboard = (el) => el.removeAttribute('inputmode');
