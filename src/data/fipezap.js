const axios = require('axios');
const NodeCache = require('node-cache');

// Cache de 24h para dados do FipeZAP (não mudam todo dia)
const cache = new NodeCache({ stdTTL: 86400 });

// Mapeamento de cidades de Goiás (inclui região metropolitana de Anápolis)
const CIDADES_GO = {
  // Capital
  'goiania': 'goiania',
  'goiânia': 'goiania',
  'aparecida de goiania': 'aparecida-de-goiania',
  'aparecida de goiânia': 'aparecida-de-goiania',
  'aparecida': 'aparecida-de-goiania',
  'senador canedo': 'senador-canedo',
  'trindade': 'trindade',
  'goianira': 'goianira',
  'hidrolandia': 'hidrolandia',
  'hidrolândia': 'hidrolandia',

  // Anápolis e região (RMTC + entorno)
  'anapolis': 'anapolis',
  'anápolis': 'anapolis',
  'neropolis': 'neropolis',
  'nerópolis': 'neropolis',
  'goianapolis': 'goianapolis',
  'goianápolis': 'goianapolis',
  'damolandia': 'damolandia',
  'damolândia': 'damolandia',
  'campo limpo de goias': 'campo-limpo-de-goias',
  'campo limpo de goiás': 'campo-limpo-de-goias',
  'ouro verde de goias': 'ouro-verde-de-goias',
  'ouro verde de goiás': 'ouro-verde-de-goias',
  'petrolina de goias': 'petrolina-de-goias',
  'petrolina de goiás': 'petrolina-de-goias',
  'pirenopolis': 'pirenopolis',
  'pirenópolis': 'pirenopolis',
  'abadiania': 'abadiania',
  'abadiânia': 'abadiania',
  'corumba de goias': 'corumba-de-goias',
  'corumbá de goiás': 'corumba-de-goias',
  'cocalzinho de goias': 'cocalzinho-de-goias',
  'cocalzinho de goiás': 'cocalzinho-de-goias',
  'itauçu': 'itaucu',
  'itaucu': 'itaucu',
  'inhumas': 'inhumas',
  'jaragua': 'jaragua',
  'jaraguá': 'jaragua',

  // Outras grandes cidades
  'rio verde': 'rio-verde',
  'caldas novas': 'caldas-novas',
  'luziania': 'luziania',
  'luziânia': 'luziania',
  'itumbiara': 'itumbiara',
  'catalao': 'catalao',
  'catalão': 'catalao',
  'jatai': 'jatai',
  'jataí': 'jatai',
  'formosa': 'formosa',
  'mineiros': 'mineiros',
  'cristalina': 'cristalina',
  'planaltina': 'planaltina'
};

/**
 * Busca índice FipeZAP para uma cidade
 * Retorna preço médio por m² e variação
 */
async function getFipeZapIndex(cidade, finalidade = 'venda') {
  const cidadeNorm = cidade.toLowerCase().trim();
  const cacheKey = `fipezap_${cidadeNorm}_${finalidade}`;
  
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    // FipeZAP disponibiliza dados públicos via API do ZAP
    const tipo = finalidade === 'aluguel' ? 'rental' : 'sale';
    const url = `https://fipezap.zapimoveis.com.br/api/v1/market/${tipo}/city?citySlug=${CIDADES_GO[cidadeNorm] || cidadeNorm}`;
    
    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    const data = response.data;
    const result = {
      cidade: cidade,
      precoMedioM2: data?.averagePrice || null,
      variacao3meses: data?.variation3m || null,
      fonte: 'FipeZAP',
      atualizado: new Date().toLocaleDateString('pt-BR')
    };

    cache.set(cacheKey, result);
    return result;

  } catch (err) {
    console.warn(`[FipeZAP] Erro ao buscar dados para ${cidade}:`, err.message);
    // Fallback com dados médios conhecidos de Goiás
    return getFallbackData(cidadeNorm, finalidade);
  }
}

/**
 * Dados de referência para quando a API não responde
 * Baseado em dados públicos do mercado de Goiás (2024-2025)
 */
function getFallbackData(cidade, finalidade) {
  // Referências de mercado de Goiás (R$/m²)
  // ATENÇÃO: revisar trimestralmente — valores aproximados
  const referencia = {
    venda: {
      // Capital e RM Goiânia
      'goiania':              { precoMedioM2: 5800, variacao3meses: 2.1 },
      'aparecida-de-goiania': { precoMedioM2: 3500, variacao3meses: 1.5 },
      'senador-canedo':       { precoMedioM2: 3200, variacao3meses: 1.4 },
      'trindade':             { precoMedioM2: 3100, variacao3meses: 1.6 },
      'goianira':             { precoMedioM2: 2900, variacao3meses: 1.3 },
      'hidrolandia':          { precoMedioM2: 2800, variacao3meses: 1.5 },

      // Anápolis e região
      'anapolis':             { precoMedioM2: 4100, variacao3meses: 1.9 },
      'neropolis':            { precoMedioM2: 3000, variacao3meses: 1.6 },
      'goianapolis':          { precoMedioM2: 2700, variacao3meses: 1.4 },
      'damolandia':           { precoMedioM2: 2500, variacao3meses: 1.2 },
      'campo-limpo-de-goias': { precoMedioM2: 2600, variacao3meses: 1.3 },
      'ouro-verde-de-goias':  { precoMedioM2: 2400, variacao3meses: 1.2 },
      'petrolina-de-goias':   { precoMedioM2: 2500, variacao3meses: 1.3 },
      'pirenopolis':          { precoMedioM2: 4500, variacao3meses: 2.8 }, // turismo
      'abadiania':            { precoMedioM2: 2700, variacao3meses: 1.5 },
      'corumba-de-goias':     { precoMedioM2: 2400, variacao3meses: 1.3 },
      'cocalzinho-de-goias':  { precoMedioM2: 2300, variacao3meses: 1.2 },
      'itaucu':               { precoMedioM2: 2400, variacao3meses: 1.2 },
      'inhumas':              { precoMedioM2: 3000, variacao3meses: 1.4 },
      'jaragua':              { precoMedioM2: 2900, variacao3meses: 1.5 },

      // Outras grandes cidades
      'rio-verde':            { precoMedioM2: 4400, variacao3meses: 2.3 },
      'caldas-novas':         { precoMedioM2: 4900, variacao3meses: 3.1 },
      'luziania':             { precoMedioM2: 3300, variacao3meses: 1.7 },
      'itumbiara':            { precoMedioM2: 3500, variacao3meses: 1.6 },
      'catalao':              { precoMedioM2: 3800, variacao3meses: 1.8 },
      'jatai':                { precoMedioM2: 3700, variacao3meses: 1.7 },
      'formosa':              { precoMedioM2: 3100, variacao3meses: 1.5 },
      'mineiros':             { precoMedioM2: 3400, variacao3meses: 1.6 },
      'cristalina':           { precoMedioM2: 3000, variacao3meses: 1.4 },
      'planaltina':           { precoMedioM2: 2900, variacao3meses: 1.3 },

      'default':              { precoMedioM2: 3000, variacao3meses: 1.5 }
    },
    aluguel: {
      // Capital e RM Goiânia
      'goiania':              { precoMedioM2: 32, variacao3meses: 1.9 },
      'aparecida-de-goiania': { precoMedioM2: 19, variacao3meses: 1.2 },
      'senador-canedo':       { precoMedioM2: 17, variacao3meses: 1.1 },
      'trindade':             { precoMedioM2: 16, variacao3meses: 1.2 },
      'goianira':             { precoMedioM2: 15, variacao3meses: 1.0 },
      'hidrolandia':          { precoMedioM2: 14, variacao3meses: 1.1 },

      // Anápolis e região
      'anapolis':             { precoMedioM2: 23, variacao3meses: 1.5 },
      'neropolis':            { precoMedioM2: 16, variacao3meses: 1.2 },
      'goianapolis':          { precoMedioM2: 14, variacao3meses: 1.1 },
      'damolandia':           { precoMedioM2: 13, variacao3meses: 1.0 },
      'campo-limpo-de-goias': { precoMedioM2: 14, variacao3meses: 1.0 },
      'ouro-verde-de-goias':  { precoMedioM2: 12, variacao3meses: 0.9 },
      'petrolina-de-goias':   { precoMedioM2: 13, variacao3meses: 1.0 },
      'pirenopolis':          { precoMedioM2: 28, variacao3meses: 2.5 }, // turismo
      'abadiania':            { precoMedioM2: 15, variacao3meses: 1.2 },
      'corumba-de-goias':     { precoMedioM2: 13, variacao3meses: 1.0 },
      'cocalzinho-de-goias':  { precoMedioM2: 12, variacao3meses: 0.9 },
      'itaucu':               { precoMedioM2: 13, variacao3meses: 1.0 },
      'inhumas':              { precoMedioM2: 16, variacao3meses: 1.2 },
      'jaragua':              { precoMedioM2: 15, variacao3meses: 1.2 },

      // Outras grandes cidades
      'rio-verde':            { precoMedioM2: 25, variacao3meses: 2.0 },
      'caldas-novas':         { precoMedioM2: 29, variacao3meses: 2.8 },
      'luziania':             { precoMedioM2: 18, variacao3meses: 1.4 },
      'itumbiara':            { precoMedioM2: 19, variacao3meses: 1.3 },
      'catalao':              { precoMedioM2: 21, variacao3meses: 1.5 },
      'jatai':                { precoMedioM2: 20, variacao3meses: 1.4 },
      'formosa':              { precoMedioM2: 17, variacao3meses: 1.2 },
      'mineiros':             { precoMedioM2: 18, variacao3meses: 1.3 },
      'cristalina':           { precoMedioM2: 16, variacao3meses: 1.1 },
      'planaltina':           { precoMedioM2: 15, variacao3meses: 1.0 },

      'default':              { precoMedioM2: 16, variacao3meses: 1.2 }
    }
  };

  const tipo = finalidade === 'aluguel' ? 'aluguel' : 'venda';
  const cidadeKey = CIDADES_GO[cidade] || 'default';
  const dados = referencia[tipo][cidadeKey] || referencia[tipo]['default'];

  return {
    cidade,
    precoMedioM2: dados.precoMedioM2,
    variacao3meses: dados.variacao3meses,
    fonte: 'Referência de mercado Goiás',
    atualizado: new Date().toLocaleDateString('pt-BR'),
    isFallback: true
  };
}

module.exports = { getFipeZapIndex };
