const express = require('express');
const router = express.Router();
const { getSession, addMessage, clearSession, isReadyToEvaluate } = require('../agent/session');
const { chat, extractPropertyData } = require('../agent/openai');
const { calcularPreco, formatarReais } = require('../data/precificador');
const { formatarSecaoLocalizacao } = require('../data/googleplaces');

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
      if (!dadosImovel) throw new Error('Não foi possível extrair dados');

      const resultado = await calcularPreco(dadosImovel);
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
    console.error('[Chat API] Erro:', err.message);
    return res.status(500).json({ error: 'Erro ao processar mensagem: ' + err.message });
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
  const { tipo, finalidade, cidade, bairro, metragem, quartos, vagas } = dados;
  const {
    precoMinimo, precoRecomendado, precoMaximo,
    precoM2Mercado, precoM2Imovel,
    comparativosEncontrados, tempoEstimadoDias,
    indiceLiquidez, variacao3meses, ajustesAplicados,
    localizacao
  } = resultado;

  const tipoLabel = tipo.charAt(0).toUpperCase() + tipo.slice(1);
  const finalidadeLabel = finalidade === 'aluguel' ? 'Aluguel' : 'Venda';

  let laudo = `📊 *LAUDO DE PRECIFICAÇÃO*\n`;
  laudo += `━━━━━━━━━━━━━━━━━━━━━\n`;
  laudo += `🏠 ${tipoLabel} • ${finalidadeLabel}\n`;
  laudo += `📍 ${bairro}, ${cidade} - GO\n`;
  laudo += `📐 ${metragem}m² • ${quartos} quartos • ${vagas} vaga(s)\n\n`;
  laudo += `💰 *Faixa de Preço Sugerida:*\n`;
  laudo += `• Mínimo: *${formatarReais(precoMinimo)}*\n`;
  laudo += `• Recomendado: *${formatarReais(precoRecomendado)}*\n`;
  laudo += `• Máximo: *${formatarReais(precoMaximo)}*\n\n`;
  laudo += `📊 *Preço por m²:*\n`;
  laudo += `• Média do mercado: ${formatarReais(precoM2Mercado)}/m²\n`;
  laudo += `• Este imóvel: ${formatarReais(precoM2Imovel)}/m²\n\n`;
  laudo += `⚡ *Liquidez:*\n`;
  laudo += `• ${indiceLiquidez}\n`;
  laudo += `• Tempo estimado: ${tempoEstimadoDias} dias\n\n`;

  if (variacao3meses) laudo += `📈 Mercado local: +${variacao3meses}% nos últimos 3 meses\n\n`;

  if (localizacao) {
    laudo += formatarSecaoLocalizacao(localizacao);
    laudo += '\n';
  }

  if (ajustesAplicados?.length > 0) {
    laudo += `🔧 *Ajustes aplicados:*\n`;
    ajustesAplicados.forEach(a => laudo += `• ${a}\n`);
    laudo += '\n';
  }

  if (comparativosEncontrados > 0) laudo += `🔍 Comparativos analisados: ${comparativosEncontrados} imóveis\n\n`;

  laudo += `_Avaliação gerada por PrecificaAI_\n_Dados: FipeZAP + Google Places + portais imobiliários_`;
  return laudo;
}

module.exports = router;
