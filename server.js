// Proxy seguro: app chama este endpoint, ele adiciona a chave Groq e repassa
// + Backup criptografado via GitHub Gist (PERSISTENTE, nunca apaga)
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const GH_TOKEN = process.env.GH_TOKEN; // Personal Access Token com scope 'gist'
const GIST_DESC = 'meufinancas-backup';

// === IA: GROQ ===
app.post('/api/ia', async (req, res) => {
  try {
    const { messages, model = 'llama-3.3-70b-versatile', temperature = 0.3, max_tokens = 1024 } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages obrigatorio' } });
    }
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens })
    });
    const data = await groqRes.json();
    res.status(groqRes.status).json(data);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// === BACKUP via GitHub Gist ===
// Cada userId tem UM Gist. A gente procura o Gist pela descrição + filename.
// Filename = "mf-{userId}.txt" (dados criptografados em base64)

async function findGistByUserId(userId) {
  // Lista Gists do user (autenticado) - GitHub retorna paginado
  let page = 1;
  while (page < 20) {
    const r = await fetch(`https://api.github.com/gists?per_page=100&page=${page}`, {
      headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'Accept': 'application/vnd.github+json' }
    });
    if (!r.ok) throw new Error(`GitHub list gists falhou: ${r.status}`);
    const gists = await r.json();
    if (gists.length === 0) return null;
    for (const g of gists) {
      if (g.description === GIST_DESC && g.files && g.files[`mf-${userId}.txt`]) {
        return g;
      }
    }
    page++;
  }
  return null;
}

async function getGistContent(userId) {
  const gist = await findGistByUserId(userId);
  if (!gist) return null;
  const file = gist.files[`mf-${userId}.txt`];
  return {
    cipher: file.content,
    updatedAt: file.updated_at || gist.updated_at
  };
}

async function saveGistContent(userId, cipher, updatedAt) {
  const filename = `mf-${userId}.txt`;
  const content = cipher;
  const existing = await findGistByUserId(userId);
  if (existing) {
    // Atualiza
    const r = await fetch(`https://api.github.com/gists/${existing.id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${GH_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        description: GIST_DESC,
        files: { [filename]: { content } }
      })
    });
    if (!r.ok) throw new Error(`PATCH gist falhou: ${r.status} ${await r.text()}`);
    const d = await r.json();
    return { updatedAt: d.updated_at };
  } else {
    // Cria
    const r = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GH_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        description: GIST_DESC,
        public: false,
        files: { [filename]: { content } }
      })
    });
    if (!r.ok) throw new Error(`POST gist falhou: ${r.status} ${await r.text()}`);
    const d = await r.json();
    return { updatedAt: d.updated_at };
  }
}

async function deleteGistContent(userId) {
  const existing = await findGistByUserId(userId);
  if (existing) {
    await fetch(`https://api.github.com/gists/${existing.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${GH_TOKEN}` }
    });
  }
}

// GET /api/backup?userId=xxx
app.get('/api/backup', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ ok: false, erro: 'userId obrigatorio' });
    if (!GH_TOKEN) return res.status(500).json({ ok: false, erro: 'GH_TOKEN nao configurado no servidor' });
    const data = await getGistContent(userId);
    if (!data) return res.json({ ok: true, found: false });
    res.json({ ok: true, found: true, cipher: data.cipher, updatedAt: data.updatedAt });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// POST /api/backup { userId, cipher, updatedAt }
app.post('/api/backup', async (req, res) => {
  try {
    const { userId, cipher, updatedAt } = req.body || {};
    if (!userId || !cipher) return res.status(400).json({ ok: false, erro: 'userId e cipher obrigatorios' });
    if (!GH_TOKEN) return res.status(500).json({ ok: false, erro: 'GH_TOKEN nao configurado no servidor' });
    const result = await saveGistContent(userId, cipher, updatedAt || new Date().toISOString());
    console.log(`[gist] salvo userId=${userId} (${cipher.length} bytes)`);
    res.json({ ok: true, updatedAt: result.updatedAt });
  } catch (e) {
    console.error(`[gist] erro: ${e.message}`);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// DELETE /api/backup?userId=xxx
app.delete('/api/backup', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ ok: false, erro: 'userId obrigatorio' });
    if (!GH_TOKEN) return res.status(500).json({ ok: false, erro: 'GH_TOKEN nao configurado no servidor' });
    await deleteGistContent(userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// === DEBUG: status das env vars ===
app.get('/debug', (_, res) => {
  res.json({
    tem_GH_TOKEN: !!process.env.GH_TOKEN,
    tem_GROQ: !!process.env.GROQ_API_KEY,
    GH_TOKEN_inicio: process.env.GH_TOKEN ? process.env.GH_TOKEN.substring(0, 8) + '...' : 'AUSENTE',
    node_version: process.version
  });
});

// === HEALTH CHECK ===
app.get('/', (_, res) => res.json({
  ok: true,
  servico: 'meu-financas-ia-proxy',
  versao: '2.0.0',
  storage: 'GitHub Gist (persistente)',
  rotas: ['/api/ia', '/api/backup']
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy v2 rodando na porta ${PORT} (backup via GitHub Gist)`));
