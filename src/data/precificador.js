const { buscarComparativos } = require('./portais');
const { getMultiplicadorBairro, getBairrosVizinhos } = require('./bairros');
// Google Places removido — OSM é mais preciso e não inventa dados
const { estimarPrecoComIA } = require('./analistaIA');
const { validarEndereco } = require('./geoValidacao');
const { perfilarLocal, gerarContextoGuru } = require('./guruAnapolis');
const db = require('./database');

/**
 * Motor de precificação — GURU IMOBILIÁRIO DE ANÁPOLIS
 *
 * Hierarquia de fontes para PREÇO:
 * 1. Cache DB (preço pesquisado recentemente, < 3 dias) → instantâneo
 * 2. Portais diretos (OLX, ZAP, VivaReal, Imovelweb)
 * 3. Perplexity (pesquisa anúncios reais na internet)
 * → Resultado SEMPRE salvo no Postgres para próximas consultas
 *
 * Conhecimento da cidade:
 * - Mapeamento de bairros (Postgres, atualizado a cada 7 dias)
 * - Análise da rua (Google Maps, em tempo real)
 * - Vizinhanças, perfil comercial, aptidões (Postgres)
 *
 * PREÇO É SEMPRE POR AMOSTRAGEM — nunca manual, nunca estático.
 * A inteligência local complementa com contexto, não com preço fixo.
 */
async function calcularPreco(dadosImovel) {
  const { tipo, finalidade, cidade, bairro, endereco, condominio, metragem, quartos, vagas, diferenciais, conservacao } = dadosImovel;

  // 1. Validar endereço e analisar rua via Google Maps
  let geoInfo = null;
  try {
    geoInfo = await validarEndereco(cidade, bairro, endereco);
    if (geoInfo?.valido) {
      console.log(`[Precificador] Geo OK: ${geoInfo.enderecoCompleto}`);
      // Salva info do bairro no DB se tiver dados novos
      await salvarInfoBairro(cidade, bairro, geoInfo);
    }
  } catch (err) {
    console.error('[Precificador] Erro geo:', err.message);
  }

  // 1b. Perfilar local com todas as APIs (OSM + IBGE + BrasilAPI)
  let perfilGuru = null;
  try {
    if (geoInfo?.valido) {
      perfilGuru = await perfilarLocal(cidade, bairro, geoInfo.lat, geoInfo.lng);
    }
  } catch (err) {
    console.warn('[Precificador] Erro no Guru:', err.message);
  }

  // Enriquece com bairros vizinhos da mesma zona (para a Perplexity buscar comparativos)
  const perfilBairro = getMultiplicadorBairro(cidade, bairro);
  const bairrosVizinhos = getBairrosVizinhos(cidade, bairro, 4);

  const dadosEnriquecidos = {
    ...dadosImovel,
    cidade: cidade || 'Anápolis', // Garante cidade padrão
    geoInfo: geoInfo?.valido
      ? { ...geoInfo, bairrosProximos: [...(geoInfo.bairrosProximos || []), ...bairrosVizinhos].slice(0, 6) }
      : bairrosVizinhos.length > 0 ? { bairrosProximos: bairrosVizinhos, valido: false } : null,
    contextoGuru: perfilGuru ? gerarContextoGuru(perfilGuru) : null,
    perfilBairro: perfilBairro.conhecido ? perfilBairro : null
  };

  // 2. Busca comparativos nos portais
  const [comparativosRes] = await Promise.allSettled([
    buscarComparativos(dadosImovel)
  ]);

  let comparativos = comparativosRes.status === 'fulfilled' ? comparativosRes.value : null;

  // ─── Determinar preço/m² ──────────────────────────────────────

  let precoM2Base = null;
  let fontePrincipal = null;
  let analiseIA = null;
  let confiancaFonte = null;

  // Prioridade 1: Cache DB (pesquisa recente < 3 dias)
  try {
    const precoDb = await db.buscarPreco(cidade, bairro, tipo, finalidade, condominio);
    // Só usa cache DB se:
    // - tem menos de 3 dias de idade
    // - E confiança é "alta" ou "media" (>=3 amostras)
    // Confiança "baixa" = poucos anúncios → força nova busca no Perplexity
    // Valida se os comparativos do cache são do bairro correto
    // (evita usar cache de "centro" quando usuário pediu "jardim europa")
    let cacheComparativosOk = true;
    if (precoDb && precoDb.comparativos) {
      const comps = typeof precoDb.comparativos === 'string'
        ? JSON.parse(precoDb.comparativos) : precoDb.comparativos;
      if (Array.isArray(comps) && comps.length > 0) {
        const bairroNorm = bairro.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        // Se NENHUM comparativo menciona o bairro solicitado, o cache é de outra consulta
        const algumDosBairro = comps.some(c => {
          const det = (c.detalhe || c.descricao || '').toLowerCase();
          return det.includes(bairroNorm) || det.includes(cidade.toLowerCase());
        });
        if (!algumDosBairro && comps.length > 0) {
          console.warn(`[Precificador] Cache DB com comparativos de bairro diferente — invalidando`);
          try { await db.invalidarPreco(cidade, bairro, tipo, finalidade, condominio); } catch {}
          cacheComparativosOk = false;
        }
      }
    }

    const cacheValido = precoDb &&
      precoDb.dias_desde < 3 &&
      precoDb.confianca !== 'baixa' &&
      (precoDb.amostras || 0) >= 3 &&
      cacheComparativosOk;
    if (cacheValido) {
      precoM2Base = Number(precoDb.preco_m2);
      fontePrincipal = `${precoDb.fonte} (cache ${Math.round(precoDb.dias_desde * 24)}h)`;
      confiancaFonte = precoDb.confianca;
      analiseIA = precoDb.comparativos ? {
        precoMedioM2: precoM2Base,
        faixaMinM2: Number(precoDb.faixa_min),
        faixaMaxM2: Number(precoDb.faixa_max),
        anunciosAnalisados: precoDb.amostras,
        comparativos: typeof precoDb.comparativos === 'string' ? JSON.parse(precoDb.comparativos) : precoDb.comparativos,
        confianca: precoDb.confianca,
        raciocinio: 'Dados recentes do banco de dados',
        faixaM2: `R$ ${precoDb.faixa_min} - R$ ${precoDb.faixa_max}/m²`
      } : null;
      console.log(`[Precificador] Cache DB: R$ ${precoM2Base}/m² (${Math.round(precoDb.dias_desde * 24)}h atrás, ${precoDb.amostras} amostras)`);
    } else if (precoDb) {
      console.log(`[Precificador] Cache DB ignorado: confiança="${precoDb.confianca}", amostras=${precoDb.amostras} — forçando nova busca`);
    }
  } catch (err) {
    console.warn('[Precificador] Erro ao buscar cache DB:', err.message);
  }

  // Prioridade 2: Portais diretos
  if (!precoM2Base && comparativos?.precoMedioM2) {
    precoM2Base = comparativos.precoMedioM2;
    fontePrincipal = comparativos.fonte;
    confiancaFonte = 'alta';
    console.log(`[Precificador] Portais: R$ ${precoM2Base}/m²`);
    // Salva no DB
    try {
      await db.salvarPreco({ cidade, bairro, tipo, finalidade, condominio, preco_m2: precoM2Base, faixa_min: comparativos.precoMinimo, faixa_max: comparativos.precoMaximo, amostras: comparativos.totalEncontrados, confianca: 'alta', fonte: comparativos.fonte, comparativos: comparativos.imoveis });
    } catch {}
  }

  // Prioridade 3: Perplexity
  if (!precoM2Base) {
    console.log('[Precificador] Consultando Perplexity...');
    try {
      analiseIA = await estimarPrecoComIA(dadosEnriquecidos);
      if (analiseIA) {
        precoM2Base = analiseIA.precoMedioM2;
        fontePrincipal = analiseIA.fonte;
        // Confiança determinada objetivamente pelo número de amostras reais
        // (não pela opinião do GPT-4o, que tende a ser conservador)
        const amostrasReais = analiseIA.anunciosAnalisados || 0;
        confiancaFonte = amostrasReais >= 5 ? 'alta'
          : amostrasReais >= 3 ? 'media'
          : 'baixa';
        analiseIA.confianca = confiancaFonte; // sincroniza para o laudo
        console.log(`[Precificador] Perplexity: R$ ${precoM2Base}/m² — ${amostrasReais} amostras → confiança ${confiancaFonte}`);
        // Salva no DB para próximas consultas
        try {
          await db.salvarPreco({ cidade, bairro, tipo, finalidade, condominio, preco_m2: precoM2Base, faixa_min: analiseIA.faixaMinM2, faixa_max: analiseIA.faixaMaxM2, amostras: analiseIA.anunciosAnalisados, confianca: analiseIA.confianca, fonte: 'Perplexity', comparativos: analiseIA.comparativos });
        } catch {}
      } else {
        console.warn(`[Precificador] ⚠️ Perplexity retornou null para ${tipo}/${finalidade} em ${bairro}, ${cidade} — vai usar fallback`);
      }
    } catch (err) {
      console.error('[Precificador] Erro Perplexity:', err.message);
    }
  }

  // Prioridade 4: Cache DB antigo (melhor que nada)
  if (!precoM2Base) {
    try {
      const precoAntigo = await db.buscarPreco(cidade, bairro, tipo, finalidade);
      if (precoAntigo) {
        precoM2Base = Number(precoAntigo.preco_m2);
        fontePrincipal = `Pesquisa anterior (${Math.round(precoAntigo.dias_desde)} dias atrás)`;
        confiancaFonte = 'baixa';
        console.log(`[Precificador] Cache antigo: R$ ${precoM2Base}/m²`);
      }
    } catch {}
  }

  // Prioridade 5 (último recurso): Multiplicador de bairro sobre média da cidade
  // Só entra quando NENHUMA fonte de mercado retornou dados.
  // Usa a média conhecida da cidade × multiplicador do bairro como estimativa.
  if (!precoM2Base && perfilBairro?.conhecido) {
    // Médias separadas por TIPO de imóvel — terrenos têm preço/m² bem menor que casas/aptos
    // Valores baseados na realidade do mercado de Anápolis-GO (2024-2025)
    const mediasCidade = {
      'anapolis': {
        venda: {
          terreno:     800,   // R$/m² médio de lote em Anápolis (bairros simples ~400, Centro ~2000)
          casa:        3500,  // R$/m² médio de casa em Anápolis
          apartamento: 5500,  // R$/m² médio de apartamento em Anápolis
          comercial:   4000,  // R$/m² médio de comercial em Anápolis
          default:     3000
        },
        aluguel: {
          terreno:     3,    // R$/m²/mês de terreno (raro)
          casa:        18,
          apartamento: 25,
          comercial:   22,
          default:     18
        }
      },
      'anápolis': null, // alias — resolvido abaixo
      'goiania': {
        venda: { terreno: 1200, casa: 5000, apartamento: 7000, comercial: 5500, default: 4500 },
        aluguel: { terreno: 4, casa: 25, apartamento: 35, comercial: 30, default: 25 }
      },
      'goiânia': null, // alias
      'default': {
        venda: { terreno: 600, casa: 2500, apartamento: 4000, comercial: 3000, default: 2000 },
        aluguel: { terreno: 2, casa: 14, apartamento: 22, comercial: 18, default: 14 }
      }
    };
    // Resolve aliases
    mediasCidade['anápolis'] = mediasCidade['anapolis'];
    mediasCidade['goiânia']  = mediasCidade['goiania'];

    const cidadeKey = (cidade || 'anapolis').toLowerCase().trim();
    const mediasCidadeData = mediasCidade[cidadeKey] || mediasCidade['default'];
    const mediasPorFinalidade = finalidade === 'aluguel' ? mediasCidadeData.aluguel : mediasCidadeData.venda;
    const mediaBase = mediasPorFinalidade[tipo] || mediasPorFinalidade.default;
    precoM2Base = Math.round(mediaBase * perfilBairro.mult);
    console.log(`[Precificador] Fallback: ${tipo}/${finalidade} base R$${mediaBase}/m² × ${perfilBairro.mult} = R$${precoM2Base}/m²`);
    fontePrincipal = `Estimativa base (sem dados de mercado disponíveis para ${bairro})`;
    confiancaFonte = 'baixa';
    console.log(`[Precificador] Fallback base: R$ ${precoM2Base}/m² (mult ${perfilBairro.mult}x sobre média ${cidade})`);
  }

  // Sem dados = erro
  if (!precoM2Base) {
    return {
      erro: true,
      mensagem: '⚠️ Não foi possível obter dados de mercado neste momento. Tente novamente em alguns minutos.',
      precoMinimo: 0, precoRecomendado: 0, precoMaximo: 0,
      precoM2Mercado: 0, precoM2Imovel: 0,
      comparativosEncontrados: 0, fontesConsultadas: [],
      tempoEstimadoDias: '-', indiceLiquidez: '-',
      ajustesAplicados: [], analiseIA: null,
      localizacao: null, scoreLocalizacao: null, descLocalizacao: null, geoInfo: null
    };
  }

  const precoM2Mercado = precoM2Base;

  // ─── Ajuste por análise da rua ──────────────────────────────────

  let precoM2Final = precoM2Base;
  let ajustesDescricao = ['Preço baseado em amostragem de mercado'];

  // Fator de escala para terrenos grandes
  // Realidade do mercado: quanto maior o terreno, menor o preço/m²
  if (tipo === 'terreno' && metragem > 500) {
    let fatorEscala = 1.0;
    let descEscala = null;
    if (metragem > 5000)      { fatorEscala = 0.55; descEscala = '-45% escala (terreno acima de 5.000m²)'; }
    else if (metragem > 2000) { fatorEscala = 0.65; descEscala = '-35% escala (terreno acima de 2.000m²)'; }
    else if (metragem > 1000) { fatorEscala = 0.75; descEscala = '-25% escala (terreno acima de 1.000m²)'; }
    else if (metragem > 500)  { fatorEscala = 0.85; descEscala = '-15% escala (terreno acima de 500m²)'; }
    precoM2Final = Math.round(precoM2Final * fatorEscala);
    if (descEscala) ajustesDescricao.push(descEscala);
    console.log(`[Precificador] Fator escala terreno ${metragem}m²: ×${fatorEscala} → R$ ${precoM2Final}/m²`);
  }

  // ─── Ajuste por estado de conservação (casas e apartamentos) ──────────────
  // Uma casa "para reformar" no Centro vale o lote, não a construção
  // Mercado de Anápolis: reforma total pode reduzir 25-35% do valor de mercado
  if ((tipo === 'casa' || tipo === 'apartamento') && conservacao) {
    let fatorConservacao = 1.0;
    let descConservacao = null;
    if (conservacao === 'reformar') {
      // Casa para reformar: desconto reflete custo de obra + menor demanda
      // No Centro, casas antigas (valor de lote) já têm isso embutido nos anúncios
      // mas a média do Perplexity tende a incluir casas em estado médio
      fatorConservacao = 0.75;
      descConservacao = '-25% estado de conservação (necessita reforma)';
    } else if (conservacao === 'bom') {
      fatorConservacao = 1.0; // sem ajuste — é o estado "padrão" dos comparativos
    } else if (conservacao === 'novo') {
      fatorConservacao = 1.12;
      descConservacao = '+12% imóvel novo ou recém-construído';
    }
    if (fatorConservacao !== 1.0) {
      precoM2Final = Math.round(precoM2Final * fatorConservacao);
      if (descConservacao) ajustesDescricao.push(descConservacao);
      console.log(`[Precificador] Ajuste conservação (${conservacao}): ×${fatorConservacao} → R$ ${precoM2Final}/m²`);
    }
  }

  // Ajuste baseado no perfil OpenStreetMap
  // REGRAS:
  // - Score OSM < 30: área pouco mapeada no OSM (não significa isolada de verdade) → ignora
  // - Só aplica ajuste quando score >= 30 E confiança da pesquisa é alta ou media
  // - Nunca penaliza duplamente: confiança baixa já indica incerteza, não adiciona desconto
  const perfilOSM = perfilGuru?.infraestrutura;
  const osmConfiavel = perfilOSM && (perfilOSM.score || 0) >= 30 && confiancaFonte !== 'baixa';
  if (osmConfiavel) {
    if (perfilOSM.perfil === 'comercial forte') {
      precoM2Final = Math.round(precoM2Final * 1.20);
      ajustesDescricao.push('+20% localização comercial forte');
    } else if (perfilOSM.perfil === 'misto' && perfilOSM.score >= 50) {
      precoM2Final = Math.round(precoM2Final * 1.10);
      ajustesDescricao.push('+10% boa infraestrutura local');
    } else if (perfilOSM.perfil === 'residencial isolado' && perfilOSM.score >= 30) {
      precoM2Final = Math.round(precoM2Final * 0.92);
      ajustesDescricao.push('-8% região residencial com infraestrutura limitada');
    }
  }

  // Mesclagem Perplexity + fallback quando confiança é baixa (< 3 amostras)
  // Evita que 1 anúncio de bairro vizinho distorça o preço final
  // Pesos: 1 amostra = 40% Perplexity + 60% fallback; 2 amostras = 65% + 35%
  if (confiancaFonte === 'baixa' && analiseIA) {
    const amostras = analiseIA.anunciosAnalisados || 1;
    const pesoPplx = amostras === 1 ? 0.40 : 0.65;
    const pesoFallback = 1 - pesoPplx;

    // Fallback calibrado por tipo E finalidade (venda vs aluguel)
    // Aluguel em R$/m²/mês — valores completamente diferentes de venda
    const mediasFallback = {
      'anapolis': {
        venda:    { terreno: 800, casa: 3500, apartamento: 5500, comercial: 4000, default: 3000 },
        aluguel:  { terreno: 3,   casa: 18,   apartamento: 28,   comercial: 22,   default: 18 }
      },
      'anápolis': null, // alias abaixo
      'goiania': {
        venda:    { terreno: 1200, casa: 5000, apartamento: 7000, comercial: 5500, default: 4500 },
        aluguel:  { terreno: 4,    casa: 25,   apartamento: 38,   comercial: 30,   default: 25 }
      },
      'goiânia': null, // alias abaixo
      'default': {
        venda:    { terreno: 600, casa: 2500, apartamento: 4000, comercial: 3000, default: 2000 },
        aluguel:  { terreno: 2,   casa: 14,   apartamento: 22,   comercial: 18,   default: 14 }
      }
    };
    mediasFallback['anápolis'] = mediasFallback['anapolis'];
    mediasFallback['goiânia']  = mediasFallback['goiania'];

    const cidadeKeyFb = (cidade || 'anapolis').toLowerCase().trim();
    const mediasFbCidade = mediasFallback[cidadeKeyFb] || mediasFallback['default'];
    const mediasFbFinal  = mediasFbCidade[finalidade] || mediasFbCidade['venda'];
    const baseFb = mediasFbFinal[tipo] || mediasFbFinal.default;
    const fallbackM2 = Math.round(baseFb * perfilBairro.mult);
    const precoMesclado = Math.round(precoM2Final * pesoPplx + fallbackM2 * pesoFallback);

    console.log(`[Precificador] Mesclagem confiança baixa (${amostras} amostras): ` +
      `Perplexity R$${precoM2Final}/m² (×${pesoPplx}) + Fallback R$${fallbackM2}/m² (×${pesoFallback}) = R$${precoMesclado}/m²`);

    precoM2Final = precoMesclado;
    ajustesDescricao.push(`Estimativa combinada: ${Math.round(pesoPplx*100)}% mercado + ${Math.round(pesoFallback*100)}% base calibrada (poucos anúncios na região)`);
  }

  // ─── Resultado final ───────────────────────────────────────────

  const precoRecomendado = Math.round(precoM2Final * metragem);
  const precoMinimo = Math.round(precoRecomendado * 0.92);
  const precoMaximo = Math.round(precoRecomendado * 1.08);
  const liquidez = estimarLiquidez(finalidade, precoM2Final, precoM2Mercado);

  const fontes = [fontePrincipal];
  if (perfilGuru) fontes.push('OpenStreetMap + IBGE');

  // Salva avaliação no histórico
  try {
    await db.salvarAvaliacao({
      cidade, bairro, endereco, tipo, finalidade, metragem, quartos, vagas, conservacao,
      diferenciais: Array.isArray(diferenciais) ? diferenciais : [],
      preco_m2_mercado: precoM2Mercado, preco_m2_ajustado: precoM2Final,
      preco_recomendado: precoRecomendado, preco_minimo: precoMinimo, preco_maximo: precoMaximo,
      fontes, confianca: confiancaFonte, analise_rua: perfilOSM, laudo: null, canal: 'web'
    });
  } catch {}

  return {
    precoMinimo, precoRecomendado, precoMaximo,
    precoM2Mercado, precoM2Imovel: precoM2Final,
    comparativosEncontrados: comparativos?.totalEncontrados || 0,
    fontesConsultadas: fontes.filter(Boolean),
    tempoEstimadoDias: liquidez.dias,
    indiceLiquidez: liquidez.indicador,
    ajustesAplicados: ajustesDescricao,
    variacao3meses: null,
    analiseIA: analiseIA ? {
      raciocinio: analiseIA.raciocinio,
      confianca: analiseIA.confianca,
      faixaM2: analiseIA.faixaM2 || `R$ ${analiseIA.faixaMinM2} - R$ ${analiseIA.faixaMaxM2}/m²`,
      precoMedioM2: analiseIA.precoMedioM2,
      anunciosAnalisados: analiseIA.anunciosAnalisados || 0,
      comparativos: analiseIA.comparativos || [],
      citacoes: analiseIA.citacoes || []
    } : null,
    confiancaFonte,
    localizacao: null, scoreLocalizacao: null, descLocalizacao: null,
    geoInfo: geoInfo?.valido ? {
      enderecoValidado: geoInfo.enderecoCompleto,
      bairrosVizinhos: geoInfo.bairrosProximos,
      distanciaCentroKm: geoInfo.distanciaCentroKm,
      viasProximas: geoInfo.viasProximas
    } : null,
    perfilGuru: perfilGuru ? {
      infraestrutura: perfilGuru.infraestrutura,
      municipio: perfilGuru.municipio,
      ruasPrincipais: perfilGuru.ruasPrincipais
    } : null
  };
}

/**
 * Salva informações do bairro no DB a partir do Google Maps
 */
async function salvarInfoBairro(cidade, bairro, geoInfo) {
  try {
    await db.salvarBairro({
      cidade, bairro,
      vizinhos: geoInfo.bairrosProximos,
      ruas_valorizadas: geoInfo.viasProximas,
      fonte: 'google_maps'
    });
  } catch {}
}

function estimarLiquidez(finalidade, precoM2Imovel, precoM2Mercado) {
  const ratio = precoM2Mercado > 0 ? precoM2Imovel / precoM2Mercado : 1.0;
  let dias, indicador;
  if (finalidade === 'aluguel') {
    if (ratio <= 0.95) { dias = '15 a 30'; indicador = '🟢 Alta liquidez'; }
    else if (ratio <= 1.05) { dias = '30 a 60'; indicador = '🟡 Liquidez normal'; }
    else { dias = '60 a 90+'; indicador = '🔴 Liquidez baixa'; }
  } else {
    if (ratio <= 0.95) { dias = '30 a 60'; indicador = '🟢 Alta liquidez'; }
    else if (ratio <= 1.05) { dias = '60 a 120'; indicador = '🟡 Liquidez normal'; }
    else { dias = '120 a 180+'; indicador = '🔴 Liquidez baixa'; }
  }
  return { dias, indicador };
}

function formatarReais(valor) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(valor);
}

module.exports = { calcularPreco, formatarReais };
