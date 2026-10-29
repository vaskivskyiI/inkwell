import { useState } from 'react';
import { post } from './api.js';
import { useStore } from './store.js';

export function AuthPage({ onDone }) {
  const auth = useStore((s) => s.authState);
  const [mode, setMode] = useState(auth?.needsSetup ? 'signup' : 'login');
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try { await post(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', f); onDone(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand"><span className="logo">✒️</span> Inkwell</div>
        <p className="muted">{auth?.needsSetup ? 'Create the first account — it becomes the administrator.' : mode === 'signup' ? 'Create your account' : 'Sign in to your notes'}</p>
        {mode === 'signup' && <input placeholder="Your name" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
        <input type="email" placeholder="E-mail" autoComplete="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <input type="password" placeholder="Password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={mode === 'signup' ? 8 : 1} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        {err && <p className="error">{err}</p>}
        <button className="primary" disabled={busy}>{busy ? '…' : mode === 'signup' ? 'Create account' : 'Sign in'}</button>
        {!auth?.needsSetup && auth?.allowSignup && (
          <button type="button" className="link" onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}>{mode === 'signup' ? 'I already have an account' : 'Create an account'}</button>
        )}
      </form>
    </div>
  );
}
