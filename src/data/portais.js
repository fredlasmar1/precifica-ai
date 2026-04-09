const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

// Cache de 6h para comparativos de mercado
const cache = new NodeCache({ stdTTL: 21600 });

/**
 * Busca imóveis comparáveis no ZAP Imóveis
 */
async function buscarComparativos(dados) {
  const { tipo, finalidade, cidade, bairro, metragem, quartos } = dados;
  const cacheKey = `comp_${tipo}_${finalidade}_${cidade}_${bairro}_${quartos}`.toLowerCase().replace(/\s/g, '_');

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const resultado = await buscarZAP(dados);
    if (resultado && resultado.imoveis.length > 0) {
      cache.set(cacheKey, resultado);
      return resultado;
    }
  } catch (err) {
    console.warn('[ZAP] Erro:', err.message);
  }

  // Fallback: estimativa baseada em dados de mercado
  return gerarEstimativaComparativa(dados);
}

/**
 * Busca no ZAP Imóveis via URL pública
 */
async function buscarZAP(dados) {
  const { tipo, finalidade, cidade, bairro, quartos, metragem } = dados;

  const tipoMap = {
    'casa': 'casas',
    'apartamento': 'apartamentos',
    'terreno': 'terrenos',
    'comercial': 'comercio-e-industria'
  };

  const finalidadeMap = {
    'venda': 'venda',
    'aluguel': 'aluguel'
  };

  const tipoSlug = tipoMap[tipo] || 'imoveis';
  const finalidadeSlug = finalidadeMap[finalidade] || 'venda';
  const cidadeSlug = cidade.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-');
  const bairroSlug = bairro.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-');

  const url = `https://www.zapimoveis.com.br/${finalidadeSlug}/${tipoSlug}/go+${cidadeSlug}+${bairroSlug}/`;

  const response = await axios.get(url, {
    timeout: 10000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });

  const $ = cheerio.load(response.data);
  const imoveis = [];

  // Extrai cards de imóveis da página
  $('[data-type="property"]').each((i, el) => {
    if (i >= 10) return false; // Limita a 10 comparativos

    const precoText = $(el).find('[class*="price"]').first().text().trim();
    const areaText = $(el).find('[class*="area"]').first().text().trim();
    
    const preco = extrairNumero(precoText);
    const area = extrairNumero(areaText);

    if (preco && preco > 10000) {
      imoveis.push({ preco, area, precoM2: area ? Math.round(preco / area) : null });
    }
  });

  if (imoveis.length === 0) return null;

  const precos = imoveis.map(i => i.preco).filter(Boolean);
  const precosM2 = imoveis.map(i => i.precoM2).filter(Boolean);

  return {
    fonte: 'ZAP Imóveis',
    totalEncontrados: imoveis.length,
    precoMinimo: Math.min(...precos),
    precoMaximo: Math.max(...precos),
    precoMedio: Math.round(precos.reduce((a, b) => a + b, 0) / precos.length),
    precoMedioM2: precosM2.length > 0 
      ? Math.round(precosM2.reduce((a, b) => a + b, 0) / precosM2.length) 
      : null,
    imoveis: imoveis.slice(0, 5)
  };
}

/**
 * Estimativa baseada em dados de referência quando portais não respondem
 */
function gerarEstimativaComparativa(dados) {
  const { tipo, metragem, quartos, conservacao, finalidade } = dados;

  // Multiplicadores por características
  const multTipo = { 'casa': 1.0, 'apartamento': 1.05, 'terreno': 0.7, 'comercial': 1.2 };
  const multConservacao = { 'novo': 1.15, 'bom': 1.0, 'reformar': 0.82 };
  const multQuartos = quartos >= 3 ? 1.1 : quartos === 2 ? 1.0 : 0.9;

  const baseM2 = finalidade === 'aluguel' ? 22 : 4000; // Referência básica GO
  const precoM2 = Math.round(
    baseM2 *
    (multTipo[tipo] || 1.0) *
    (multConservacao[conservacao] || 1.0) *
    multQuartos
  );

  const precoBase = precoM2 * metragem;

  return {
    fonte: 'Estimativa de mercado Goiás',
    totalEncontrados: 0,
    precoMinimo: Math.round(precoBase * 0.88),
    precoMaximo: Math.round(precoBase * 1.12),
    precoMedio: Math.round(precoBase),
    precoMedioM2: precoM2,
    isEstimativa: true
  };
}

function extrairNumero(texto) {
  if (!texto) return null;
  const num = texto.replace(/[^\d]/g, '');
  return num ? parseInt(num) : null;
}

module.exports = { buscarComparativos };
