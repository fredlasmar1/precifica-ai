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

/** Checa o consumo da ScraperAPI e avisa se estiver acabando. */
async function checkUsoEAlertar() {
  const chatId = process.env.ALERT_CHAT_ID;
  if (!chatId) return;
  try {
    const k = process.env.SCRAPER_API_KEY;
    if (!k) return;
    const { data } = await axios.get(`http://api.scraperapi.com/account?api_key=${k}`, { timeout: 15000 });
    const limite = data.requestLimit || 0;
    const restam = data.creditsLeft ?? 0;
    const pct = limite ? Math.round((data.requestCount / limite) * 100) : 0;
    if (limite && restam < limite * 0.15) {
      const avals = Math.floor(restam / 2);
      const reset = (data.nextBillingDate || '').slice(0, 10) || 'em breve';
      await enviarTelegram(chatId,
        `⚠️ *Precifica Aí — alerta de uso*\n` +
        `Scraping de anúncios: *${pct}%* usado este mês.\n` +
        `Restam *${restam}* buscas (~${avals} avaliações).\n` +
        `Renova em ${reset}.`);
      console.log(`[Alerta] aviso ScraperAPI enviado (${pct}% usado)`);
    }
  } catch (e) {
    console.warn('[Alerta] erro ao checar ScraperAPI:', e.message);
  }

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
