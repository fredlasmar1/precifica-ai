const { getSession, addMessage, clearSession, isReadyToEvaluate } = require('../agent/session');
const { chat, extractPropertyData } = require('../agent/openai');
const { calcularPreco, formatarReais } = require('../data/precificador');
const { formatarSecaoLocalizacao } = require('../data/googleplaces');
const { sendMessage } = require('./sender');

/**
 * Handler principal do webhook da Evolution API
 */
async function handleWebhook(req, res) {
  // Responde imediatamente para a Evolution API não reenviar
  res.status(200).json({ received: true });

  try {
    const body = req.body;

    // Suporta o formato de evento da Evolution API v2
    const event = body?.event || body?.type;
    if (event !== 'messages.upsert' && event !== 'MESSAGES_UPSERT') return;

    const message = body?.data?.message || body?.data?.messages?.[0];
    if (!message) return;

    // Ignora mensagens do próprio bot
    if (message.key?.fromMe) return;

    // Extrai telefone e texto
    const phone = message.key?.remoteJid?.replace('@s.whatsapp.net', '');
    const text = message.message?.conversation ||
                 message.message?.extendedTextMessage?.text ||
                 '';

    if (!phone || !text.trim()) return;

    console.log(`[Webhook] Mensagem de ${phone}: ${text.substring(0, 60)}`);

    await processarMensagem(phone, text.trim());

  } catch (err) {
    console.error('[Webhook] Erro:', err.message);
  }
}

/**
 * Processa a mensagem e coordena agente + precificação
 */
async function processarMensagem(phone, texto) {
  // Comando de reset
  if (/reiniciar|nova avalia[çc][aã]o|reset/i.test(texto)) {
    clearSession(phone);
    await sendMessage(phone, '🔄 Sessão reiniciada! Vamos começar uma nova avaliação.\n\nQual tipo de imóvel você quer avaliar? (casa, apartamento, terreno ou comercial)');
    return;
  }

  // Adiciona mensagem do usuário ao histórico
  const history = addMessage(phone, 'user', texto);

  // Verifica se o agente já sinalizou que vai consultar o mercado
  const jaColetouDados = isReadyToEvaluate(history.slice(0, -1)); // histórico antes desta msg

  if (jaColetouDados) {
    // Extrai dados estruturados e calcula preço
    await sendMessage(phone, '⏳ Consultando mercado imobiliário de Goiás...');
    
    try {
      const dadosImovel = await extractPropertyData(history);

      if (!dadosImovel) {
        await sendMessage(phone, '⚠️ Não consegui organizar os dados do imóvel. Pode me passar de novo o resumo? (tipo, finalidade, cidade, bairro, metragem, quartos, vagas e estado de conservação)');
        return;
      }

      const resultado = await calcularPreco(dadosImovel);
      const laudo = gerarLaudo(dadosImovel, resultado);

      addMessage(phone, 'assistant', laudo);
      await sendMessage(phone, laudo);

      // Mensagem de follow-up após o laudo
      await new Promise(r => setTimeout(r, 1500));
      await sendMessage(phone, '💡 Quer avaliar outro imóvel? Digite *nova avaliação* para recomeçar.');

    } catch (err) {
      console.error('[Precificação] Erro:', err);
      await sendMessage(phone, '❌ Tive um problema técnico ao consultar o mercado. Tente novamente em instantes — se persistir, digite *reiniciar*.');
    }
    return;
  }

  // Fluxo normal: agente conversa e coleta dados
  try {
    const resposta = await chat(history);
    addMessage(phone, 'assistant', resposta);
    await sendMessage(phone, resposta);

    // Se o agente acabou de sinalizar que vai consultar, faz a precificação agora
    if (isReadyToEvaluate([...history, { role: 'assistant', content: resposta }])) {
      await new Promise(r => setTimeout(r, 1500)); // Pequena pausa para naturalidade
      
      const historicoCompleto = [...history, { role: 'assistant', content: resposta }];
      const dadosImovel = await extractPropertyData(historicoCompleto);
      
      if (dadosImovel) {
        const resultado = await calcularPreco(dadosImovel);
        const laudo = gerarLaudo(dadosImovel, resultado);

        addMessage(phone, 'assistant', laudo);
        await sendMessage(phone, laudo);

        await new Promise(r => setTimeout(r, 1500));
        await sendMessage(phone, '💡 Quer avaliar outro imóvel? Digite *nova avaliação* para recomeçar.');
      }
    }

  } catch (err) {
    console.error('[Chat] Erro:', err.message);
    await sendMessage(phone, '❌ Erro ao processar sua mensagem. Tente novamente.');
  }
}

/**
 * Gera o laudo formatado para WhatsApp
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
      laudo += `• ${analiseIA.anunciosAnalisados} anúncios comparáveis encontrados\n\n`;
    } else {
      laudo += `• ${analiseIA.raciocinio}\n`;
      laudo += `• Faixa encontrada: ${analiseIA.faixaM2}\n\n`;
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
    laudo += `🔍 Comparativos analisados: ${comparativosEncontrados} imóveis\n`;
  }

  laudo += `\n📋 *Fontes:* ${(fontesConsultadas || []).join(' | ')}\n`;
  laudo += `_Avaliação gerada por PrecificaAI_`;

  return laudo;
}

module.exports = { handleWebhook };
