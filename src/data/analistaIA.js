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
 * Filtra comparativos por relevância (apartamentos e casas):
 * - Metragem não pode desviar mais de 80% do imóvel avaliado
 * - Quartos (opcional) não podem diferir mais de 2
 * Evita que imóveis de perfis muito diferentes distorçam a média do m²
 * IMPORTANTE: só remove quando há amostras suficientes — nunca deixa vazio.
 */
function filtrarRelevanciaApartamento(resultado, metragemRef, quartosRef, tipo = 'apartamento') {
  if (!resultado?.comparativos || resultado.comparativos.length < 2) return resultado;

  // Para casas: filtro assimétrico
  //   - Casa avaliada pequena/média (<= 250m²): ±70% simétrico
  //   - Casa avaliada grande (> 250m²): sem mínimo restritivo — aceita qualquer tamanho
  //     menor (preço/m² do bairro vale para todos); limita superior a +100%
  // Para apartamentos: ±50% simétrico
  const filtrarQuartos = tipo === 'apartamento';

  const descartados = [];
  const filtrados = resultado.comparativos.filter(c => {
    const area = c.area || 0;
    const quartos = c.quartos != null ? c.quartos : null;

    // Filtro de metragem por tipo e tamanho
    if (area > 0 && metragemRef > 0) {
      if (tipo === 'casa') {
        if (metragemRef > 250) {
          // Casa grande: sem filtro mínimo (bairro tem poucas casas grandes)
          // Apenas descarta casas absurdamente maiores (>3x a avaliada)
          if (area > metragemRef * 3) {
            descartados.push(`${area}m² descartado (${Math.round(area/metragemRef)}x maior que a avaliada de ${metragemRef}m²)`);
            return false;
          }
        } else {
          // Casa média/pequena: ±70% simétrico
          const desvioArea = Math.abs(area - metragemRef) / metragemRef;
          if (desvioArea > 0.70) {
            descartados.push(`${area}m² descartado (desvia ${Math.round(desvioArea*100)}% da metragem de referência ${metragemRef}m²)`);
            return false;
          }
        }
      } else {
        // Apartamento: ±65% simétrico (mais tolerante — amostra melhor)
        const desvioArea = Math.abs(area - metragemRef) / metragemRef;
        if (desvioArea > 0.65) {
          descartados.push(`${area}m² descartado (desvia ${Math.round(desvioArea*100)}% da metragem de referência ${metragemRef}m²)`);
          return false;
        }
      }
    }

    // Filtro de quartos: aceita ±1 quarto de diferença (apenas apartamentos)
    if (filtrarQuartos && quartos != null && quartosRef != null && quartosRef > 0) {
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

  if (filtrados.length < 3) {
    // Poucos sobraram (<3) — relaxa o filtro de metragem para ±90% para não
    // esvaziar a amostra e aproveitar mais anúncios reais.
    console.log(`[Relevância] Só ${filtrados.length} sobrou(aram) — relaxando filtro para ±90%`);
    const filtradosRelaxados = resultado.comparativos.filter(c => {
      const area = c.area || 0;
      if (area > 0 && metragemRef > 0) {
        return Math.abs(area - metragemRef) / metragemRef <= 0.90;
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

/**
 * Filtra comparativos cujo bairro informado tem padrão de preço incompatível
 * com o bairro avaliado. Usa BAIRROS (bairros.js) para verificar multiplicador.
 * Remove bairros cujo mult difere mais de 0.25 do bairro avaliado.
 * Nunca deixa o resultado vazio — se todos forem filtrados, mantm original.
 */
/**
 * Filtra comparativos comerciais por relevância:
 * - Metragem dentro de ±50% do imóvel avaliado (mais restritivo que apto pq sub-tipos
 *   misturados destroem o preço/m²)
 * - Detecta e descarta anúncios poluentes: coworking, diária, salas virtuais, escritórios
 *   compartilhados — fontes/detalhes com essas palavras
 * - Nunca esvazia: se sobrar menos de 2, relaxa pra ±80%
 */
function filtrarRelevanciaComercial(resultado, metragemRef) {
  if (!resultado?.comparativos || resultado.comparativos.length < 2) return resultado
  if (!metragemRef || metragemRef <= 0) return resultado

  const padraoPoluente = /coworking|cowork|virtual|compartilh|por\s+(hora|dia|diári|semana)|temporári|day\s*use/i
  const descartados = []
  const filtrados = resultado.comparativos.filter(c => {
    const txt = `${c.detalhe || ''} ${c.fonte || ''} ${c.tipo || ''}`.trim()
    if (padraoPoluente.test(txt)) {
      descartados.push(`${c.area || '?'}m² descartado (poluente: ${txt.match(padraoPoluente)?.[0]})`)
      return false
    }
    const area = c.area || 0
    if (area > 0) {
      const desvio = Math.abs(area - metragemRef) / metragemRef
      if (desvio > 0.5) {
        descartados.push(`${area}m² descartado (desvia ${Math.round(desvio * 100)}% de ${metragemRef}m²)`)
        return false
      }
    }
    return true
  })

  if (descartados.length > 0) {
    console.log(`[RelevânciaComercial] ${descartados.length} descartado(s):`)
    descartados.forEach(d => console.log(`  ↳ ${d}`))
  }

  // Relax: se sobrou menos de 2, aumenta tolerância pra ±80% (mantém o filtro de poluente)
  let final = filtrados
  if (final.length < 2) {
    final = resultado.comparativos.filter(c => {
      const txt = `${c.detalhe || ''} ${c.fonte || ''} ${c.tipo || ''}`.trim()
      if (padraoPoluente.test(txt)) return false
      const area = c.area || 0
      if (area > 0 && Math.abs(area - metragemRef) / metragemRef > 0.8) return false
      return true
    })
    if (final.length === 0) return resultado // mantém original
    console.log('[RelevânciaComercial] Relaxado para ±80%')
  }

  const precos = final.map(c => c.precoM2).filter(p => p > 0)
  if (precos.length === 0) return resultado
  const soma = precos.reduce((a, b) => a + b, 0)
  return {
    ...resultado,
    comparativos: final,
    precoMedioM2: Math.round(soma / precos.length),
    faixaMinM2: Math.min(...precos),
    faixaMaxM2: Math.max(...precos),
    anunciosAnalisados: final.length,
    raciocinio: (resultado.raciocinio || '')
      + (descartados.length > 0 ? ` (${descartados.length} comparativo(s) fora do perfil comercial descartado(s))` : ''),
  }
}

function filtrarComparativosPorBairro(resultado, bairroRef) {
  if (!resultado?.comparativos || resultado.comparativos.length < 2) return resultado;
  const { BAIRROS } = require('./bairros');
  const bairroKey = (bairroRef || '').toLowerCase().trim();
  const multRef = BAIRROS[bairroKey]?.mult;
  if (!multRef) return resultado; // bairro desconhecido, não filtra

  const descartados = [];
  const filtrados = resultado.comparativos.filter(c => {
    // Se o comparativo não tem campo bairro, mantém
    const bComp = (c.bairro || '').toLowerCase().trim();
    if (!bComp) return true;
    const multComp = BAIRROS[bComp]?.mult;
    if (!multComp) return true; // bairro desconhecido, não descarta
    const diff = Math.abs(multComp - multRef);
    if (diff > 0.25) {
      descartados.push(`${bComp} (mult=${multComp} vs ref=${multRef}, diff=${diff.toFixed(2)})`);
      return false;
    }
    return true;
  });

  if (descartados.length > 0) {
    console.log(`[FiltroBairro] Descartados por padrão diferente: ${descartados.join('; ')}`);
  }

  // Só aplica se sobrar pelo menos 2 (evita esvaziar resultado)
  if (filtrados.length < 2) return resultado;

  const precosValidos = filtrados.map(c => c.precoM2).filter(p => p > 0);
  if (precosValidos.length === 0) return resultado;
  const soma = precosValidos.reduce((a, b) => a + b, 0);
  return {
    ...resultado,
    comparativos: filtrados,
    precoMedioM2: Math.round(soma / precosValidos.length),
    faixaMinM2: Math.min(...precosValidos),
    faixaMaxM2: Math.max(...precosValidos),
    anunciosAnalisados: filtrados.length
  };
}

async function estimarPrecoComIA(dadosImovel) {
  const { tipo, finalidade, cidade, bairro, endereco, condominio, metragem, areaLote, quartos, vagas, diferenciais, conservacao, geoInfo, contextoGuru } = dadosImovel;

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
    // Não usa cache se confiança for baixa (< 3 amostras) — força nova busca
    if (cached.confianca === 'baixa' || (cached.anunciosAnalisados || 0) < 3) {
      console.log(`[Perplexity] Cache hit ignorado (confiança=${cached.confianca}, amostras=${cached.anunciosAnalisados || 0}) — refazendo busca: ${cacheKey}`);
    } else {
      console.log(`[Perplexity] Cache hit: ${cacheKey}`);
      return cached;
    }
  }

  // Cache similar: SOMENTE para apartamentos (metragem varia pouco, preço/m² do bairro é estável)
  // Para terrenos e casas: NÃO reaproveitar — metragem afeta muito o resultado (fator escala terreno,
  // e casas grandes têm perfil de mercado diferente de casas pequenas no mesmo bairro)
  if (tipo === 'apartamento') {
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
  const isRural = tipo === 'rural';

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

## RETORNE o JSON com os lotes coletados e a média calculada:
{
  "comparativos": [
    {"area": número_m2, "preco": número_reais, "precoM2": número, "bairro": "nome do bairro", "fonte": "nome do site", "detalhe": "breve descrição"}
  ],
  "precoMedioM2": número (média dos preço/m² de todos os lotes),
  "faixaMinM2": número, "faixaMaxM2": número,
  "anunciosAnalisados": número,
  "confianca": "alta" se 5+ lotes, "media" se 3-4, "baixa" se menos,
  "raciocinio": "resumo dos lotes encontrados"
}
IMPORTANTE: campo "bairro" em cada comparativo é obrigatório.`;

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
- Busque o MÁXIMO de anúncios reais possível: de 8 a 25 (quanto mais, melhor a amostra). Não pare no primeiro que achar.
- **RETORNE TODOS OS COMPARATIVOS ENCONTRADOS — não filtre nem descarte nenhum**
- O sistema fará a filtragem estatística depois — sua tarefa é coletar dados brutos
- Calcule: Média = soma(preço/m² de cada anúncio) ÷ N`;

  } else if (isCasa) {
    // ─── LÓGICA PARA CASAS ────────────────────────────────────
    const casaGrande = metragem >= 250;
    const faixaCasaMin = Math.round(metragem * 0.5);
    const faixaCasaMax = Math.round(metragem * 2.0);
    prompt = `Você é um pesquisador de mercado imobiliário. Preciso calcular o PREÇO MÉDIO DO METRO QUADRADO de casas ${finalidadeLabel} em ${bairro}, ${cidade}-GO (estado de Goiás, Brasil — NÃO confunda com outras cidades).

## CASA AVALIADA:
- Localização: ${bairro}, ${cidade}-GO${endereco ? ` (${endereco})` : ''}
- Área construída: ${metragem}m² | ${quartos} quartos | ${vagas} vaga(s)${areaLote ? `
- Lote: ${areaLote}m²` : ''}
- Estado: ${conservacao}
- Diferenciais: ${difsTexto}

## MÉTODO (siga exatamente):

**PASSO 1 — Colete casas em ${cidade}-GO**
Pesquise casas ${finalidadeLabel} em ${bairro} e região em ${cidade}-GO nos portais:
• vivareal.com.br → busque "casa ${bairro} ${cidade}" e "casa ${cidade} Goiás"
• zapimoveis.com.br → busque "casa ${bairro} ${cidade} GO" e "casa à venda ${cidade} GO"
• chavesnamao.com.br → "casas ${cidade} GO" filtrado por bairro "${bairro}"
• olx.com.br → "casa ${bairro} ${cidade} Goiás" e "casa ${cidade} Goiás"
• 62imoveis.com.br → casas em ${cidade}, bairro ${bairro}
• encontreimoveisanapolis.com.br → casas em ${bairro}
• mgfimoveis.com.br, dfimoveis.com.br

**PASSO 2 — Para cada casa encontrada:**
| Área construída (m²) | Quartos | Preço (R$) | Preço/m² | Bairro | Estado | Fonte |
Preço/m² = Preço ÷ Área CONSTRUÍDA (não o lote). Use sempre a área construída/útil do anúncio.

**PASSO 3 — Se achar menos de 5 casas em ${bairro}:**
Amplie para bairros SIMILARES de ${cidade}-GO — mesmo padrão construtivo e faixa de preço:
${vizinhosTexto ? `Prioritários: ${vizinhosTexto}` : `Bairros próximos de perfil similar ao ${bairro}`}
⚠️ NÃO MISTURE bairros de padrão muito diferente. Exemplo: casas do Centro (bairro antigo) NÃO devem ser comparadas com casas de condomínios novos ou bairros premium.
Se necessário, aceite bairros de padrão similar até encontrar 5 comparativos.

## PRIORIDADE DE TAMANHO:
${casaGrande
  ? `Esta é uma casa grande (${metragem}m²). Priorize casas entre ${faixaCasaMin}m² e ${faixaCasaMax}m². Casas muito pequenas (< ${faixaCasaMin}m²) têm preço/m² muito diferente — inclua-as apenas se não houver outras opções.`
  : `Priorize casas entre ${faixaCasaMin}m² e ${faixaCasaMax}m² para comparação mais precisa. Aceite qualquer tamanho se não houver suficientes.`
}

## ESTADO DE CONSERVAÇÃO:
${conservacao === 'novo'
  ? 'Esta é uma casa NOVA. Priorize casas novas ou recém-construídas (até 5 anos). Aceite casas em bom estado se não houver novas suficientes.'
  : conservacao === 'bom'
    ? 'Esta é uma casa em BOM ESTADO (5-15 anos, conservada). Priorize casas bem mantidas. Aceite novas ou usadas se necessário.'
    : `Esta é uma casa ANTIGA ou que PRECISA DE REFORMA. Priorize casas velhas, com bids de reforma, ou antigas do bairro ${bairro}. Se não houver, aceite casas usadas em geral — o sistema aplica desconto de reforma separadamente.`
}
Registre TODOS os anúncios encontrados — não descarte nenhum.

## REGRAS ABSOLUTAS:
- SOMENTE ${cidade}-GO (estado de Goiás, Brasil) — ignore outras cidades
- NUNCA invente preços — use apenas anúncios reais e atuais
- SOMENTE casas construídas — ignore apartamentos, terrenos, comerciais
- RETORNE TODOS OS COMPARATIVOS ENCONTRADOS — o sistema faz a filtragem
- Mínimo 5, máximo 15 anúncios
- Se não achar 5 no bairro, amplie para a cidade inteira`;

  } else if (isRural) {
    // ─── LÓGICA PARA RURAL (chácara, sítio, fazenda) ──────────
    const { subTipoRural, areaAlqueires, acessoAsfalto, margemAsfalto, temAgua, temEnergia, benfeitorias, rodoviaReferencia } = dadosImovel;

    const areaHa = areaAlqueires ? (areaAlqueires * 4.84).toFixed(1) : (metragem / 10000).toFixed(1);
    const alqLabel = areaAlqueires ? `${areaAlqueires} alqueires (${areaHa} ha)` : `${areaHa} ha`;
    const subLabel = subTipoRural || 'propriedade rural';
    const rodovia = rodoviaReferencia ? `na ${rodoviaReferencia}` : `em ${cidade}-GO`;
    const acessoLabel = margemAsfalto ? 'beira de asfalto (sem estrada de chão)' : acessoAsfalto ? 'acesso pelo asfalto' : 'estrada de chão';
    const benfeitoriasTexto = Array.isArray(benfeitorias) && benfeitorias.length > 0 ? benfeitorias.join(', ') : 'não informadas';

    prompt = `Você é um pesquisador especializado em mercado imobiliário RURAL. Preciso calcular o PREÇO MÉDIO POR ALQUEIRE de ${subLabel}s à venda em ${cidade}-GO e região, especialmente próximo a ${rodoviaReferencia || 'rodovias locais'}.

## PROPRIEDADE AVALIADA:
- Tipo: ${subLabel}
- Localização: ${cidade}-GO${rodoviaReferencia ? `, ${rodoviaReferencia}` : ''}
- Área: ${alqLabel}
- Acesso: ${acessoLabel}
- Água: ${temAgua ? 'sim (poço/nascente/córrego/represa)' : 'não informado'}
- Energia: ${temEnergia ? 'sim' : 'não informado'}
- Benfeitorias: ${benfeitoriasTexto}

## MÉTODO (siga exatamente):

**PASSO 1 — Colete propriedades rurais anunciadas**
Pesquise ${subLabel}s à venda em ${cidade}-GO e cidades próximas (Goianápolis, Abadiânia, Nerópolis, Campo Limpo de Goiás) nos portais:
• zapimoveis.com.br → busque "${subLabel} venda ${cidade} GO"
• olx.com.br → busque "${subLabel} ${cidade} Goiás venda"
• chavesnamao.com.br → busque "${subLabel} ${cidade} GO"
• ruralpecuaria.com.br → busque "${subLabel} ${cidade} Goiás"
• fazendaaberta.com.br → busque propriedades em ${cidade} e entorno
• 62imoveis.com.br → rural em ${cidade}-GO
• credruralimoveis.com.br, mgfimoveis.com.br

**PASSO 2 — Para cada propriedade encontrada:**
| Área (alq) | Área (ha) | Preço (R$) | Preço/alq | Acesso | Água | Benfeitorias | Localização | Fonte |
Preço/alq = Preço ÷ alqueires (1 alq goiano = 4,84 ha = 48.400 m²)
Se a área estiver em m² ou ha, converta: m²÷48400 = alqueires; ha÷4,84 = alqueires

**PASSO 3 — Se achar menos de 4 propriedades em ${cidade}:**
Amplie para municípios vizinhos: Goianápolis, Abadiânia, Nerópolis, Campo Limpo de Goiás, Silvânia, Anápolis
Priorize propriedades com perfil similar (${subLabel}, ${acessoLabel})

## FOCO DE BUSCA:
${margemAsfalto
  ? `PRIORIDADE MÁXIMA: propriedades que BEIRAM O ASFALTO (GO-415, BR-153, BR-060, GO-330 ou outras rodovias). Beira de asfalto sem chão tem prêmio significativo no mercado rural goiano.`
  : acessoAsfalto
    ? `Priorize propriedades com acesso pelo asfalto.`
    : `Aceite qualquer tipo de acesso.`
}
Tipo prioritário: ${subLabel}s${areaAlqueires ? ` de tamanho similar (${Math.max(1, areaAlqueires - 5)} a ${areaAlqueires + 10} alqueires)` : ''}

## REGRAS ABSOLUTAS:
- SOMENTE Goiás (região de Anápolis/Goiânia) — ignore outros estados
- NUNCA invente preços — use apenas anúncios reais
- SOMENTE propriedades rurais — ignore urbanas
- Converta todas as áreas para alqueires no resultado
- Mínimo 4, máximo 12 comparativos

RETORNE SOMENTE um JSON válido:
{
  "comparativos": [
    {"areaAlq": número, "areaHa": número, "preco": número, "precoAlq": número, "precoM2": número (preço÷área_m²), "acesso": "asfalto|chão", "agua": true/false, "benfeitorias": "resumo", "bairro": "município/localização", "fonte": "site", "detalhe": "descrição"}
  ],
  "precoMedioAlq": número (média simples de todos preço/alq),
  "precoMedioM2": número (precoMedioAlq ÷ 48400 para compatibilidade),
  "faixaMinAlq": número, "faixaMaxAlq": número,
  "faixaMinM2": número, "faixaMaxM2": número,
  "anunciosAnalisados": número,
  "confianca": "alta" se 5+ comparativos, "media" se 3-4, "baixa" se menos,
  "raciocinio": "resumo dos anúncios encontrados, preços por alqueire, perfil de acesso"
}`;

  } else {
    // ─── LÓGICA PARA COMERCIAL ────────────────────────────────
    // Detecta sub-tipo a partir dos diferenciais (ou cai em "sala/loja" como default).
    const subtipoMatch = (diferenciais || []).find(d => /sala|loja|galpão|galp|pavilh|laje|conjunto|andar|ponto/i.test(d))
      || (condominio && /galp/i.test(condominio) ? 'galpão' : null)
      || 'sala/loja comercial';
    const ehGalpao = /galp|pavilh/i.test(subtipoMatch);
    const ehLaje = /laje|andar/i.test(subtipoMatch);
    const minMet = Math.max(20, Math.round(metragem * 0.6));
    const maxMet = Math.round(metragem * 1.4);

    prompt = `Você é um pesquisador de mercado imobiliário COMERCIAL em ${cidade}-GO. Preciso calcular o PREÇO MÉDIO DO METRO QUADRADO para ${finalidadeLabel === 'para ALUGAR' ? 'ALUGUEL MENSAL TRADICIONAL (contrato fixo, não temporário)' : 'VENDA'} de imóveis comerciais em ${bairro}.

## IMÓVEL AVALIADO:
- Sub-tipo: ${subtipoMatch}
- Localização: ${bairro}, ${cidade}-GO${endereco ? ` (${endereco})` : ''}${condominio ? `\n- Edifício/condomínio: ${condominio}` : ''}
- Área: ${metragem}m²
- Estado: ${conservacao || 'não informado'}
- Diferenciais: ${difsTexto}

## MÉTODO (siga estritamente):

**PASSO 1 — Pesquise anúncios reais em ${cidade}-GO**
${ehGalpao ? `Foque em GALPÕES / PAVILHÕES industriais ou comerciais. Sites:
• vivareal.com.br → "galpão ${bairro} ${cidade}"
• zapimoveis.com.br → "galpão ${cidade} GO"
• olx.com.br → "galpão ${cidade} Goiás"
• 62imoveis.com.br, encontreimoveisanapolis.com.br`
: ehLaje ? `Foque em LAJES CORPORATIVAS / ANDARES INTEIROS. Sites:
• vivareal.com.br → "laje corporativa ${cidade}"
• zapimoveis.com.br → "andar corporativo ${bairro} ${cidade}"
• 62imoveis.com.br`
: `Foque em SALAS COMERCIAIS, LOJAS, PONTOS COMERCIAIS de aluguel mensal tradicional. Sites:
• vivareal.com.br → "sala comercial ${bairro} ${cidade}" e "loja ${bairro} ${cidade}"
• zapimoveis.com.br → "sala comercial ${cidade} GO ${bairro}"
• olx.com.br → "sala comercial ${cidade} ${bairro}"
• 62imoveis.com.br → bairro ${bairro}
• encontreimoveisanapolis.com.br`}

**PASSO 2 — Anote cada anúncio em tabela:**
| Sub-tipo | Área (m²) | Preço mensal (R$) | Preço/m² | Bairro | Fonte/URL |
Preço/m² = Preço ÷ Área. Calcule individualmente, não acredite no número que o anúncio mostra.

**PASSO 3 — Se achar menos de 5 no bairro:**
Amplie SOMENTE para bairros vizinhos de perfil COMERCIAL similar (não pegue zonas residenciais nobres pq elas têm aluguel comercial superestimado): ${vizinhosTexto || 'bairros próximos de mesmo padrão comercial'}.

## EXCLUA OBRIGATORIAMENTE (anúncios poluentes):
- ❌ Coworking, salas virtuais, escritórios compartilhados
- ❌ Aluguel por diária, semanal, ou temporada
- ❌ Salas de reunião (cobrança por hora)
- ❌ Sub-tipo MUITO diferente do avaliado: ${ehGalpao ? 'ignore salas/lojas pequenas' : ehLaje ? 'ignore salas pequenas e lojas de rua' : 'ignore galpões industriais e lajes corporativas inteiras'}
- ❌ Imóveis em condomínios/shoppings premium quando o avaliado é em prédio comum (e vice-versa)
- ❌ Anúncios sem área (m²) declarada
- ❌ Anúncios fora de ${cidade}-GO

## PRIORIZE (em ordem):
1. Mesmo sub-tipo (${subtipoMatch}) E metragem entre ${minMet}m² e ${maxMet}m² (±40% do avaliado)
2. Mesmo sub-tipo, qualquer metragem dentro do bairro
3. Sub-tipo compatível em bairros vizinhos comerciais

## REGRAS ABSOLUTAS:
- SOMENTE ${cidade}-GO (Goiás, Brasil)
- SOMENTE aluguel mensal tradicional (contrato fixo)
- NUNCA invente — apenas anúncios reais com URL rastreável
- Mínimo 3, máximo 12 anúncios
- RETORNE TODOS os comparativos coletados (o sistema filtra outliers depois). Não filtre você.
- Informe a metragem real do anúncio — se o anúncio não declarar, NÃO inclua`;
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
    {"area": número_m2, "preco": número_reais, "precoM2": número, "quartos": número_ou_null, "bairro": "nome do bairro exato", "fonte": "nome do site", "detalhe": "breve descrição"}
  ],
  "precoMedioM2": número (média simples de TODOS os preço/m² — NÃO descarte nenhum valor, retorne todos os comparativos encontrados),
  "faixaMinM2": número (menor preço/m² encontrado),
  "faixaMaxM2": número (maior preço/m² encontrado),
  "anunciosAnalisados": número,
  "confianca": "alta" se achou 5+ imóveis com filtros exatos, "media" se achou 3-4, "baixa" se menos,
  "raciocinio": "resumo dos anúncios encontrados, com preços e fontes"
}
IMPORTANTE: o campo "bairro" em cada comparativo deve conter o nome exato do bairro do anúncio (ex: "Centro", "Anápolis City", "Vila Brasil"). NÃO omita esse campo.`;

  try {
    console.log(`[Perplexity] Pesquisando preços reais: ${tipo} ${finalidade} ${bairro}, ${cidade}...`);

    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar-pro',
      messages: [
        {
          role: 'system',
          content: 'Você é um pesquisador de mercado imobiliário brasileiro. Sua função é pesquisar preços REAIS e ATUAIS em portais de imóveis (OLX, ZAP, VivaReal, Imovelweb, 62imóveis). NUNCA invente preços. NUNCA use médias nacionais genéricas. Use SOMENTE anúncios reais encontrados na internet para a cidade e bairro solicitados. Retorne SOMENTE JSON válido, sem markdown, sem texto extra.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 3200
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
      throw new Error('precoMedioM2 inválido — forçando retry');
    }

    // Sem comparativos = Perplexity inventou a média sem buscar anúncios reais — retry
    if (!resultado.comparativos || resultado.comparativos.length === 0) {
      console.warn('[Perplexity] 0 comparativos retornados — forçando retry para buscar anúncios reais');
      throw new Error('0 comparativos — forçando retry');
    }

    // Faixas de sanidade por tipo — terrenos podem ter m² bem abaixo de casas/aptos
    const faixas = {
      venda: {
        terreno:      { min: 30,  max: 15000 },
        casa:         { min: 500, max: 30000 },
        apartamento:  { min: 800, max: 30000 },
        comercial:    { min: 200, max: 30000 },
        rural:        { min: 1,   max: 500   }, // rural em R$/m² — chácara R$400k/alq = ~R$8/m²
        default:      { min: 100, max: 50000 }
      },
      aluguel: {
        terreno:      { min: 1,   max: 100 },
        casa:         { min: 5,   max: 200 },
        apartamento:  { min: 8,   max: 200 },
        comercial:    { min: 5,   max: 300 },
        rural:        { min: 0.001, max: 5  }, // rural aluguel em R$/m²/mês
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

    // Recalcula médias a partir dos comparativos brutos
    if (resultado.comparativos && resultado.comparativos.length > 0) {
      if (tipo === 'rural') {
        // Rural: recalcula precoMedioAlq e deriva precoMedioM2
        const precosAlqValidos = resultado.comparativos
          .map(c => Number(c.precoAlq))
          .filter(p => p > 0);
        if (precosAlqValidos.length > 0) {
          const somaAlq = precosAlqValidos.reduce((acc, p) => acc + p, 0);
          resultado.precoMedioAlq = Math.round(somaAlq / precosAlqValidos.length);
          resultado.precoMedioM2 = Math.round(resultado.precoMedioAlq / 48400);
          resultado.faixaMinAlq = Math.min(...precosAlqValidos);
          resultado.faixaMaxAlq = Math.max(...precosAlqValidos);
          resultado.faixaMinM2 = Math.round(resultado.faixaMinAlq / 48400);
          resultado.faixaMaxM2 = Math.round(resultado.faixaMaxAlq / 48400);
          resultado.anunciosAnalisados = precosAlqValidos.length;
          console.log(`[Rural] precoMedioAlq=${resultado.precoMedioAlq} → precoMedioM2=${resultado.precoMedioM2}`);
        }
      } else {
        // Urbano: recalcula precoMedioM2 a partir dos comparativos brutos
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
    }
    // Filtro de bairro: remove comparativos de bairros com padrão muito diferente do avaliado
    // Evita que Perplexity misture bairros premium com bairros antigos/populares
    // Exemplo: casa do Centro não deve comparar com Residencial Verona ou Anápolis City
    resultado = filtrarComparativosPorBairro(resultado, bairro);

    // Filtro de relevância: remove imóveis de tamanho muito diferente (apartamentos e casas)
    // Exemplo: casa de 60m² não deve influenciar o preço/m² de uma casa de 390m²
    if ((tipo === 'apartamento' || tipo === 'casa') && metragem > 0) {
      resultado = filtrarRelevanciaApartamento(resultado, metragem, quartos, tipo);
    }
    // Comercial: descarta coworking/diária e metragem muito diferente
    if (tipo === 'comercial' && metragem > 0) {
      resultado = filtrarRelevanciaComercial(resultado, metragem);
    }
    // Filtro de outliers para valores extremos (após filtro de relevância)
    resultado = filtrarOutliersComparativos(resultado);

    // ─── DETECTOR DE FABRICAÇÃO ──────────────────────────────────────
    // Anúncio real nunca dá R$/m² idêntico em todos os comparativos.
    // Se a dispersão é ~0 (ex: tudo 2.500/m²), a IA inventou os números:
    // rebaixa a confiança para 'baixa' → o precificador puxa pra âncora EBM.
    const m2arr = (resultado.comparativos || []).map(c => Number(c.precoM2)).filter(p => p > 0);
    if (m2arr.length >= 3) {
      const minM2 = Math.min(...m2arr), maxM2 = Math.max(...m2arr);
      const dispersao = maxM2 > 0 ? (maxM2 - minM2) / maxM2 : 0;
      if (dispersao < 0.015) {
        console.warn(`[Perplexity] ⚠️ Fabricação suspeita: dispersão de R$/m² = ${(dispersao * 100).toFixed(2)}% em ${m2arr.length} comps (todos ≈ R$${minM2}/m²). Confiança → baixa.`);
        resultado.confianca = 'baixa';
        resultado.fabricacaoSuspeita = true;
      }
    }
    // Marca comparativos que se assumiram "estimados" (não são anúncio real)
    if (Array.isArray(resultado.comparativos)) {
      const estimados = resultado.comparativos.filter(c =>
        /estimad|aproximad|similar|baseado/i.test(c.detalhe || '')).length;
      if (estimados > 0 && estimados >= resultado.comparativos.length / 2) {
        console.warn(`[Perplexity] ⚠️ ${estimados}/${resultado.comparativos.length} comps marcados como estimados — confiança → baixa.`);
        resultado.confianca = 'baixa';
      }
    }

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

    // Para terrenos grandes: no retry, aceitar qualquer tamanho (calcular preço/m² de qualquer lote da região)
    const retryAreaFiltro = isTerreno && metragem > 1000
      ? '' // sem filtro de área — queremos o preço/m² do bairro, não lotes do mesmo tamanho
      : `Área entre ${metMin}m² e ${metMax}m².`;

    const promptSimples = `Pesquise anúncios REAIS de ${isTerreno ? 'terrenos/lotes vazios (SEM construção)' : tipo + 's'} ${finalidadeLabel} no bairro ${bairro} e região de ${cidade}-GO (estado de Goiás, Brasil).

${retryAreaFiltro} Busque em OLX, ZAP Imóveis, VivaReal, 62imóveis, Chaves na Mão, encontreimoveisanapolis.com.br.

${isTerreno ? 'SOMENTE lotes vazios. NÃO inclua casas ou imóveis construídos. Se não achar em ' + bairro + ', amplie para bairros vizinhos de ' + cidade + '.' : ''}

Retorne SOMENTE JSON: {"comparativos":[{"area":N,"preco":N,"precoM2":N,"bairro":"nome bairro","fonte":"site","detalhe":"desc"}],"precoMedioM2":N (média simples de TODOS — não filtre nada),"faixaMinM2":N,"faixaMaxM2":N,"anunciosAnalisados":N,"confianca":"alta|media|baixa","raciocinio":"resumo"}`;

    const retryResp = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar-pro',
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

    if (retryResult && (retryResult.precoMedioM2 > 0 || retryResult.precoMedioAlq > 0)) {
      // Rural: derivar precoMedioM2 de precoMedioAlq se necessário
      if (tipo === 'rural' && retryResult.precoMedioAlq > 0 && !retryResult.precoMedioM2) {
        retryResult.precoMedioM2 = Math.round(retryResult.precoMedioAlq / 48400);
      }
      const citations = retryResp.data.citations || [];
      retryResult = filtrarComparativosPorBairro(retryResult, bairro);
      if ((tipo === 'apartamento' || tipo === 'casa') && metragem > 0) {
        retryResult = filtrarRelevanciaApartamento(retryResult, metragem, quartos, tipo);
      }
      if (tipo === 'comercial' && metragem > 0) {
        retryResult = filtrarRelevanciaComercial(retryResult, metragem);
      }
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

/**
 * Busca DEDICADA ao prédio: encontra apenas unidades do edifício/condomínio
 * informado (comparação direta — o melhor comparável para apartamento).
 * Retorna comps marcados origem:'prédio', ou null/vazio se não achar.
 */
async function estimarPrecoPredio(dadosImovel) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;
  const { finalidade, cidade, bairro, condominio } = dadosImovel;
  if (!condominio) return null;

  const finalidadeLabel = finalidade === 'aluguel' ? 'para ALUGAR' : 'à venda';
  const prompt = `Liste APENAS apartamentos ${finalidadeLabel} no edifício/condomínio "${condominio}", bairro ${bairro}, ${cidade}-GO (estado de Goiás).

Pesquise nos portais (VivaReal, ZAP, OLX, Chaves na Mão, 62imóveis, QuintoAndar) anúncios REAIS de unidades NESSE prédio específico. Para cada unidade, registre área (m²), preço (R$), quartos, andar e a fonte.

REGRAS ABSOLUTAS:
- SOMENTE unidades do edifício "${condominio}". NÃO inclua imóveis de outros prédios nem do bairro em geral.
- CONFIRME que o edifício fica em ${bairro}, ${cidade}-GO (Goiás). DESCARTE qualquer anúncio de OUTRA cidade (ex: Goiânia) ou de prédio HOMÔNIMO em outro lugar — se a rua/cidade não bater com ${cidade}-GO, NÃO inclua.
- Use SOMENTE anúncios de portais imobiliários reais. DESCARTE vídeos do YouTube, blogs e fontes que não sejam anúncio de imóvel.
- NUNCA invente preços. Se não encontrar nenhuma unidade desse prédio em ${cidade}-GO, retorne lista vazia.

RETORNE SOMENTE JSON válido:
{
  "comparativos": [{"area": número, "preco": número, "precoM2": número, "quartos": número_ou_null, "fonte": "site", "detalhe": "andar/descrição curta"}],
  "precoMedioM2": número,
  "anunciosAnalisados": número,
  "raciocinio": "resumo das unidades encontradas no prédio"
}`;

  try {
    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar-pro',
      messages: [
        { role: 'system', content: 'Pesquisador imobiliário. Retorne SOMENTE anúncios reais do edifício solicitado, nunca de outros prédios. NUNCA invente. SOMENTE JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1, max_tokens: 1500
    }, { timeout: 60000, headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });

    let jsonStr = response.data.choices[0].message.content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let r;
    try { r = JSON.parse(jsonStr); } catch { r = repararJSON(jsonStr); }
    if (!r || !Array.isArray(r.comparativos)) return { comparativos: [], anunciosAnalisados: 0 };

    const comps = r.comparativos
      .filter((c) => Number(c.precoM2) > 0)
      .map((c) => ({
        area: Number(c.area) || null,
        preco: Number(c.preco) || null,
        precoM2: Math.round(Number(c.precoM2)),
        quartos: c.quartos != null ? Number(c.quartos) : null,
        bairro: condominio,
        fonte: c.fonte || 'Pesquisa de prédio',
        detalhe: `${c.detalhe ? c.detalhe + ' — ' : ''}mesmo prédio`,
        origem: 'prédio',
      }));
    if (!comps.length) return { comparativos: [], anunciosAnalisados: 0 };

    const m2 = comps.map((c) => c.precoM2).filter((p) => p > 0).sort((a, b) => a - b);
    const mediana = m2[Math.floor(m2.length / 2)];
    const disp = m2.length >= 3 ? (Math.max(...m2) - Math.min(...m2)) / Math.max(...m2) : 1;

    return {
      comparativos: comps,
      precoMedioM2: mediana,
      faixaMinM2: Math.min(...m2),
      faixaMaxM2: Math.max(...m2),
      anunciosAnalisados: comps.length,
      confianca: comps.length >= 3 ? 'alta' : 'media',
      suspeitaFabricacao: m2.length >= 3 && disp < 0.015,
      raciocinio: r.raciocinio || `${comps.length} unidade(s) encontrada(s) no ${condominio}.`,
      citacoes: (response.data.citations || []).slice(0, 5),
    };
  } catch (e) {
    console.warn('[Predio] erro:', e.response?.data?.error || e.message);
    return null;
  }
}

module.exports = { estimarPrecoComIA, estimarPrecoPredio };
