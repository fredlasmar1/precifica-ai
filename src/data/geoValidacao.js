const { Client } = require('@googlemaps/google-maps-services-js');
const cache = require('./cacheFile');

const client = new Client({});
const GEO_CACHE_TTL = 604800; // 7 dias

/**
 * Valida e enriquece o endereço via Google Maps Geocoding.
 *
 * Retorna:
 * - valido: true/false (o endereço existe na cidade informada?)
 * - enderecoCompleto: endereço resolvido pelo Google
 * - lat/lng: coordenadas
 * - bairroGoogle: bairro como o Google entende
 * - cidadeGoogle: cidade como o Google entende
 * - bairrosProximos: bairros vizinhos (via reverse geocoding em pontos próximos)
 * - distanciaCentro: distância em km até o centro da cidade
 * - viasProximas: avenidas/ruas principais próximas
 */
async function validarEndereco(cidade, bairro, endereco) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  const enderecoCompleto = endereco
    ? `${endereco}, ${bairro}, ${cidade}, GO, Brasil`
    : `${bairro}, ${cidade}, GO, Brasil`;

  const cacheKey = `geo_${enderecoCompleto}`.toLowerCase().replace(/\s/g, '_').slice(0, 200);
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[Geo] Cache hit: ${bairro}, ${cidade}`);
    return cached;
  }

  try {
    // 1. Geocodifica o endereço
    const geocode = await client.geocode({
      params: {
        address: enderecoCompleto,
        key: apiKey,
        language: 'pt-BR',
        region: 'br',
        bounds: {
          southwest: { lat: -19.5, lng: -53.3 },
          northeast: { lat: -12.4, lng: -45.9 }
        }
      }
    });

    if (!geocode.data.results.length) {
      console.warn(`[Geo] Endereço não encontrado: ${enderecoCompleto}`);
      return { valido: false, motivo: 'Endereço não encontrado pelo Google Maps' };
    }

    const result = geocode.data.results[0];
    const location = result.geometry.location;
    const formatted = result.formatted_address;

    // Validar que está em Goiás
    if (location.lat < -20 || location.lat > -12 || location.lng < -53.5 || location.lng > -45.5) {
      console.warn(`[Geo] Fora de Goiás: ${formatted} (${location.lat}, ${location.lng})`);
      return { valido: false, motivo: `Endereço caiu fora de Goiás: ${formatted}` };
    }

    // Extrair componentes do endereço
    const components = result.address_components || [];
    const bairroGoogle = getComponent(components, 'sublocality_level_1') ||
                         getComponent(components, 'sublocality') ||
                         getComponent(components, 'neighborhood') || bairro;
    const cidadeGoogle = getComponent(components, 'administrative_area_level_2') ||
                         getComponent(components, 'locality') || cidade;

    // Validar que a cidade confere
    const cidadeNorm = cidade.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const cidadeGoogleNorm = cidadeGoogle.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (!cidadeGoogleNorm.includes(cidadeNorm) && !cidadeNorm.includes(cidadeGoogleNorm)) {
      console.warn(`[Geo] Cidade diverge: esperado "${cidade}", Google retornou "${cidadeGoogle}" (${formatted})`);
      return { valido: false, motivo: `Google Maps encontrou "${cidadeGoogle}" em vez de "${cidade}"` };
    }

    // 2. Buscar bairros vizinhos (4 pontos cardeais ~1km de distância)
    const bairrosProximos = await buscarBairrosVizinhos(location, apiKey);

    // 3. Calcular distância ao centro da cidade
    const distanciaCentro = await calcularDistanciaCentro(cidade, location, apiKey);

    // 4. Buscar vias principais próximas
    const viasProximas = await buscarViasProximas(location, apiKey);

    const resultado = {
      valido: true,
      enderecoCompleto: formatted,
      lat: location.lat,
      lng: location.lng,
      bairroGoogle,
      cidadeGoogle,
      bairrosProximos: [...new Set(bairrosProximos)].filter(b => b.toLowerCase() !== bairroGoogle.toLowerCase()),
      distanciaCentroKm: distanciaCentro,
      viasProximas: [...new Set(viasProximas)].slice(0, 5)
    };

    console.log(`[Geo] Validado: ${formatted} | Vizinhos: ${resultado.bairrosProximos.join(', ')} | ${distanciaCentro}km do centro`);
    cache.set(cacheKey, resultado, GEO_CACHE_TTL);
    return resultado;

  } catch (err) {
    console.error(`[Geo] Erro:`, err.message);
    return null;
  }
}

/**
 * Reverse geocode em 4 pontos ~1km ao redor para descobrir bairros vizinhos
 */
async function buscarBairrosVizinhos(location, apiKey) {
  const offset = 0.009; // ~1km
  const pontos = [
    { lat: location.lat + offset, lng: location.lng },         // norte
    { lat: location.lat - offset, lng: location.lng },         // sul
    { lat: location.lat, lng: location.lng + offset },         // leste
    { lat: location.lat, lng: location.lng - offset },         // oeste
  ];

  const bairros = [];
  const promises = pontos.map(async (ponto) => {
    try {
      const res = await client.reverseGeocode({
        params: { latlng: ponto, key: apiKey, language: 'pt-BR', result_type: ['sublocality_level_1', 'neighborhood', 'sublocality'] }
      });
      for (const r of (res.data.results || []).slice(0, 2)) {
        const b = getComponent(r.address_components, 'sublocality_level_1') ||
                  getComponent(r.address_components, 'sublocality') ||
                  getComponent(r.address_components, 'neighborhood');
        if (b) bairros.push(b);
      }
    } catch { /* ignore */ }
  });

  await Promise.all(promises);
  return bairros;
}

/**
 * Calcula distância até o centro da cidade
 */
async function calcularDistanciaCentro(cidade, location, apiKey) {
  try {
    const centroGeo = await client.geocode({
      params: {
        address: `Centro, ${cidade}, GO, Brasil`,
        key: apiKey,
        language: 'pt-BR',
        region: 'br'
      }
    });
    if (centroGeo.data.results.length) {
      const centro = centroGeo.data.results[0].geometry.location;
      const dist = haversine(location.lat, location.lng, centro.lat, centro.lng);
      return Math.round(dist * 10) / 10;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Busca vias/avenidas principais próximas via reverse geocode
 */
async function buscarViasProximas(location, apiKey) {
  const vias = [];
  try {
    const res = await client.reverseGeocode({
      params: { latlng: location, key: apiKey, language: 'pt-BR', result_type: ['route'] }
    });
    for (const r of (res.data.results || []).slice(0, 5)) {
      const route = getComponent(r.address_components, 'route');
      if (route) vias.push(route);
    }
  } catch { /* ignore */ }
  return vias;
}

function getComponent(components, type) {
  const c = (components || []).find(c => c.types.includes(type));
  return c ? c.long_name : null;
}

/**
 * Fórmula de Haversine para distância entre coordenadas em km
 */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = { validarEndereco };
