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

    // 5. Analisar a rua/entorno imediato (o que valoriza ou desvaloriza)
    const analiseRua = await analisarRua(location, apiKey);

    const resultado = {
      valido: true,
      enderecoCompleto: formatted,
      lat: location.lat,
      lng: location.lng,
      bairroGoogle,
      cidadeGoogle,
      bairrosProximos: [...new Set(bairrosProximos)].filter(b => b.toLowerCase() !== bairroGoogle.toLowerCase()),
      distanciaCentroKm: distanciaCentro,
      viasProximas: [...new Set(viasProximas)].slice(0, 5),
      analiseRua
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

/**
 * Analisa o entorno imediato da rua (raio 200m) para identificar
 * fatores que agregam ou reduzem valor do terreno/imóvel.
 */
async function analisarRua(location, apiKey) {
  const fatoresPositivos = [];
  const fatoresNegativos = [];

  // Categorias que AGREGAM valor (raio 200m — entorno imediato)
  const positivos = [
    { tipo: 'shopping_mall', label: 'Shopping/centro comercial', raio: 500 },
    { tipo: 'bank',          label: 'Bancos',                    raio: 200 },
    { tipo: 'restaurant',    label: 'Restaurantes/comércio',     raio: 200 },
    { tipo: 'school',        label: 'Escolas',                   raio: 300 },
    { tipo: 'hospital',      label: 'Hospital/clínica',          raio: 500 },
    { tipo: 'supermarket',   label: 'Supermercado',              raio: 300 },
    { tipo: 'park',          label: 'Praça/parque',              raio: 300 },
    { tipo: 'pharmacy',      label: 'Farmácias',                 raio: 200 },
  ];

  // Categorias que podem REDUZIR valor (raio 300m)
  const negativos = [
    { tipo: 'cemetery',       label: 'Cemitério próximo',        raio: 300 },
    { tipo: 'gas_station',    label: 'Posto de combustível',     raio: 150 },
    { tipo: 'bus_station',    label: 'Terminal de ônibus',        raio: 200 },
  ];

  try {
    // Busca positivos em paralelo
    const buscasPos = positivos.map(cat =>
      client.placesNearby({
        params: { location, radius: cat.raio, type: cat.tipo, key: apiKey, language: 'pt-BR' }
      }).then(res => {
        const count = res.data.results.length;
        if (count > 0) {
          const exemplos = res.data.results.slice(0, 2).map(p => p.name);
          fatoresPositivos.push({
            tipo: cat.label,
            quantidade: count,
            exemplos,
            destaque: count >= 3 ? `Rua com forte presença de ${cat.label.toLowerCase()}` : null
          });
        }
      }).catch(() => {})
    );

    // Busca negativos em paralelo
    const buscasNeg = negativos.map(cat =>
      client.placesNearby({
        params: { location, radius: cat.raio, type: cat.tipo, key: apiKey, language: 'pt-BR' }
      }).then(res => {
        const count = res.data.results.length;
        if (count > 0) {
          const exemplos = res.data.results.slice(0, 2).map(p => p.name);
          fatoresNegativos.push({
            tipo: cat.label,
            quantidade: count,
            exemplos
          });
        }
      }).catch(() => {})
    );

    await Promise.all([...buscasPos, ...buscasNeg]);

    // Determinar perfil da rua
    const temComercio = fatoresPositivos.some(f => ['Restaurantes/comércio', 'Bancos', 'Supermercado'].includes(f.tipo) && f.quantidade >= 2);
    const temServicos = fatoresPositivos.some(f => ['Escolas', 'Hospital/clínica', 'Farmácias'].includes(f.tipo));
    const temLazer = fatoresPositivos.some(f => ['Praça/parque', 'Shopping/centro comercial'].includes(f.tipo));

    let perfilRua = 'residencial';
    if (temComercio && fatoresPositivos.filter(f => f.quantidade >= 2).length >= 3) {
      perfilRua = 'comercial forte';
    } else if (temComercio) {
      perfilRua = 'misto (residencial/comercial)';
    }

    // Avaliação de impacto no valor
    let impacto = 'neutro';
    let descricao = 'Rua sem fatores significativos de valorização ou desvalorização identificados.';

    if (perfilRua === 'comercial forte' && temServicos) {
      impacto = 'positivo';
      descricao = 'Rua com perfil comercial forte — comércio, serviços e boa infraestrutura ao redor. Agrega valor ao imóvel.';
    } else if (perfilRua === 'comercial forte') {
      impacto = 'positivo';
      descricao = 'Rua com perfil comercial — boa movimentação e comércio próximo. Pode agregar valor.';
    } else if (temLazer && temServicos) {
      impacto = 'positivo';
      descricao = 'Rua com boa infraestrutura — praças/parques e serviços essenciais próximos. Valoriza o imóvel.';
    } else if (fatoresNegativos.length > 0 && fatoresPositivos.length < 2) {
      impacto = 'negativo';
      descricao = `Atenção: ${fatoresNegativos.map(f => f.tipo.toLowerCase()).join(', ')} próximo(s). Pode reduzir valor.`;
    }

    return {
      perfilRua,
      impacto,
      descricao,
      positivos: fatoresPositivos.slice(0, 6),
      negativos: fatoresNegativos,
      totalPositivos: fatoresPositivos.reduce((s, f) => s + f.quantidade, 0),
      totalNegativos: fatoresNegativos.reduce((s, f) => s + f.quantidade, 0)
    };
  } catch (err) {
    console.warn('[Geo] Erro na análise da rua:', err.message);
    return null;
  }
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
