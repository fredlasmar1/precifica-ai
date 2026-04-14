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

// Diagnóstico rápido da Perplexity API
const axios = require('axios');
app.get('/debug/perplexity', async (req, res) => {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return res.json({ error: 'PERPLEXITY_API_KEY não configurada' });
  try {
    const r = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar',
      messages: [{ role: 'user', content: 'Qual a população de Anápolis GO? Responda em 1 frase.' }],
      max_tokens: 100
    }, {
      timeout: 30000,
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
    });
    res.json({
      ok: true,
      response: r.data.choices[0].message.content,
      model: r.data.model,
      usage: r.data.usage
    });
  } catch (err) {
    res.json({
      ok: false,
      status: err.response?.status,
      error: err.response?.data || err.message
    });
  }
});

// Debug: teste de precificação direto (sem passar pela conversa)
const { calcularPreco } = require('./data/precificador');
app.post('/debug/precificar', async (req, res) => {
  try {
    const resultado = await calcularPreco(req.body);
    res.json(resultado);
  } catch (err) {
    res.json({ error: err.message, stack: err.stack?.split('\n').slice(0, 5) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Precifica AI rodando na porta ${PORT}`);
  console.log(`🌐 Interface web: http://localhost:${PORT}`);
});
