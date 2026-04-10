const { getFipeZapIndex } = require('./fipezap');
const { buscarComparativos } = require('./portais');
const { analisarLocalizacao, formatarSecaoLocalizacao } = require('./googleplaces');
const { getMultiplicadorBairro } = require('./bairros');

/**
 * Motor de precificação — combina FipeZAP + comparativos + ajustes
 * Retorna uma faixa de preço com justificativa
 */
async function calcularPreco(dadosImovel) {
  const { tipo, finalidade, cidade, bairro, metragem, quartos, vagas, diferenciais, conservacao } = dadosImovel;

  // Busca paralela com isolamento de falhas:
  // se UMA fonte cair, as outras continuam e o laudo ainda é gerado.
  // Cada fonte já tem fallback interno; isso é defesa em profundidade.
  const [fipezapRes, comparativosRes, localizacaoRes] = await Promise.allSettled([
    getFipeZapIndex(cidade, finalidade),
    buscarComparativos(dadosImovel),
    analisarLocalizacao(cidade, bairro)
  ]);

  const fipezap = fipezapRes.status === 'fulfilled' && fipezapRes.value
    ? fipezapRes.value
    : fipezapEmergencia(finalidade);

  const comparativos = comparativosRes.status === 'fulfilled' && comparativosRes.value
    ? comparativosRes.value
    : { fonte: null, totalEncontrados: 0, precoMedioM2: null };

  const localizacao = localizacaoRes.status === 'fulfilled' ? localizacaoRes.value : null;

  if (fipezapRes.status === 'rejected') console.warn('[Precificador] FipeZAP rejeitado:', fipezapRes.reason?.message);
  if (comparativosRes.status === 'rejected') console.warn('[Precificador] Comparativos rejeitados:', comparativosRes.reason?.message);
  if (localizacaoRes.status === 'rejected') console.warn('[Precificador] Localização rejeitada:', localizacaoRes.reason?.message);

  // Preço base pelo FipeZAP
  let precoM2Base = fipezap.precoMedioM2;

  // Se tiver comparativos reais, pondera 60% mercado local + 40% FipeZAP
  if (comparativos.precoMedioM2) {
    precoM2Base = Math.round(
      (comparativos.precoMedioM2 * 0.6) + (fipezap.precoMedioM2 * 0.4)
    );
  }

  // Multiplicador de bairro: ajusta o baseline da cidade para o bairro específico.
  // Setor Bueno em Goiânia vale muito mais que Vila Brasília, mesmo na mesma cidade.
  const bairroInfo = getMultiplicadorBairro(cidade, bairro);
  if (bairroInfo.conhecido) {
    precoM2Base = Math.round(precoM2Base * bairroInfo.mult);
  }

  // Ajustes por características do imóvel
  const ajustes = calcularAjustes(dadosImovel);

  // Ajuste de localização via Google Places
  const multLocalizacao = localizacao ? localizacao.multiplicador.fator : 1.0;
  const descLocalizacao = localizacao ? localizacao.multiplicador.descricao : null;

  const precoM2Ajustado = Math.round(precoM2Base * ajustes.fator * multLocalizacao);

  // Faixa final
  const precoRecomendado = Math.round(precoM2Ajustado * metragem);
  const precoMinimo = Math.round(precoRecomendado * 0.90);
  const precoMaximo = Math.round(precoRecomendado * 1.12);

  // Tempo estimado de venda/locação (liquidez)
  const liquidez = estimarLiquidez(dadosImovel, precoM2Ajustado, fipezap.precoMedioM2);

  return {
    // Faixas de preço
    precoMinimo,
    precoRecomendado,
    precoMaximo,

    // Preço por m²
    precoM2Mercado: fipezap.precoMedioM2,
    precoM2Imovel: precoM2Ajustado,

    // Comparativos
    comparativosEncontrados: comparativos.totalEncontrados || 0,
    fontesConsultadas: [fipezap.fonte, comparativos.fonte].filter(Boolean),

    // Liquidez
    tempoEstimadoDias: liquidez.dias,
    indiceLiquidez: liquidez.indicador,

    // Metadados
    ajustesAplicados: ajustes.descricao,
    fipezapData: fipezap.atualizado,
    variacao3meses: fipezap.variacao3meses,
    bairroPerfil: bairroInfo.perfil,
    bairroConhecido: bairroInfo.conhecido,
    bairroMultiplicador: bairroInfo.mult,

    // Google Places
    localizacao,
    scoreLocalizacao: localizacao?.score || null,
    descLocalizacao
  };
}

/**
 * Último recurso: se até o fallback do FipeZAP falhar (erro interno),
 * usa um valor de mercado conservador para Goiás para que o laudo
 * NUNCA quebre por falta de baseline.
 */
function fipezapEmergencia(finalidade) {
  return {
    cidade: '',
    precoMedioM2: finalidade === 'aluguel' ? 18 : 3200,
    variacao3meses: null,
    fonte: 'Referência conservadora Goiás',
    atualizado: new Date().toLocaleDateString('pt-BR'),
    isFallback: true
  };
}

/**
 * Calcula fator de ajuste baseado nas características do imóvel
 */
function calcularAjustes(dados) {
  const { tipo, conservacao, vagas, diferenciais, quartos, metragem } = dados;
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

  // Terreno — sem ajuste por quartos
  if (tipo === 'terreno') {
    return { fator: fator * 0.75, descricao: [...descricao, '-25% terreno (sem construção)'] };
  }

  return { fator, descricao };
}

/**
 * Estima o tempo de liquidez baseado no posicionamento de preço
 */
function estimarLiquidez(dados, precoM2Imovel, precoM2Mercado) {
  const { finalidade, tipo } = dados;
  const ratio = precoM2Imovel / precoM2Mercado;

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
