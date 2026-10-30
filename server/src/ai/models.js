// What listed models are good for. Provider APIs mostly return bare names, so tasks are read from the name; a model we
// cannot place stays selectable. The advice is shown in Settings → AI; ids are prefixes, so sizes and dates still match.

export const MODEL_ADVICE = {
  ollama: {
    chat: { models: ['qwen3', 'qwen2.5:', 'gemma4', 'llama'], note: 'Runs on your own hardware. A 7–8 GB model answers well on a mid-range GPU; background work is slow on CPU.' },
    vision: { models: ['qwen2.5vl', 'gemma4', 'llava'], note: 'qwen2.5vl reads handwriting best here. It needs about 8 GB of GPU memory at the 7b size.' },
    embed: { models: ['bge-m3', 'nomic-embed-text', 'mxbai-embed-large'], note: 'bge-m3 for several languages, nomic-embed-text for English and the smallest download.' },
    audio: { models: [], note: 'Ollama has no speech to text. Use another provider for recordings.' },
  },
  openai: {
    chat: { models: ['gpt-4.1-mini', 'gpt-4.1'], note: 'gpt-4.1-mini is cheap enough for background summaries.' },
    vision: { models: ['gpt-4.1-mini', 'gpt-4.1'], note: 'gpt-4.1 for difficult handwriting, gpt-4.1-mini for everyday pages.' },
    embed: { models: ['text-embedding-3-small', 'text-embedding-3-large'], note: 'text-embedding-3-small is enough for notes.' },
    audio: { models: ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'], note: 'whisper-1 is the reliable choice for long recordings.' },
  },
  'openai-compatible': {
    chat: { models: [], note: 'Depends on the server: pick any capable chat model it offers.' },
    vision: { models: [], note: 'Pick a model with image input, such as a Qwen VL or Gemma model.' },
    embed: { models: ['bge-m3', 'nomic-embed'], note: 'Pick an embedding model, if the server has one.' },
    audio: { models: ['whisper'], note: 'Pick a Whisper model, if the server has one.' },
  },
  anthropic: {
    chat: { models: ['claude-haiku-5-5', 'claude-sonnet-5-5'], note: 'Haiku for background work, Sonnet when writing quality matters more than cost.' },
    vision: { models: ['claude-sonnet-5-5', 'claude-opus-5-5'], note: 'Sonnet reads handwriting well; Opus for the hardest pages.' },
    embed: { models: [], note: 'Anthropic has no embedding models. Use another provider for search by meaning.' },
    audio: { models: [], note: 'Anthropic has no speech to text. Use another provider for recordings.' },
  },
  gemini: {
    chat: { models: ['gemini-2.5-flash', 'gemini-2.5-pro'], note: 'Flash is fast and cheap enough for background work.' },
    vision: { models: ['gemini-2.5-flash', 'gemini-2.5-pro'], note: 'Flash for everyday pages, Pro for difficult handwriting.' },
    embed: { models: ['gemini-embedding-001'], note: 'Works well across languages.' },
    audio: { models: ['gemini-2.5-flash'], note: 'Flash transcribes long recordings at low cost.' },
  },
};

const EMBED = /embed|bge|minilm|nomic|arctic|\be5-|\bgte-/i;
const AUDIO = /whisper|transcribe|parakeet/i;
const OTHER = /tts|dall-e|imagen|image-gen|sora|moderation|veo|realtime|-audio/i;
const VISION = /claude|gemini|gpt-4o|gpt-4\.1|gpt-5|vl\b|vl[:-]|vision|llava|moondream|pixtral|gemma[34]/i;

/** Tasks a model can do, as far as its name tells. */
export function tasksOf(type, m) {
  if (m.embedding || EMBED.test(m.id)) return ['embed'];
  if (AUDIO.test(m.id)) return ['audio'];
  if (OTHER.test(m.id)) return [];
  const tasks = VISION.test(m.id) ? ['chat', 'vision'] : ['chat'];
  if (type === 'gemini') tasks.push('audio');
  return tasks;
}

export function describeModels(type, list) {
  const advice = MODEL_ADVICE[type] || {};
  return list.map((m) => ({
    ...m,
    tasks: tasksOf(type, m),
    suggested: Object.keys(advice).filter((t) => advice[t].models.some((p) => m.id.startsWith(p))),
  }));
}
