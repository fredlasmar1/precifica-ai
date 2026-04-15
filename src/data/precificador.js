const { buscarComparativos } = require('./portais');
const { analisarLocalizacao, formatarSecaoLocalizacao } = require('./googleplaces');
const { estimarPrecoComIA } = require('./analistaIA');
const { validarEndereco } = require('./geoValidacao');
const inteligencia = require('./inteligenciaLocal');

/**
 * Motor de precificação — hierarquia de fontes:
 *
 * 1. Portais reais (OLX, VivaReal, ZAP, Imovelweb) → comparativos diretos
 * 2. Perplexity → pesquisa anúncios reais na internet
 * 3. Fallback estático → último recurso
 *
 * REGRA FUNDAMENTAL:
 * Quando temos comparativos REAIS (portais ou Perplexity), o preço/m²
 * já reflete localização, diferenciais e conservação porque os comparativos
 * são filtrados pelo mesmo perfil. NÃO aplicar ajustes por cima.
 * Ajustes artificiais só existem no fallback estático.
 *
 * Google Places serve apenas como INFORMAÇÃO no laudo (o que tem por perto),
 * NÃO como multiplicador de preço quando temos dados reais.
 */
async function calcularPreco(dadosImovel) {
  const { tipo, finalidade, cidade, bairro, endereco, metragem, quartos, vagas, diferenciais, conservacao } = dadosImovel;

  // 1. Validar endereço via Google Maps (confirma que bairro existe na cidade)
  let geoInfo = null;
  try {
    geoInfo = await validarEndereco(cidade, bairro, endereco);
    if (geoInfo && !geoInfo.valido) {
      console.warn(`[Precificador] Endereço inválido: ${geoInfo.motivo}`);
    } else if (geoInfo?.valido) {
      console.log(`[Precificador] Endereço validado: ${geoInfo.enderecoCompleto}`);
    }
  } catch (geoErr) {
    console.error('[Precificador] Erro na validação geográfica:', geoErr.message);
  }

  // Injeta dados geográficos no dadosImovel para a Perplexity usar
  const dadosEnriquecidos = {
    ...dadosImovel,
    geoInfo: geoInfo?.valido ? geoInfo : null
  };

  // 2. Busca paralela: portais + localização (informativa)
  const [comparativosRes, localizacaoRes] = await Promise.allSettled([
    buscarComparativos(dadosImovel),
    analisarLocalizacao(cidade, bairro, endereco)
  ]);

  let comparativos = comparativosRes.status === 'fulfilled' ? comparativosRes.value : null;
  const localizacao = localizacaoRes.status === 'fulfilled' ? localizacaoRes.value : null;

  if (comparativosRes.status === 'rejected') console.warn('[Precificador] Comparativos rejeitados:', comparativosRes.reason?.message);
  if (localizacaoRes.status === 'rejected') console.warn('[Precificador] Localização rejeitada:', localizacaoRes.reason?.message);

  // ─── Determinar preço/m² base (hierarquia de fontes) ─────────────
  //
  // 1. Inteligência Local (dados validados pelo corretor) — PRIORIDADE MÁXIMA
  // 2. Inteligência Local (dados de pesquisas anteriores, < 30 dias)
  // 3. Portais diretos (OLX, ZAP, etc.)
  // 4. Perplexity (pesquisa na internet) — e salva resultado na base local
  //
  // Cada consulta da Perplexity alimenta a inteligência local.
  // Com o tempo, o sistema depende cada vez menos da Perplexity.

  let precoM2Base = null;
  let fontePrincipal = null;
  let analiseIA = null;
  let usouDadosReais = false;
  let confiancaFonte = null;

  // Prioridade 1: Inteligência Local
  const dadoLocal = inteligencia.consultar(cidade, bairro, tipo, finalidade);
  if (dadoLocal && dadoLocal.confianca !== 'baixa') {
    precoM2Base = dadoLocal.precoM2;
    fontePrincipal = `${dadoLocal.fonte} (${dadoLocal.validadoPor === 'corretor' ? 'validado' : dadoLocal.amostras + ' amostras'})`;
    usouDadosReais = true;
    confiancaFonte = dadoLocal.confianca;
    console.log(`[Precificador] Inteligência Local: R$ ${precoM2Base}/m² (${dadoLocal.validadoPor}, confiança ${dadoLocal.confianca})`);
  }

  // Prioridade 2: dados REAIS dos portais
  if (!precoM2Base && comparativos && comparativos.precoMedioM2) {
    precoM2Base = comparativos.precoMedioM2;
    fontePrincipal = comparativos.fonte;
    usouDadosReais = true;
    console.log(`[Precificador] Usando comparativos reais: R$ ${precoM2Base}/m² (${fontePrincipal})`);
    // Salva na inteligência local
    inteligencia.registrarPesquisa(cidade, bairro, tipo, finalidade, precoM2Base, comparativos.totalEncontrados, comparativos.precoMinimo, comparativos.precoMaximo);
  }

  // Prioridade 3: Perplexity pesquisa na internet
  if (!precoM2Base) {
    console.log('[Precificador] Consultando Perplexity...');
    try {
      analiseIA = await estimarPrecoComIA(dadosEnriquecidos);
      console.log(`[Precificador] Perplexity retornou: ${analiseIA ? 'dados OK' : 'NULL (falhou)'}`);
      if (analiseIA) {
        precoM2Base = analiseIA.precoMedioM2;
        fontePrincipal = analiseIA.fonte;
        usouDadosReais = true;
        confiancaFonte = analiseIA.confianca;
        console.log(`[Precificador] Perplexity: R$ ${precoM2Base}/m² (confiança: ${analiseIA.confianca})`);
        // Salva na inteligência local para próximas consultas
        inteligencia.registrarPesquisa(cidade, bairro, tipo, finalidade, precoM2Base, analiseIA.anunciosAnalisados, analiseIA.faixaMinM2, analiseIA.faixaMaxM2);
      }
    } catch (pplxErr) {
      console.error('[Precificador] EXCEÇÃO na Perplexity:', pplxErr.message);
    }
  }

  // Prioridade 4: Inteligência Local com confiança baixa (melhor que nada)
  if (!precoM2Base && dadoLocal) {
    precoM2Base = dadoLocal.precoM2;
    fontePrincipal = `${dadoLocal.fonte} (dado antigo — ${dadoLocal.diasDesdeAtualização} dias)`;
    usouDadosReais = true;
    console.log(`[Precificador] Usando dado local antigo: R$ ${precoM2Base}/m²`);
  }

  // Se nenhuma fonte retornou dados, NÃO inventar um preço.
  // Melhor informar que não conseguiu do que dar um número errado.
  if (!precoM2Base) {
    console.error('[Precificador] TODAS as fontes falharam — sem dados para precificar');
    return {
      erro: true,
      mensagem: '⚠️ Não foi possível obter dados de mercado para este imóvel neste momento. Os portais e a pesquisa online não retornaram resultados. Tente novamente em alguns minutos ou com um endereço/bairro diferente.',
      precoMinimo: 0, precoRecomendado: 0, precoMaximo: 0,
      precoM2Mercado: 0, precoM2Imovel: 0,
      comparativosEncontrados: 0, fontesConsultadas: [],
      tempoEstimadoDias: '-', indiceLiquidez: '-',
      ajustesAplicados: [], variacao3meses: null,
      analiseIA: null, localizacao, scoreLocalizacao: localizacao?.score || null,
      descLocalizacao: null
    };
  }

  const precoM2Mercado = precoM2Base;

  // ─── Preço final ────────────────────────────────────────────────
  //
  // Dados reais (portais ou Perplexity): preço JÁ reflete tudo.
  // Os comparativos são do mesmo tipo, bairro, tamanho e estado.
  // NÃO aplicar ajustes — seria contar duas vezes.
  //
  // Fallback estático: preço é genérico, precisa de ajuste.

  let precoM2Final;
  let ajustesDescricao = [];

  if (usouDadosReais) {
    precoM2Final = precoM2Base;
    ajustesDescricao.push('Preço baseado em comparativos reais');

    // ─── Ajuste inteligente por análise da rua ─────────────────
    // Quando os comparativos são de bairros VIZINHOS (não do bairro exato)
    // E a análise da rua indica que o local tem valor diferente da média,
    // aplicar um ajuste proporcional. Isso é justo porque um terreno no
    // Centro comercial vale mais que no bairro residencial vizinho.
    const analiseRua = geoInfo?.analiseRua;
    const confiancaBaixa = confiancaFonte === 'baixa' || analiseIA?.confianca === 'baixa';

    if (analiseRua && confiancaBaixa) {
      // Confiança baixa = provavelmente usou bairros vizinhos
      if (analiseRua.impacto === 'positivo' && analiseRua.perfilRua === 'comercial forte') {
        const ajuste = 1.20; // +20% para rua comercial forte quando dados são de vizinhos
        precoM2Final = Math.round(precoM2Final * ajuste);
        ajustesDescricao.push('+20% rua comercial forte (comparativos de bairros vizinhos)');
        console.log(`[Precificador] Ajuste rua comercial forte: ${precoM2Base} → ${precoM2Final}/m²`);
      } else if (analiseRua.impacto === 'positivo') {
        const ajuste = 1.10; // +10% para rua com boa infraestrutura
        precoM2Final = Math.round(precoM2Final * ajuste);
        ajustesDescricao.push('+10% boa infraestrutura na rua (comparativos de bairros vizinhos)');
        console.log(`[Precificador] Ajuste infraestrutura: ${precoM2Base} → ${precoM2Final}/m²`);
      } else if (analiseRua.impacto === 'negativo') {
        const ajuste = 0.90; // -10% para rua com fatores negativos
        precoM2Final = Math.round(precoM2Final * ajuste);
        ajustesDescricao.push('-10% fatores negativos na rua (comparativos de bairros vizinhos)');
        console.log(`[Precificador] Ajuste negativo: ${precoM2Base} → ${precoM2Final}/m²`);
      }
    }
  } else {
    // Fallback: aplica ajustes porque o baseline é genérico
    const ajustes = calcularAjustesFallback(dadosImovel);
    precoM2Final = Math.round(precoM2Base * ajustes.fator);
    ajustesDescricao = ajustes.descricao;
  }

  // ─── Faixa final ────────────────────────────────────────────────

  const precoRecomendado = Math.round(precoM2Final * metragem);
  const precoMinimo = Math.round(precoRecomendado * 0.92);
  const precoMaximo = Math.round(precoRecomendado * 1.08);

  // Liquidez
  const liquidez = estimarLiquidez(finalidade, precoM2Final, precoM2Mercado);

  // Fontes
  const fontes = [fontePrincipal];
  if (localizacao) fontes.push('Google Places (infraestrutura)');
  if (analiseIA) fontes.push(`Confiança: ${analiseIA.confianca}`);

  return {
    precoMinimo,
    precoRecomendado,
    precoMaximo,

    precoM2Mercado,
    precoM2Imovel: precoM2Final,

    comparativosEncontrados: comparativos?.totalEncontrados || 0,
    fontesConsultadas: fontes.filter(Boolean),

    tempoEstimadoDias: liquidez.dias,
    indiceLiquidez: liquidez.indicador,

    ajustesAplicados: ajustesDescricao,
    variacao3meses: null,

    // Pesquisa Perplexity (se usada)
    analiseIA: analiseIA ? {
      raciocinio: analiseIA.raciocinio,
      confianca: analiseIA.confianca,
      faixaM2: `R$ ${analiseIA.faixaMinM2} - R$ ${analiseIA.faixaMaxM2}/m²`,
      precoMedioM2: analiseIA.precoMedioM2,
      anunciosAnalisados: analiseIA.anunciosAnalisados || 0,
      comparativos: analiseIA.comparativos || [],
      citacoes: analiseIA.citacoes || []
    } : null,

    // Google Places — apenas informativo, não altera preço
    localizacao,
    scoreLocalizacao: localizacao?.score || null,
    descLocalizacao: localizacao ? localizacao.multiplicador.descricao : null,

    // Dados geográficos do Google Maps
    geoInfo: geoInfo?.valido ? {
      enderecoValidado: geoInfo.enderecoCompleto,
      bairrosVizinhos: geoInfo.bairrosProximos,
      distanciaCentroKm: geoInfo.distanciaCentroKm,
      viasProximas: geoInfo.viasProximas,
      analiseRua: geoInfo.analiseRua
    } : null
  };
}

/**
 * Ajustes SOMENTE para fallback estático — quando não temos dados reais.
 * NÃO usar quando tiver comparativos reais.
 */
function calcularAjustesFallback(dados) {
  const { tipo, conservacao, vagas, diferenciais } = dados;
  let fator = 1.0;
  const descricao = [];

  if (conservacao === 'novo') {
    fator *= 1.12;
    descricao.push('+12% imóvel novo');
  } else if (conservacao === 'reformar') {
    fator *= 0.85;
    descricao.push('-15% necessita reformas');
  }

  if (vagas >= 2) {
    fator *= 1.06;
    descricao.push('+6% 2+ vagas');
  } else if (vagas === 0) {
    fator *= 0.95;
    descricao.push('-5% sem garagem');
  }

  const difsArray = Array.isArray(diferenciais) ? diferenciais : [];
  const difsPremium = ['piscina', 'academia', 'portaria 24h', 'gourmet', 'churrasqueira', 'área de lazer'];
  const count = difsArray.filter(d =>
    difsPremium.some(dp => d.toLowerCase().includes(dp.toLowerCase()))
  ).length;

  if (count >= 3) {
    fator *= 1.10;
    descricao.push('+10% múltiplos diferenciais premium');
  } else if (count >= 1) {
    fator *= 1.05;
    descricao.push('+5% diferenciais');
  }

  if (tipo === 'terreno') {
    fator *= 0.75;
    descricao.push('-25% terreno (sem construção)');
  }

  return { fator, descricao };
}

/**
 * Estima liquidez
 */
function estimarLiquidez(finalidade, precoM2Imovel, precoM2Mercado) {
  const ratio = precoM2Mercado > 0 ? precoM2Imovel / precoM2Mercado : 1.0;
  let dias, indicador;

  if (finalidade === 'aluguel') {
    if (ratio <= 0.95) { dias = '15 a 30'; indicador = '🟢 Alta liquidez'; }
    else if (ratio <= 1.05) { dias = '30 a 60'; indicador = '🟡 Liquidez normal'; }
    else { dias = '60 a 90+'; indicador = '🔴 Liquidez baixa'; }
  } else {
    if (ratio <= 0.95) { dias = '30 a 60'; indicador = '🟢 Alta liquidez'; }
    else if (ratio <= 1.05) { dias = '60 a 120'; indicador = '🟡 Liquidez normal'; }
    else { dias = '120 a 180+'; indicador = '🔴 Liquidez baixa'; }
  }

  return { dias, indicador };
}

function formatarReais(valor) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(valor);
}

module.exports = { calcularPreco, formatarReais };
