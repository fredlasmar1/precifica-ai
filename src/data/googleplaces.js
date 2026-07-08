const { Client } = require('@googlemaps/google-maps-services-js');
const NodeCache = require('node-cache');

const client = new Client({});
const cache = new NodeCache({ stdTTL: 86400 }); // Cache de 24h

/**
 * Analisa a infraestrutura ao redor do imóvel via Google Places
 * Retorna score de localização e lista de pontos relevantes
 */
async function analisarLocalizacao(cidade, bairro, endereco) {
  const enderecoCompleto = endereco
    ? `${endereco}, ${bairro}, ${cidade}, Goiás, Brasil`
    : `${bairro}, ${cidade}, Goiás, Brasil`;

  const cacheKey = `places_${enderecoCompleto}`.toLowerCase().replace(/\s/g, '_').slice(0, 200);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.warn('[Places] GOOGLE_PLACES_API_KEY não configurada — pulando análise de localização');
    return null;
  }

  try {
    // 1. Geocodifica o endereço para obter lat/lng
    // Forçamos region=br e bounds no estado de Goiás para não cair
    // em homônimos (ex: "Jundiaí" → Jundiaí-SP em vez de bairro em Anápolis)
    console.log(`[Places] Geocodificando: ${enderecoCompleto}`);
    const geocode = await client.geocode({
      params: {
        address: enderecoCompleto,
        key: apiKey,
        language: 'pt-BR',
        region: 'br',
        // Bounds do estado de Goiás — prioriza resultados dentro desse retângulo
        bounds: {
          southwest: { lat: -19.5, lng: -53.3 },
          northeast: { lat: -12.4, lng: -45.9 }
        }
      }
    });

    if (!geocode.data.results.length) return null;

    const location = geocode.data.results[0].geometry.location;
    const enderecoResolvido = geocode.data.results[0].formatted_address || '';

    // Validação: verifica se caiu dentro de Goiás (lat -12 a -20, lng -53 a -45)
    // Se caiu fora, é homônimo (ex: Jundiaí-SP) — rejeita
    if (location.lat < -20 || location.lat > -12 || location.lng < -53.5 || location.lng > -45.5) {
      console.warn(`[Places] Geocode fora de Goiás! Caiu em: ${enderecoResolvido} (${location.lat}, ${location.lng})`);
      return null;
    }

    // Verifica se o endereço resolvido contém a cidade esperada
    const cidadeNorm = cidade.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (!enderecoResolvido.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(cidadeNorm)) {
      console.warn(`[Places] Geocode caiu na cidade errada! Esperava "${cidade}", recebeu: ${enderecoResolvido}`);
      // Tenta de novo forçando a cidade no endereço
      const retry = await client.geocode({
        params: {
          address: `${bairro}, ${cidade}, GO, Brasil`,
          key: apiKey,
          language: 'pt-BR',
          region: 'br',
          bounds: {
            southwest: { lat: -19.5, lng: -53.3 },
            northeast: { lat: -12.4, lng: -45.9 }
          }
        }
      });
      if (retry.data.results.length) {
        const retryLoc = retry.data.results[0].geometry.location;
        const retryAddr = retry.data.results[0].formatted_address || '';
        if (retryAddr.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(cidadeNorm)) {
          console.log(`[Places] Retry OK: ${retryAddr}`);
          Object.assign(location, retryLoc);
        } else {
          console.warn(`[Places] Retry também falhou: ${retryAddr}. Abortando.`);
          return null;
        }
      } else {
        return null;
      }
    }

    console.log(`[Places] Localizado: ${enderecoResolvido} (${location.lat}, ${location.lng})`);

    // 2. Busca categorias em paralelo (raio de 1km)
    const categorias = [
      { tipo: 'school',      label: 'Escolas',         raio: 1000, peso: 1.5 },
      { tipo: 'hospital',    label: 'Hospitais/UBS',   raio: 2000, peso: 1.3 },
      { tipo: 'supermarket', label: 'Supermercados',   raio: 800,  peso: 1.4 },
      { tipo: 'shopping_mall', label: 'Shoppings',     raio: 3000, peso: 1.2 },
      { tipo: 'bank',        label: 'Bancos',           raio: 1000, peso: 1.0 },
      { tipo: 'restaurant',  label: 'Restaurantes',    raio: 500,  peso: 0.8 },
      { tipo: 'gym',         label: 'Academia',        raio: 1000, peso: 0.9 },
      { tipo: 'pharmacy',    label: 'Farmácias',       raio: 800,  peso: 1.1 },
      { tipo: 'bus_station', label: 'Transporte',      raio: 500,  peso: 1.6 },
      { tipo: 'park',        label: 'Parques/Praças',  raio: 1000, peso: 1.0 }
    ];

    const buscas = categorias.map(cat =>
      client.placesNearby({
        params: {
          location,
          radius: cat.raio,
          type: cat.tipo,
          key: apiKey,
          language: 'pt-BR'
        }
      }).then(res => ({
        ...cat,
        encontrados: res.data.results.length,
        exemplos: res.data.results.slice(0, 2).map(p => p.name)
      })).catch(() => ({ ...cat, encontrados: 0, exemplos: [] }))
    );

    const resultados = await Promise.all(buscas);

    // 3. Calcula score de infraestrutura (0 a 100)
    const score = calcularScore(resultados);

    // 4. Calcula multiplicador de valorização
    const multiplicador = calcularMultiplicador(score);

    // 5. Identifica destaques e alertas
    const { destaques, alertas } = analisarPontos(resultados);

    const analise = {
      location,
      score,
      multiplicador,
      destaques,
      alertas,
      categorias: resultados.filter(r => r.encontrados > 0),
      enderecoReferencia: geocode.data.results[0].formatted_address
    };

    cache.set(cacheKey, analise);
    return analise;

  } catch (err) {
    console.error('[Places] Erro na análise:', err.message);
    return null;
  }
}

/**
 * Score de 0 a 100 baseado na densidade de serviços essenciais
 */
function calcularScore(resultados) {
  let pontos = 0;
  let pesoTotal = 0;

  for (const cat of resultados) {
    const qtd = Math.min(cat.encontrados, 5); // Cap em 5 por categoria
    const contribuicao = (qtd / 5) * cat.peso * 10;
    pontos += contribuicao;
    pesoTotal += cat.peso * 10;
  }

  return Math.min(100, Math.round((pontos / pesoTotal) * 100));
}

/**
 * Converte score em multiplicador de preço
 * Score 80+ = +8% no valor | Score <40 = -5%
 */
function calcularMultiplicador(score) {
  if (score >= 85) return { fator: 1.10, descricao: 'Localização excelente (+10%)' };
  if (score >= 70) return { fator: 1.06, descricao: 'Localização muito boa (+6%)' };
  if (score >= 55) return { fator: 1.03, descricao: 'Localização boa (+3%)' };
  if (score >= 40) return { fator: 1.00, descricao: 'Localização mediana (sem ajuste)' };
  if (score >= 25) return { fator: 0.97, descricao: 'Localização abaixo da média (-3%)' };
  return { fator: 0.94, descricao: 'Localização periférica (-6%)' };
}

/**
 * Separa pontos positivos e negativos da análise
 */
function analisarPontos(resultados) {
  const destaques = [];
  const alertas = [];

  const essenciais = ['school', 'supermarket', 'bus_station', 'pharmacy'];
  const premium = ['shopping_mall', 'gym', 'hospital'];

  for (const cat of resultados) {
    if (essenciais.includes(cat.tipo) && cat.encontrados === 0) {
      alertas.push(`Sem ${cat.label.toLowerCase()} próximo(a)`);
    } else if (cat.encontrados >= 3 && premium.includes(cat.tipo)) {
      destaques.push(`${cat.label}: ${cat.exemplos[0] || cat.encontrados + ' opções'}`);
    } else if (cat.encontrados >= 2 && essenciais.includes(cat.tipo)) {
      destaques.push(`${cat.label}: ${cat.encontrados} próximo(as)`);
    }
  }

  return { destaques, alertas };
}

/**
 * Formata a seção de localização para o laudo WhatsApp
 */
function formatarSecaoLocalizacao(analise) {
  if (!analise) return '';

  const { score, multiplicador, destaques, alertas } = analise;

  const emoji = score >= 70 ? '🟢' : score >= 45 ? '🟡' : '🔴';

  let secao = `\n📍 *Análise de Localização (Google Places):*\n`;
  secao += `• Score: ${emoji} ${score}/100 — ${multiplicador.descricao}\n`;

  if (destaques.length > 0) {
    secao += `\n✅ *Pontos positivos:*\n`;
    destaques.slice(0, 4).forEach(d => secao += `• ${d}\n`);
  }

  if (alertas.length > 0) {
    secao += `\n⚠️ *Atenção:*\n`;
    alertas.slice(0, 3).forEach(a => secao += `• ${a}\n`);
  }

  return secao;
}

module.exports = { analisarLocalizacao, formatarSecaoLocalizacao };
