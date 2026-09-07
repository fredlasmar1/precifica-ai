const axios = require('axios');

/**
 * Alertas de uso/custo — enviados SOMENTE para o chat configurado em
 * ALERT_CHAT_ID (o Telegram do administrador). Ninguém mais recebe.
 */

async function enviarTelegram(chatId, texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return false;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId, text: texto, parse_mode: 'Markdown'
    }, { timeout: 15000 });
    return true;
  } catch (e) {
    console.warn('[Alerta] envio falhou:', e.response?.data?.description || e.message);
    return false;
  }
}

/**
 * Alertas de consumo. A ScraperAPI saiu daqui em 07/09/2026: a assinatura foi
 * cancelada e a chave removida da Railway, mas o alerta continuava batendo na
 * conta todo dia e logando `erro ao checar ScraperAPI: status 400`. Alarme que
 * toca sozinho ensina a ignorar alarme. O proxy hoje e o Zyte, que e
 * pay-as-you-go — nao ha cota mensal para vigiar.
 */
async function checkUsoEAlertar() {
  const chatId = process.env.ALERT_CHAT_ID;
  if (!chatId) return;

  // ── Google Places (contador interno × cota grátis de US$200 ≈ 6.250 buscas) ──
  try {
    const db = require('./database');
    const usados = await db.obterUso('google_places');
    const limiteGoogle = Number(process.env.GOOGLE_PLACES_ALERTA || 5500); // ~88% da cota grátis
    if (usados >= limiteGoogle) {
      const pctG = Math.round((usados / 6250) * 100);
      await enviarTelegram(chatId,
        `⚠️ *Precifica Aí — alerta de uso (Google)*\n` +
        `Buscas no Google Maps: *${usados}* este mês (~${pctG}% da cota grátis de US$200).\n` +
        `Acima disso passa a ter custo (~US$0,032/busca). Considere reduzir análises comerciais ou ativar billing.`);
      console.log(`[Alerta] aviso Google enviado (${usados} buscas)`);
    }
  } catch (e) {
    console.warn('[Alerta] erro ao checar Google:', e.message);
  }
}

/** Agenda: checa 1x ao subir (após 1 min) e a cada 24h. */
function iniciarAlertas() {
  if (!process.env.ALERT_CHAT_ID) {
    console.log('[Alerta] ALERT_CHAT_ID não configurado — alertas desativados.');
    return;
  }
  setTimeout(checkUsoEAlertar, 60 * 1000);
  setInterval(checkUsoEAlertar, 24 * 60 * 60 * 1000);
  console.log('[Alerta] alertas de uso ativados (diário).');
}

module.exports = { iniciarAlertas, checkUsoEAlertar, enviarTelegram };
