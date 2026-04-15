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

// ─── API da Inteligência Local ───────────────────────────────────
const inteligencia = require('./data/inteligenciaLocal');

// Ver estatísticas da base
app.get('/api/inteligencia/stats', (req, res) => {
  res.json(inteligencia.stats());
});

// Ver todos os dados de uma cidade
app.get('/api/inteligencia/:cidade', (req, res) => {
  res.json(inteligencia.listarCidade(req.params.cidade));
});

// Corretor valida/corrige um preço
// POST { cidade, bairro, tipo, finalidade, precoM2, faixaMin, faixaMax, notas }
app.post('/api/inteligencia/validar', (req, res) => {
  const { cidade, bairro, tipo, finalidade, precoM2, faixaMin, faixaMax, notas } = req.body;
  if (!cidade || !bairro || !tipo || !finalidade || !precoM2) {
    return res.status(400).json({ error: 'cidade, bairro, tipo, finalidade e precoM2 são obrigatórios' });
  }
  const resultado = inteligencia.validarPreco(cidade, bairro, tipo, finalidade, precoM2, faixaMin, faixaMax, notas);
  res.json({ ok: true, dado: resultado });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Precifica AI rodando na porta ${PORT}`);
  console.log(`🌐 Interface web: http://localhost:${PORT}`);
});
