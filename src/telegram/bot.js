const axios = require('axios');
const { getSession, addMessage, clearSession, isReadyToEvaluate } = require('../agent/session');
const { chat, extractPropertyData } = require('../agent/openai');
const { calcularPreco, formatarReais } = require('../data/precificador');
const { formatarSecaoLocalizacao } = require('../data/googleplaces');

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const API = () => `https://api.telegram.org/bot${BOT_TOKEN()}`;

/**
 * Handler do webhook do Telegram
 */
async function handleTelegram(req, res) {
  res.status(200).json({ ok: true });

  try {
    const update = req.body;
    const message = update?.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();
    const sessionId = `tg_${chatId}`;

    console.log(`[Telegram] ${chatId}: ${text.substring(0, 60)}`);

    // Comando /start
    if (text === '/start') {
      clearSession(sessionId);
      await enviar(chatId,
        '👋 Olá! Sou o *PrecificaAI* — seu assistente de precificação imobiliária.\n\n' +
        'Me diga os dados do imóvel e eu consulto o mercado em tempo real para gerar um laudo com faixa de preço.\n\n' +
        'Vamos começar? Qual o *tipo* do imóvel? (casa, apartamento, terreno ou comercial)'
      );
      return;
    }

    // Comando /reiniciar ou /novo
    if (/^\/?(reiniciar|novo|nova|reset)/i.test(text)) {
      clearSession(sessionId);
      await enviar(chatId, '🔄 Sessão reiniciada! Qual o tipo do imóvel que quer avaliar?');
      return;
    }

    await processarMensagem(chatId, sessionId, text);

  } catch (err) {
    console.error('[Telegram] Erro:', err.message);
  }
}

async function processarMensagem(chatId, sessionId, texto) {
  const history = addMessage(sessionId, 'user', texto);
  const jaColetouDados = isReadyToEvaluate(history.slice(0, -1));

  if (jaColetouDados) {
    await enviar(chatId, '⏳ Consultando mercado imobiliário...');

    try {
      const dadosImovel = await extractPropertyData(history);
      if (!dadosImovel) {
        await enviar(chatId, '⚠️ Não consegui organizar os dados. Pode me passar o resumo de novo? (tipo, finalidade, cidade, bairro, metragem, quartos, vagas e estado)');
        return;
      }

      const resultado = await calcularPreco(dadosImovel);
      const laudo = gerarLaudo(dadosImovel, resultado);

      addMessage(sessionId, 'assistant', laudo);
      await enviar(chatId, laudo);

      await new Promise(r => setTimeout(r, 1000));
      await enviar(chatId, '💡 Quer avaliar outro imóvel? Digite /novo para recomeçar.');

    } catch (err) {
      console.error('[Telegram Precificação] Erro:', err);
      await enviar(chatId, '❌ Tive um problema ao consultar o mercado. Tente de novo ou digite /reiniciar');
    }
    return;
  }

  // Fluxo normal: agente conversa
  try {
    const resposta = await chat(history);
    addMessage(sessionId, 'assistant', resposta);
    await enviar(chatId, resposta);

    // Verifica se agora está pronto
    const historicoAtual = [...history, { role: 'assistant', content: resposta }];
    if (isReadyToEvaluate(historicoAtual)) {
      await new Promise(r => setTimeout(r, 1000));
      const dadosImovel = await extractPropertyData(historicoAtual);
      if (dadosImovel) {
        await enviar(chatId, '⏳ Consultando mercado imobiliário...');
        const resultado = await calcularPreco(dadosImovel);
        const laudo = gerarLaudo(dadosImovel, resultado);
        addMessage(sessionId, 'assistant', laudo);
        await enviar(chatId, laudo);
        await new Promise(r => setTimeout(r, 1000));
        await enviar(chatId, '💡 Quer avaliar outro imóvel? Digite /novo para recomeçar.');
      }
    }
  } catch (err) {
    console.error('[Telegram Chat] Erro:', err);
    await enviar(chatId, '❌ Erro ao processar. Tente de novo ou digite /reiniciar');
  }
}

/**
 * Envia mensagem via Telegram Bot API
 */
async function enviar(chatId, texto) {
  // Telegram tem limite de 4096 chars por mensagem
  const chunks = splitMessage(texto, 4000);
  for (const chunk of chunks) {
    await axios.post(`${API()}/sendMessage`, {
      chat_id: chatId,
      text: chunk,
      parse_mode: 'Markdown'
    }).catch(async (err) => {
      // Se falhar com Markdown, tenta sem formatação
      if (err.response?.data?.description?.includes('parse')) {
        await axios.post(`${API()}/sendMessage`, {
          chat_id: chatId,
          text: chunk
        });
      } else {
        throw err;
      }
    });
  }
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let current = text;
  while (current.length > maxLen) {
    let split = current.lastIndexOf('\n', maxLen);
    if (split < maxLen * 0.5) split = maxLen;
    chunks.push(current.substring(0, split));
    current = current.substring(split);
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Gera laudo formatado para Telegram (Markdown)
 */
function gerarLaudo(dados, resultado) {
  const { tipo, finalidade, cidade, bairro, endereco, metragem, quartos, vagas } = dados;
  const {
    precoMinimo, precoRecomendado, precoMaximo,
    precoM2Mercado, precoM2Imovel,
    comparativosEncontrados, tempoEstimadoDias,
    indiceLiquidez, ajustesAplicados,
    fontesConsultadas, analiseIA, localizacao
  } = resultado;

  const tipoLabel = tipo.charAt(0).toUpperCase() + tipo.slice(1);
  const finalidadeLabel = finalidade === 'aluguel' ? 'Aluguel' : 'Venda';

  let laudo = `📊 *LAUDO DE PRECIFICAÇÃO*\n`;
  laudo += `━━━━━━━━━━━━━━━━━━━━━\n`;
  laudo += `🏠 ${tipoLabel} • ${finalidadeLabel}\n`;
  laudo += endereco ? `📍 ${endereco}, ${bairro} - ${cidade}/GO\n` : `📍 ${bairro}, ${cidade} - GO\n`;
  laudo += `📐 ${metragem}m² • ${quartos} quartos • ${vagas} vaga(s)\n\n`;

  laudo += `💰 *Faixa de Preço Sugerida:*\n`;
  laudo += `• Mínimo: *${formatarReais(precoMinimo)}*\n`;
  laudo += `• Recomendado: *${formatarReais(precoRecomendado)}*\n`;
  laudo += `• Máximo: *${formatarReais(precoMaximo)}*\n\n`;

  laudo += `📊 *Preço por m²:*\n`;
  laudo += `• Referência de mercado: ${formatarReais(precoM2Mercado)}/m²\n`;
  laudo += `• Este imóvel (ajustado): ${formatarReais(precoM2Imovel)}/m²\n\n`;

  laudo += `⚡ *Liquidez:*\n`;
  laudo += `• ${indiceLiquidez}\n`;
  laudo += `• Tempo estimado: ${tempoEstimadoDias} dias\n\n`;

  if (analiseIA) {
    laudo += `🔎 *Comparativos de mercado:*\n`;
    if (analiseIA.comparativos && analiseIA.comparativos.length > 0) {
      analiseIA.comparativos.slice(0, 7).forEach((c, i) => {
        const detalhe = c.detalhe ? ` — ${c.detalhe}` : '';
        laudo += `  ${i + 1}. ${c.area}m² • ${formatarReais(c.preco)} (${formatarReais(c.precoM2)}/m²)${detalhe}\n`;
      });
      laudo += `\n• *Média: ${formatarReais(analiseIA.precoMedioM2)}/m²*\n`;
      laudo += `• Faixa: ${analiseIA.faixaM2}\n`;
      laudo += `• ${analiseIA.anunciosAnalisados} anúncios comparáveis\n\n`;
    } else {
      laudo += `• ${analiseIA.raciocinio}\n`;
      laudo += `• Faixa: ${analiseIA.faixaM2}\n\n`;
    }
  }

  if (localizacao) {
    laudo += formatarSecaoLocalizacao(localizacao);
    laudo += '\n';
  }

  if (ajustesAplicados && ajustesAplicados.length > 0) {
    laudo += `🔧 *Ajustes aplicados:*\n`;
    ajustesAplicados.forEach(a => laudo += `• ${a}\n`);
    laudo += '\n';
  }

  if (comparativosEncontrados > 0) {
    laudo += `🔍 Comparativos diretos: ${comparativosEncontrados} imóveis\n`;
  }

  laudo += `\n📋 *Fontes:* ${(fontesConsultadas || []).join(' | ')}\n`;
  laudo += `_Avaliação gerada por PrecificaAI_`;

  return laudo;
}

module.exports = { handleTelegram };
