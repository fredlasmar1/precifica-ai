const axios = require('axios');

const IBGE_API = 'https://servicodados.ibge.gov.br/api';

/**
 * IBGE API — Dados demográficos e socioeconômicos.
 * Gratuita, sem chave.
 *
 * Retorna: população, PIB, renda, IDH, área, densidade.
 * Essencial para entender o poder aquisitivo de cada região.
 */

// Cache em memória (dados do IBGE mudam 1x/ano)
const cache = {};

/**
 * Busca dados completos de um município.
 */
async function getDadosMunicipio(codigoIBGE) {
  if (!codigoIBGE) return null;
  if (cache[codigoIBGE]) return cache[codigoIBGE];

  try {
    // Busca em paralelo: dados gerais + indicadores
    const [infoRes, populacaoRes, pibRes] = await Promise.allSettled([
      axios.get(`${IBGE_API}/v1/localidades/municipios/${codigoIBGE}`, { timeout: 10000 }),
      axios.get(`${IBGE_API}/v3/agregados/6579/periodos/-1/variaveis/9324?localidades=N6[${codigoIBGE}]`, { timeout: 10000 }),
      axios.get(`${IBGE_API}/v3/agregados/5938/periodos/-1/variaveis/37?localidades=N6[${codigoIBGE}]`, { timeout: 10000 })
    ]);

    const info = infoRes.status === 'fulfilled' ? infoRes.value.data : {};

    // Extrair população
    let populacao = null;
    try {
      if (populacaoRes.status === 'fulfilled') {
        const dados = populacaoRes.value.data;
        const serie = dados?.[0]?.resultados?.[0]?.series?.[0]?.serie;
        if (serie) {
          const ultimoAno = Object.keys(serie).sort().pop();
          populacao = parseInt(serie[ultimoAno]);
        }
      }
    } catch {}

    // Extrair PIB
    let pib = null;
    try {
      if (pibRes.status === 'fulfilled') {
        const dados = pibRes.value.data;
        const serie = dados?.[0]?.resultados?.[0]?.series?.[0]?.serie;
        if (serie) {
          const ultimoAno = Object.keys(serie).sort().pop();
          pib = parseFloat(serie[ultimoAno]);
        }
      }
    } catch {}

    const resultado = {
      codigo: codigoIBGE,
      nome: info.nome || null,
      estado: info.microrregiao?.mesorregiao?.UF?.nome || 'Goiás',
      siglaEstado: info.microrregiao?.mesorregiao?.UF?.sigla || 'GO',
      microrregiao: info.microrregiao?.nome || null,
      mesorregiao: info.microrregiao?.mesorregiao?.nome || null,
      populacao,
      pibMilhoes: pib ? Math.round(pib / 1000) : null,
      pibPerCapita: populacao && pib ? Math.round(pib / populacao) : null
    };

    console.log(`[IBGE] ${resultado.nome}: pop ${populacao?.toLocaleString()}, PIB R$ ${resultado.pibMilhoes}mi`);
    cache[codigoIBGE] = resultado;
    return resultado;

  } catch (err) {
    console.error('[IBGE] Erro:', err.message);
    return null;
  }
}

/**
 * Busca dados de renda por setor censitário (aproximação por município).
 */
async function getRendaMunicipio(codigoIBGE) {
  if (!codigoIBGE) return null;
  const cacheKey = `renda_${codigoIBGE}`;
  if (cache[cacheKey]) return cache[cacheKey];

  try {
    // Rendimento nominal mensal domiciliar per capita
    const response = await axios.get(
      `${IBGE_API}/v3/agregados/6579/periodos/-1/variaveis/9324|9325|9326?localidades=N6[${codigoIBGE}]`,
      { timeout: 15000 }
    );

    const resultado = { codigoIBGE };
    for (const variavel of (response.data || [])) {
      const serie = variavel?.resultados?.[0]?.series?.[0]?.serie;
      if (serie) {
        const ultimoAno = Object.keys(serie).sort().pop();
        const valor = parseFloat(serie[ultimoAno]);
        if (variavel.id === '9324') resultado.rendaMediaDomiciliar = valor;
        if (variavel.id === '9325') resultado.rendaMediana = valor;
        if (variavel.id === '9326') resultado.rendaTotal = valor;
      }
    }

    console.log(`[IBGE] Renda ${codigoIBGE}: média R$ ${resultado.rendaMediaDomiciliar}`);
    cache[cacheKey] = resultado;
    return resultado;
  } catch (err) {
    console.warn('[IBGE] Erro renda:', err.message);
    return null;
  }
}

/**
 * Busca indicadores econômicos complementares do município.
 */
async function getIndicadores(codigoIBGE) {
  if (!codigoIBGE) return null;
  const cacheKey = `ind_${codigoIBGE}`;
  if (cache[cacheKey]) return cache[cacheKey];

  try {
    const response = await axios.get(
      `https://brasilapi.com.br/api/ibge/municipios/v1/${codigoIBGE}`,
      { timeout: 10000 }
    ).catch(() => null);

    // Complementa com dados de área territorial
    const areaRes = await axios.get(
      `${IBGE_API}/v3/agregados/1301/periodos/-1/variaveis/615?localidades=N6[${codigoIBGE}]`,
      { timeout: 10000 }
    ).catch(() => null);

    let area = null;
    try {
      const serie = areaRes?.data?.[0]?.resultados?.[0]?.series?.[0]?.serie;
      if (serie) {
        const ultimoAno = Object.keys(serie).sort().pop();
        area = parseFloat(serie[ultimoAno]);
      }
    } catch {}

    const resultado = {
      areaKm2: area,
      fonte: 'IBGE'
    };

    cache[cacheKey] = resultado;
    return resultado;
  } catch (err) {
    console.warn('[IBGE] Erro indicadores:', err.message);
    return null;
  }
}

module.exports = { getDadosMunicipio, getRendaMunicipio, getIndicadores };
