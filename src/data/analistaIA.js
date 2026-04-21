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
/**
 * Filtra outliers de um array de comparativos usando mediana.
 * Descarta valores que desviam mais de 60% da mediana.
 * Recalcula precoMedioM2 com os valores filtrados.
 */
/**
 * Filtra outliers usando média aparada (trimmed mean):
 * - 4+ amostras: remove o valor mais alto E o mais baixo (extremos distorcem a média)
 * - 2-3 amostras: remove apenas se desviar >80% da mediana
 * Mais justo que filtro por mediana para mercados com poucos anúncios.
 */
function filtrarOutliersComparativos(resultado) {
  if (!resultado || !resultado.comparativos || resultado.comparativos.length < 2) {
    return resultado;
  }

  const validos = resultado.comparativos.filter(c => c.precoM2 > 0);
  if (validos.length < 2) return resultado;

  const ordenados = [...validos].sort((a, b) => a.precoM2 - b.precoM2);

  let filtrados;
  if (ordenados.length >= 4) {
    // Média aparada: remove 1 mais barato e 1 mais caro
    filtrados = ordenados.slice(1, ordenados.length - 1);
    console.log(`[Outlier] Aparado: menor R$${ordenados[0].precoM2}/m² (${ordenados[0].area}m²) e maior R$${ordenados[ordenados.length-1].precoM2}/m² (${ordenados[ordenados.length-1].area}m²)`);
  } else {
    // Poucos comparativos: só remove se desviar >80% da mediana
    const mid = Math.floor(ordenados.length / 2);
    const mediana = ordenados.length % 2 !== 0
      ? ordenados[mid].precoM2
      : (ordenados[mid - 1].precoM2 + ordenados[mid].precoM2) / 2;
    filtrados = validos.filter(c => Math.abs(c.precoM2 - mediana) / mediana <= 0.80);
    if (filtrados.length === 0) filtrados = validos;
  }

  if (filtrados.length === 0) {
    console.log('[Outlier] Nenhum restou — mantendo todos');
    return resultado;
  }

  const soma = filtrados.reduce((acc, c) => acc + c.precoM2, 0);
  const novaMed = Math.round(soma / filtrados.length);
  const descartados = validos.length - filtrados.length;

  return {
    ...resultado,
    comparativos: filtrados,
    precoMedioM2: novaMed,
    faixaMinM2: Math.min(...filtrados.map(c => c.precoM2)),
    faixaMaxM2: Math.max(...filtrados.map(c => c.precoM2)),
    anunciosAnalisados: filtrados.length,
    raciocinio: (resultado.raciocinio || 'Comparativos filtrados') +
      (descartados > 0 ? ` (${descartados} outlier(s) descartado(s))` : '')
  };
}

/**
 * Filtra comparativos de apartamentos por relevância:
 * - Metragem não pode desviar mais de 80% do imóvel avaliado
 * - Quartos não podem diferir mais de 2 do imóvel avaliado
 * Evita que apartamentos de perfis muito diferentes distorçam a média do m²
 */
function filtrarRelevanciaApartamento(resultado, metragemRef, quartosRef) {
  if (!resultado?.comparativos || resultado.comparativos.length < 2) return resultado;

  const descartados = [];
  const filtrados = resultado.comparativos.filter(c => {
    const area = c.area || 0;
    const quartos = c.quartos != null ? c.quartos : null;

    // Filtro de metragem: aceita ±50% da metragem de referência
    // Ex: avaliado 142m² → aceita entre 71m² e 213m²
    if (area > 0 && metragemRef > 0) {
      const desvioArea = Math.abs(area - metragemRef) / metragemRef;
      if (desvioArea > 0.50) {
        descartados.push(`${area}m² descartado (desvia ${Math.round(desvioArea*100)}% da metragem de referência ${metragemRef}m²)`);
        return false;
      }
    }

    // Filtro de quartos: aceita ±1 quarto de diferença
    if (quartos != null && quartosRef != null && quartosRef > 0) {
      const difQuartos = Math.abs(quartos - quartosRef);
      if (difQuartos > 1) {
        descartados.push(`${area}m² ${quartos}q descartado (${difQuartos} quartos de diferença do avaliado com ${quartosRef}q)`);
        return false;
      }
    }

    return true;
  });

  if (descartados.length > 0) {
    console.log(`[Relevância] ${descartados.length} comparativo(s) removido(s) por perfil diferente:`);
    descartados.forEach(d => console.log(`  ↳ ${d}`));
  }

  if (filtrados.length === 0) {
    // Todos descartados por relevância — relaxa o filtro de metragem para ±80%
    // para não ficar sem nenhum comparativo
    console.log('[Relevância] Todos descartados — relaxando filtro para ±80%');
    const filtradosRelaxados = resultado.comparativos.filter(c => {
      const area = c.area || 0;
      if (area > 0 && metragemRef > 0) {
        return Math.abs(area - metragemRef) / metragemRef <= 0.80;
      }
      return true;
    });
    if (filtradosRelaxados.length > 0) {
      const precosR = filtradosRelaxados.map(c => c.precoM2).filter(p => p > 0);
      const somaR = precosR.reduce((a, b) => a + b, 0);
      return {
        ...resultado,
        comparativos: filtradosRelaxados,
        precoMedioM2: Math.round(somaR / precosR.length),
        faixaMinM2: Math.min(...precosR),
        faixaMaxM2: Math.max(...precosR),
        anunciosAnalisados: filtradosRelaxados.length,
        raciocinio: (resultado.raciocinio || '') + ' (filtro de relevância relaxado — poucos comparativos do mesmo porte na região)'
      };
    }
    // Se ainda vazio, mantém todos
    return resultado;
  }

  const precosValidos = filtrados.map(c => c.precoM2).filter(p => p > 0);
  const soma = precosValidos.reduce((a, b) => a + b, 0);
  const novaMedia = Math.round(soma / precosValidos.length);

  return {
    ...resultado,
    comparativos: filtrados,
    precoMedioM2: novaMedia,
    faixaMinM2: Math.min(...precosValidos),
    faixaMaxM2: Math.max(...precosValidos),
    anunciosAnalisados: filtrados.length,
    raciocinio: (resultado.raciocinio || '') +
      (descartados.length > 0 ? ` (${descartados.length} comparativo(s) de perfil diferente descartado(s))` : '')
  };
}

async function estimarPrecoComIA(dadosImovel) {
  const { tipo, finalidade, cidade, bairro, endereco, condominio, metragem, quartos, vagas, diferenciais, conservacao, geoInfo, contextoGuru } = dadosImovel;

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
    // A lógica correta de precificação por amostragem:
    // 1. Coletar N lotes anunciados na região (qualquer tamanho)
    // 2. Calcular preço/m² de cada um: preço ÷ área
    // 3. Somar todos os preço/m² e dividir por N → média do m² da região
    // 4. Multiplicar pela metragem do imóvel avaliado → preço sugerido
    prompt = `Você é um pesquisador de mercado imobiliário. Preciso calcular o PREÇO MÉDIO DO METRO QUADRADO de terrenos/lotes em ${bairro}, ${cidade}-GO.

## MÉTODO (siga exatamente):

**PASSO 1 — Colete lotes anunciados**
Pesquise lotes/terrenos VAZIOS à venda em ${bairro} e região em ${cidade}-GO nos portais abaixo.
Acesse cada URL diretamente:
• vivareal.com.br → busque "terreno ${bairro} ${cidade}"
• zapimoveis.com.br → busque "lote ${bairro} ${cidade} GO"  
• chavesnamao.com.br → busque "terreno ${cidade} GO ${bairro}"
• olx.com.br → busque "terreno ${bairro} ${cidade} Goiás"
• 62imoveis.com.br → busque terrenos em ${cidade}, bairro ${bairro}
• encontreimoveisanapolis.com.br → busque lotes em ${bairro}
• mgfimoveis.com.br e dfimoveis.com.br → busque lotes em ${bairro}

**PASSO 2 — Para cada lote encontrado, anote:**
| Área (m²) | Preço (R$) | Preço/m² | Fonte |
|---|---|---|---|
| ex: 360 | ex: 290.000 | ex: 806 | vivareal |

Preço/m² = Preço ÷ Área. Calcule para CADA lote individualmente.

**PASSO 3 — Se achar menos de 5 lotes em ${bairro}:**
Amplie para os bairros vizinhos: ${vizinhosTexto || 'bairros próximos de perfil similar'}
Continue coletando até ter no mínimo 3 lotes no total.

**PASSO 4 — Calcule a média:**
Média do m² = (preço/m² do lote 1 + preço/m² do lote 2 + ... + preço/m² do lote N) ÷ N

## REGRAS ABSOLUTAS:
- SOMENTE lotes/terrenos VAZIOS — ignore casas, sobrados, galpões, construídos
- SOMENTE ${cidade}-GO (Goiás, Brasil) — nunca confunda com cidades homônimas
- NUNCA invente preços — use apenas anúncios reais que você encontrar
- Aceite qualquer tamanho de lote — o que importa é o preço/m² da região
- Registre a fonte (nome do site) de cada anúncio

## RETORNE o JSON com os lotes coletados e a média calculada:`;

  } else if (isApto) {
    // ─── LÓGICA PARA APARTAMENTOS ─────────────────────────────
    // Busca em 2 etapas: primeiro no mesmo condomínio (se informado), depois no bairro
    const condominioTexto = condominio ? `"${condominio}"` : null;
    prompt = `Você é um pesquisador de mercado imobiliário. Preciso calcular o PREÇO MÉDIO DO METRO QUADRADO de apartamentos ${finalidadeLabel} em ${bairro}, ${cidade}-GO.

## APARTAMENTO AVALIADO:
- Localização: ${bairro}, ${cidade}-GO${endereco ? ` (${endereco})` : ''}${condominioTexto ? `
- Condomínio/Edifício: ${condominioTexto}` : ''}
- Área: ${metragem}m² | ${quartos} quartos | ${vagas} vaga(s)
- Estado: ${conservacao}

## MÉTODO DE PESQUISA (siga essa ordem):

${condominioTexto ? `**ETAPA 1 — Busque no mesmo condomínio/edifício:**
Pesquise apartamentos ${finalidadeLabel} no condomínio ${condominioTexto} em ${cidade}-GO.
Sites: vivareal.com.br, zapimoveis.com.br, 62imoveis.com.br, chavesnamao.com.br, olx.com.br
Para cada anúncio: registre área (m²), preço (R$), preço/m² = preço ÷ área.

**ETAPA 2 — Se achar menos de 3 no mesmo condomínio, amplie para o bairro:**` :
`**ETAPA 1 — Busque no bairro ${bairro}:**`}
Pesquise apartamentos ${finalidadeLabel} em ${bairro}, ${cidade}-GO nos portais:
- vivareal.com.br → busque "apartamento ${bairro} ${cidade}"
- zapimoveis.com.br → busque "apartamento ${bairro} ${cidade} GO"
- chavesnamao.com.br → "apartamentos ${cidade} GO ${bairro}"
- 62imoveis.com.br, olx.com.br, encontreimoveisanapolis.com.br

**ETAPA ${condominioTexto ? '3' : '2'} — Se não achar 5+ anúncios no bairro:**
Amplie para bairros vizinhos de perfil similar: ${vizinhosTexto || geoInfo?.bairrosProximos?.join(', ') || 'bairros próximos'}

## PARA CADA ANÚNCIO ENCONTRADO:
| Condomínio/Edifício | Área (m²) | Preço (R$) | Preço/m² | Estado | Fonte |
Preço/m² = Preço ÷ Área (calcule individualmente para cada anúncio)

## CATEGORIA DE REFERÊNCIA:
O apartamento avaliado está em estado "${conservacao}":
${conservacao === 'novo' ? '→ Priorize NOVOS (na planta ou recém-entregues)' : conservacao === 'bom' ? '→ Priorize SEMI-NOVOS (até 5 anos, bom estado)' : '→ Priorize USADOS (revenda, mais de 5 anos)'}
Mas registre TODOS os anúncios encontrados para calcular a média geral do bairro.

## REGRAS:
- SOMENTE ${cidade}-GO (Goiás) — nunca use dados de outras cidades
- NUNCA invente preços — apenas anúncios reais encontrados
- **PRIORIZE apartamentos de tamanho similar**: entre ${Math.round(metragem*0.5)}m² e ${Math.round(metragem*1.5)}m² e com ${quartos > 1 ? quartos - 1 + ' a ' + (quartos + 1) : quartos} quartos
- Se não achar suficientes desse porte, amplie para qualquer tamanho no bairro
- Busque no mínimo 3 e no máximo 15 anúncios
- Calcule: Média = soma(preço/m² de cada anúncio) ÷ N`;

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

SITES PARA CONSULTAR (em ordem de prioridade): VivaReal, ZAP Imóveis, Chaves na Mão, OLX, 62imóveis, Imovelweb, encontreimoveisanapolis.com.br, mgfimoveis.com.br, dfimoveis.com.br, quintoandar.com.br

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
    {"area": número_m2, "preco": número_reais, "precoM2": número, "quartos": número_ou_null, "fonte": "nome do site", "detalhe": "breve descrição"}
  ],
  "precoMedioM2": número (média de preço/m² dos comparativos, EXCLUINDO outliers: descarte qualquer valor que desvie mais de 60% da mediana antes de calcular a média),
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

    // Recalcula precoMedioM2 a partir dos comparativos brutos (média simples dos preço/m²)
    // Garante que a média é sempre: soma(precoM2 de cada lote) ÷ N
    // independente do que o modelo calculou
    if (resultado.comparativos && resultado.comparativos.length > 0) {
      const precosValidos = resultado.comparativos
        .map(c => Number(c.precoM2))
        .filter(p => p > 0);
      if (precosValidos.length > 0) {
        const somaM2 = precosValidos.reduce((acc, p) => acc + p, 0);
        const mediaRecalculada = Math.round(somaM2 / precosValidos.length);
        if (Math.abs(mediaRecalculada - resultado.precoMedioM2) > 50) {
          console.log(`[Precificador] Recalculo média: modelo=${resultado.precoMedioM2} → correto=${mediaRecalculada} (${precosValidos.length} amostras)`);
        }
        resultado.precoMedioM2 = mediaRecalculada;
        resultado.faixaMinM2 = Math.min(...precosValidos);
        resultado.faixaMaxM2 = Math.max(...precosValidos);
        resultado.anunciosAnalisados = precosValidos.length;
      }
    }
    // Mantém todos os comparativos para calcular a média do m² da região
    // (mesmo metodologia dos terrenos — quanto mais amostras, melhor a média)
    // Filtro de outliers apenas para valores absurdos (>60% da mediana)
    resultado = filtrarOutliersComparativos(resultado);
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

Retorne SOMENTE JSON: {"comparativos":[{"area":N,"preco":N,"precoM2":N,"fonte":"site","detalhe":"desc"}],"precoMedioM2":N (média SEM outliers — exclua valores que desviem >60% da mediana),"faixaMinM2":N,"faixaMaxM2":N,"anunciosAnalisados":N,"confianca":"alta|media|baixa","raciocinio":"resumo"}`;

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
      retryResult = filtrarOutliersComparativos(retryResult);
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
