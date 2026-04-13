const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

// Cache de 6h para comparativos
const cache = new NodeCache({ stdTTL: 21600 });

const DIRECT_TIMEOUT = 12000;
const PROXY_TIMEOUT = 45000;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache'
};

// ─── Entrada principal ───────────────────────────────────────────────

/**
 * Busca comparativos de mercado em TODOS os portais em paralelo.
 * Combina os resultados de quem responder.
 * Retorna null se nenhum portal retornar dados (para o GPT-4o assumir).
 */
async function buscarComparativos(dados) {
  const { tipo, finalidade, cidade, bairro, quartos } = dados;
  const cacheKey = `comp_${tipo}_${finalidade}_${cidade}_${bairro}_${quartos}`
    .toLowerCase().replace(/\s/g, '_');

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Busca em todos os portais ao mesmo tempo
  const resultados = await Promise.allSettled([
    buscarOLX(dados),
    buscarVivaReal(dados),
    buscarZAP(dados),
    buscarImovelweb(dados)
  ]);

  // Combina imóveis de todos que retornaram
  const todosImoveis = [];
  const fontesUsadas = [];

  for (const r of resultados) {
    if (r.status === 'fulfilled' && r.value && r.value.imoveis.length > 0) {
      todosImoveis.push(...r.value.imoveis);
      fontesUsadas.push(r.value.fonte);
    }
  }

  if (todosImoveis.length === 0) {
    console.warn('[Portais] Nenhum portal retornou dados reais');
    return null; // sem dados — precificador vai usar GPT-4o
  }

  const resultado = montarResultado(todosImoveis, fontesUsadas);
  cache.set(cacheKey, resultado);
  return resultado;
}

// ─── Helpers de request ──────────────────────────────────────────────

function getUrl(targetUrl) {
  const scraperKey = process.env.SCRAPER_API_KEY;
  if (scraperKey) {
    return {
      url: `http://api.scraperapi.com/?api_key=${scraperKey}&url=${encodeURIComponent(targetUrl)}&country_code=br&render=false`,
      timeout: PROXY_TIMEOUT,
      via: 'ScraperAPI'
    };
  }
  return { url: targetUrl, timeout: DIRECT_TIMEOUT, via: 'direto' };
}

async function fetchHtml(targetUrl, label) {
  const { url, timeout, via } = getUrl(targetUrl);
  const response = await axios.get(url, {
    timeout,
    maxRedirects: 3,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: BROWSER_HEADERS
  });
  console.log(`[${label}] OK via ${via} (${typeof response.data === 'string' ? response.data.length : 0} chars)`);
  return response.data;
}

// ─── OLX ─────────────────────────────────────────────────────────────

async function buscarOLX(dados) {
  try {
    const { tipo, finalidade, cidade, bairro } = dados;

    const tipoMap = {
      'casa': 'casas',
      'apartamento': 'apartamentos',
      'terreno': 'terrenos',
      'comercial': 'comercial-e-industrial'
    };
    const categoriaSlug = tipoMap[tipo] || 'imoveis';
    const operacao = finalidade === 'aluguel' ? 'aluguel' : 'venda';

    // OLX usa query string para busca
    const query = encodeURIComponent(`${categoriaSlug} ${operacao} ${bairro} ${cidade} GO`);
    const url = `https://www.olx.com.br/imoveis/estado-go?q=${query}`;

    const html = await fetchHtml(url, 'OLX');
    const $ = cheerio.load(html);
    const imoveis = [];

    // OLX embute dados no __NEXT_DATA__ (Next.js)
    const nextData = extrairNextDataGenerico(html);
    if (nextData) {
      const ads = findDeep(nextData, 'ads') || findDeep(nextData, 'adList') || [];
      for (const ad of (Array.isArray(ads) ? ads : []).slice(0, 15)) {
        const preco = extrairPrecoObjeto(ad);
        const area = extrairAreaObjeto(ad);
        if (preco && preco > 10000) {
          imoveis.push({ preco, area, precoM2: area ? Math.round(preco / area) : null });
        }
        if (imoveis.length >= 10) break;
      }
    }

    // Fallback: parse HTML
    if (imoveis.length === 0) {
      const selectors = ['[data-ds-component="DS-NewAdCard-Link"]', '.olx-ad-card', 'a[data-lurker-detail]', '.sc-12rk7z2-0'];
      let cards = $();
      for (const sel of selectors) {
        cards = $(sel);
        if (cards.length > 0) break;
      }
      cards.each((i, el) => {
        if (i >= 10) return false;
        const texto = $(el).text();
        const preco = extrairPrecoTexto(texto);
        const area = extrairAreaTexto(texto);
        if (preco && preco > 10000) {
          imoveis.push({ preco, area, precoM2: area ? Math.round(preco / area) : null });
        }
      });
    }

    if (imoveis.length === 0) return null;
    return { fonte: 'OLX', imoveis };

  } catch (err) {
    console.warn('[OLX] Erro:', err.message);
    return null;
  }
}

// ─── VivaReal ────────────────────────────────────────────────────────

async function buscarVivaReal(dados) {
  try {
    const { tipo, finalidade, cidade, bairro } = dados;

    const tipoMap = {
      'casa': 'casas',
      'apartamento': 'apartamentos',
      'terreno': 'terrenos',
      'comercial': 'comercial'
    };
    const tipoSlug = tipoMap[tipo] || 'imoveis';
    const finalidadeSlug = finalidade === 'aluguel' ? 'aluguel' : 'venda';
    const cidadeSlug = slugify(cidade);
    const bairroSlug = slugify(bairro);

    // VivaReal pertence ao mesmo grupo do ZAP (Grupo OLX/ZAP)
    const url = `https://www.vivareal.com.br/${finalidadeSlug}/goias/${cidadeSlug}/${bairroSlug}/${tipoSlug}/`;

    const html = await fetchHtml(url, 'VivaReal');
    const imoveis = [];

    // VivaReal também é Next.js
    const nextData = extrairNextDataGenerico(html);
    if (nextData) {
      const candidatos = [
        nextData?.props?.pageProps?.fetchListing?.search?.result?.listings,
        nextData?.props?.pageProps?.listings,
        nextData?.props?.pageProps?.searchResult?.listings
      ];
      const listings = candidatos.find(l => Array.isArray(l) && l.length > 0);
      if (listings) {
        for (const item of listings.slice(0, 20)) {
          const listing = item.listing || item;
          const pricingInfo = (listing.pricingInfos && listing.pricingInfos[0]) || listing.pricingInfo || {};
          const preco = parseFloat(pricingInfo.price || pricingInfo.rentalTotalPrice || 0);
          const area = parseFloat(listing.usableAreas?.[0] || listing.totalAreas?.[0] || 0);
          if (preco && preco > 10000) {
            imoveis.push({ preco: Math.round(preco), area: area || null, precoM2: area ? Math.round(preco / area) : null });
          }
          if (imoveis.length >= 10) break;
        }
      }
    }

    // Fallback HTML
    if (imoveis.length === 0) {
      const $ = cheerio.load(html);
      const selectors = ['[data-type="property"]', '.property-card__container', 'article.property-card', '.js-property-card'];
      let cards = $();
      for (const sel of selectors) {
        cards = $(sel);
        if (cards.length > 0) break;
      }
      cards.each((i, el) => {
        if (i >= 10) return false;
        const $el = $(el);
        const precoText = $el.find('[class*="price"]').first().text().trim() || $el.find('.property-card__price').text().trim();
        const areaText = $el.find('[class*="area"]').first().text().trim() || $el.find('.property-card__detail-area').text().trim();
        const preco = extrairNumero(precoText);
        const area = extrairNumero(areaText);
        if (preco && preco > 10000) {
          imoveis.push({ preco, area, precoM2: area ? Math.round(preco / area) : null });
        }
      });
    }

    if (imoveis.length === 0) return null;
    return { fonte: 'VivaReal', imoveis };

  } catch (err) {
    console.warn('[VivaReal] Erro:', err.message);
    return null;
  }
}

// ─── ZAP Imóveis ─────────────────────────────────────────────────────

async function buscarZAP(dados) {
  try {
    const { tipo, finalidade, cidade, bairro } = dados;

    const tipoMap = { 'casa': 'casas', 'apartamento': 'apartamentos', 'terreno': 'terrenos', 'comercial': 'comercio-e-industria' };
    const tipoSlug = tipoMap[tipo] || 'imoveis';
    const finalidadeSlug = finalidade === 'aluguel' ? 'aluguel' : 'venda';
    const cidadeSlug = slugify(cidade);
    const bairroSlug = slugify(bairro);

    const url = `https://www.zapimoveis.com.br/${finalidadeSlug}/${tipoSlug}/go+${cidadeSlug}+${bairroSlug}/`;

    const html = await fetchHtml(url, 'ZAP');
    const imoveis = [];

    // Next.js
    const nextData = extrairNextDataGenerico(html);
    if (nextData) {
      const candidatos = [
        nextData?.props?.pageProps?.fetchListing?.search?.result?.listings,
        nextData?.props?.pageProps?.listings,
        nextData?.props?.pageProps?.initialState?.results?.listings,
        nextData?.props?.pageProps?.searchResult?.listings
      ];
      const listings = candidatos.find(l => Array.isArray(l) && l.length > 0);
      if (listings) {
        for (const item of listings.slice(0, 20)) {
          const listing = item.listing || item;
          const pricingInfo = (listing.pricingInfos && listing.pricingInfos[0]) || listing.pricingInfo || {};
          const preco = parseFloat(pricingInfo.price || pricingInfo.rentalTotalPrice || 0);
          const area = parseFloat(listing.usableAreas?.[0] || listing.totalAreas?.[0] || 0);
          if (preco && preco > 10000) {
            imoveis.push({ preco: Math.round(preco), area: area || null, precoM2: area ? Math.round(preco / area) : null });
          }
          if (imoveis.length >= 10) break;
        }
      }
    }

    // Fallback HTML
    if (imoveis.length === 0) {
      const $ = cheerio.load(html);
      const selectors = ['[data-cy="rp-property-cd"]', '[data-type="property"]', 'article[data-position]'];
      let cards = $();
      for (const sel of selectors) {
        cards = $(sel);
        if (cards.length > 0) break;
      }
      cards.each((i, el) => {
        if (i >= 10) return false;
        const $el = $(el);
        const precoText = $el.find('[class*="price"]').first().text().trim();
        const areaText = $el.find('[class*="area"]').first().text().trim();
        const preco = extrairNumero(precoText);
        const area = extrairNumero(areaText);
        if (preco && preco > 10000) {
          imoveis.push({ preco, area, precoM2: area ? Math.round(preco / area) : null });
        }
      });
    }

    if (imoveis.length === 0) return null;
    return { fonte: 'ZAP Imóveis', imoveis };

  } catch (err) {
    console.warn('[ZAP] Erro:', err.message);
    return null;
  }
}

// ─── Imovelweb ───────────────────────────────────────────────────────

async function buscarImovelweb(dados) {
  try {
    const { tipo, finalidade, cidade, bairro } = dados;

    const tipoMap = { 'casa': 'casas', 'apartamento': 'apartamentos', 'terreno': 'terrenos', 'comercial': 'comerciais' };
    const tipoSlug = tipoMap[tipo] || 'imoveis';
    const finalidadeSlug = finalidade === 'aluguel' ? 'aluguel' : 'venda';
    const cidadeSlug = slugify(cidade);
    const bairroSlug = slugify(bairro);

    const url = `https://www.imovelweb.com.br/${tipoSlug}-${finalidadeSlug}-${bairroSlug}-${cidadeSlug}-go.html`;

    const html = await fetchHtml(url, 'Imovelweb');
    const $ = cheerio.load(html);
    const imoveis = [];

    // Imovelweb tem estrutura mais tradicional (não é Next.js)
    const selectors = ['[data-posting-type]', '.avisos-container .aviso', '.listing-item', '.postingCard'];
    let cards = $();
    for (const sel of selectors) {
      cards = $(sel);
      if (cards.length > 0) break;
    }

    cards.each((i, el) => {
      if (i >= 10) return false;
      const $el = $(el);
      const precoText =
        $el.find('[data-qa="POSTING_CARD_PRICE"]').text().trim() ||
        $el.find('.firstPrice, .precio-valor, .price').first().text().trim() ||
        $el.find('[class*="price"]').first().text().trim();
      const areaText =
        $el.find('[data-qa="POSTING_CARD_FEATURES"]').text().trim() ||
        $el.find('.postingMainFeatures, .superficie').first().text().trim() ||
        $el.find('[class*="area"]').first().text().trim();

      const preco = extrairNumero(precoText);
      const area = extrairAreaTexto(areaText) || extrairNumero(areaText);

      if (preco && preco > 10000) {
        imoveis.push({ preco, area, precoM2: area ? Math.round(preco / area) : null });
      }
    });

    // Tenta __NEXT_DATA__ também (Imovelweb pode ter migrado)
    if (imoveis.length === 0) {
      const nextData = extrairNextDataGenerico(html);
      if (nextData) {
        const listings = findDeep(nextData, 'listPostings') || findDeep(nextData, 'listingsProps') || [];
        for (const item of (Array.isArray(listings) ? listings : []).slice(0, 15)) {
          const preco = item.price?.amount || item.priceOperationTypes?.[0]?.prices?.[0]?.amount || 0;
          const area = item.totalArea || item.floorSpace || 0;
          if (preco && preco > 10000) {
            imoveis.push({ preco: Math.round(preco), area: area || null, precoM2: area ? Math.round(preco / area) : null });
          }
          if (imoveis.length >= 10) break;
        }
      }
    }

    if (imoveis.length === 0) return null;
    return { fonte: 'Imovelweb', imoveis };

  } catch (err) {
    console.warn('[Imovelweb] Erro:', err.message);
    return null;
  }
}

// ─── Utilitários ─────────────────────────────────────────────────────

function extrairNextDataGenerico(html) {
  try {
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return null;
    return JSON.parse(match[1]);
  } catch { return null; }
}

/**
 * Busca recursiva por uma chave em objeto profundo (máx 5 níveis).
 * Útil quando a estrutura do __NEXT_DATA__ varia entre portais/versões.
 */
function findDeep(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  if (obj[key] !== undefined) return obj[key];
  for (const k of Object.keys(obj)) {
    const found = findDeep(obj[k], key, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function extrairPrecoObjeto(ad) {
  // OLX guarda preço em vários formatos
  if (ad.price) return typeof ad.price === 'number' ? ad.price : extrairNumero(String(ad.price));
  if (ad.priceValue) return parseFloat(ad.priceValue);
  const props = ad.properties || [];
  for (const p of props) {
    if (p.name === 'price' && p.value) return extrairNumero(p.value);
  }
  return null;
}

function extrairAreaObjeto(ad) {
  if (ad.area) return parseFloat(ad.area);
  const props = ad.properties || [];
  for (const p of props) {
    if ((p.name === 'size' || p.name === 'area') && p.value) return parseFloat(p.value);
  }
  return null;
}

function extrairPrecoTexto(texto) {
  if (!texto) return null;
  // Captura R$ XX.XXX ou R$ X.XXX.XXX
  const match = texto.match(/R\$\s*([\d.]+)/);
  if (match) return extrairNumero(match[1]);
  return extrairNumero(texto);
}

function extrairAreaTexto(texto) {
  if (!texto) return null;
  // Captura NNN m² ou NNN m2
  const match = texto.match(/([\d.,]+)\s*m[²2]/i);
  if (match) return parseFloat(match[1].replace(',', '.'));
  return null;
}

function montarResultado(imoveis, fontes) {
  const precos = imoveis.map(i => i.preco).filter(Boolean);
  const precosM2 = imoveis.map(i => i.precoM2).filter(Boolean);

  // Remove outliers (abaixo de P10 e acima de P90) para média mais realista
  const precosM2Filtrados = removerOutliers(precosM2);

  return {
    fonte: fontes.join(' + '),
    totalEncontrados: imoveis.length,
    precoMinimo: Math.min(...precos),
    precoMaximo: Math.max(...precos),
    precoMedio: Math.round(precos.reduce((a, b) => a + b, 0) / precos.length),
    precoMedioM2: precosM2Filtrados.length > 0
      ? Math.round(precosM2Filtrados.reduce((a, b) => a + b, 0) / precosM2Filtrados.length)
      : (precosM2.length > 0 ? Math.round(precosM2.reduce((a, b) => a + b, 0) / precosM2.length) : null),
    imoveis: imoveis.slice(0, 10),
    isEstimativa: false
  };
}

function removerOutliers(arr) {
  if (arr.length < 4) return arr;
  const sorted = [...arr].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  return arr.filter(v => v >= p10 && v <= p90);
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
  const num = texto.replace(/[^\d]/g, '');
  return num ? parseInt(num, 10) : null;
}

module.exports = { buscarComparativos };
