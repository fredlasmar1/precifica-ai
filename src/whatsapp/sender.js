const axios = require('axios');

/**
 * Envia mensagem via Evolution API
 */
async function sendMessage(phone, text) {
  const { EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE } = process.env;

  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
    console.log(`[Sender] SIMULADO → ${phone}: ${text.substring(0, 80)}...`);
    return;
  }

  try {
    await axios.post(
      `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      {
        number: phone,
        text: text
      },
      {
        headers: {
          'apikey': EVOLUTION_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    console.log(`[Sender] ✅ Mensagem enviada para ${phone}`);
  } catch (err) {
    console.error(`[Sender] ❌ Erro ao enviar para ${phone}:`, err.response?.data || err.message);
  }
}

module.exports = { sendMessage };
