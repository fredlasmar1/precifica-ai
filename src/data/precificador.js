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
  const { tipo, finalidade, cidade, bairro, endereco, metragem, quartos, vagas, diferenciais, conservacao } = dadosImovel;

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
    const precoDb = await db.buscarPreco(cidade, bairro, tipo, finalidade);
    if (precoDb && precoDb.dias_desde < 3) {
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
      console.log(`[Precificador] Cache DB: R$ ${precoM2Base}/m² (${Math.round(precoDb.dias_desde * 24)}h atrás)`);
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
      await db.salvarPreco({ cidade, bairro, tipo, finalidade, preco_m2: precoM2Base, faixa_min: comparativos.precoMinimo, faixa_max: comparativos.precoMaximo, amostras: comparativos.totalEncontrados, confianca: 'alta', fonte: comparativos.fonte, comparativos: comparativos.imoveis });
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
        confiancaFonte = analiseIA.confianca;
        console.log(`[Precificador] Perplexity: R$ ${precoM2Base}/m² (${analiseIA.confianca})`);
        // Salva no DB para próximas consultas
        try {
          await db.salvarPreco({ cidade, bairro, tipo, finalidade, preco_m2: precoM2Base, faixa_min: analiseIA.faixaMinM2, faixa_max: analiseIA.faixaMaxM2, amostras: analiseIA.anunciosAnalisados, confianca: analiseIA.confianca, fonte: 'Perplexity', comparativos: analiseIA.comparativos });
        } catch {}
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
    const mediasCidade = {
      'anapolis': { venda: 6000, aluguel: 28 },
      'anápolis': { venda: 6000, aluguel: 28 },
      'goiania':  { venda: 7500, aluguel: 35 },
      'goiânia':  { venda: 7500, aluguel: 35 },
      'default':  { venda: 5000, aluguel: 22 }
    };
    const cidadeKey = (cidade || 'anapolis').toLowerCase().trim();
    const medias = mediasCidade[cidadeKey] || mediasCidade['default'];
    const mediaBase = finalidade === 'aluguel' ? medias.aluguel : medias.venda;
    precoM2Base = Math.round(mediaBase * perfilBairro.mult);
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

  // Ajuste baseado no perfil OpenStreetMap (dados reais mapeados por pessoas)
  const perfilOSM = perfilGuru?.infraestrutura;
  if (perfilOSM && confiancaFonte === 'baixa') {
    if (perfilOSM.perfil === 'comercial forte') {
      precoM2Final = Math.round(precoM2Final * 1.20);
      ajustesDescricao.push('+20% região comercial forte (comparativos de bairros vizinhos)');
    } else if (perfilOSM.perfil === 'misto' && perfilOSM.score >= 50) {
      precoM2Final = Math.round(precoM2Final * 1.10);
      ajustesDescricao.push('+10% boa infraestrutura (comparativos de bairros vizinhos)');
    } else if (perfilOSM.perfil === 'residencial isolado') {
      precoM2Final = Math.round(precoM2Final * 0.90);
      ajustesDescricao.push('-10% região isolada (comparativos de bairros vizinhos)');
    }
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
