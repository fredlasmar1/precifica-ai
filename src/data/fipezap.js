const axios = require('axios');
const NodeCache = require('node-cache');

// Cache de 24h para dados do FipeZAP (não mudam todo dia)
const cache = new NodeCache({ stdTTL: 86400 });

// Mapeamento de cidades de Goiás para IDs do FipeZAP
const CIDADES_GO = {
  'goiania': 'goiania',
  'goiânia': 'goiania',
  'anapolis': 'anapolis',
  'anápolis': 'anapolis',
  'aparecida de goiania': 'aparecida-de-goiania',
  'aparecida de goiânia': 'aparecida-de-goiania',
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
  'senador canedo': 'senador-canedo',
  'trindade': 'trindade'
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
  const referencia = {
    venda: {
      'goiania': { precoMedioM2: 5800, variacao3meses: 2.1 },
      'anapolis': { precoMedioM2: 3900, variacao3meses: 1.8 },
      'aparecida-de-goiania': { precoMedioM2: 3500, variacao3meses: 1.5 },
      'rio-verde': { precoMedioM2: 4200, variacao3meses: 2.3 },
      'caldas-novas': { precoMedioM2: 4800, variacao3meses: 3.1 },
      'default': { precoMedioM2: 3200, variacao3meses: 1.5 }
    },
    aluguel: {
      'goiania': { precoMedioM2: 32, variacao3meses: 1.9 },
      'anapolis': { precoMedioM2: 22, variacao3meses: 1.4 },
      'aparecida-de-goiania': { precoMedioM2: 19, variacao3meses: 1.2 },
      'rio-verde': { precoMedioM2: 24, variacao3meses: 2.0 },
      'caldas-novas': { precoMedioM2: 28, variacao3meses: 2.8 },
      'default': { precoMedioM2: 18, variacao3meses: 1.3 }
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
