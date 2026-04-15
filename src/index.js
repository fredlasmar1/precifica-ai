require('dotenv').config();
const express = require('express');
const path = require('path');
const { handleWebhook } = require('./whatsapp/webhook');
const { handleTelegram } = require('./telegram/bot');
const chatRoutes = require('./routes/chat');

const app = express();
app.use(express.json());

// Interface web (pasta public)
app.use(express.static(path.join(__dirname, '../public')));

// Rotas da API de chat (interface web)
app.use('/api', chatRoutes);

// Webhook do WhatsApp (Evolution API)
app.post('/webhook', handleWebhook);

// Webhook do Telegram
app.post('/telegram', handleTelegram);

// Health check para Railway
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Precifica AI', timestamp: new Date().toISOString() });
});

// ─── API do Guru Imobiliário ─────────────────────────────────────
const db = require('./data/database');

// Estatísticas da base de conhecimento
app.get('/api/guru/stats', async (req, res) => {
  try { res.json(await db.stats()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Listar bairros mapeados de uma cidade
app.get('/api/guru/bairros/:cidade', async (req, res) => {
  try { res.json(await db.listarBairros(req.params.cidade)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Ver dados de um bairro específico
app.get('/api/guru/bairro/:cidade/:bairro', async (req, res) => {
  try { res.json(await db.buscarBairro(req.params.cidade, req.params.bairro)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Corretor adiciona/atualiza info de um bairro
app.post('/api/guru/bairro', async (req, res) => {
  try { res.json(await db.salvarBairro(req.body)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Corretor envia feedback sobre uma avaliação
app.post('/api/guru/feedback', async (req, res) => {
  try { res.json(await db.salvarFeedback(req.body)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Precifica AI rodando na porta ${PORT}`);
  console.log(`🌐 Interface web: http://localhost:${PORT}`);
  // Inicializa tabelas do Postgres
  try {
    await db.inicializar();
  } catch (err) {
    console.error('[DB] Falha ao inicializar:', err.message);
  }
});
