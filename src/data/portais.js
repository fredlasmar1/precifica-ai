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

  // Busca real via ScraperAPI. VivaReal/ZAP (JSON-LD, ~30 anúncios cada) +
  // OLX/Imovelweb (best-effort — se o parser falhar, allSettled ignora).
  const resultados = await Promise.allSettled([
    buscarVivaReal(dados),
    buscarZAP(dados),
    buscarOLX(dados),
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

  // Dedup: VivaReal e ZAP são do mesmo grupo e repetem o mesmo anúncio.
  const vistos = new Set();
  const unicos = todosImoveis.filter(i => {
    const k = `${i.area}_${i.preco}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
  console.log(`[Portais] ${todosImoveis.length} anúncios (${fontesUsadas.join('+')}) → ${unicos.length} únicos`);

  const resultado = montarResultado(unicos, fontesUsadas, dados);
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

    // Slugs de tipo no padrão atual do VivaReal (/.../bairros/<bairro>/<tipo>/)
    const tipoMap = {
      'casa': 'casa_residencial',
      'apartamento': 'apartamento_residencial',
      'terreno': 'lote-terreno_residencial',
      'comercial': 'conjunto-comercial-sala_comercial'
    };
    const tipoSlug = tipoMap[tipo] || 'casa_residencial';
    const finalidadeSlug = finalidade === 'aluguel' ? 'aluguel' : 'venda';
    const cidadeSlug = slugify(cidade);
    const bairroSlug = slugify(bairro);

    const url = `https://www.vivareal.com.br/${finalidadeSlug}/goias/${cidadeSlug}/bairros/${bairroSlug}/${tipoSlug}/`;

    const html = await fetchHtml(url, 'VivaReal');

    // Extrai anúncios reais do JSON-LD (ItemList de House/Apartment)
    let imoveis = extrairListingsJsonLD(html, 'VivaReal');
    if (imoveis.length > 0) {
      console.log(`[VivaReal] ${imoveis.length} anúncios reais extraídos (JSON-LD)`);
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

    const tipoMap = { 'casa': 'casas', 'apartamento': 'apartamentos', 'terreno': 'lotes-terrenos', 'comercial': 'imoveis-comerciais' };
    const tipoSlug = tipoMap[tipo] || 'casas';
    const finalidadeSlug = finalidade === 'aluguel' ? 'aluguel' : 'venda';
    const cidadeSlug = slugify(cidade);
    const bairroSlug = slugify(bairro);

    // ZAP: /<finalidade>/<tipo>/go+<cidade>++<bairro>/
    const url = `https://www.zapimoveis.com.br/${finalidadeSlug}/${tipoSlug}/go+${cidadeSlug}++${bairroSlug}/`;

    const html = await fetchHtml(url, 'ZAP');
    const imoveis = extrairListingsJsonLD(html, 'ZAP');
    if (imoveis.length > 0) console.log(`[ZAP] ${imoveis.length} anúncios reais extraídos (JSON-LD)`);

    if (imoveis.length === 0) return null;
    return { fonte: 'ZAP', imoveis };

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

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

/** Extrai o preço de um campo offers (objeto, array, ou com priceSpecification). */
function extrairOfferPrice(offers) {
  if (!offers) return null;
  const arr = Array.isArray(offers) ? offers : [offers];
  for (const o of arr) {
    if (!o) continue;
    if (o.price) return num(o.price);
    const ps = o.priceSpecification?.price || o.potentialAction?.priceSpecification?.price;
    if (ps) return num(ps);
  }
  return null;
}

/**
 * Extrai anúncios reais do JSON-LD (ItemList de House/Apartment) — funciona
 * para VivaReal e ZAP (mesmo grupo, mesma estrutura schema.org).
 * Preço: offers.price (estruturado) → URL (...RS650000...) → name (R$ ...).
 * Área: floorSize.value → name "X m²" → URL "Xm2".  Quartos: numberOfBedrooms.
 */
function extrairListingsJsonLD(html, fonte) {
  const imoveis = [];
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const lists = Array.isArray(data) ? data : [data];
    for (const d of lists) {
      if (!d || d['@type'] !== 'ItemList' || !Array.isArray(d.itemListElement)) continue;
      for (const el of d.itemListElement) {
        const item = el.item || {};
        const name = item.name || '';
        const url = item.url || '';

        let area = num(item.floorSize?.value);
        if (!area) { const ma = name.match(/(\d+)\s*m²/) || url.match(/(\d+)m2/); area = ma ? parseInt(ma[1], 10) : null; }

        let preco = extrairOfferPrice(item.offers);
        if (!preco) { const mp = url.match(/RS(\d+)/i) || name.match(/R\$\s?([\d.]+)/); preco = mp ? parseInt(String(mp[1]).replace(/\./g, ''), 10) : null; }

        let quartos = item.numberOfBedrooms != null ? num(item.numberOfBedrooms) : null;
        if (quartos == null) { const mq = name.match(/(\d+)\s*quartos?/i); quartos = mq ? parseInt(mq[1], 10) : null; }

        if (area > 0 && preco > 1000) {
          imoveis.push({ preco: Math.round(preco), area: Math.round(area), precoM2: Math.round(preco / area), quartos, url, fonte });
        }
      }
    }
  }
  return imoveis;
}

function mediana(arr) {
  if (!arr || !arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function montarResultado(imoveis, fontes, dados = {}) {
  const { metragem, tipo, finalidade } = dados;

  // Filtro de sanidade: descarta R$/m² absurdo (erro de parsing / anúncio quebrado)
  const faixas = {
    venda:   { terreno: [80, 8000], default: [800, 25000] },
    aluguel: { terreno: [1, 60],    default: [5, 200] }
  };
  const fx = faixas[finalidade] || faixas.venda;
  const lim = tipo === 'terreno' ? fx.terreno : fx.default;
  let usados = imoveis.filter(i => i.precoM2 >= lim[0] && i.precoM2 <= lim[1]);
  const descartados = imoveis.length - usados.length;
  if (descartados > 0) console.log(`[Sanidade] ${descartados} anúncio(s) fora da faixa R$${lim[0]}-${lim[1]}/m² descartado(s)`);

  // Filtro por área similar ao imóvel avaliado (amostragem comparável)
  if (metragem > 0 && usados.length >= 5) {
    let sim;
    if (tipo === 'casa' && metragem > 250) {
      // casa grande: aceita casas até 3x maiores e qualquer menor do bairro
      sim = usados.filter(i => !i.area || i.area <= metragem * 3);
    } else {
      sim = usados.filter(i => !i.area || Math.abs(i.area - metragem) / metragem <= 0.6);
    }
    if (sim.length >= 4) usados = sim;
  }

  const precos = usados.map(i => i.preco).filter(Boolean);
  const precosM2 = usados.map(i => i.precoM2).filter(Boolean);
  const precosM2Filtrados = removerOutliers(precosM2);
  const base = precosM2Filtrados.length >= 3 ? precosM2Filtrados : precosM2;

  return {
    fonte: [...new Set(fontes)].join(' + '),
    totalEncontrados: usados.length,
    precoMinimo: precos.length ? Math.min(...precos) : null,
    precoMaximo: precos.length ? Math.max(...precos) : null,
    precoMedio: precos.length ? Math.round(precos.reduce((a, b) => a + b, 0) / precos.length) : null,
    precoMedioM2: mediana(base),   // MEDIANA (robusta a outlier), não média
    faixaMinM2: base.length ? Math.min(...base) : null,
    faixaMaxM2: base.length ? Math.max(...base) : null,
    imoveis: usados.slice(0, 12),
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
