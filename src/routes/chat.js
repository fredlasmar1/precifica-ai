const express = require('express');
const router = express.Router();
const { getSession, addMessage, clearSession, isReadyToEvaluate } = require('../agent/session');
const { chat, extractPropertyData } = require('../agent/openai');
const { calcularPreco, formatarReais } = require('../data/precificador');

/**
 * POST /api/chat
 * Recebe mensagem do usuário e retorna resposta do agente
 */
router.post('/chat', async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId e message são obrigatórios' });
  }

  // Comando de reset
  if (/reiniciar|nova avalia[çc][aã]o|reset/i.test(message)) {
    clearSession(sessionId);
    return res.json({
      response: '🔄 Sessão reiniciada! Vamos começar uma nova avaliação.\n\nQual tipo de imóvel você quer avaliar? (casa, apartamento, terreno ou comercial)',
      type: 'text'
    });
  }

  try {
    const history = addMessage(sessionId, 'user', message);
    const jaColetouDados = isReadyToEvaluate(history.slice(0, -1));

    if (jaColetouDados) {
      // Extrai e precifica
      const dadosImovel = await extractPropertyData(history);
      if (!dadosImovel) {
        const msg = '⚠️ Não consegui organizar os dados da conversa. Pode me passar o resumo do imóvel novamente? (tipo, finalidade, cidade, bairro, metragem, quartos, vagas e estado de conservação)';
        addMessage(sessionId, 'assistant', msg);
        return res.json({ response: msg, type: 'text' });
      }

      const resultado = await calcularPreco(dadosImovel);
      if (resultado.erro) {
        addMessage(sessionId, 'assistant', resultado.mensagem);
        return res.json({ response: resultado.mensagem, type: 'text' });
      }
      const laudo = gerarLaudo(dadosImovel, resultado);

      addMessage(sessionId, 'assistant', laudo);
      return res.json({ response: laudo, type: 'laudo', dados: dadosImovel, resultado });
    }

    // Conversa normal
    const resposta = await chat(history);
    addMessage(sessionId, 'assistant', resposta);

    // Verifica se agora está pronto para precificar
    const historicoAtual = [...history, { role: 'assistant', content: resposta }];
    if (isReadyToEvaluate(historicoAtual)) {
      const dadosImovel = await extractPropertyData(historicoAtual);
      if (dadosImovel) {
        const resultado = await calcularPreco(dadosImovel);
        if (resultado.erro) {
          addMessage(sessionId, 'assistant', resultado.mensagem);
          return res.json({ response: resposta, followUp: resultado.mensagem, type: 'text' });
        }
        const laudo = gerarLaudo(dadosImovel, resultado);
        addMessage(sessionId, 'assistant', laudo);

        return res.json({
          response: resposta,
          followUp: laudo,
          type: 'laudo',
          dados: dadosImovel,
          resultado
        });
      }
    }

    return res.json({ response: resposta, type: 'text' });

  } catch (err) {
    console.error('[Chat API] Erro:', err);
    const userMsg =
      '⚠️ Tive um problema técnico ao processar sua mensagem. ' +
      'Tente novamente em instantes ou digite *reiniciar* para começar uma nova avaliação.';
    return res.status(500).json({ error: userMsg, debug: err.message });
  }
});

/**
 * DELETE /api/chat/:sessionId
 * Limpa sessão
 */
router.delete('/chat/:sessionId', (req, res) => {
  clearSession(req.params.sessionId);
  res.json({ ok: true });
});

function gerarLaudo(dados, resultado) {
  const { tipo, finalidade, cidade, bairro, endereco, metragem, quartos, vagas } = dados;
  const {
    precoMinimo, precoRecomendado, precoMaximo, geoInfo, perfilGuru,
    precoM2Mercado, precoM2Imovel,
    comparativosEncontrados, tempoEstimadoDias,
    indiceLiquidez, ajustesAplicados,
    fontesConsultadas, analiseIA
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
        if (c.fonte) laudo += `     _Fonte: ${c.fonte}_\n`;
      });
      laudo += `\n📊 *Resultado da pesquisa:*\n`;
      laudo += `• Média: *${formatarReais(analiseIA.precoMedioM2)}/m²*\n`;
      laudo += `• Faixa: ${analiseIA.faixaM2}\n`;
      laudo += `• ${analiseIA.anunciosAnalisados} anúncios comparáveis\n`;
      laudo += `• Confiança: ${analiseIA.confianca}\n`;
      if (analiseIA.raciocinio) laudo += `• ${analiseIA.raciocinio}\n`;
      laudo += '\n';
      // Links dos portais consultados
      if (analiseIA.citacoes && analiseIA.citacoes.length > 0) {
        laudo += `🔗 *Links consultados:*\n`;
        analiseIA.citacoes.slice(0, 3).forEach(url => {
          laudo += `• ${url}\n`;
        });
        laudo += '\n';
      }
    } else {
      laudo += `• ${analiseIA.raciocinio}\n`;
      laudo += `• Faixa: ${analiseIA.faixaM2}\n\n`;
    }
  }

  if (ajustesAplicados?.length > 0) {
    laudo += `🔧 *Ajustes aplicados:*\n`;
    ajustesAplicados.forEach(a => laudo += `• ${a}\n`);
    laudo += '\n';
  }

  if (comparativosEncontrados > 0) laudo += `🔍 Comparativos analisados: ${comparativosEncontrados} imóveis\n`;

  if (perfilGuru?.infraestrutura) {
    const i = perfilGuru.infraestrutura;
    laudo += `🏘️ *Perfil do bairro:*\n`;
    laudo += `• ${i.resumo}\n`;
    if (i.vocacoes?.length) laudo += `• Vocação: ${i.vocacoes.join(', ')}\n`;
    if (i.exemplosComercios?.length) laudo += `• Comércios: ${i.exemplosComercios.slice(0, 3).join(', ')}\n`;
    if (i.exemplosAlimentacao?.length) laudo += `• Alimentação: ${i.exemplosAlimentacao.slice(0, 3).join(', ')}\n`;
    if (i.exemplosSaude?.length) laudo += `• Saúde: ${i.exemplosSaude.slice(0, 3).join(', ')}\n`;
    laudo += '\n';
  }

  if (perfilGuru?.municipio) {
    const m = perfilGuru.municipio;
    laudo += `📊 *Dados do município (IBGE):*\n`;
    if (m.populacao) laudo += `• População: ${m.populacao.toLocaleString()}\n`;
    if (m.pibPerCapita) laudo += `• PIB per capita: R$ ${m.pibPerCapita.toLocaleString()}\n`;
    laudo += '\n';
  }

  if (geoInfo) {
    laudo += `🗺️ *Localização (Google Maps):*\n`;
    if (geoInfo.enderecoValidado) laudo += `• Endereço: ${geoInfo.enderecoValidado}\n`;
    if (geoInfo.bairrosVizinhos?.length) laudo += `• Bairros vizinhos: ${geoInfo.bairrosVizinhos.join(', ')}\n`;
    if (geoInfo.distanciaCentroKm != null) laudo += `• Distância ao centro: ${geoInfo.distanciaCentroKm} km\n`;
    if (geoInfo.viasProximas?.length) laudo += `• Vias próximas: ${geoInfo.viasProximas.join(', ')}\n`;
    laudo += '\n';
  }

  laudo += `📋 *Fontes:* ${(fontesConsultadas || []).join(' | ')}\n`;
  laudo += `_Avaliação gerada por PrecificaAI_\n\n`;
  laudo += `⚠️ _Este laudo é por amostragem/aproximação, baseado na média dos valores publicados em sites e portais de imóveis. Válido somente para simples consulta e sem valor de documento oficial._`;
  return laudo;
}

module.exports = router;
