require('dotenv').config();
const express = require('express');
const path = require('path');
const { handleWebhook } = require('./whatsapp/webhook');
const chatRoutes = require('./routes/chat');

const app = express();
app.use(express.json());

// Interface web (pasta public)
app.use(express.static(path.join(__dirname, '../public')));

// Rotas da API de chat (interface web)
app.use('/api', chatRoutes);

// Webhook do WhatsApp (Evolution API)
app.post('/webhook', handleWebhook);

// Health check para Railway
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Precifica AI', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Precifica AI rodando na porta ${PORT}`);
  console.log(`🌐 Interface web: http://localhost:${PORT}`);
});
