import express from 'express';

const {
  FAL_KEY,
  ANTHROPIC_API_KEY,
  PORT = 3000,
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

const FAL_MODEL = process.env.FAL_MODEL || 'fal-ai/ltx-2.3/image-to-video/fast';
const EXTRA = JSON.parse(process.env.FAL_EXTRA_INPUT || '{"fps":25}');
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const DAILY = 100, COST = 10, DURATIONS = [8, 10, 12, 15];

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, dan SUPABASE_SERVICE_ROLE_KEY wajib diisi di environment server.');
}
const SB_URL = SUPABASE_URL.replace(/\/+$/, '');

const app = express();
app.use(express.json({ limit: '30mb' }));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, app: 'Theo' }));
app.get('/config.js', (_req, res) => {
  res.type('application/javascript').send(
    `window.THEO_CONFIG = ${JSON.stringify({
      SUPABASE_URL: SB_URL,
      SUPABASE_PUBLISHABLE_KEY
    })};`
  );
});
app.use(express.static('public'));

async function sbRequest(path, { method = 'GET', body, service = false, accessToken } = {}) {
  const key = service ? SUPABASE_SERVICE_ROLE_KEY : SUPABASE_PUBLISHABLE_KEY;
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (service) headers.Authorization = `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  else if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const r = await fetch(`${SB_URL}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.msg || data.message || data.error_description || data.error || `Supabase error (${r.status})`);
  return data;
}

async function requireUser(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ error: 'Silakan login terlebih dahulu.' });
  try {
    const user = await sbRequest('/auth/v1/user', { accessToken: match[1] });
    if (!user?.id) return res.status(401).json({ error: 'Sesi login tidak valid.' });
    req.user = user;
    req.accessToken = match[1];
    next();
  } catch {
    return res.status(401).json({ error: 'Sesi login kedaluwarsa. Silakan login kembali.' });
  }
}

const jobs = new Map();
const jakartaDay = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const part = type => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

async function getTokens(userId) {
  const date = jakartaDay();
  const rows = await sbRequest(
    `/rest/v1/daily_usage?user_id=eq.${encodeURIComponent(userId)}&usage_date=eq.${date}&select=tokens_used`,
    { service: true }
  );
  const used = rows?.[0]?.tokens_used || 0;
  return { left: DAILY - used, max: DAILY, cost: COST };
}
async function consumeTokens(userId) {
  const result = await sbRequest('/rest/v1/rpc/consume_daily_tokens', {
    method: 'POST', service: true, body: { p_user_id: userId, p_cost: COST }
  });
  const left = typeof result === 'number' ? result : Number(result);
  if (left < 0) return null;
  return { left, max: DAILY, cost: COST };
}
async function refundTokens(userId) {
  await sbRequest('/rest/v1/rpc/refund_daily_tokens', {
    method: 'POST', service: true, body: { p_user_id: userId, p_cost: COST }
  });
}

/* Claude reads a few frames from a reference video and writes a motion prompt. */
async function promptFromFrames(frames, hint) {
  const content = frames.slice(0, 4).map(f => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: f.split(',')[1] }
  }));
  content.push({
    type: 'text',
    text: 'These are frames from a reference music video. Write ONE English prompt (max 80 words) for an image-to-video model that recreates its camera movement, pacing, lighting and mood. Output only the prompt.' +
      (hint ? ' Extra direction: ' + hint : '')
  });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 300,
      messages: [{ role: 'user', content }]
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Claude API error');
  return j.content.map(c => c.text || '').join('').trim();
}

app.get('/api/tokens', requireUser, async (req, res) => {
  try { res.json(await getTokens(req.user.id)); }
  catch (e) { res.status(500).json({ error: 'Gagal membaca kuota token.' }); }
});

app.post('/api/generate', requireUser, async (req, res) => {
  const { image, prompt = '', duration, frames } = req.body || {};
  if (!/^data:image\//.test(image || '')) return res.status(400).json({ error: 'Gambar wajib diunggah.' });
  if (!DURATIONS.includes(+duration)) return res.status(400).json({ error: 'Durasi tidak valid.' });
  if (typeof prompt !== 'string' || (!prompt.trim() && !frames?.length)) return res.status(400).json({ error: 'Tulis prompt atau unggah video referensi.' });
  if (frames && (!Array.isArray(frames) || frames.length > 4 || frames.some(f => typeof f !== 'string' || !f.startsWith('data:image/')))) {
    return res.status(400).json({ error: 'Frame video referensi tidak valid.' });
  }
  if (!FAL_KEY) return res.status(503).json({ error: 'Fitur generate belum aktif karena FAL_KEY belum diatur di Environment Render. Login dan pengecekan kuota tetap bisa diuji.' });

  let quota;
  try { quota = await consumeTokens(req.user.id); }
  catch (e) { return res.status(500).json({ error: 'Gagal memproses kuota. Pastikan SQL setup sudah dijalankan.' }); }
  if (!quota) return res.status(429).json({ error: 'Token harian habis. Coba lagi besok.' });

  try {
    let p = prompt.trim();
    if (frames?.length) {
      if (!ANTHROPIC_API_KEY) throw new Error('Mode referensi video butuh ANTHROPIC_API_KEY di environment server.');
      p = await promptFromFrames(frames, p);
    }
    p += ' Music video style, cinematic lighting, smooth natural motion.';
    const r = await fetch(`https://queue.fal.run/${FAL_MODEL}`, {
      method: 'POST',
      headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: p, image_url: image, duration: +duration, ...EXTRA })
    });
    const j = await r.json();
    if (!r.ok || !j.request_id) {
      throw new Error(typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail || j).slice(0, 300));
    }
    jobs.set(j.request_id, {
      uid: req.user.id, status_url: j.status_url, response_url: j.response_url, refunded: false
    });
    res.json({ id: j.request_id, prompt: p, ...quota });
  } catch (e) {
    try { await refundTokens(req.user.id); } catch {}
    res.status(500).json({ error: e.message, ...(await getTokens(req.user.id).catch(() => ({}))) });
  }
});

app.get('/api/status/:id', requireUser, async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.uid !== req.user.id) return res.status(404).json({ error: 'Job tidak ditemukan.' });
  const H = { Authorization: `Key ${FAL_KEY}` };
  try {
    const sr = await fetch(job.status_url, { headers: H });
    const s = await sr.json();
    if (!sr.ok) throw new Error('Gagal memeriksa status video.');
    if (s.status === 'COMPLETED') {
      const r = await fetch(job.response_url, { headers: H });
      const o = await r.json();
      if (!r.ok || !o.video?.url) throw new Error('Generate gagal: ' + JSON.stringify(o.detail || o).slice(0, 250));
      jobs.delete(req.params.id);
      return res.json({ status: 'done', videoUrl: o.video.url });
    }
    if (s.status === 'FAILED') {
      if (!job.refunded) {
        job.refunded = true;
        await refundTokens(job.uid);
      }
      jobs.delete(req.params.id);
      return res.status(500).json({ error: 'Pembuatan video gagal. Token sudah dikembalikan.' });
    }
    res.json({ status: 'pending', position: s.queue_position ?? null });
  } catch (e) {
    if (!job.refunded) {
      job.refunded = true;
      try { await refundTokens(job.uid); } catch {}
    }
    jobs.delete(req.params.id);
    res.status(500).json({ error: e.message, ...(await getTokens(req.user.id).catch(() => ({}))) });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Theo jalan di port ${PORT}`));
