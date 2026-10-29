import { useEffect, useRef } from 'react';

const EMOJI = '📄 📝 📓 📔 📒 📕 📗 📘 📙 📚 🗂️ 📁 📌 📎 🗓️ 📅 ⏰ ✅ ☑️ 🎯 🚀 💡 🔥 ⭐ ❤️ 💼 🏠 🏢 👥 🤝 💬 📣 📈 📊 💰 🧾 🛒 ✈️ 🌍 🧪 🔬 🧠 🎓 🖋️ ✍️ 🎨 🎵 🎬 📷 🍳 🌱 🏃 🧘 🐞 🛠️ ⚙️ 🔒 🔑 📦 🧩'.split(' ');

export function EmojiPicker({ onPick, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [onClose]);
  return (
    <div className="emoji-picker" ref={ref}>
      <div className="grid">{EMOJI.map((e) => <button key={e} onClick={() => onPick(e)}>{e}</button>)}</div>
      <button className="link" onClick={() => onPick('')}>Remove icon</button>
    </div>
  );
}
