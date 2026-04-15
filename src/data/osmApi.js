const axios = require('axios');

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/**
 * OpenStreetMap (Overpass API) — Mapeamento detalhado de infraestrutura.
 * Gratuita, sem chave. Muito mais detalhado que Google Places para
 * mapeamento em massa.
 *
 * Retorna: comércios, serviços, escolas, hospitais, ruas,
 * transporte público, praças, bancos — tudo por coordenada/raio.
 */

/**
 * Busca infraestrutura completa num raio ao redor de um ponto.
 * Retorna contagem e exemplos por categoria.
 */
async function mapearInfraestrutura(lat, lng, raioMetros = 1000) {
  const query = `
    [out:json][timeout:30];
    (
      // Comércio
      node["shop"](around:${raioMetros},${lat},${lng});
      way["shop"](around:${raioMetros},${lat},${lng});
      // Alimentação
      node["amenity"="restaurant"](around:${raioMetros},${lat},${lng});
      node["amenity"="cafe"](around:${raioMetros},${lat},${lng});
      node["amenity"="fast_food"](around:${raioMetros},${lat},${lng});
      node["amenity"="bar"](around:${raioMetros},${lat},${lng});
      // Saúde
      node["amenity"="hospital"](around:${raioMetros},${lat},${lng});
      node["amenity"="clinic"](around:${raioMetros},${lat},${lng});
      node["amenity"="pharmacy"](around:${raioMetros},${lat},${lng});
      node["amenity"="dentist"](around:${raioMetros},${lat},${lng});
      // Educação
      node["amenity"="school"](around:${raioMetros},${lat},${lng});
      node["amenity"="university"](around:${raioMetros},${lat},${lng});
      node["amenity"="kindergarten"](around:${raioMetros},${lat},${lng});
      // Financeiro
      node["amenity"="bank"](around:${raioMetros},${lat},${lng});
      node["amenity"="atm"](around:${raioMetros},${lat},${lng});
      // Transporte
      node["highway"="bus_stop"](around:${raioMetros},${lat},${lng});
      node["amenity"="fuel"](around:${raioMetros},${lat},${lng});
      node["amenity"="parking"](around:${raioMetros},${lat},${lng});
      // Lazer
      node["leisure"="park"](around:${raioMetros},${lat},${lng});
      node["leisure"="playground"](around:${raioMetros},${lat},${lng});
      node["leisure"="fitness_centre"](around:${raioMetros},${lat},${lng});
      // Público
      node["amenity"="place_of_worship"](around:${raioMetros},${lat},${lng});
      node["amenity"="post_office"](around:${raioMetros},${lat},${lng});
      node["amenity"="police"](around:${raioMetros},${lat},${lng});
      node["amenity"="fire_station"](around:${raioMetros},${lat},${lng});
    );
    out body;
  `;

  try {
    const response = await axios.post(OVERPASS_URL, `data=${encodeURIComponent(query)}`, {
      timeout: 35000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const elements = response.data?.elements || [];
    return classificarElementos(elements);
  } catch (err) {
    console.error('[OSM] Erro:', err.message);
    return null;
  }
}

/**
 * Classifica os elementos do OSM em categorias úteis para o mercado imobiliário.
 */
function classificarElementos(elements) {
  const categorias = {
    comercio: { total: 0, tipos: {}, exemplos: [] },
    alimentacao: { total: 0, tipos: {}, exemplos: [] },
    saude: { total: 0, tipos: {}, exemplos: [] },
    educacao: { total: 0, tipos: {}, exemplos: [] },
    financeiro: { total: 0, tipos: {}, exemplos: [] },
    transporte: { total: 0, tipos: {}, exemplos: [] },
    lazer: { total: 0, tipos: {}, exemplos: [] },
    servicos_publicos: { total: 0, tipos: {}, exemplos: [] }
  };

  for (const el of elements) {
    const tags = el.tags || {};
    const nome = tags.name || tags.brand || null;

    // Comércio (shop=*)
    if (tags.shop) {
      categorias.comercio.total++;
      categorias.comercio.tipos[tags.shop] = (categorias.comercio.tipos[tags.shop] || 0) + 1;
      if (nome && categorias.comercio.exemplos.length < 5) categorias.comercio.exemplos.push(nome);
    }

    // Alimentação
    if (['restaurant', 'cafe', 'fast_food', 'bar'].includes(tags.amenity)) {
      categorias.alimentacao.total++;
      categorias.alimentacao.tipos[tags.amenity] = (categorias.alimentacao.tipos[tags.amenity] || 0) + 1;
      if (nome && categorias.alimentacao.exemplos.length < 5) categorias.alimentacao.exemplos.push(nome);
    }

    // Saúde
    if (['hospital', 'clinic', 'pharmacy', 'dentist'].includes(tags.amenity)) {
      categorias.saude.total++;
      categorias.saude.tipos[tags.amenity] = (categorias.saude.tipos[tags.amenity] || 0) + 1;
      if (nome && categorias.saude.exemplos.length < 5) categorias.saude.exemplos.push(nome);
    }

    // Educação
    if (['school', 'university', 'kindergarten'].includes(tags.amenity)) {
      categorias.educacao.total++;
      categorias.educacao.tipos[tags.amenity] = (categorias.educacao.tipos[tags.amenity] || 0) + 1;
      if (nome && categorias.educacao.exemplos.length < 5) categorias.educacao.exemplos.push(nome);
    }

    // Financeiro
    if (['bank', 'atm'].includes(tags.amenity)) {
      categorias.financeiro.total++;
      categorias.financeiro.tipos[tags.amenity] = (categorias.financeiro.tipos[tags.amenity] || 0) + 1;
      if (nome && categorias.financeiro.exemplos.length < 5) categorias.financeiro.exemplos.push(nome);
    }

    // Transporte
    if (tags.highway === 'bus_stop' || ['fuel', 'parking'].includes(tags.amenity)) {
      categorias.transporte.total++;
      const tipo = tags.highway === 'bus_stop' ? 'bus_stop' : tags.amenity;
      categorias.transporte.tipos[tipo] = (categorias.transporte.tipos[tipo] || 0) + 1;
      if (nome && categorias.transporte.exemplos.length < 5) categorias.transporte.exemplos.push(nome);
    }

    // Lazer
    if (tags.leisure) {
      categorias.lazer.total++;
      categorias.lazer.tipos[tags.leisure] = (categorias.lazer.tipos[tags.leisure] || 0) + 1;
      if (nome && categorias.lazer.exemplos.length < 5) categorias.lazer.exemplos.push(nome);
    }

    // Serviços públicos
    if (['place_of_worship', 'post_office', 'police', 'fire_station'].includes(tags.amenity)) {
      categorias.servicos_publicos.total++;
      categorias.servicos_publicos.tipos[tags.amenity] = (categorias.servicos_publicos.tipos[tags.amenity] || 0) + 1;
      if (nome && categorias.servicos_publicos.exemplos.length < 5) categorias.servicos_publicos.exemplos.push(nome);
    }
  }

  // Score de urbanização (0-100)
  const totalPontos = Object.values(categorias).reduce((s, c) => s + c.total, 0);
  const score = Math.min(100, Math.round(totalPontos * 1.5));

  // Perfil do local
  let perfil = 'residencial';
  if (categorias.comercio.total >= 20 && categorias.alimentacao.total >= 10) perfil = 'comercial forte';
  else if (categorias.comercio.total >= 10 || categorias.alimentacao.total >= 5) perfil = 'misto';
  else if (totalPontos < 10) perfil = 'residencial isolado';

  // Vocação
  const vocacoes = [];
  if (categorias.comercio.total >= 15) vocacoes.push('comércio');
  if (categorias.alimentacao.total >= 8) vocacoes.push('gastronomia');
  if (categorias.saude.total >= 5) vocacoes.push('saúde');
  if (categorias.educacao.total >= 3) vocacoes.push('educação');
  if (categorias.financeiro.total >= 3) vocacoes.push('financeiro');

  return {
    totalEstabelecimentos: totalPontos,
    scoreUrbanizacao: score,
    perfil,
    vocacoes,
    categorias,
    resumo: gerarResumo(categorias, perfil, score, vocacoes)
  };
}

function gerarResumo(categorias, perfil, score, vocacoes) {
  const parts = [];
  parts.push(`Região ${perfil} (score urbanização: ${score}/100).`);

  if (vocacoes.length > 0) {
    parts.push(`Vocação: ${vocacoes.join(', ')}.`);
  }

  const destaques = [];
  if (categorias.comercio.total > 0) destaques.push(`${categorias.comercio.total} comércios`);
  if (categorias.alimentacao.total > 0) destaques.push(`${categorias.alimentacao.total} restaurantes/bares`);
  if (categorias.saude.total > 0) destaques.push(`${categorias.saude.total} saúde`);
  if (categorias.educacao.total > 0) destaques.push(`${categorias.educacao.total} escolas`);
  if (categorias.financeiro.total > 0) destaques.push(`${categorias.financeiro.total} bancos/caixas`);
  if (categorias.transporte.total > 0) destaques.push(`${categorias.transporte.total} transporte`);

  if (destaques.length > 0) {
    parts.push(`No raio de 1km: ${destaques.join(', ')}.`);
  }

  return parts.join(' ');
}

/**
 * Busca as ruas principais de um bairro via OpenStreetMap.
 */
async function buscarRuasPrincipais(lat, lng, raioMetros = 1500) {
  const query = `
    [out:json][timeout:20];
    (
      way["highway"~"primary|secondary|tertiary"](around:${raioMetros},${lat},${lng});
    );
    out tags;
  `;

  try {
    const response = await axios.post(OVERPASS_URL, `data=${encodeURIComponent(query)}`, {
      timeout: 25000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const ruas = [];
    for (const el of (response.data?.elements || [])) {
      if (el.tags?.name && !ruas.includes(el.tags.name)) {
        ruas.push(el.tags.name);
      }
    }
    return ruas.slice(0, 15);
  } catch (err) {
    console.warn('[OSM] Erro buscar ruas:', err.message);
    return [];
  }
}

module.exports = { mapearInfraestrutura, buscarRuasPrincipais };
