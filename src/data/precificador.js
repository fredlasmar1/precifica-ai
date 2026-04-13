const { buscarComparativos } = require('./portais');
const { analisarLocalizacao, formatarSecaoLocalizacao } = require('./googleplaces');
const { estimarPrecoComIA } = require('./analistaIA');

/**
 * Motor de precificação — hierarquia de fontes:
 *
 * 1. Comparativos REAIS de portais (OLX, VivaReal, ZAP, Imovelweb)
 *    → média ponderada de preço/m² de imóveis similares reais à venda
 *
 * 2. Se nenhum portal retornar dados → GPT-4o como analista de mercado
 *    → estima preço/m² baseado no conhecimento do mercado imobiliário
 *
 * 3. Google Places → analisa infraestrutura e aplica multiplicador
 *
 * 4. Ajustes por características (conservação, vagas, diferenciais)
 */
async function calcularPreco(dadosImovel) {
  const { tipo, finalidade, cidade, bairro, metragem, quartos, vagas, diferenciais, conservacao } = dadosImovel;

  // Busca paralela: portais + localização
  const [comparativosRes, localizacaoRes] = await Promise.allSettled([
    buscarComparativos(dadosImovel),
    analisarLocalizacao(cidade, bairro)
  ]);

  let comparativos = comparativosRes.status === 'fulfilled' ? comparativosRes.value : null;
  const localizacao = localizacaoRes.status === 'fulfilled' ? localizacaoRes.value : null;

  if (comparativosRes.status === 'rejected') console.warn('[Precificador] Comparativos rejeitados:', comparativosRes.reason?.message);
  if (localizacaoRes.status === 'rejected') console.warn('[Precificador] Localização rejeitada:', localizacaoRes.reason?.message);

  // ─── Determinar preço/m² base ───────────────────────────────────

  let precoM2Base = null;
  let fontePrincipal = null;
  let analiseIA = null;

  // Prioridade 1: dados REAIS dos portais
  if (comparativos && comparativos.precoMedioM2) {
    precoM2Base = comparativos.precoMedioM2;
    fontePrincipal = comparativos.fonte;
    console.log(`[Precificador] Usando comparativos reais: R$ ${precoM2Base}/m² (${fontePrincipal})`);
  }

  // Prioridade 2: GPT-4o analista de mercado
  if (!precoM2Base) {
    console.log('[Precificador] Sem comparativos reais, consultando GPT-4o...');
    analiseIA = await estimarPrecoComIA(dadosImovel);
    if (analiseIA) {
      precoM2Base = analiseIA.precoMedioM2;
      fontePrincipal = analiseIA.fonte;
      console.log(`[Precificador] GPT-4o estimou: R$ ${precoM2Base}/m² (confiança: ${analiseIA.confianca})`);
    }
  }

  // Prioridade 3: último recurso estático (para nunca quebrar)
  if (!precoM2Base) {
    console.warn('[Precificador] Todas as fontes falharam, usando referência estática');
    precoM2Base = finalidade === 'aluguel' ? 18 : 3200;
    fontePrincipal = 'Referência base Goiás';
  }

  const precoM2Mercado = precoM2Base; // Guardar para referência no laudo

  // ─── Ajustes ────────────────────────────────────────────────────

  const ajustes = calcularAjustes(dadosImovel);

  // Localização (Google Places)
  const multLocalizacao = localizacao ? localizacao.multiplicador.fator : 1.0;
  const descLocalizacao = localizacao ? localizacao.multiplicador.descricao : null;

  const precoM2Ajustado = Math.round(precoM2Base * ajustes.fator * multLocalizacao);

  // ─── Faixa final ────────────────────────────────────────────────

  const precoRecomendado = Math.round(precoM2Ajustado * metragem);
  const precoMinimo = Math.round(precoRecomendado * 0.90);
  const precoMaximo = Math.round(precoRecomendado * 1.12);

  // Liquidez
  const liquidez = estimarLiquidez(dadosImovel, precoM2Ajustado, precoM2Mercado);

  // Fontes consultadas
  const fontes = [fontePrincipal];
  if (localizacao) fontes.push('Google Places');
  if (analiseIA) fontes.push(`Confiança IA: ${analiseIA.confianca}`);

  return {
    precoMinimo,
    precoRecomendado,
    precoMaximo,

    precoM2Mercado,
    precoM2Imovel: precoM2Ajustado,

    comparativosEncontrados: comparativos?.totalEncontrados || 0,
    fontesConsultadas: fontes.filter(Boolean),

    tempoEstimadoDias: liquidez.dias,
    indiceLiquidez: liquidez.indicador,

    ajustesAplicados: ajustes.descricao,
    variacao3meses: null, // removido — vinha do FipeZAP que não existe mais

    // Pesquisa de mercado Perplexity (se usada)
    analiseIA: analiseIA ? {
      raciocinio: analiseIA.raciocinio,
      confianca: analiseIA.confianca,
      faixaM2: `R$ ${analiseIA.faixaMinM2} - R$ ${analiseIA.faixaMaxM2}/m²`,
      anunciosAnalisados: analiseIA.anunciosAnalisados || 0,
      citacoes: analiseIA.citacoes || []
    } : null,

    // Google Places
    localizacao,
    scoreLocalizacao: localizacao?.score || null,
    descLocalizacao
  };
}

/**
 * Calcula fator de ajuste baseado nas características do imóvel
 */
function calcularAjustes(dados) {
  const { tipo, conservacao, vagas, diferenciais } = dados;
  let fator = 1.0;
  const descricao = [];

  // Conservação
  if (conservacao === 'novo') {
    fator *= 1.12;
    descricao.push('+12% imóvel novo');
  } else if (conservacao === 'reformar') {
    fator *= 0.85;
    descricao.push('-15% necessita reformas');
  }

  // Vagas de garagem
  if (vagas >= 2) {
    fator *= 1.06;
    descricao.push('+6% 2+ vagas');
  } else if (vagas === 0) {
    fator *= 0.95;
    descricao.push('-5% sem garagem');
  }

  // Diferenciais premium
  const difsArray = Array.isArray(diferenciais) ? diferenciais : [];
  const difsPremium = ['piscina', 'academia', 'portaria 24h', 'gourmet', 'churrasqueira', 'área de lazer'];
  const difsPresentesPremium = difsArray.filter(d =>
    difsPremium.some(dp => d.toLowerCase().includes(dp.toLowerCase()))
  );

  if (difsPresentesPremium.length >= 3) {
    fator *= 1.10;
    descricao.push('+10% múltiplos diferenciais premium');
  } else if (difsPresentesPremium.length >= 1) {
    fator *= 1.05;
    descricao.push('+5% diferenciais');
  }

  // Terreno
  if (tipo === 'terreno') {
    return { fator: fator * 0.75, descricao: [...descricao, '-25% terreno (sem construção)'] };
  }

  return { fator, descricao };
}

/**
 * Estima o tempo de liquidez baseado no posicionamento de preço
 */
function estimarLiquidez(dados, precoM2Imovel, precoM2Mercado) {
  const { finalidade } = dados;
  const ratio = precoM2Mercado > 0 ? precoM2Imovel / precoM2Mercado : 1.0;

  let dias, indicador;

  if (finalidade === 'aluguel') {
    if (ratio <= 0.95) { dias = '15 a 30'; indicador = '🟢 Alta liquidez'; }
    else if (ratio <= 1.05) { dias = '30 a 60'; indicador = '🟡 Liquidez normal'; }
    else { dias = '60 a 90+'; indicador = '🔴 Liquidez baixa — preço acima do mercado'; }
  } else {
    if (ratio <= 0.93) { dias = '30 a 60'; indicador = '🟢 Alta liquidez'; }
    else if (ratio <= 1.05) { dias = '60 a 120'; indicador = '🟡 Liquidez normal'; }
    else { dias = '120 a 180+'; indicador = '🔴 Liquidez baixa — preço acima do mercado'; }
  }

  return { dias, indicador };
}

/**
 * Formata os valores em Real brasileiro
 */
function formatarReais(valor) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(valor);
}

module.exports = { calcularPreco, formatarReais };
