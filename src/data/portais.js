const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

// Cache de 6h para comparativos de mercado
const cache = new NodeCache({ stdTTL: 21600 });

const HTTP_TIMEOUT_MS = 12000;

/**
 * Busca imóveis comparáveis no ZAP Imóveis
 * Fluxo: cache → scraping ZAP → fallback de estimativa
 */
async function buscarComparativos(dados) {
  const { tipo, finalidade, cidade, bairro, quartos } = dados;
  const cacheKey = `comp_${tipo}_${finalidade}_${cidade}_${bairro}_${quartos}`
    .toLowerCase().replace(/\s/g, '_');

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const resultado = await buscarZAP(dados);
    if (resultado && resultado.imoveis && resultado.imoveis.length > 0) {
      cache.set(cacheKey, resultado);
      return resultado;
    }
    console.warn('[ZAP] Nenhum imóvel extraído, usando fallback');
  } catch (err) {
    console.warn('[ZAP] Erro:', err.message);
  }

  // Fallback: estimativa baseada em dados de referência de Goiás
  return gerarEstimativaComparativa(dados);
}

/**
 * Busca no ZAP Imóveis via URL pública.
 * Estratégia em camadas:
 *  1) Extrai dados do __NEXT_DATA__ (mais confiável — é um app Next.js)
 *  2) Fallback: parse do HTML com múltiplos seletores
 */
async function buscarZAP(dados) {
  const url = montarUrlZAP(dados);

  const response = await axios.get(url, {
    timeout: HTTP_TIMEOUT_MS,
    maxRedirects: 3,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      'Upgrade-Insecure-Requests': '1'
    }
  });

  const html = response.data;

  // Estratégia 1: __NEXT_DATA__ (mais robusta)
  let imoveis = extrairDoNextData(html);

  // Estratégia 2: parse de HTML com múltiplos seletores
  if (imoveis.length === 0) {
    imoveis = extrairDoHtml(html);
  }

  if (imoveis.length === 0) return null;

  return montarResultado(imoveis);
}

/**
 * Constrói a URL pública do ZAP a partir dos dados do imóvel
 */
function montarUrlZAP({ tipo, finalidade, cidade, bairro }) {
  const tipoMap = {
    'casa': 'casas',
    'apartamento': 'apartamentos',
    'terreno': 'terrenos',
    'comercial': 'comercio-e-industria'
  };
  const tipoSlug = tipoMap[tipo] || 'imoveis';
  const finalidadeSlug = finalidade === 'aluguel' ? 'aluguel' : 'venda';
  const cidadeSlug = slugify(cidade);
  const bairroSlug = slugify(bairro);

  return `https://www.zapimoveis.com.br/${finalidadeSlug}/${tipoSlug}/go+${cidadeSlug}+${bairroSlug}/`;
}

/**
 * Extrai a lista de imóveis do payload Next.js (__NEXT_DATA__).
 * O ZAP é um app Next.js — a listagem vem em JSON embutido no HTML inicial.
 */
function extrairDoNextData(html) {
  try {
    const match = html.match(
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
    );
    if (!match) return [];

    const data = JSON.parse(match[1]);
    // Caminhos conhecidos onde o ZAP guarda os listings (varia entre versões)
    const candidatos = [
      data?.props?.pageProps?.fetchListing?.search?.result?.listings,
      data?.props?.pageProps?.listings,
      data?.props?.pageProps?.initialState?.results?.listings,
      data?.props?.pageProps?.searchResult?.listings
    ];

    const listings = candidatos.find((l) => Array.isArray(l) && l.length > 0);
    if (!listings) return [];

    const imoveis = [];
    for (const item of listings.slice(0, 20)) {
      const listing = item.listing || item;
      const pricingInfo =
        (listing.pricingInfos && listing.pricingInfos[0]) || listing.pricingInfo || {};
      const preco = parseFloat(pricingInfo.price || pricingInfo.rentalTotalPrice || 0);
      const area = parseFloat(
        listing.usableAreas?.[0] || listing.totalAreas?.[0] || 0
      );

      if (preco && preco > 10000) {
        imoveis.push({
          preco: Math.round(preco),
          area: area || null,
          precoM2: area ? Math.round(preco / area) : null
        });
      }
      if (imoveis.length >= 10) break;
    }
    return imoveis;
  } catch (err) {
    console.warn('[ZAP] Falha ao extrair __NEXT_DATA__:', err.message);
    return [];
  }
}

/**
 * Fallback: parse direto do HTML.
 * Tenta múltiplos seletores conhecidos do ZAP (eles mudam com frequência).
 */
function extrairDoHtml(html) {
  const $ = cheerio.load(html);
  const imoveis = [];

  // Lista de seletores possíveis para o card do imóvel
  const cardSelectors = [
    '[data-cy="rp-property-cd"]',
    '[data-type="property"]',
    'article[data-position]',
    '.listing-card',
    '.result-card'
  ];

  let cards = $();
  for (const sel of cardSelectors) {
    cards = $(sel);
    if (cards.length > 0) break;
  }

  cards.each((i, el) => {
    if (i >= 10) return false;

    const $el = $(el);
    const precoText =
      $el.find('[data-cy="rp-cardProperty-price-txt"]').first().text().trim() ||
      $el.find('[class*="price__"]').first().text().trim() ||
      $el.find('[class*="Price"]').first().text().trim() ||
      $el.find('[class*="price"]').first().text().trim();

    const areaText =
      $el.find('[data-cy="rp-cardProperty-propertyArea-txt"]').first().text().trim() ||
      $el.find('[class*="area__"]').first().text().trim() ||
      $el.find('[class*="Area"]').first().text().trim() ||
      $el.find('[class*="area"]').first().text().trim();

    const preco = extrairNumero(precoText);
    const area = extrairNumero(areaText);

    if (preco && preco > 10000) {
      imoveis.push({
        preco,
        area,
        precoM2: area ? Math.round(preco / area) : null
      });
    }
  });

  return imoveis;
}

function montarResultado(imoveis) {
  const precos = imoveis.map((i) => i.preco).filter(Boolean);
  const precosM2 = imoveis.map((i) => i.precoM2).filter(Boolean);

  return {
    fonte: 'ZAP Imóveis',
    totalEncontrados: imoveis.length,
    precoMinimo: Math.min(...precos),
    precoMaximo: Math.max(...precos),
    precoMedio: Math.round(precos.reduce((a, b) => a + b, 0) / precos.length),
    precoMedioM2:
      precosM2.length > 0
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

  const precoBase = precoM2 * (metragem || 1);

  return {
    fonte: 'Estimativa de mercado Goiás',
    totalEncontrados: 0,
    precoMinimo: Math.round(precoBase * 0.88),
    precoMaximo: Math.round(precoBase * 1.12),
    precoMedio: Math.round(precoBase),
    precoMedioM2: precoM2,
    imoveis: [],
    isEstimativa: true
  };
}

function slugify(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function extrairNumero(texto) {
  if (!texto) return null;
  // Remove tudo que não é dígito (preços vêm com R$, pontos, etc.)
  const num = texto.replace(/[^\d]/g, '');
  return num ? parseInt(num, 10) : null;
}

module.exports = { buscarComparativos };
