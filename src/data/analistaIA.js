const axios = require('axios');
const { getConhecimentoLocal } = require('./conhecimentoLocal');
const cache = require('./cacheFile');

const CACHE_TTL = 86400; // 24h — preços não mudam no mesmo dia

/**
 * Usa Perplexity (modelo sonar) para pesquisar preços REAIS na internet.
 *
 * Diferente do GPT-4o que chuta baseado em treinamento antigo,
 * a Perplexity faz busca em tempo real nos portais imobiliários
 * (ZAP, OLX, VivaReal, etc.) e retorna dados com fontes.
 *
 * Retorna { precoMedioM2, faixaMinM2, faixaMaxM2, confianca, analise, fontes }
 */
async function estimarPrecoComIA(dadosImovel) {
  const { tipo, finalidade, cidade, bairro, endereco, metragem, quartos, vagas, diferenciais, conservacao, geoInfo, contextoGuru } = dadosImovel;

  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    console.warn('[Perplexity] PERPLEXITY_API_KEY não configurada');
    return null;
  }

  // Para terrenos: inclui faixa de tamanho na chave de cache
  // (terreno 200m² e 2000m² têm preço/m² diferente após fator de escala)
  let cacheKey;
  if (tipo === 'terreno') {
    const faixaTerreno = metragem > 5000 ? 'g5000'
      : metragem > 2000 ? 'g2000'
      : metragem > 1000 ? 'g1000'
      : metragem > 500  ? 'g500'
      : 'ate500';
    cacheKey = `pplx_${tipo}_${finalidade}_${cidade}_${bairro}_${faixaTerreno}`
      .toLowerCase().replace(/\s/g, '_');
  } else {
    cacheKey = `pplx_${tipo}_${finalidade}_${cidade}_${bairro}_${quartos}_${metragem}`
      .toLowerCase().replace(/\s/g, '_');
  }

  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[Perplexity] Cache hit: ${cacheKey}`);
    return cached;
  }

  // Cache similar: só para apartamentos/casas (metragem não afeta preço/m² do bairro)
  // Para terrenos: NÃO reaproveitar cache por tamanho, pois o fator de escala varia
  if (tipo !== 'terreno') {
    const similarPrefix = `pplx_${tipo}_${finalidade}_${cidade}_${bairro}`.toLowerCase().replace(/\s/g, '_');
    const similar = cache.getSimilar(similarPrefix);
    if (similar) {
      console.log(`[Perplexity] Cache similar encontrado para ${similarPrefix}`);
      return similar;
    }
  }

  const difsTexto = Array.isArray(diferenciais) && diferenciais.length > 0
    ? diferenciais.join(', ')
    : 'nenhum diferencial especial';

  // Faixa de metragem: buscar imóveis com tamanho similar (±30%)
  const metMin = Math.round(metragem * 0.7);
  const metMax = Math.round(metragem * 1.3);

  const conservacaoLabel = {
    'novo': 'NOVOS ou na planta',
    'bom': 'em BOM ESTADO (usados/revenda)',
    'reformar': 'que PRECISAM DE REFORMA'
  };
  const estadoFiltro = conservacaoLabel[conservacao] || 'em bom estado';

  const finalidadeLabel = finalidade === 'aluguel' ? 'para ALUGAR' : 'à VENDA';

  // Busca contexto local da cidade (pesquisado na internet, cacheado 7 dias)
  // Limita a 3000 chars para não estourar o prompt e cortar a resposta JSON
  let contextoLocal = await getConhecimentoLocal(cidade);
  if (contextoLocal.length > 3000) {
    contextoLocal = contextoLocal.slice(0, 3000) + '\n[...contexto resumido por limite de tamanho]';
  }

  // Descrição precisa do que buscar por tipo
  const isTerreno = tipo === 'terreno';
  const isCasa = tipo === 'casa';
  const isApto = tipo === 'apartamento';

  let descricaoTipo;
  if (isTerreno) {
    descricaoTipo = `LOTES ou TERRENOS vazios (SEM construção) ${finalidadeLabel}. NÃO inclua casas, apartamentos ou qualquer imóvel construído. Apenas terrenos/lotes vazios para construir.`;
  } else if (isCasa) {
    descricaoTipo = `CASAS ${conservacao === 'novo' ? 'NOVAS' : 'de REVENDA (usadas)'} ${finalidadeLabel}. NÃO inclua terrenos, apartamentos ou lotes. Apenas casas construídas.`;
  } else if (isApto) {
    descricaoTipo = `APARTAMENTOS ${conservacao === 'novo' ? 'NOVOS ou na planta' : 'de REVENDA (usados)'} ${finalidadeLabel}. NÃO inclua casas, terrenos ou lotes.`;
  } else {
    descricaoTipo = `${tipo}s ${finalidadeLabel}`;
  }

  // Bairros vizinhos para ampliar busca quando há poucos anúncios
  const vizinhosTexto = geoInfo?.bairrosProximos?.length
    ? geoInfo.bairrosProximos.join(', ')
    : '';

  let prompt;

  if (isTerreno) {
    // ─── LÓGICA PARA TERRENOS ─────────────────────────────────────────────
    // Busca o preço/m² médio do bairro com QUALQUER tamanho de lote.
    // O fator de escala para terrenos grandes é aplicado no precificador.
    // Se < 3 anúncios no bairro, amplia OBRIGATORIAMENTE para vizinhos.
    prompt = `Preciso descobrir o PREÇO MÉDIO DO METRO QUADRADO de terrenos/lotes vazios ${finalidadeLabel} no bairro ${bairro}, ${cidade}-GO (estado de Goiás, Brasil).

TERRENO QUE ESTOU AVALIANDO: ${metragem}m² no ${bairro}${endereco ? `, ${endereco}` : ''}

COMO PESQUISAR (siga essa ordem):
1. Busque terrenos/lotes VAZIOS no bairro ${bairro} em ${cidade}-GO nos portais
2. Aceite QUALQUER tamanho de lote (200m², 500m², 1000m², 2000m²+) — quer o preço/m² do bairro
3. Para cada anúncio: calcule preço ÷ área = preço/m²
4. SE achar menos de 3 anúncios no ${bairro}, amplie OBRIGATORIAMENTE para os bairros vizinhos: ${vizinhosTexto || 'bairros próximos de perfil similar'}
5. Calcule a média ponderada de preço/m² de todos os anúncios encontrados
6. No raciocínio, informe quantos anúncios achou no bairro principal e quantos nos vizinhos

REGRAS ABSOLUTAS:
- SOMENTE terrenos/lotes VAZIOS sem construção — ignore casas, sobrados, imóveis construídos
- A cidade é ${cidade}-GO (estado de GOIÁS, Brasil) — NÃO confunda com homônimos de outros estados
- Busque entre 5 e 15 anúncios no total
- NÃO filtre por tamanho similar ao avaliado — o ajuste de escala é feito depois pelo sistema
- Se o único anúncio for pequeno (ex: 200m²), use o preço/m² dele mesmo assim`;

  } else if (isApto) {
    // ─── LÓGICA PARA APARTAMENTOS ─────────────────────────────
    // Mesma lógica dos terrenos: buscar preço/m² do bairro por CATEGORIA
    // (novo, semi-novo, usado). Depois multiplicar pela metragem.
    prompt = `Preciso descobrir o PREÇO MÉDIO DO METRO QUADRADO de apartamentos ${finalidadeLabel} no bairro ${bairro}, ${cidade}-GO (estado de Goiás, Brasil).

APARTAMENTO QUE ESTOU AVALIANDO: ${metragem}m², ${quartos} quartos, ${vagas} vagas, estado: ${conservacao}

COMO PESQUISAR:
1. Busque apartamentos ${finalidadeLabel} no bairro ${bairro} em ${cidade}-GO
2. Aceite apartamentos de QUALQUER tamanho — o que importa é o preço por m² do bairro
3. Para cada anúncio: preço ÷ área = preço/m²
4. SEPARE os resultados por categoria:
   - NOVOS (na planta ou recém-entregues)
   - SEMI-NOVOS (até 5 anos de uso, bom estado)
   - USADOS (mais de 5 anos, usado/revenda)
5. Calcule a média de preço/m² para CADA categoria
6. Busque entre 5 e 10 anúncios no total
7. Se não achar suficientes no ${bairro}, busque em bairros vizinhos de perfil similar${geoInfo?.bairrosProximos?.length ? ` (vizinhos: ${geoInfo.bairrosProximos.join(', ')})` : ''}

ATENÇÃO:
- O apartamento que estou avaliando está em estado "${conservacao}" — use a categoria correspondente como referência principal
- ${conservacao === 'novo' ? 'Use a média de NOVOS como referência' : conservacao === 'bom' ? 'Use a média de SEMI-NOVOS como referência' : 'Use a média de USADOS como referência'}
- A cidade é ${cidade} no estado de GOIÁS (GO) — NÃO confunda com homônimos
- SOMENTE apartamentos, não casas ou terrenos`;

  } else {
    // ─── LÓGICA PARA CASAS E OUTROS ──────────────────────────
    // Casas: buscar preço/m² do bairro, separando por categoria
    prompt = `Preciso descobrir o PREÇO MÉDIO DO METRO QUADRADO de ${tipo}s ${finalidadeLabel} no bairro ${bairro}, ${cidade}-GO (estado de Goiás, Brasil).

IMÓVEL QUE ESTOU AVALIANDO: ${tipo}, ${metragem}m², ${quartos} quartos, ${vagas} vagas, estado: ${conservacao}
Diferenciais: ${difsTexto}

COMO PESQUISAR:
1. Busque ${tipo}s ${finalidadeLabel} no bairro ${bairro} em ${cidade}-GO
2. Aceite ${tipo}s de QUALQUER tamanho — o que importa é o preço por m² do bairro
3. Para cada anúncio: preço ÷ área = preço/m²
4. SEPARE por categoria: NOVOS, SEMI-NOVOS/BOM ESTADO, USADOS/PARA REFORMA
5. Calcule a média de preço/m² para cada categoria
6. Busque entre 5 e 10 anúncios
7. Se não achar no ${bairro}, busque vizinhos${geoInfo?.bairrosProximos?.length ? ` (${geoInfo.bairrosProximos.join(', ')})` : ''}
8. ${conservacao === 'novo' ? 'Use NOVOS como referência' : conservacao === 'bom' ? 'Use SEMI-NOVOS como referência' : 'Use USADOS como referência'}

ATENÇÃO:
- A cidade é ${cidade} no estado de GOIÁS (GO)
- SOMENTE ${tipo}s, não misture com outros tipos`;
  }

  // Parte comum do prompt
  prompt += `

SITES PARA CONSULTAR: OLX, ZAP Imóveis, VivaReal, Imovelweb, Chaves na Mão, 62imóveis, QuintoAndar

ATENÇÃO ABSOLUTA: A cidade é ${cidade.toUpperCase()}-GO no estado de GOIÁS, Brasil. NÃO use dados de ${cidade} de outros estados. NÃO use dados genéricos nacionais. SOMENTE anúncios REAIS e ATUAIS de ${cidade}-GO.
${geoInfo ? `
DADOS GEOGRÁFICOS CONFIRMADOS PELO GOOGLE MAPS:
- Endereço validado: ${geoInfo.enderecoCompleto}
- Coordenadas: ${geoInfo.lat}, ${geoInfo.lng}
- Bairros vizinhos: ${(geoInfo.bairrosProximos || []).join(', ') || 'não identificados'}
- Distância ao centro: ${geoInfo.distanciaCentroKm != null ? geoInfo.distanciaCentroKm + ' km' : 'não calculada'}
- Vias próximas: ${(geoInfo.viasProximas || []).join(', ') || 'não identificadas'}
Use esses bairros vizinhos como alternativa se não encontrar anúncios suficientes no bairro principal.` : ''}
${geoInfo?.analiseRua ? `
ANÁLISE DA RUA (Google Maps):
- Perfil da rua: ${geoInfo.analiseRua.perfilRua}
- Impacto no valor: ${geoInfo.analiseRua.impacto}
- ${geoInfo.analiseRua.descricao}
${geoInfo.analiseRua.positivos?.length ? '- O que tem por perto: ' + geoInfo.analiseRua.positivos.map(f => `${f.tipo} (${f.quantidade})`).join(', ') : ''}
Considere o perfil da rua ao avaliar se o preço/m² deve ser ajustado para cima ou para baixo em relação à média do bairro.` : ''}
${contextoGuru ? `\n${contextoGuru}` : ''}

${contextoLocal}

RETORNE SOMENTE um JSON válido neste formato:
{
  "comparativos": [
    {"area": número_m2, "preco": número_reais, "precoM2": número, "fonte": "nome do site", "detalhe": "breve descrição"}
  ],
  "precoMedioM2": número (média de preço/m² dos comparativos),
  "faixaMinM2": número (menor preço/m² encontrado),
  "faixaMaxM2": número (maior preço/m² encontrado),
  "anunciosAnalisados": número,
  "confianca": "alta" se achou 5+ imóveis com filtros exatos, "media" se achou 3-4, "baixa" se menos,
  "raciocinio": "resumo dos anúncios encontrados, com preços e fontes"
}`;

  try {
    console.log(`[Perplexity] Pesquisando preços reais: ${tipo} ${finalidade} ${bairro}, ${cidade}...`);

    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'Você é um pesquisador de mercado imobiliário brasileiro. Sua função é pesquisar preços REAIS e ATUAIS em portais de imóveis (OLX, ZAP, VivaReal, Imovelweb, 62imóveis). NUNCA invente preços. NUNCA use médias nacionais genéricas. Use SOMENTE anúncios reais encontrados na internet para a cidade e bairro solicitados. Retorne SOMENTE JSON válido, sem markdown, sem texto extra.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 2000
    }, {
      timeout: 60000,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    const content = response.data.choices[0].message.content;

    // Perplexity pode retornar JSON dentro de code block
    let jsonStr = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    // Tenta parsear; se falhar (JSON truncado), tenta reparar
    let resultado;
    try {
      resultado = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.warn('[Perplexity] JSON incompleto, tentando reparar...');
      resultado = repararJSON(jsonStr);
      if (!resultado) {
        console.error('[Perplexity] Não foi possível reparar o JSON:', parseErr.message);
        console.error('[Perplexity] Conteúdo recebido:', content.slice(0, 500));
        return null;
      }
    }

    // Validação de sanidade
    if (!resultado.precoMedioM2 || resultado.precoMedioM2 <= 0) {
      console.warn('[Perplexity] Resposta inválida:', resultado);
      return null;
    }

    // Faixas de sanidade por tipo — terrenos podem ter m² bem abaixo de casas/aptos
    const faixas = {
      venda: {
        terreno:      { min: 30,  max: 15000 },
        casa:         { min: 500, max: 30000 },
        apartamento:  { min: 800, max: 30000 },
        comercial:    { min: 200, max: 30000 },
        default:      { min: 100, max: 50000 }
      },
      aluguel: {
        terreno:      { min: 1,   max: 100 },
        casa:         { min: 5,   max: 200 },
        apartamento:  { min: 8,   max: 200 },
        comercial:    { min: 5,   max: 300 },
        default:      { min: 1,   max: 300 }
      }
    };
    const faixa = faixas[finalidade]?.[tipo] || faixas[finalidade]?.default || { min: 30, max: 50000 };
    if (resultado.precoMedioM2 < faixa.min || resultado.precoMedioM2 > faixa.max) {
      console.warn(`[Perplexity] Preço/m² fora da faixa de sanidade para ${tipo}/${finalidade} (${faixa.min}-${faixa.max}):`, resultado.precoMedioM2);
      return null;
    }

    // Extrai fontes citadas pela Perplexity (se disponíveis)
    const citations = response.data.citations || [];

    const analise = {
      precoMedioM2: Math.round(resultado.precoMedioM2),
      faixaMinM2: Math.round(resultado.faixaMinM2 || resultado.precoMedioM2 * 0.85),
      faixaMaxM2: Math.round(resultado.faixaMaxM2 || resultado.precoMedioM2 * 1.15),
      anunciosAnalisados: resultado.anunciosAnalisados || 0,
      comparativos: resultado.comparativos || [],
      confianca: resultado.confianca || 'media',
      raciocinio: resultado.raciocinio || '',
      fonte: 'Pesquisa de mercado (Perplexity)',
      citacoes: citations.slice(0, 5)
    };

    console.log(`[Perplexity] Resultado: R$ ${analise.precoMedioM2}/m² (${analise.confianca}) — ${analise.anunciosAnalisados} anúncios`);

    cache.set(cacheKey, analise, CACHE_TTL);
    return analise;

  } catch (err) {
    console.error('[Perplexity] Erro na tentativa principal:', err.response?.data || err.message);
  }

  // ─── RETRY: tentativa simplificada (sem contexto local) ─────────
  try {
    console.log('[Perplexity] Retry com prompt simplificado...');

    const promptSimples = `Pesquise anúncios REAIS de ${isTerreno ? 'terrenos/lotes vazios (SEM construção)' : tipo + 's'} ${finalidadeLabel} no bairro ${bairro}, ${cidade}-GO (estado de Goiás, Brasil).

Área entre ${metMin}m² e ${metMax}m². Busque em OLX, ZAP, VivaReal, 62imóveis, Chaves na Mão.

${isTerreno ? 'SOMENTE lotes vazios, NÃO inclua casas ou imóveis construídos.' : ''}

Retorne SOMENTE JSON: {"comparativos":[{"area":N,"preco":N,"precoM2":N,"fonte":"site","detalhe":"desc"}],"precoMedioM2":N,"faixaMinM2":N,"faixaMaxM2":N,"anunciosAnalisados":N,"confianca":"alta|media|baixa","raciocinio":"resumo"}`;

    const retryResp = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar',
      messages: [
        { role: 'system', content: 'Pesquisador imobiliário. Retorne SOMENTE JSON válido, curto e direto.' },
        { role: 'user', content: promptSimples }
      ],
      temperature: 0.1,
      max_tokens: 1500
    }, {
      timeout: 60000,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });

    const retryContent = retryResp.data.choices[0].message.content;
    let retryJson = retryContent.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    let retryResult;
    try {
      retryResult = JSON.parse(retryJson);
    } catch {
      retryResult = repararJSON(retryJson);
    }

    if (retryResult && retryResult.precoMedioM2 > 0) {
      const citations = retryResp.data.citations || [];
      const analise = {
        precoMedioM2: Math.round(retryResult.precoMedioM2),
        faixaMinM2: Math.round(retryResult.faixaMinM2 || retryResult.precoMedioM2 * 0.85),
        faixaMaxM2: Math.round(retryResult.faixaMaxM2 || retryResult.precoMedioM2 * 1.15),
        anunciosAnalisados: retryResult.anunciosAnalisados || 0,
        comparativos: retryResult.comparativos || [],
        confianca: retryResult.confianca || 'media',
        raciocinio: retryResult.raciocinio || '',
        fonte: 'Pesquisa de mercado (Perplexity)',
        citacoes: citations.slice(0, 5)
      };
      console.log(`[Perplexity] Retry OK: R$ ${analise.precoMedioM2}/m²`);
      cache.set(cacheKey, analise, CACHE_TTL);
      return analise;
    }
  } catch (retryErr) {
    console.error('[Perplexity] Retry também falhou:', retryErr.message);
  }

  return null;
}

/**
 * Tenta reparar JSON truncado (quando max_tokens corta no meio).
 * Estratégia: fecha arrays/objetos abertos e tenta parsear.
 */
function repararJSON(str) {
  try {
    // Remove trailing incompleto (string cortada, vírgula pendente)
    let s = str.replace(/,\s*$/, '').replace(/,\s*\]/, ']').replace(/,\s*\}/, '}');

    // Conta chaves/colchetes abertos e fecha os que faltam
    let opens = 0, opensArr = 0;
    for (const c of s) {
      if (c === '{') opens++;
      else if (c === '}') opens--;
      else if (c === '[') opensArr++;
      else if (c === ']') opensArr--;
    }

    // Se tem string aberta, fecha
    const lastQuote = s.lastIndexOf('"');
    const quoteCount = (s.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      s = s.slice(0, lastQuote + 1);
      // Reconta
      opens = 0; opensArr = 0;
      for (const c of s) {
        if (c === '{') opens++;
        else if (c === '}') opens--;
        else if (c === '[') opensArr++;
        else if (c === ']') opensArr--;
      }
    }

    // Remove vírgula pendente de novo após corte
    s = s.replace(/,\s*$/, '');

    // Fecha o que falta
    while (opensArr > 0) { s += ']'; opensArr--; }
    while (opens > 0) { s += '}'; opens--; }

    const parsed = JSON.parse(s);
    console.log('[Perplexity] JSON reparado com sucesso');
    return parsed;
  } catch {
    return null;
  }
}

module.exports = { estimarPrecoComIA };
