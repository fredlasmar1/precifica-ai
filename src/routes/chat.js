const express = require('express');
const router = express.Router();
const { getSession, addMessage, clearSession, isReadyToEvaluate } = require('../agent/session');
const { chat, extractPropertyData } = require('../agent/openai');
const { calcularPreco, formatarReais } = require('../data/precificador');
const { fontesAvaliacao, textoFontes } = require('../data/fontes');

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

/**
 * POST /api/avaliar
 * Avaliação direta via formulário do site (campos estruturados, sem auth).
 * Pula a coleta conversacional do LLM e chama o MESMO motor (calcularPreco)
 * e o MESMO laudo formatado usados pelo chat e pelo Telegram.
 */
router.post('/avaliar', async (req, res) => {
  const b = req.body || {};

  const tipo = String(b.tipo || '').trim().toLowerCase();
  const finalidade = String(b.finalidade || 'venda').trim().toLowerCase();
  const cidade = String(b.cidade || '').trim();
  const bairro = String(b.bairro || '').trim();
  const metragem = b.metragem != null && b.metragem !== '' ? Number(b.metragem) : null;
  const areaLote = b.areaLote != null && b.areaLote !== '' ? Number(b.areaLote) : null;

  const faltando = [];
  if (!tipo) faltando.push('tipo');
  if (!cidade) faltando.push('cidade');
  if (!bairro) faltando.push('bairro');
  if ((!metragem || metragem <= 0) && (!areaLote || areaLote <= 0)) faltando.push('metragem');
  if (faltando.length) {
    return res.status(400).json({ error: `Preencha: ${faltando.join(', ')}.` });
  }

  const dadosImovel = {
    tipo,
    finalidade: finalidade === 'aluguel' ? 'aluguel' : 'venda',
    cidade,
    bairro,
    endereco: String(b.endereco || '').trim() || null,
    condominio: String(b.condominio || '').trim() || null,
    metragem,
    areaLote,
    quartos: b.quartos != null && b.quartos !== '' ? Number(b.quartos) : null,
    vagas: b.vagas != null && b.vagas !== '' ? Number(b.vagas) : null,
    diferenciais: String(b.diferenciais || '').trim(),
    conservacao: String(b.conservacao || 'bom').trim().toLowerCase()
  };

  try {
    const resultado = await calcularPreco(dadosImovel);
    if (resultado.erro) {
      return res.status(422).json({ error: resultado.mensagem });
    }
    const laudo = gerarLaudo(dadosImovel, resultado);
    return res.json({ type: 'laudo', response: laudo, dados: dadosImovel, resultado });
  } catch (err) {
    console.error('[Avaliar API] Erro:', err);
    return res.status(500).json({
      error: '⚠️ Tive um problema técnico ao avaliar. Tente novamente em instantes.',
      debug: err.message
    });
  }
});

/**
 * POST /api/ponto-comercial
 * Buscador inteligente comercial: dado endereço + ramo do cliente, avalia
 * concorrência, geradores de movimento e demanda → veredito de ponto comercial.
 */
router.post('/ponto-comercial', async (req, res) => {
  const b = req.body || {};
  const cidade = String(b.cidade || 'Anápolis').trim();
  const bairro = String(b.bairro || '').trim();
  const endereco = String(b.endereco || '').trim();
  const ramo = String(b.ramo || '').trim();

  if (!bairro || !ramo) {
    return res.status(400).json({ error: 'Informe o bairro e o ramo do cliente (ex: farmácia, academia).' });
  }

  try {
    const { validarEndereco } = require('../data/geoValidacao');
    const { perfilarLocal } = require('../data/guruAnapolis');
    const { analisarPontoComercial, formatarRelatorioComercial, coordsBairro } = require('../data/pontoComercial');

    const geo = await validarEndereco(cidade, bairro, endereco);
    let lat, lng;
    if (geo && geo.valido) { lat = geo.lat; lng = geo.lng; }
    else {
      const c = coordsBairro(bairro); // fallback p/ bairros conhecidos (ex: "Centro" sem rua)
      if (c) { lat = c.lat; lng = c.lng; }
      else return res.status(422).json({ error: 'Não consegui localizar esse endereço/bairro em Goiás. Confira e tente de novo.' });
    }

    let perfilGuru = null;
    try { perfilGuru = await perfilarLocal(cidade, bairro, lat, lng); } catch {}

    const analise = await analisarPontoComercial(lat, lng, ramo, { cidade, bairro, perfilGuru });
    if (analise.erro) return res.status(422).json({ error: analise.erro });

    const texto = formatarRelatorioComercial(analise);
    return res.json({ type: 'comercial', response: texto, analise });
  } catch (err) {
    console.error('[PontoComercial API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao analisar o ponto comercial. Tente novamente.', debug: err.message });
  }
});

/**
 * POST /api/melhor-bairro
 * Recomendador: varre os bairros de Anápolis e ranqueia os melhores para o ramo.
 * Aceita { ramo } direto OU { pergunta } em linguagem natural ("qual o melhor
 * bairro para uma barbearia?").
 */
router.post('/melhor-bairro', async (req, res) => {
  const b = req.body || {};
  try {
    const { melhorBairro, formatarMelhorBairro, extrairRamo } = require('../data/pontoComercial');
    let ramo = String(b.ramo || '').trim();
    if (!ramo && b.pergunta) ramo = await extrairRamo(b.pergunta);
    if (!ramo) return res.status(400).json({ error: 'Não identifiquei o ramo. Ex: "qual o melhor bairro para uma barbearia?"' });

    const d = await melhorBairro(ramo);
    if (d.erro) return res.status(422).json({ error: d.erro });
    return res.json({ type: 'melhor-bairro', response: formatarMelhorBairro(d), ramo, ranking: d.ranking });
  } catch (err) {
    console.error('[MelhorBairro API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao buscar o melhor bairro. Tente novamente.', debug: err.message });
  }
});

/**
 * POST /api/predio — aba "Prédios": ficha completa de um edifício
 * (endereço, CNPJ, condomínio, IPTU, lazer, processos) + unidades anunciadas.
 */
router.post('/predio', async (req, res) => {
  const b = req.body || {};
  const condominio = String(b.condominio || '').trim();
  const bairro = String(b.bairro || '').trim();
  const cidade = String(b.cidade || 'Anápolis').trim();
  if (!condominio || !bairro) {
    return res.status(400).json({ error: 'Informe o nome do prédio e o bairro.' });
  }
  try {
    const { estimarPrecoPredio } = require('../data/analistaIA');
    const { gerarFichaPredio, formatarBuscaPredio } = require('../data/fichaPredio');

    // unidades anunciadas no prédio (para faixa de preço + base do IPTU)
    const unidades = await estimarPrecoPredio({ finalidade: 'venda', cidade, bairro, condominio });
    const comps = (unidades && unidades.comparativos) || [];
    let valorRef = 0;
    if (comps.length) {
      const precos = comps.map(c => Number(c.preco)).filter(p => p > 0).sort((a, b) => a - b);
      valorRef = precos[Math.floor(precos.length / 2)] || 0;
    }

    const ficha = await gerarFichaPredio({ condominio, bairro, cidade, valorMercado: valorRef });
    const texto = formatarBuscaPredio(ficha, unidades);
    return res.json({ type: 'predio', response: texto, ficha, unidades: comps });
  } catch (err) {
    console.error('[Predio API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao pesquisar o prédio. Tente novamente.' });
  }
});

/**
 * POST /api/avaliar-empresa — Calculadora de avaliação de empresa / passagem de ponto.
 */
router.post('/avaliar-empresa', async (req, res) => {
  const b = req.body || {};
  if (!b.faturamentoMensal || Number(b.faturamentoMensal) <= 0) {
    return res.status(400).json({ error: 'Informe ao menos o faturamento mensal.' });
  }
  try {
    const { avaliarEmpresa, formatarEmpresa } = require('../data/valuationEmpresa');
    const resultado = await avaliarEmpresa(b);
    if (resultado.erro) return res.status(422).json({ error: resultado.erro });
    return res.json({ type: 'empresa', response: formatarEmpresa(resultado), resultado });
  } catch (err) {
    console.error('[Empresa API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao avaliar a empresa. Tente novamente.' });
  }
});

/** POST /api/relatorio-empresa — PDF da avaliação de empresa. */
router.post('/relatorio-empresa', async (req, res) => {
  const { resultado, solicitante } = req.body || {};
  if (!resultado) return res.status(400).json({ error: 'Faça uma avaliação de empresa primeiro.' });
  try {
    const { gerarEmpresaPdf } = require('../data/relatorioPdf');
    const pdf = await gerarEmpresaPdf(resultado, { solicitante });
    const slug = String(resultado.ramo || 'empresa').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="avaliacao-empresa-${slug}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[RelatEmpresa API] Erro:', err);
    res.status(500).json({ error: '⚠️ Erro ao gerar o PDF. Tente novamente.' });
  }
});

/**
 * GET /api/uso — status de consumo das APIs (para monitorar custos).
 */
router.get('/uso', async (req, res) => {
  const axios = require('axios');
  const out = { scraperapi: null, google: null, alertas: [] };
  try {
    const k = process.env.SCRAPER_API_KEY;
    if (k) {
      const { data } = await axios.get(`http://api.scraperapi.com/account?api_key=${k}`, { timeout: 12000 });
      const usados = data.requestCount, limite = data.requestLimit, restam = data.creditsLeft;
      const pct = limite ? Math.round((usados / limite) * 100) : 0;
      out.scraperapi = { usados, limite, restam, pct };
      if (restam < limite * 0.1) out.alertas.push(`ScraperAPI: só ${restam} buscas restantes (${pct}% usado)`);
    }
  } catch (e) { out.scraperapi = { erro: e.message }; }
  try {
    const usados = await require('../data/database').obterUso('google_places');
    const cotaGratis = 6250; // US$200 / US$0,032 por busca
    out.google = { usados, cotaGratis, pct: Math.round((usados / cotaGratis) * 100) };
    if (usados >= cotaGratis * 0.85) out.alertas.push(`Google Maps: ${usados} buscas (${out.google.pct}% da cota grátis)`);
  } catch (e) { out.google = { erro: e.message }; }
  res.json(out);
});

/**
 * POST /api/relatorio
 * Gera o PDF do Parecer de Avaliação Mercadológica (PTAM por amostragem).
 * Body: { dados, resultado, versao: 'tecnica'|'cliente', solicitante }
 */
router.post('/relatorio', async (req, res) => {
  const { dados, resultado, versao, solicitante } = req.body || {};
  if (!dados || !resultado) return res.status(400).json({ error: 'Faça uma avaliação primeiro.' });
  try {
    const { gerarRelatorioPdf } = require('../data/relatorioPdf');
    const pdf = await gerarRelatorioPdf(dados, resultado, { versao, solicitante });
    const slug = String(dados.bairro || 'imovel').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
    const nome = `parecer-${slug}-${versao === 'cliente' ? 'cliente' : 'tecnico'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.send(pdf);
  } catch (err) {
    console.error('[Relatorio API] Erro:', err);
    res.status(500).json({ error: '⚠️ Erro ao gerar o PDF. Tente novamente.' });
  }
});

/**
 * POST /api/relatorio-comercial — PDF do Estudo de Viabilidade Comercial.
 * Body: { analise (de /api/ponto-comercial), solicitante }
 */
router.post('/relatorio-comercial', async (req, res) => {
  const { analise, solicitante } = req.body || {};
  if (!analise) return res.status(400).json({ error: 'Faça uma análise de ponto comercial primeiro.' });
  try {
    const { gerarDossiePdf } = require('../data/relatorioPdf');
    const pdf = await gerarDossiePdf(analise, { solicitante });
    const slug = String(analise.ramo || 'ponto').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="viabilidade-${slug}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[RelatComercial API] Erro:', err);
    res.status(500).json({ error: '⚠️ Erro ao gerar o PDF. Tente novamente.' });
  }
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

  if (resultado.fichaPredioTexto) laudo += `\n${resultado.fichaPredioTexto}`;

  // Bloco padronizado de credibilidade (método, amostra, data, links, bases)
  try { laudo += textoFontes(fontesAvaliacao(dados, resultado)); } catch {}

  laudo += `_Avaliação gerada por Precifica Aí (Bens Imóveis Corporativos)_\n\n`;
  laudo += `⚠️ _Parecer de avaliação mercadológica por amostragem. Apoio à decisão — não substitui laudo de engenharia (ABNT NBR 14653) para fins judiciais ou fiscais._`;
  return laudo;
}

module.exports = router;
