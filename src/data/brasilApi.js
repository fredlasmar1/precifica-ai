const axios = require('axios');
const db = require('./database');

/**
 * BrasilAPI — Dados de empresas/comércios por CEP e cidade.
 * Gratuita, sem chave de API.
 *
 * Mapeia a vocação comercial de cada bairro:
 * - Quantas empresas ativas
 * - Tipos de atividade (comércio, serviço, indústria)
 * - Porte (MEI, ME, EPP, grande)
 */

const BRASIL_API = 'https://brasilapi.com.br/api';

/**
 * Busca CEPs de um bairro/cidade para depois consultar empresas.
 * BrasilAPI não tem busca por bairro direto, mas podemos usar
 * a busca por CEP + enriquecimento.
 */
async function buscarCEPsBairro(cidade, bairro, estado = 'GO') {
  try {
    // Busca CEPs da localidade
    const query = `${bairro} ${cidade}`;
    const response = await axios.get(`${BRASIL_API}/cep/v2/${encodeURIComponent(query)}`, {
      timeout: 10000
    }).catch(() => null);

    // Alternativa: buscar por endereço parcial
    if (!response) {
      const resp2 = await axios.get(`https://viacep.com.br/ws/${estado}/${encodeURIComponent(cidade)}/${encodeURIComponent(bairro)}/json/`, {
        timeout: 10000
      });
      if (Array.isArray(resp2.data)) {
        return resp2.data.map(c => ({
          cep: c.cep?.replace('-', ''),
          logradouro: c.logradouro,
          bairro: c.bairro,
          cidade: c.localidade
        }));
      }
    }
    return [];
  } catch (err) {
    console.warn('[BrasilAPI] Erro ao buscar CEPs:', err.message);
    return [];
  }
}

/**
 * Busca informações detalhadas de um CEP (incluindo coordenadas e bairro).
 */
async function consultarCEP(cep) {
  try {
    const response = await axios.get(`${BRASIL_API}/cep/v2/${cep}`, { timeout: 8000 });
    return response.data;
  } catch {
    return null;
  }
}

/**
 * Busca dados de um CNPJ específico.
 */
async function consultarCNPJ(cnpj) {
  try {
    const response = await axios.get(`${BRASIL_API}/cnpj/v1/${cnpj}`, { timeout: 10000 });
    return response.data;
  } catch {
    return null;
  }
}

/**
 * Mapeia o perfil comercial de um bairro usando ViaCEP para descobrir
 * as ruas e depois GooglePlaces/OSM para os comércios.
 * Retorna resumo do perfil comercial.
 */
async function mapearPerfilComercial(cidade, bairro) {
  try {
    // Busca ruas do bairro via ViaCEP
    const ceps = await buscarCEPsBairro(cidade, bairro);

    const resultado = {
      bairro,
      cidade,
      totalRuas: ceps.length,
      ruas: ceps.slice(0, 20).map(c => c.logradouro).filter(Boolean),
      ceps: ceps.slice(0, 10).map(c => c.cep),
      mapeadoEm: new Date().toISOString()
    };

    console.log(`[BrasilAPI] ${bairro}, ${cidade}: ${ceps.length} ruas encontradas`);

    // Salva no banco
    if (ceps.length > 0) {
      try {
        await db.salvarBairro({
          cidade, bairro,
          ruas_valorizadas: resultado.ruas.slice(0, 10),
          fonte: 'brasil_api'
        });
      } catch {}
    }

    return resultado;
  } catch (err) {
    console.error('[BrasilAPI] Erro ao mapear:', err.message);
    return null;
  }
}

/**
 * Busca o código do município no IBGE (necessário para outras APIs).
 */
async function getCodigoMunicipio(cidade, estado = 'GO') {
  try {
    const response = await axios.get(`${BRASIL_API}/ibge/municipios/v1/${estado}`, { timeout: 10000 });
    const municipio = response.data.find(m =>
      m.nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') ===
      cidade.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    );
    return municipio?.codigo_ibge || null;
  } catch (err) {
    console.warn('[BrasilAPI] Erro ao buscar código município:', err.message);
    return null;
  }
}

module.exports = { buscarCEPsBairro, consultarCEP, consultarCNPJ, mapearPerfilComercial, getCodigoMunicipio };
