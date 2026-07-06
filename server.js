// Proxy MeuFinanças v2
// - /api/ia → repassa mensagens pra Groq (chat, refinar, parsear)
// - /api/notificacao → recebe notif de banco, categoriza via IA, salva na fila
// - /api/fila/:userId → retorna transações pendentes pro app puxar
// - /api/categorizar → categoriza descrição usando IA (uso geral)
// - /api/backup → salva/restaura backup criptografado no GitHub Gist

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Persistência simples: arquivo JSON (no Render, fica em disco efêmero,
// mas é suficiente como fila de curto prazo; em produção, trocar por Redis/Postgres)
const DATA_DIR = process.env.DATA_DIR || '/tmp';
const FILA_FILE = path.join(DATA_DIR, 'fila_notificacoes.json');

function lerFila() {
  try {
    if (fs.existsSync(FILA_FILE)) {
      return JSON.parse(fs.readFileSync(FILA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Erro ao ler fila:', e.message);
  }
  return {};
}

function salvarFila(fila) {
  try {
    fs.writeFileSync(FILA_FILE, JSON.stringify(fila, null, 2));
  } catch (e) {
    console.error('Erro ao salvar fila:', e.message);
  }
}

// ====== BACKUP: GitHub Gist (persistente de verdade) ======
const GIST_ID = process.env.GIST_ID || 'a588103ce3cc213240d38853c66bdc4e';
const GIST_TOKEN = process.env.GIST_TOKEN;

async function gistRead(userId) {
  if (!GIST_TOKEN) {
    console.warn('GIST_TOKEN nao configurado - backup desabilitado');
    return null;
  }
  try {
    const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { 'Authorization': `token ${GIST_TOKEN}` }
    });
    if (!r.ok) return null;
    const gist = await r.json();
    const filename = `mf-${userId}.txt`;
    const file = gist.files?.[filename];
    if (!file) return null;
    return { cipher: file.content, updatedAt: gist.updated_at };
  } catch (e) {
    console.error('gistRead erro:', e.message);
    return null;
  }
}

async function gistWrite(userId, cipher) {
  if (!GIST_TOKEN) {
    console.warn('GIST_TOKEN nao configurado - backup desabilitado');
    return { ok: false, erro: 'Servidor sem GIST_TOKEN configurado' };
  }
  try {
    const filename = `mf-${userId}.txt`;
    const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${GIST_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        files: {
          [filename]: { content: cipher }
        }
      })
    });
    if (!r.ok) {
      const errText = await r.text();
      return { ok: false, erro: `GitHub ${r.status}: ${errText.slice(0, 200)}` };
    }
    const data = await r.json();
    return { ok: true, updatedAt: data.updated_at };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

// ====== ENDPOINT 1: /api/ia (chat genérico) ======
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

// ====== ENDPOINT 2: /api/notificacao (chamado pelo app Android) ======
// Recebe: { userId, banco, valor, descricao, timestamp }
// Faz: categoriza via IA e salva na fila do userId
app.post('/api/notificacao', async (req, res) => {
  try {
    const { userId, banco, valor, descricao, timestamp } = req.body || {};
    if (!userId || !valor) {
      return res.status(400).json({ error: { message: 'userId e valor obrigatorios' } });
    }

    // Categoriza via IA
    const categoria = await categorizar(banco || 'Banco', descricao || '');

    // Cria transação
    const transacao = {
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      banco: banco || 'Banco',
      valor: valor,
      descricao: descricao || '',
      categoria: categoria.categoria,
      subcategoria: categoria.subcategoria,
      tipo: categoria.tipo, // 'despesa' ou 'receita'
      timestamp: timestamp || Date.now(),
      dataISO: new Date(timestamp || Date.now()).toISOString(),
      origem: 'notificacao'
    };

    // Adiciona na fila do user
    const fila = lerFila();
    if (!fila[userId]) fila[userId] = [];
    fila[userId].push(transacao);
    // Mantém só últimas 100 por user
    if (fila[userId].length > 100) {
      fila[userId] = fila[userId].slice(-100);
    }
    salvarFila(fila);

    console.log(`[notif] user=${userId} banco=${banco} valor=${valor} cat=${categoria.categoria}`);
    res.json({ ok: true, transacao });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// ====== ENDPOINT 3: /api/fila/:userId (app puxa transações pendentes) ======
// Query: ?consumir=true → após ler, remove da fila
app.get('/api/fila/:userId', (req, res) => {
  const { userId } = req.params;
  const { consumir } = req.query;
  const fila = lerFila();
  const itens = fila[userId] || [];

  if (consumir === 'true') {
    delete fila[userId];
    salvarFila(fila);
  }

  res.json({ ok: true, total: itens.length, itens });
});

// ====== ENDPOINT 4: /api/categorizar (categoriza 1 descrição) ======
// Recebe: { banco, descricao }
// Retorna: { categoria, subcategoria, tipo }
app.post('/api/categorizar', async (req, res) => {
  try {
    const { banco = 'Banco', descricao = '' } = req.body || {};
    if (!descricao) {
      return res.status(400).json({ error: { message: 'descricao obrigatoria' } });
    }
    const cat = await categorizar(banco, descricao);
    res.json({ ok: true, ...cat });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// ====== ENDPOINT 5: /api/backup (backup criptografado no Gist) ======
// POST: salva backup do userId
//   Body: { userId, cipher, updatedAt }
//   Retorna: { ok, updatedAt } ou { ok: false, erro }
// GET: ?userId=X → recupera backup
//   Retorna: { ok, found, cipher, updatedAt }
app.post('/api/backup', async (req, res) => {
  try {
    const { userId, cipher } = req.body || {};
    if (!userId || !cipher) {
      return res.status(400).json({ ok: false, erro: 'userId e cipher obrigatorios' });
    }
    if (typeof cipher !== 'string' || cipher.length < 10) {
      return res.status(400).json({ ok: false, erro: 'cipher invalido' });
    }
    const result = await gistWrite(userId, cipher);
    if (result.ok) {
      console.log(`[backup] user=${userId} salvo ${cipher.length} chars em ${result.updatedAt}`);
    } else {
      console.error(`[backup] user=${userId} erro: ${result.erro}`);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get('/api/backup', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ ok: false, erro: 'userId obrigatorio' });
    }
    const result = await gistRead(userId);
    if (!result) {
      return res.json({ ok: true, found: false });
    }
    console.log(`[backup] user=${userId} recuperado ${result.cipher.length} chars`);
    res.json({ ok: true, found: true, cipher: result.cipher, updatedAt: result.updatedAt });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ====== HEALTH ======
app.get('/', (_, res) => res.json({
  ok: true,
  servico: 'meu-financas-ia-proxy',
  versao: '2.0.0',
  storage: 'GitHub Gist (persistente)',
  endpoints: ['/api/ia', '/api/notificacao', '/api/fila/:userId', '/api/categorizar', '/api/backup']
}));

// ====== FUNÇÃO AUXILIAR: categorizar via Groq ======
async function categorizar(banco, descricao) {
  const prompt = `Você é um categorizador de transações financeiras brasileiras.

BANCO: ${banco}
DESCRIÇÃO: "${descricao}"

Categorias principais válidas: Alimentação, Transporte, Moradia, Saúde, Educação, Lazer, Compras, Serviços, Transferência, Salário, Investimentos, Outros.

Responda SOMENTE com JSON válido neste formato exato:
{
  "categoria": "Alimentação",
  "subcategoria": "iFood",
  "tipo": "despesa"
}

Regras:
- tipo = "receita" APENAS se for salário, transferência recebida, cashback, rendimento, pix recebido de pessoa
- caso contrário, tipo = "despesa"
- subcategoria é o nome curto do estabelecimento (ex: "iFood", "Uber", "Posto Ipiranga", "Netflix")
- se for genérico (ex: "Compra"), use o banco + "débito" como subcategoria`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant', // modelo rápido, dá conta
        messages: [
          { role: 'system', content: 'Você responde APENAS JSON válido, sem markdown, sem explicações.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 100,
        response_format: { type: 'json_object' }
      })
    });
    const data = await groqRes.json();
    const texto = data?.choices?.[0]?.message?.content || '{}';

    let cat;
    try {
      cat = JSON.parse(texto);
    } catch {
      // Fallback: regex pra extrair JSON
      const match = texto.match(/\{[\s\S]*\}/);
      cat = match ? JSON.parse(match[0]) : {};
    }

    return {
      categoria: cat.categoria || 'Outros',
      subcategoria: cat.subcategoria || descricao.slice(0, 30),
      tipo: cat.tipo === 'receita' ? 'receita' : 'despesa'
    };
  } catch (e) {
    console.error('Erro ao categorizar:', e.message);
    return { categoria: 'Outros', subcategoria: descricao.slice(0, 30), tipo: 'despesa' };
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy v2 rodando na porta ${PORT}`));
