const axios = require('axios');
const { getSession, addMessage, clearSession, isReadyToEvaluate } = require('../agent/session');
const { chat, extractPropertyData } = require('../agent/openai');
const { calcularPreco, formatarReais } = require('../data/precificador');
const { formatarSecaoLocalizacao } = require('../data/googleplaces');

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const API = () => `https://api.telegram.org/bot${BOT_TOKEN()}`;

// Guarda o último laudo por sessão para uso no modo conversa
const laudoCache = new Map();

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
      laudoCache.delete(sessionId);
      await enviar(chatId,
        '👋 Olá! Sou o *PrecificaAI* — seu assistente de precificação imobiliária.\n\n' +
        'Me diga os dados do imóvel e eu consulto o mercado em tempo real para gerar um laudo com faixa de preço.\n\n' +
        'Vamos começar? Qual o *tipo* do imóvel? (casa, apartamento, terreno ou comercial)'
      );
      return;
    }

    // Comando /reiniciar ou /novo
    if (/^[/]?(reiniciar|novo|nova|reset)/i.test(text)) {
      clearSession(sessionId);
      laudoCache.delete(sessionId);
      await enviar(chatId, '🔄 Sessão reiniciada! Qual o tipo do imóvel que quer avaliar?');
      return;
    }

    await processarMensagem(chatId, sessionId, text);

  } catch (err) {
    console.error('[Telegram] Erro:', err.message);
  }
}

async function processarMensagem(chatId, sessionId, texto) {
  // ─── MODO CONVERSA PÓS-LAUDO ─────────────────────────────────────────────
  // Se já existe um laudo gerado nesta sessão, responde perguntas sobre ele
  const laudoSessao = laudoCache.get(sessionId);
  if (laudoSessao) {
    // Detecta intenção de nova avaliação
    // Casos: palavra-chave explícita OU usuário descreve um novo imóvel (tipo + localização)
    const novaAvaliacaoExplicita = /\b(novo|nova|outro|outra|precificar|começar|comecar|reiniciar|nova avalia)\b/i.test(texto);
    const descreveImovel = /\b(terreno|casa|apart|apto|comercial|sala|galpão|lote)\b/i.test(texto) &&
      /\b(bairro|rua|av\.|avenida|setor|jardim|vila|parque|residencial|em [A-Z])/i.test(texto);
    if (novaAvaliacaoExplicita || descreveImovel) {
      clearSession(sessionId);
      laudoCache.delete(sessionId);
      if (descreveImovel && !novaAvaliacaoExplicita) {
        // Usuário começou nova avaliação sem avisar — processa direto
        await processarMensagem(chatId, sessionId, texto);
      } else {
        await enviar(chatId, '🔄 Certo! Vamos avaliar outro imóvel.\n\nQual o *tipo* do imóvel? (casa, apartamento, terreno ou comercial)');
      }
      return;
    }

    // Responde perguntas sobre o laudo com contexto completo
    try {
      const systemPostLaudo = `Você é o PrecificaAI, um especialista em precificação imobiliária. 
O usuário acabou de receber um laudo de precificação e pode ter dúvidas ou querer aprofundar a análise.

LAUDO GERADO:
${laudoSessao.texto}

DADOS DO IMÓVEL AVALIADO:
${JSON.stringify(laudoSessao.dados, null, 2)}

Responda de forma clara e direta, como um corretor experiente explicaria para o cliente.
Você pode:
- Explicar como chegamos ao preço sugerido
- Comparar com outros bairros ou tipos de imóvel
- Esclarecer o que significa cada indicador do laudo
- Sugerir como melhorar a precificação (ex: reformas, diferenciais)
- Simular cenários (ex: "e se fosse aluguel?", "e se tivesse piscina?")
Se o usuário quiser avaliar um novo imóvel, oriente-o a digitar /novo.`;

      const history = addMessage(sessionId, 'user', texto);

      const resposta = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPostLaudo },
          ...history.slice(-10) // últimas 10 mensagens para contexto da conversa
        ],
        temperature: 0.7,
        max_tokens: 600
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const respostaTexto = resposta.data.choices[0].message.content;
      addMessage(sessionId, 'assistant', respostaTexto);
      await enviar(chatId, respostaTexto);
      await new Promise(r => setTimeout(r, 800));
      await enviar(chatId, '_Para avaliar outro imóvel, digite /novo_');

    } catch (err) {
      console.error('[Telegram PostLaudo] Erro:', err.message);
      await enviar(chatId, '❌ Erro ao responder. Tente de novo ou digite /reiniciar');
    }
    return;
  }

  // ─── FLUXO NORMAL: COLETA DE DADOS ────────────────────────────────────────
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
      if (resultado.erro) {
        await enviar(chatId, resultado.mensagem);
        return;
      }
      const laudo = gerarLaudo(dadosImovel, resultado);

      addMessage(sessionId, 'assistant', laudo);
      await enviar(chatId, laudo);

      // Salva laudo para modo conversa pós-laudo
      laudoCache.set(sessionId, { texto: laudo, dados: dadosImovel, resultado });

      await new Promise(r => setTimeout(r, 1000));
      await enviar(chatId,
        '💬 *Posso te ajudar mais?*\n' +
        'Pergunte qualquer coisa sobre este laudo — por que esse preço, comparação com outros bairros, simulações, etc.\n\n' +
        '_Para avaliar outro imóvel, digite /novo_'
      );

    } catch (err) {
      console.error('[Telegram Precificação] Erro:', err);
      await enviar(chatId, '❌ Tive um problema ao consultar o mercado. Tente de novo ou digite /reiniciar');
    }
    return;
  }

  // Fluxo normal: agente conversa para coletar dados
  try {
    const resposta = await chat(history);
    addMessage(sessionId, 'assistant', resposta);
    await enviar(chatId, resposta);

    // Verifica se agora está pronto para precificar
    const historicoAtual = [...history, { role: 'assistant', content: resposta }];
    if (isReadyToEvaluate(historicoAtual)) {
      await new Promise(r => setTimeout(r, 1000));
      const dadosImovel = await extractPropertyData(historicoAtual);
      if (dadosImovel) {
        await enviar(chatId, '⏳ Consultando mercado imobiliário...');
        const resultado = await calcularPreco(dadosImovel);
        if (resultado.erro) {
          await enviar(chatId, resultado.mensagem);
        } else {
          const laudo = gerarLaudo(dadosImovel, resultado);
          addMessage(sessionId, 'assistant', laudo);
          await enviar(chatId, laudo);

          // Salva laudo para modo conversa pós-laudo
          laudoCache.set(sessionId, { texto: laudo, dados: dadosImovel, resultado });

          await new Promise(r => setTimeout(r, 1000));
          await enviar(chatId,
            '💬 *Posso te ajudar mais?*\n' +
            'Pergunte qualquer coisa sobre este laudo — por que esse preço, comparação com outros bairros, simulações, etc.\n\n' +
            '_Para avaliar outro imóvel, digite /novo_'
          );
        }
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
    precoMinimo, precoRecomendado, precoMaximo, geoInfo, perfilGuru,
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
        laudo += `  ${i + 1}. ${c.area}m² • ${formatarReais(c.preco)} (${formatarReais(c.precoM2)}/m²)\n`;
        if (c.detalhe) laudo += `     ${c.detalhe}\n`;
        if (c.fonte) {
          // Monta link clicável se for um domínio reconhecível
          const fonteStr = String(c.fonte).trim();
          const dominio = fonteStr.match(/^https?:\/\//i) ? fonteStr
            : fonteStr.match(/\.(com|com\.br|br|net|org)/) ? `https://${fonteStr}`
            : null;
          laudo += dominio
            ? `     Fonte: [${fonteStr}](${dominio})\n`
            : `     Fonte: ${fonteStr}\n`;
        }
      });
      laudo += `\n📊 *Resultado da pesquisa:*\n`;
      laudo += `• Média: *${formatarReais(analiseIA.precoMedioM2)}/m²*\n`;
      laudo += `• Faixa: ${analiseIA.faixaM2}\n`;
      laudo += `• ${analiseIA.anunciosAnalisados} anúncios comparáveis\n`;
      laudo += `• Confiança: ${analiseIA.confianca}\n`;
      if (analiseIA.raciocinio) laudo += `• ${analiseIA.raciocinio}\n`;
      laudo += '\n';
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

  if (perfilGuru?.infraestrutura) {
    const i = perfilGuru.infraestrutura;
    laudo += `🏘️ *Perfil do bairro:*\n`;
    laudo += `• ${i.resumo}\n`;
    if (i.vocacoes?.length) laudo += `• Vocação: ${i.vocacoes.join(', ')}\n`;
    laudo += '\n';
  }

  if (perfilGuru?.municipio?.populacao) {
    laudo += `📊 Pop: ${perfilGuru.municipio.populacao.toLocaleString()} | PIB/cap: R$ ${perfilGuru.municipio.pibPerCapita?.toLocaleString() || '?'}\n\n`;
  }

  if (geoInfo) {
    laudo += `🗺️ *Localização:*\n`;
    if (geoInfo.bairrosVizinhos?.length) laudo += `• Vizinhos: ${geoInfo.bairrosVizinhos.join(', ')}\n`;
    if (geoInfo.distanciaCentroKm != null) laudo += `• ${geoInfo.distanciaCentroKm} km do centro\n`;
    laudo += '\n';
  }

  // Indicador de confiança da fonte
  const confiancaLabel = resultado.confiancaFonte === 'alta' ? '🟢 Alta (dados reais dos portais)'
    : resultado.confiancaFonte === 'media' ? '🟡 Média (poucos comparativos encontrados)'
    : resultado.confiancaFonte === 'baixa' ? '🔴 Baixa (estimativa — poucos anúncios na região)'
    : null;

  if (confiancaLabel) {
    laudo += `📡 *Confiança da pesquisa:* ${confiancaLabel}\n`;
  }

  laudo += `📋 *Fontes:* ${(fontesConsultadas || []).join(' | ')}\n`;
  laudo += `_Avaliação gerada por PrecificaAI_\n\n`;
  laudo += `⚠️ _Este laudo é por amostragem/aproximação, baseado na média dos valores publicados em sites e portais de imóveis. Válido somente para simples consulta e sem valor de documento oficial._`;

  return laudo;
}

module.exports = { handleTelegram };
