const { mapearInfraestrutura, buscarRuasPrincipais } = require('./osmApi');
const { getDadosMunicipio, getRendaMunicipio } = require('./ibgeApi');
const { mapearPerfilComercial, getCodigoMunicipio } = require('./brasilApi');
const db = require('./database');

/**
 * GURU IMOBILIÁRIO — Motor de inteligência que combina todas as APIs
 * para construir um perfil completo de bairro/rua.
 *
 * Chamado pelo precificador quando tem coordenadas (após geoValidação).
 * Salva tudo no Postgres para enriquecer consultas futuras.
 *
 * Fontes:
 * - OpenStreetMap: comércios, serviços, ruas (mapeamento detalhado)
 * - IBGE: população, renda, PIB
 * - BrasilAPI: CEPs, ruas do bairro
 * - Google Maps: já feito pelo geoValidação
 */

// Cache em memória para evitar repetir no mesmo request
const memCache = {};

/**
 * Gera o perfil completo de um local (bairro + rua).
 * Retorna contexto enriquecido para o prompt da Perplexity e laudo.
 */
async function perfilarLocal(cidade, bairro, lat, lng) {
  const cacheKey = `guru_${cidade}_${bairro}`.toLowerCase().replace(/\s/g, '_');
  if (memCache[cacheKey] && (Date.now() - memCache[cacheKey].ts < 86400000)) {
    return memCache[cacheKey].data;
  }

  console.log(`[Guru] Perfilando ${bairro}, ${cidade}...`);

  // Busca paralela em todas as APIs
  const [osmRes, ibgeRes, brasilRes, ruasRes] = await Promise.allSettled([
    lat && lng ? mapearInfraestrutura(lat, lng, 1000) : Promise.resolve(null),
    getCodigoMunicipio(cidade).then(cod => cod ? getDadosMunicipio(cod) : null),
    mapearPerfilComercial(cidade, bairro),
    lat && lng ? buscarRuasPrincipais(lat, lng) : Promise.resolve([])
  ]);

  const osm = osmRes.status === 'fulfilled' ? osmRes.value : null;
  const ibge = ibgeRes.status === 'fulfilled' ? ibgeRes.value : null;
  const brasil = brasilRes.status === 'fulfilled' ? brasilRes.value : null;
  const ruas = ruasRes.status === 'fulfilled' ? ruasRes.value : [];

  // Monta perfil combinado
  const perfil = {
    bairro,
    cidade,

    // OpenStreetMap
    infraestrutura: osm ? {
      total: osm.totalEstabelecimentos,
      score: osm.scoreUrbanizacao,
      perfil: osm.perfil,
      vocacoes: osm.vocacoes,
      comercio: osm.categorias?.comercio?.total || 0,
      alimentacao: osm.categorias?.alimentacao?.total || 0,
      saude: osm.categorias?.saude?.total || 0,
      educacao: osm.categorias?.educacao?.total || 0,
      financeiro: osm.categorias?.financeiro?.total || 0,
      transporte: osm.categorias?.transporte?.total || 0,
      lazer: osm.categorias?.lazer?.total || 0,
      resumo: osm.resumo,
      exemplosComercios: osm.categorias?.comercio?.exemplos || [],
      exemplosAlimentacao: osm.categorias?.alimentacao?.exemplos || [],
      exemplosSaude: osm.categorias?.saude?.exemplos || [],
    } : null,

    // IBGE
    municipio: ibge ? {
      populacao: ibge.populacao,
      pibMilhoes: ibge.pibMilhoes,
      pibPerCapita: ibge.pibPerCapita,
      microrregiao: ibge.microrregiao
    } : null,

    // BrasilAPI
    bairroInfo: brasil ? {
      totalRuas: brasil.totalRuas,
      ruas: brasil.ruas
    } : null,

    // Ruas principais (OSM)
    ruasPrincipais: ruas,

    perfiladoEm: new Date().toISOString()
  };

  // Salva no Postgres
  try {
    await db.salvarBairro({
      cidade, bairro,
      perfil: osm?.perfil || null,
      descricao: osm?.resumo || null,
      aptidao_comercial: osm?.vocacoes?.join(', ') || null,
      ruas_valorizadas: ruas.length > 0 ? ruas : (brasil?.ruas?.slice(0, 10) || null),
      pontos_referencia: [
        ...(osm?.categorias?.comercio?.exemplos || []),
        ...(osm?.categorias?.alimentacao?.exemplos || []),
        ...(osm?.categorias?.saude?.exemplos || [])
      ].slice(0, 10) || null,
      fonte: 'guru_completo'
    });
  } catch {}

  console.log(`[Guru] ${bairro}: ${osm?.totalEstabelecimentos || 0} estabelecimentos, score ${osm?.scoreUrbanizacao || 0}/100, perfil: ${osm?.perfil || '?'}`);

  memCache[cacheKey] = { data: perfil, ts: Date.now() };
  return perfil;
}

/**
 * Gera texto de contexto para o prompt da Perplexity.
 */
function gerarContextoGuru(perfil) {
  if (!perfil) return '';

  const parts = [];

  if (perfil.municipio) {
    const m = perfil.municipio;
    parts.push(`DADOS DO MUNICÍPIO (IBGE): ${perfil.cidade}-GO, população ${m.populacao?.toLocaleString() || '?'}, PIB R$ ${m.pibMilhoes || '?'} milhões, PIB per capita R$ ${m.pibPerCapita?.toLocaleString() || '?'}.`);
  }

  if (perfil.infraestrutura) {
    const i = perfil.infraestrutura;
    parts.push(`INFRAESTRUTURA DO BAIRRO ${perfil.bairro.toUpperCase()} (OpenStreetMap, raio 1km): ${i.resumo}`);
    if (i.exemplosComercios?.length) parts.push(`Comércios: ${i.exemplosComercios.join(', ')}.`);
    if (i.exemplosAlimentacao?.length) parts.push(`Alimentação: ${i.exemplosAlimentacao.join(', ')}.`);
    if (i.exemplosSaude?.length) parts.push(`Saúde: ${i.exemplosSaude.join(', ')}.`);
  }

  if (perfil.ruasPrincipais?.length) {
    parts.push(`VIAS PRINCIPAIS próximas: ${perfil.ruasPrincipais.join(', ')}.`);
  }

  if (perfil.bairroInfo?.totalRuas) {
    parts.push(`O bairro ${perfil.bairro} tem ${perfil.bairroInfo.totalRuas} ruas catalogadas.`);
  }

  return parts.join('\n');
}

/**
 * Gera seção para o laudo.
 */
function gerarSecaoLaudo(perfil) {
  if (!perfil) return '';

  let secao = '';

  if (perfil.infraestrutura) {
    const i = perfil.infraestrutura;
    secao += `🏘️ *Perfil do bairro (OpenStreetMap):*\n`;
    secao += `• ${i.resumo}\n`;
    if (i.vocacoes?.length) secao += `• Vocação: ${i.vocacoes.join(', ')}\n`;
    if (i.exemplosComercios?.length) secao += `• Comércios: ${i.exemplosComercios.slice(0, 3).join(', ')}\n`;
    if (i.exemplosAlimentacao?.length) secao += `• Alimentação: ${i.exemplosAlimentacao.slice(0, 3).join(', ')}\n`;
    secao += '\n';
  }

  if (perfil.municipio) {
    const m = perfil.municipio;
    secao += `📊 *Dados do município (IBGE):*\n`;
    if (m.populacao) secao += `• População: ${m.populacao.toLocaleString()}\n`;
    if (m.pibPerCapita) secao += `• PIB per capita: R$ ${m.pibPerCapita.toLocaleString()}\n`;
    secao += '\n';
  }

  return secao;
}

module.exports = { perfilarLocal, gerarContextoGuru, gerarSecaoLaudo };
