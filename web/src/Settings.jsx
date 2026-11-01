import { useEffect, useState } from 'react';
import { User, Layers, Sparkles, PenLine, Plug, KeyRound, Shield, Trash2, Plus, Check, RefreshCw, Upload, Pencil, Download } from 'lucide-react';
import { get, post, put, patch, del, sendFile } from './api.js';
import { installApp, standalone, iosDevice } from './pwa.js';
import { store, useStore, navigate, openNote, toast, toastError, localGet } from './store.js';
import { loadSpaces, switchSpace, loadTree } from './data.js';
import { setTheme } from './theme.js';

const SECTIONS = [['profile', 'Profile', User], ['spaces', 'Spaces & sharing', Layers], ['ai', 'AI', Sparkles], ['pen', 'Pen & paper', PenLine], ['integrations', 'Integrations', Plug], ['import', 'Import', Upload], ['tokens', 'Apps & tokens', KeyRound], ['admin', 'Administration', Shield]];

export function SettingsPage({ section }) {
  const user = useStore((s) => s.user);
  const cur = section || 'profile';
  return (
    <div className="settings">
      <nav className="settings-nav">
        {SECTIONS.filter(([id]) => id !== 'admin' || user?.isAdmin).map(([id, label, Icon]) => (
          <a key={id} href={`#/settings/${id}`} className={cur === id ? 'on' : ''}><Icon size={16} /> {label}</a>
        ))}
      </nav>
      <div className="settings-body">
        {cur === 'profile' && <Profile />}
        {cur === 'spaces' && <Spaces />}
        {cur === 'ai' && <AiSettings />}
        {cur === 'pen' && <PenSettings />}
        {cur === 'integrations' && <Integrations />}
        {cur === 'import' && <Import />}
        {cur === 'tokens' && <Tokens />}
        {cur === 'admin' && user?.isAdmin && <Admin />}
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return <label className="field"><span className="label">{label}</span>{children}{hint && <span className="hint">{hint}</span>}</label>;
}

async function saveSettings(patchObj) {
  const s = await put('/api/settings', patchObj);
  store.set({ settings: s });
  return s;
}

function Profile() {
  const user = useStore((s) => s.user);
  const halcyonLogin = useStore((s) => s.authState?.halcyonLogin);
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.color);
  const [pw, setPw] = useState({ password: '', newPassword: '' });
  const [theme, setThemePref] = useState(localGet('theme') || 'system');
  const save = async () => { const u = await patch('/api/me', { name, color }); store.set({ user: u }); toast('Saved'); };
  const changePw = async () => { await patch('/api/me', pw); setPw({ password: '', newPassword: '' }); toast('Password changed — other browsers were signed out'); };
  return (
    <>
      <h2>Profile</h2>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Colour" hint="Your cursor and avatar colour for co-editors."><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></Field>
      <Field label="E-mail"><input value={user.email} disabled /></Field>
      <button className="primary" onClick={() => save().catch(toastError)}>Save</button>
      {halcyonLogin && <><h3>Halcyon login</h3>
        {user.halcyonLinked ? <p className="muted">Linked. You can sign in with Halcyon, and Halcyon's shared spaces appear here for you.</p>
          : <><p className="muted">Sign in here with your Halcyon login, and get Halcyon's shared spaces as spaces here.</p><a className="button" href="/api/auth/halcyon/start?link=1">Link my Halcyon login</a></>}</>}
      <InstallApp />
      <h3>Appearance</h3>
      <div className="seg">{['system', 'light', 'dark'].map((t) => <button key={t} className={theme === t ? 'on' : ''} onClick={() => { setThemePref(t); setTheme(t); }}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>
      <h3>Password</h3>
      <Field label="Current password"><input type="password" autoComplete="current-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></Field>
      <Field label="New password" hint="At least 8 characters."><input type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
      <button onClick={() => changePw().catch(toastError)} disabled={!pw.password || pw.newPassword.length < 8}>Change password</button>
    </>
  );
}

function InstallApp() {
  const canInstall = useStore((s) => s.canInstall);
  if (standalone()) return null;
  return (
    <>
      <h3>App</h3>
      {canInstall ? <><p className="muted">Install Inkwell as an app: its own window and icon, opens without a connection, and other apps can share photos, files and links to it.</p>
        <button onClick={() => installApp().catch(toastError)}><Download size={14} /> Install app</button></>
        : iosDevice() ? <p className="muted">In Safari tap Share, then “Add to Home Screen”: Inkwell gets its own icon and opens full screen.</p>
          : <p className="muted">Your browser can install Inkwell as an app from its menu (“Install Inkwell” or “Add to Home screen”). Installing needs https.</p>}
    </>
  );
}

function Spaces() {
  const spaces = useStore((s) => s.spaces);
  const halcyon = useStore((s) => s.halcyon);
  const [hspaces, setHspaces] = useState([]);
  const route = useStore((s) => s.route);
  const [sel, setSel] = useState(route.query.space || spaces[0]?.id);
  useEffect(() => { if (route.query.space) setSel(route.query.space); }, [route.query.space]);
  const space = spaces.find((s) => s.id === sel) || spaces[0];
  const [members, setMembers] = useState([]);
  const [invite, setInvite] = useState({ email: '', role: 'editor' });
  const [edit, setEdit] = useState(null);
  const owner = space?.role === 'owner';
  const loadMembers = () => space && get(`/api/spaces/${space.id}/members`).then(setMembers).catch(toastError);
  const hconn = space?.settings?.halcyonConnection;
  useEffect(() => { if (halcyon?.connected) get(`/api/halcyon/spaces${hconn ? `?connection=${hconn}` : ''}`).then(setHspaces).catch(() => {}); }, [halcyon?.connected, hconn]);
  useEffect(() => { loadMembers(); setEdit(space ? { name: space.name, icon: space.icon, color: space.color } : null); }, [space?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!space) return null;
  const me = store.get().user;
  return (
    <>
      <h2>Spaces & sharing</h2>
      <div className="space-list">
        {spaces.map((s) => <button key={s.id} className={s.id === space.id ? 'on' : ''} onClick={() => setSel(s.id)}><span className="space-icon" style={{ background: s.color }}>{s.icon || s.name[0]}</span>{s.name}<span className="muted small">{s.role}{s.members > 1 ? ` · ${s.members} people` : ''}</span></button>)}
        <button onClick={async () => { const name = window.prompt('Name of the new space'); if (name) { const s = await post('/api/spaces', { name }); await loadSpaces(); setSel(s.id); } }}><Plus size={15} /> New space</button>
      </div>
      {owner && edit && (
        <div className="row wrap">
          <Field label="Icon"><input className="short" value={edit.icon} maxLength={4} onChange={(e) => setEdit({ ...edit, icon: e.target.value })} /></Field>
          <Field label="Name"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Colour"><input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} /></Field>
          <button className="primary" onClick={() => patch(`/api/spaces/${space.id}`, edit).then(loadSpaces).then(() => toast('Saved')).catch(toastError)}>Save</button>
        </div>
      )}
      {owner && (
        <>
          <label className="check"><input type="checkbox" checked={!!space.settings?.localAiOnly} onChange={(e) => patch(`/api/spaces/${space.id}`, { settings: { localAiOnly: e.target.checked } }).then(loadSpaces).catch(toastError)} />
            Only local AI for this space <span className="hint">— pages here are never sent to cloud AI providers (Ollama / LAN servers only).</span></label>
          <label className="check"><input type="checkbox" checked={space.settings?.aiEnabled !== false} onChange={(e) => patch(`/api/spaces/${space.id}`, { settings: { aiEnabled: e.target.checked } }).then(loadSpaces).catch(toastError)} /> AI features in this space</label>
        </>
      )}
      {space.settings?.aiEnabled !== false && <SpaceAi key={space.id} space={space} owner={owner} />}
      {owner && halcyon?.connections?.length > 1 && (
        <Field label="Halcyon mailbox" hint="Whose mail, calendar and tasks this space shows. Automatic: the connection with the same name as this space, otherwise all of them.">
          <select value={halcyon.connections.some((c) => c.id === hconn) ? hconn : ''} onChange={(e) => patch(`/api/spaces/${space.id}`, { settings: { halcyonConnection: e.target.value || null } }).then(loadSpaces).catch(toastError)}>
            <option value="">Automatic</option>
            {halcyon.connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      )}
      {owner && halcyon?.connected && (
        <Field label="Halcyon space" hint="Today on the home page shows this space's meetings, tasks and e-mails from Halcyon, and notes from Halcyon land here. Automatic: the Halcyon space with the same name.">
          <select value={space.settings?.halcyonSpace ?? '__auto'} onChange={(e) => patch(`/api/spaces/${space.id}`, { settings: { halcyonSpace: e.target.value === '__auto' ? null : e.target.value } }).then(loadSpaces).catch(toastError)}>
            <option value="__auto">Automatic (same name)</option>
            <option value="">None</option>
            {[...new Set([...hspaces, space.settings?.halcyonSpace].filter(Boolean))].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
      )}
      <h3>People</h3>
      <table className="members">
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td><span className="avatar" style={{ background: m.color }}>{m.name[0]}</span> {m.name} <span className="muted small">{m.email}</span></td>
              <td>{owner && m.id !== me.id ? (
                <select value={m.role} onChange={(e) => patch(`/api/spaces/${space.id}/members/${m.id}`, { role: e.target.value }).then(loadMembers).catch(toastError)}>
                  {['owner', 'editor', 'commenter', 'viewer'].map((r) => <option key={r}>{r}</option>)}
                </select>) : m.role}</td>
              <td>{(owner || m.id === me.id) && <button className="icon small" title={m.id === me.id ? 'Leave space' : 'Remove'} onClick={() => del(`/api/spaces/${space.id}/members/${m.id}`).then(() => (m.id === me.id ? loadSpaces() : loadMembers())).catch(toastError)}><Trash2 size={14} /></button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {owner && (
        <div className="row wrap">
          <input placeholder="colleague@example.com" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
          <select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>{['editor', 'commenter', 'viewer', 'owner'].map((r) => <option key={r}>{r}</option>)}</select>
          <button className="primary" onClick={() => post(`/api/spaces/${space.id}/members`, invite).then(() => { setInvite({ email: '', role: 'editor' }); loadMembers(); loadSpaces(); toast('Shared'); }).catch(toastError)}>Share</button>
        </div>
      )}
      <p className="hint">Editors write and organise pages; commenters and viewers read (commenting comes later). Everyone sees co-editors' cursors live.</p>
      {owner && <DeleteSpace space={space} spaces={spaces} open={route.query.delete === '1'} onDone={(next) => setSel(next)} />}
    </>
  );
}

// Deleting a space: its pages go to another space first, unless the person chooses to delete them too.
function DeleteSpace({ space, spaces, open, onDone }) {
  const targets = spaces.filter((s) => s.id !== space.id && ['owner', 'editor'].includes(s.role));
  const [to, setTo] = useState(targets[0]?.id || '');
  const [count, setCount] = useState(null);
  const [busy, setBusy] = useState(false);
  const ownCount = spaces.filter((s) => s.role === 'owner').length;
  useEffect(() => {
    setTo(targets[0]?.id || '');
    get(`/api/spaces/${space.id}/tree`).then((r) => setCount(r.notes.length)).catch(() => setCount(null));
    if (open) setTimeout(() => document.getElementById('delete-space')?.scrollIntoView({ block: 'center' }), 50);
  }, [space.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async () => {
    const target = targets.find((s) => s.id === to);
    const what = count ? `${count} page${count === 1 ? '' : 's'}` : 'its pages';
    const others = space.members > 1 ? ` ${space.members - 1} other ${space.members === 2 ? 'person' : 'people'} lose${space.members === 2 ? 's' : ''} access to it.` : '';
    const msg = target ? `Delete the space “${space.name}”? Its ${what} ${count === 1 ? 'moves' : 'move'} to “${target.name}”.${others}`
      : `Delete the space “${space.name}” and its ${what} for everyone? This cannot be undone.${others}`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      const r = await del(`/api/spaces/${space.id}${target ? `?moveTo=${target.id}` : ''}`);
      await loadSpaces();
      const next = target?.id || store.get().spaces[0]?.id;
      if (target) await loadTree(target.id);
      if (store.get().spaceId === space.id || !store.get().spaces.some((s) => s.id === store.get().spaceId)) switchSpace(next);
      toast(target ? `Space deleted — ${r.moved} page${r.moved === 1 ? '' : 's'} moved to ${target.name}` : 'Space deleted');
      onDone(next);
      navigate(`#/settings/spaces?space=${next}`);
    } catch (e) { toastError(e); }
    setBusy(false);
  };
  return (
    <div id="delete-space" className={`danger-zone${open ? ' flash' : ''}`}>
      <h3>Delete this space</h3>
      {ownCount <= 1 ? <p className="hint">This is your only space of your own, so it cannot be deleted. Make another one first.</p> : (
        <>
          <Field label={`Its pages${count != null ? ` (${count})` : ''}`} hint="Moved pages keep their sub-pages, files, history and the trash.">
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {targets.map((s) => <option key={s.id} value={s.id}>Move to {s.icon} {s.name}</option>)}
              <option value="">Delete them with the space</option>
            </select>
          </Field>
          <button className="danger" disabled={busy} onClick={run}>{busy ? <span className="spinner" /> : <Trash2 size={14} />} Delete space</button>
        </>
      )}
    </div>
  );
}

const TASKS = [['chat', 'Writing, summaries, questions'], ['vision', 'Handwriting & images'], ['embed', 'Search by meaning'], ['audio', 'Speech to text (recordings)']];
const TASK_NAMES = { chat: 'text', vision: 'images', embed: 'search', audio: 'speech' };

function ModelList({ models }) {
  if (!models) return <p className="hint model-list"><span className="spinner" /> Asking the provider…</p>;
  if (models.error) return <p className="hint error model-list">Could not list models: {models.error}</p>;
  if (!models.length) return <p className="hint model-list">The provider lists no models.</p>;
  return (
    <ul className="model-list">
      {models.map((m) => <li key={m.id}><code>{m.id}</code> <span className="muted small">{m.tasks.map((t) => `${m.suggested.includes(t) ? '★ ' : ''}${TASK_NAMES[t]}`).join(' · ')}</span></li>)}
    </ul>
  );
}

// A list of what the provider really has, best fits first. A name can still be typed: not every server lists everything.
function ModelPicker({ task, value, list, onPick }) {
  const [typing, setTyping] = useState(false);
  const models = Array.isArray(list) ? list : [];
  const known = models.some((m) => m.id === value);
  if (typing || list?.error || (list && !models.length)) {
    return (
      <>
        <input key={value} defaultValue={value} placeholder="model name" autoFocus={typing} onBlur={(e) => { setTyping(false); if (e.target.value !== value) onPick(e.target.value.trim()); }} onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
        {list?.error && <span className="hint error route-note">Could not list models: {list.error}</span>}
      </>
    );
  }
  const best = models.filter((m) => m.suggested.includes(task));
  const fits = models.filter((m) => !m.suggested.includes(task) && m.tasks.includes(task));
  const rest = models.filter((m) => !m.suggested.includes(task) && !m.tasks.includes(task));
  const opts = (l, star) => l.map((m) => <option key={m.id} value={m.id}>{star}{m.id}</option>);
  return (
    <select value={value} disabled={!list} onChange={(e) => { if (e.target.value === '__type') setTyping(true); else onPick(e.target.value); }}>
      <option value="">{list ? 'Default model' : 'Loading models…'}</option>
      {value && !known && <option value={value}>{value}</option>}
      {best.length > 0 && <optgroup label="Suggested">{opts(best, '★ ')}</optgroup>}
      {fits.length > 0 && <optgroup label="Fits this task">{opts(fits, '')}</optgroup>}
      {rest.length > 0 && <optgroup label="Other models">{opts(rest, '')}</optgroup>}
      <option value="__type">Type a name…</option>
    </select>
  );
}

function AiSettings() {
  const settings = useStore((s) => s.settings);
  const user = useStore((s) => s.user);
  const [types, setTypes] = useState([]);
  const [providers, setProviders] = useState([]);
  const [status, setStatus] = useState(null);
  const [failed, setFailed] = useState([]);
  const [form, setForm] = useState(null);
  const [models, setModels] = useState({});
  const load = () => Promise.all([get('/api/ai/providers').then(setProviders), get('/api/ai/status').then(setStatus), get('/api/ai/failed').then(setFailed)]).catch(toastError);
  useEffect(() => { get('/api/ai/types').then(setTypes).catch(toastError); load(); }, []);
  // While work runs, keep the counts and any new failure reason current.
  const busy = (status?.jobs.queued || 0) + (status?.jobs.running || 0);
  useEffect(() => { if (!busy) return undefined; const t = setTimeout(load, 4000); return () => clearTimeout(t); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  const [shown, setShown] = useState(null);
  const loadModels = (id, body = { id }) => post('/api/ai/models', body).then((m) => m, (e) => ({ error: e.message })).then((m) => { setModels((x) => ({ ...x, [id]: m })); return m; });
  const chosen = ['chat', 'vision', 'embed', 'audio'].map((t) => settings?.ai[t]?.providerId).filter(Boolean).join();
  useEffect(() => { for (const id of new Set(chosen.split(',').filter(Boolean))) if (!models[id]) loadModels(id); }, [chosen]); // eslint-disable-line react-hooks/exhaustive-deps
  const test = async (body) => { const r = await post('/api/ai/test', body); toast(r.ok ? `Works (${r.model}, ${r.ms} ms): “${r.reply}”` : `Failed: ${r.error}`, { kind: r.ok ? 'info' : 'error', duration: 7000 }); };
  const saveProvider = async () => {
    const { id, name, type, baseUrl, apiKey, shared } = form;
    if (id) await patch(`/api/ai/providers/${id}`, { name, type, baseUrl, apiKey });
    else await post('/api/ai/providers', { name, type, baseUrl, apiKey, shared });
    setForm(null); setModels({}); await load(); toast(id ? 'Provider saved' : 'Provider added');
  };
  const editProvider = (p) => { setModels((m) => ({ ...m, form: undefined })); setForm({ id: p.id, type: p.type, name: p.name, baseUrl: p.baseUrl || '', apiKey: '', hasKey: p.hasKey }); };
  const showModels = (id) => { setShown(shown === id ? null : id); if (shown !== id) loadModels(id); };
  const route = (task, providerId, model) => saveSettings({ ai: { [task]: providerId ? { providerId, model } : null } }).then(load);
  if (!settings) return null;
  const T = (id) => types.find((t) => t.id === id);
  const reasons = Object.entries(failed.reduce((all, f) => { const k = `${f.type}: ${f.error}`; all[k] = (all[k] || 0) + 1; return all; }, {}));
  return (
    <>
      <h2>AI</h2>
      <label className="check"><input type="checkbox" checked={settings.ai.enabled} onChange={(e) => saveSettings({ ai: { enabled: e.target.checked } })} /> Use AI</label>
      <label className="check"><input type="checkbox" checked={settings.ai.background} onChange={(e) => saveSettings({ ai: { background: e.target.checked } })} /> Work in the background <span className="hint">— summaries, handwriting, image text and search index are ready before you ask.</span></label>
      <Field label="Language of AI output" hint="Empty: the language of each page."><input value={settings.language} placeholder="e.g. Slovenian" onChange={(e) => store.set({ settings: { ...settings, language: e.target.value } })} onBlur={(e) => saveSettings({ language: e.target.value })} /></Field>

      <h3>Providers</h3>
      {providers.map((p) => (
        <div key={p.id} className="provider">
          <b>{p.name}</b> <span className="muted small">{T(p.type)?.label || p.type}{p.baseUrl ? ` · ${p.baseUrl}` : ''}{p.shared ? ' · server-wide' : ''}</span>
          <span className="grow" />
          <button onClick={() => test({ id: p.id }).catch(toastError)}>Test</button>
          <button onClick={() => showModels(p.id)}>Models</button>
          {!p.env && (!p.shared || user.isAdmin) && <button onClick={() => editProvider(p)}><Pencil size={14} /> Edit</button>}
          {!p.env && (!p.shared || user.isAdmin) && <button className="icon small" onClick={() => del(`/api/ai/providers/${p.id}`).then(load).catch(toastError)} aria-label="Remove"><Trash2 size={14} /></button>}
          {shown === p.id && <ModelList models={models[p.id]} />}
        </div>
      ))}
      {!form ? <button onClick={() => { setModels((m) => ({ ...m, form: undefined })); setForm({ type: 'ollama', name: '', baseUrl: '', apiKey: '' }); }}><Plus size={14} /> Add provider</button> : (
        <div className="card-form">
          <Field label="Type"><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></Field>
          <Field label="Name"><input value={form.name} placeholder={T(form.type)?.label} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Address" hint={`Default: ${T(form.type)?.defaultBaseUrl || '—'}`}><input value={form.baseUrl} placeholder={T(form.type)?.defaultBaseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></Field>
          {T(form.type)?.needsKey !== false && <Field label="API key" hint={form.hasKey ? 'A key is saved. Leave empty to keep it.' : undefined}><input type="password" autoComplete="new-password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></Field>}
          {!form.id && user.isAdmin && <label className="check"><input type="checkbox" checked={!!form.shared} onChange={(e) => setForm({ ...form, shared: e.target.checked })} /> Server-wide (all users may use it)</label>}
          <div className="row"><button onClick={() => test(form).catch(toastError)}>Test</button><button onClick={() => loadModels('form', form)}>List models</button><button className="primary" onClick={() => saveProvider().catch(toastError)}>{form.id ? 'Save' : 'Add'}</button><button onClick={() => setForm(null)}>Cancel</button></div>
          {models.form && <ModelList models={models.form} />}
        </div>
      )}

      <h3>Which model does what</h3>
      <p className="hint">Pick a provider for a task, then one of its models. Models marked ★ are the ones we suggest for that task. Background work runs often, so a fast, cheap model is usually the better choice for writing and summaries.</p>
      {TASKS.map(([task, label]) => {
        const r = settings.ai[task];
        const chosenType = providers.find((p) => p.id === r?.providerId)?.type;
        const note = T(chosenType)?.advice?.[task]?.note;
        return (
          <div key={task} className="route-row">
            <span className="label">{label}</span>
            <select value={r?.providerId || ''} onChange={(e) => route(task, e.target.value, '')}>
              <option value="">Automatic{status?.[task] ? ` (${status[task].provider} · ${status[task].model})` : ' (none)'}</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {r?.providerId && (
              <ModelPicker task={task} value={r.model || ''} list={models[r.providerId]} onPick={(m) => route(task, r.providerId, m)} />
            )}
            {note && <span className="hint route-note">{note}</span>}
          </div>
        );
      })}
      <details className="advice">
        <summary>Suggested models for each provider</summary>
        {types.filter((t) => t.advice).map((t) => (
          <div key={t.id}>
            <h4>{t.label}</h4>
            <ul className="hint">{TASKS.map(([task, label]) => <li key={task}><b>{label}:</b> {t.advice[task].models.join(', ')}{t.advice[task].models.length ? '. ' : ''}{t.advice[task].note}</li>)}</ul>
          </div>
        ))}
      </details>
      <h3>Background work</h3>
      <p>{status ? `${status.jobs.queued} waiting · ${status.jobs.running} running · ${status.jobs.failed} failed` : '…'}</p>
      <div className="row">
        <button onClick={() => post('/api/ai/reanalyse').then((r) => toast(`${r.queued} pages queued`)).catch(toastError)}><RefreshCw size={14} /> Re-analyse all my pages</button>
        {failed.length > 0 && <button onClick={() => post('/api/ai/failed/retry').then((r) => { toast(`${r.queued} job${r.queued === 1 ? '' : 's'} queued again`); return load(); }).catch(toastError)}><RefreshCw size={14} /> Try failed work again</button>}
      </div>
      {reasons.length > 0 && <h4>Why it failed</h4>}
      {reasons.slice(0, 5).map(([text, n]) => <p key={text} className="error small">{text}{n > 1 ? ` (${n} times)` : ''}</p>)}
    </>
  );
}

function PenSettings() {
  const settings = useStore((s) => s.settings);
  if (!settings) return null;
  return (
    <>
      <h2>Pen & paper</h2>
      <Field label="Paper for new journal pages">
        <div className="seg">{['ruled', 'grid', 'dotted', 'plain'].map((p) => <button key={p} className={settings.paper === p ? 'on' : ''} onClick={() => saveSettings({ paper: p })}>{p}</button>)}</div>
      </Field>
      <Field label="Touch and pen" hint="Automatic: once you use a pen, fingers scroll and only the pen writes (palm rejection).">
        <div className="seg">{[['auto', 'Automatic'], ['on', 'Pen only'], ['off', 'Fingers draw too']].map(([v, l]) => <button key={v} className={settings.penOnly === v ? 'on' : ''} onClick={() => saveSettings({ penOnly: v })}>{l}</button>)}</div>
      </Field>
      <h3>Shortcuts on a canvas</h3>
      <p className="hint">P pen · H highlighter · E eraser · L lasso (select, drag to move, Delete) · S insert space (drag down for room, up to close a gap) · T text box (journal) · Ctrl+Z / Ctrl+Y undo/redo. The pen's eraser end and barrel button erase.</p>
    </>
  );
}

// The models a space's pages use for everyone in it, whoever starts the work: chosen once by its owner, shown to the
// other members. Automatic leaves it to each person's own choice.
function SpaceAi({ space, owner }) {
  const [info, setInfo] = useState(null);
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState({});
  const load = () => get(`/api/spaces/${space.id}/ai`).then(setInfo).catch(toastError);
  useEffect(() => { load(); if (owner) get('/api/ai/providers').then(setProviders).catch(() => {}); }, [owner]); // eslint-disable-line react-hooks/exhaustive-deps
  const ids = info ? TASKS.slice(0, 3).map(([t]) => info[t]?.providerId).filter(Boolean).join() : '';
  useEffect(() => {
    if (owner) for (const id of new Set(ids.split(',').filter(Boolean))) if (!models[id]) post('/api/ai/models', { id }).then((m) => m, (e) => ({ error: e.message })).then((m) => setModels((x) => ({ ...x, [id]: m })));
  }, [ids, owner]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (task, providerId, model) => patch(`/api/spaces/${space.id}`, { settings: { ai: { [task]: providerId ? { providerId, model } : null } } }).then(load).catch(toastError);
  if (!info) return null;
  return (
    <>
      <h3>AI models for this space</h3>
      <p className="hint">{owner ? 'Work on this space’s pages uses these for everyone in it. Automatic: each person’s own choice under Settings → AI. You can pick server-wide providers and your own.'
        : 'Set by the space’s owner. Automatic: your own choice under Settings → AI.'}</p>
      {TASKS.slice(0, 3).map(([task, label]) => {
        const c = info[task];
        return (
          <div key={task} className="route-row">
            <span className="label">{label}</span>
            {owner ? <>
              <select value={c?.providerId || ''} onChange={(e) => set(task, e.target.value, '')}>
                <option value="">Automatic (each person’s own)</option>
                {c?.providerId && !providers.some((p) => p.id === c.providerId) && <option value={c.providerId}>{c.provider || 'Unavailable provider'}</option>}
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}{p.shared ? ' (server-wide)' : ''}</option>)}
              </select>
              {c?.providerId && <ModelPicker task={task} value={c.model} list={models[c.providerId]} onPick={(m) => set(task, c.providerId, m)} />}
            </> : <span>{c ? `${c.provider || 'Unavailable provider'}${c.model ? ` · ${c.model}` : ''}` : 'Automatic (your own choice)'} <span className="hint">— set by the space’s owner</span></span>}
          </div>
        );
      })}
    </>
  );
}

function Integrations() {
  const halcyon = useStore((s) => s.halcyon);
  const all = halcyon?.connections || [];
  // Suite connections come with the Halcyon sign-in; pasted ones are for another Halcyon server.
  const suite = all.filter((c) => c.suite);
  const list = all.filter((c) => !c.suite);
  const blank = { name: '', baseUrl: list[0]?.baseUrl || '', token: '', tls: { mode: 'check', ca: '' } };
  const [form, setForm] = useState(null);
  const shown = form || (all.length ? null : blank);
  const [busy, setBusy] = useState(false);
  const set = (patchObj) => setForm({ ...shown, ...patchObj });
  const tlsBody = (t) => (t.mode === 'keep' ? undefined : t.mode === 'skip' ? { insecure: true } : t.mode === 'ca' ? { ca: t.ca } : {});
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: shown.name, baseUrl: shown.baseUrl, token: shown.token, tls: tlsBody(shown.tls) };
      const r = await (shown.id ? patch(`/api/integrations/halcyon/connections/${shown.id}`, body) : post('/api/integrations/halcyon/connections', body));
      store.set({ halcyon: r }); setForm(null); toast(shown.id ? 'Connection saved' : 'Halcyon connected');
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const remove = (c) => { if (window.confirm(`Remove the connection “${c.name}”? Links on your pages stay.`)) del(`/api/integrations/halcyon/connections/${c.id}`).then((r) => store.set({ halcyon: r })).catch(toastError); };
  return (
    <>
      <h2>Integrations</h2>
      <h3>Halcyon — mail, calendar & tasks</h3>
      <p>Link pages with e-mails, meetings and tasks, start meeting notes from your calendar and send action items to your task list.</p>
      {suite.map((c) => (
        <div key={c.id} className="provider">
          <Check size={16} /> <b>{c.name}</b>
          <span className="muted small">{c.shared ? 'shared space' : 'your mail'} · through Halcyon sign-in — set up by the administrator</span>
        </div>
      ))}
      {suite.length > 0 && <p className="hint">Nothing to set up: your own mail and the shared spaces you are in come with your Halcyon login.</p>}
      {suite.length > 0 ? <details className="advice" open={list.length > 0 || !!form}><summary>Other Halcyon server</summary>{manual()}</details> : manual()}
    </>
  );

  function manual() {
    return <>
      {list.map((c, i) => (
        <div key={c.id} className="provider">
          <Check size={16} /> <b>{c.name}</b>
          <span className="muted small">{c.baseUrl}{i === 0 && list.length > 1 ? ' · main' : ''}{c.settings?.tls?.insecure ? ' · certificate not checked' : c.settings?.tls?.ca ? ' · own certificate authority' : ''}</span>
          <span className="grow" />
          <button onClick={() => setForm({ id: c.id, name: c.name, baseUrl: c.baseUrl, token: '', tls: { mode: 'keep', ca: '' } })}><Pencil size={14} /> Edit</button>
          <button className="icon small" onClick={() => remove(c)} aria-label={`Remove ${c.name}`}><Trash2 size={14} /></button>
        </div>
      ))}
      {!shown && <button onClick={() => setForm(blank)}><Plus size={14} /> Add a mailbox or shared space</button>}
      {list.length > 0 && <p className="hint">Each Halcyon token reads one mailbox: your own mail, or one shared space. Add one connection for each. Tasks and meetings from all of them appear here; to tie a connection to an Inkwell space, give both the same name or choose it under Spaces & sharing.</p>}
      {shown && (
        <div className={list.length ? 'card-form' : ''}>
          {!shown.id && (
            <ol className="hint">
              <li>In Halcyon open <b>Settings → Assistants</b> and create a token for “Inkwell”. Choose whose mail it reads: your own, or a shared space. Choose <i>propose</i> access so Inkwell can add tasks.</li>
              <li>Paste Halcyon's address and the token here.</li>
            </ol>
          )}
          <Field label="Name" hint="Shown next to items when you have several connections."><input value={shown.name} placeholder={list.length ? 'e.g. Lab shared' : 'My mail'} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Halcyon address"><input value={shown.baseUrl} placeholder="https://mail.example.com" onChange={(e) => set({ baseUrl: e.target.value })} /></Field>
          <Field label={shown.id ? 'New assistant token' : 'Assistant token'} hint={shown.id ? 'Leave empty to keep the saved token.' : undefined}><input type="password" autoComplete="new-password" value={shown.token} placeholder="hmcp_…" onChange={(e) => set({ token: e.target.value })} /></Field>
          {/^https:/i.test(shown.baseUrl.trim()) && <CertField value={shown.tls} onChange={(tls) => set({ tls })} />}
          <div className="row">
            <button className="primary" disabled={busy || !shown.baseUrl || (!shown.id && !shown.token)} onClick={save}>{busy ? 'Checking…' : shown.id ? 'Save' : 'Connect'}</button>
            {form && all.length > 0 && <button onClick={() => setForm(null)}>Cancel</button>}
          </div>
        </div>
      )}
    </>;
  }
}

/**
 * Halcyon's certificate: checked as usual, checked against the user's own certificate authority (self-signed, a
 * company or home CA — pasted or loaded from a .pem/.crt/.cer file), or not checked.
 */
function CertField({ value, onChange }) {
  const load = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder().decode(buf);
    // A binary (DER) certificate becomes PEM.
    const pem = text.includes('-----BEGIN') ? text.trim()
      : `-----BEGIN CERTIFICATE-----\n${btoa(String.fromCharCode(...buf)).replace(/.{64}/g, '$&\n').trim()}\n-----END CERTIFICATE-----`;
    onChange({ mode: 'ca', ca: pem });
  };
  return (
    <>
      <Field label="Halcyon's certificate"><select value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value })}>
        {value.mode === 'keep' && <option value="keep">Keep as saved</option>}
        <option value="check">Check as usual</option>
        <option value="ca">Trust my certificate authority (self-signed / own CA)</option>
        <option value="skip">Do not check (not safe)</option>
      </select></Field>
      {value.mode === 'ca' && <>
        <textarea rows={4} style={{ fontFamily: 'monospace', fontSize: 11, width: '100%' }} placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----'} value={value.ca} onChange={(e) => onChange({ ...value, ca: e.target.value })} />
        <p className="hint">The certificate of the authority that signed Halcyon's certificate (or Halcyon's own self-signed one). <label style={{ color: 'var(--accent)', cursor: 'pointer' }}>Load from file…<input type="file" accept=".pem,.crt,.cer,.der" hidden onChange={load} /></label></p>
      </>}
      {value.mode === 'skip' && <p className="hint error">The connection stays encrypted, but Inkwell cannot tell Halcyon from an impostor. Prefer adding your certificate authority.</p>}
    </>
  );
}

function Import() {
  const spaces = useStore((s) => s.spaces).filter((s) => ['owner', 'editor'].includes(s.role));
  const current = useStore((s) => s.spaceId);
  const [chosen, setSpaceId] = useState(null);
  // Spaces may still be loading on first render: fall back to the current one until the user picks.
  const spaceId = spaces.some((s) => s.id === chosen) ? chosen : spaces.some((s) => s.id === current) ? current : spaces[0]?.id;
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);
  const [result, setResult] = useState(null);
  const run = async () => {
    setBusy(true); setResult(null);
    try {
      const uploadId = await sendFile(file, { onProgress: setSent });
      setSent(null);
      const r = await post('/api/import', { uploadId, name: file.name, spaceId });
      setResult(r);
      await loadTree(spaceId);
      toast(`Imported ${r.pages} page${r.pages === 1 ? '' : 's'}`);
    } catch (e) { toastError(e); } finally { setBusy(false); setSent(null); }
  };
  return (
    <>
      <h2>Import</h2>
      <h3>From AFFiNE</h3>
      <ol className="hint">
        <li>In AFFiNE export the workspace and choose the <code>.affine</code> file below. A <b>Snapshot</b> <code>.zip</code> of a workspace or a doc works too.</li>
        <li>Choose it below. Headings, lists, to-dos, tables, code, callouts, images, files, links between docs and pen strokes from edgeless canvases are kept;
          docs embedded as linked cards become sub-pages. Database views arrive as plain lists; edgeless shapes are skipped.</li>
      </ol>
      <h3>From OneNote</h3>
      <p className="hint">A <code>.onepkg</code> notebook package (OneNote desktop: File → Export → Notebook), a <code>.one</code> section, or a <code>.zip</code> of a notebook folder. Handwritten pages become journals that keep their layout, with pictures and text boxes in place; typed pages become ordinary pages. Section groups, sections and sub-pages keep their order.</p>
      <h3>From Markdown, Notion or Obsidian</h3>
      <p className="hint">A single <code>.md</code> file or a <code>.zip</code> of them: folders become parent pages, relative images are uploaded, links between files become page links.</p>
      <Field label="Into space">
        <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>{spaces.map((s) => <option key={s.id} value={s.id}>{s.icon} {s.name}</option>)}</select>
      </Field>
      <Field label="File" hint="Everything lands under one new page “Imported from …”, which you can move or rename afterwards.">
        <input type="file" accept=".one,.onepkg,.affine,.zip,.md,.markdown" onChange={(e) => setFile(e.target.files[0] || null)} />
      </Field>
      <button className="primary" disabled={!file || !spaceId || busy} onClick={run}>{busy ? <><span className="spinner" /> {sent != null ? `Uploading ${Math.floor(sent * 100)}%…` : 'Importing…'}</> : <><Upload size={15} /> Import</>}</button>
      {result && (
        <div className="banner">
          <Check size={16} /> {result.pages} pages and {result.assets} files imported.
          <button onClick={() => openNote(result.rootId)}>Open</button>
          {result.warnings.length > 0 && <ul className="hint">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
        </div>
      )}
    </>
  );
}

function Tokens() {
  const [tokens, setTokens] = useState([]);
  const [fresh, setFresh] = useState(null);
  const load = () => get('/api/tokens').then(setTokens).catch(toastError);
  useEffect(() => { load(); }, []);
  return (
    <>
      <h2>Apps & tokens</h2>
      <p>Native apps sign in and get their own token. Create one here for scripts, or for a Halcyon on another server to look up notes linked to its e-mails and events (<code>GET /api/links/lookup?kind=event&ref=…</code>) — the Halcyon set up with this server needs none.</p>
      {fresh && <div className="banner">Copy it now — it is shown only once: <code className="select">{fresh}</code></div>}
      <button onClick={async () => { const name = window.prompt('Name for the token', 'Halcyon'); if (name) { setFresh((await post('/api/tokens', { name })).token); load(); } }}><Plus size={14} /> New token</button>
      <table className="members"><tbody>
        {tokens.map((t) => <tr key={t.id}><td><b>{t.name}</b></td><td className="muted small">created {new Date(t.createdAt).toLocaleDateString()}{t.lastUsedAt ? ` · used ${new Date(t.lastUsedAt).toLocaleDateString()}` : ''}</td>
          <td><button className="icon small" onClick={() => del(`/api/tokens/${t.id}`).then(load).catch(toastError)} aria-label="Revoke"><Trash2 size={14} /></button></td></tr>)}
      </tbody></table>
    </>
  );
}

function Admin() {
  const [users, setUsers] = useState([]);
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState(null);
  const me = useStore((s) => s.user);
  const load = () => Promise.all([get('/api/admin/users').then(setUsers), get('/api/admin/settings').then(setCfg)]).catch(toastError);
  useEffect(() => { load(); }, []);
  const save = async () => {
    const { id, name, email, password, isAdmin } = form;
    if (id) await patch(`/api/admin/users/${id}`, { name, email, ...(password ? { password } : {}) });
    else await post('/api/admin/users', { name, email, password, isAdmin });
    setForm(null); await load(); toast(id ? 'User saved' : 'User added');
    if (id === me.id) store.set({ user: await get('/api/me') });
  };
  return (
    <>
      <h2>Administration</h2>
      {cfg && <label className="check"><input type="checkbox" checked={cfg.allowSignup} onChange={(e) => put('/api/admin/settings', { allowSignup: e.target.checked }).then(load).catch(toastError)} /> Anyone can create an account on this server</label>}
      <h3>Users</h3>
      <table className="members"><tbody>
        {users.map((u) => (
          <tr key={u.id}>
            <td><span className="avatar" style={{ background: u.color }}>{u.name[0]}</span> {u.name} <span className="muted small">{u.email}</span></td>
            <td className="muted small">{u.spaces} spaces{u.isAdmin ? ' · admin' : ''}{u.disabled ? ' · disabled' : ''}</td>
            <td>
              <button onClick={() => setForm({ id: u.id, name: u.name, email: u.email, password: '' })}><Pencil size={14} /> Edit</button>
              <button onClick={() => patch(`/api/admin/users/${u.id}`, { isAdmin: !u.isAdmin }).then(load).catch(toastError)}>{u.isAdmin ? 'Remove admin' : 'Make admin'}</button>
              <button className={u.disabled ? '' : 'danger'} onClick={() => patch(`/api/admin/users/${u.id}`, { disabled: !u.disabled }).then(load).catch(toastError)}>{u.disabled ? 'Enable' : 'Disable'}</button>
            </td>
          </tr>
        ))}
      </tbody></table>
      {!form ? <button onClick={() => setForm({ name: '', email: '', password: '', isAdmin: false })}><Plus size={14} /> Add user</button> : (
        <div className="card-form">
          <h4>{form.id ? `Edit ${form.name}` : 'New user'}</h4>
          <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="E-mail" hint="This is what they sign in with."><input type="email" autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label={form.id ? 'New password' : 'Password'} hint={form.id ? 'Leave empty to keep the password. A new one signs this user out everywhere, apps and tokens too.' : 'At least 8 characters. Give it to the user yourself; they can change it under Profile.'}><input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          {!form.id && <label className="check"><input type="checkbox" checked={form.isAdmin} onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })} /> Administrator</label>}
          <div className="row"><button className="primary" disabled={!form.email || (form.password ? form.password.length < 8 : !form.id)} onClick={() => save().catch(toastError)}>{form.id ? 'Save' : 'Add user'}</button><button onClick={() => setForm(null)}>Cancel</button></div>
        </div>
      )}
      <p className="hint">Server-wide AI providers are added under Settings → AI (tick “Server-wide”). <button className="link" onClick={() => navigate('#/settings/ai')}>Open</button></p>
    </>
  );
}
