// Estudo de viabilidade BTS (Build to Suit) — o investidor constrói um imóvel
// sob medida para um inquilino corporativo que assina contrato longo (10–20 anos)
// e paga aluguel. Diferente da INCORPORAÇÃO (aba Terrenos): ali constrói e VENDE
// (margem sobre o VGV); aqui constrói e ALUGA — o retorno é o cap rate (yield =
// aluguel anual ÷ investimento total).
//
// Fluxo: valor do terreno (motor real) → potencial construtivo → custo de obra
// (CUB comercial/galpão) → investimento total → aluguel de mercado do ponto →
// cap rate/veredito → melhor ramo para o ponto (Google Places) → empresas que
// buscam expansão (base curada + busca web ao vivo com fontes) → parecer IA.

const OpenAI = require('openai');
const axios = require('axios');
const { calcularPreco } = require('./precificador');
const { getBaseVenda, getBaseLote } = require('./baseAnapolis');
const { placesNearby, placesCountExato, coordsBairro } = require('./pontoComercial');

let _openai = null;
function getOpenAI() {
  if (!_openai && process.env.OPENAI_API_KEY) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ── Parâmetros do estudo BTS ──
// Custo de obra por m² construído (CUB-GO aprox., ref. 2026), por padrão de imóvel.
const OBRA = { galpao: 1500, comercial: 2300, loja: 2700 };
const EFIC_COMERCIAL = 0.85;     // área locável (GLA) / área construída
const INDIRETOS_OBRA = 0.18;     // projeto, fundação/infra, adm da obra, BDI (sobre a obra)
const YIELD_ALVO_MES = 0.009;    // cap rate mensal alvo p/ "aluguel necessário" (~11,3%/ano — típico BTS)
const PRAZO_PADRAO = 12;         // meses de obra até início do contrato (default)

// Taxa de ocupação (footprint sobre o lote) por zona — ESTIMATIVA (conferir Plano Diretor).
const TO_ZONA = { 'residencial-baixa': 0.50, 'residencial-media': 0.60, 'corredor': 0.70, 'central': 0.70 };

// ── Catálogo curado de inquilinos BTS (perfil Centro-Oeste / Anápolis-GO) ──
// areaMin/areaMax = faixa de lote típica; keyword = busca no Google Places;
// chains = redes reais que costumam operar por BTS/expansão nesse ramo.
const CATALOGO_BTS = [
  { key: 'atacarejo',  label: 'Atacarejo / supermercado', keyword: 'supermercado atacarejo', obra: 'loja',      areaMin: 2000, areaMax: 20000,
    chains: ['Assaí', 'Atacadão', 'Grupo Mateus', 'Supermercados BH', 'Bretas', 'Tatico'] },
  { key: 'homecenter', label: 'Home center / construção', keyword: 'material de construção home center', obra: 'loja', areaMin: 2000, areaMax: 20000,
    chains: ['Quero-Quero', 'Balaroti', 'Center Castilho', 'Havan'] },
  { key: 'academia',   label: 'Academia', keyword: 'academia', obra: 'comercial', areaMin: 700, areaMax: 4000,
    chains: ['Smart Fit', 'Selfit', 'Bluefit', 'Bio Ritmo'] },
  { key: 'fastfood',   label: 'Fast-food / restaurante', keyword: 'restaurante fast food lanchonete', obra: 'comercial', areaMin: 400, areaMax: 3000,
    chains: ['McDonald’s (Arcos Dorados)', 'Burger King (Zamp)', 'Habib’s', 'Subway', 'Madero'] },
  { key: 'pet',        label: 'Pet shop / clínica veterinária', keyword: 'pet shop veterinária', obra: 'comercial', areaMin: 400, areaMax: 2000,
    chains: ['Petz', 'Cobasi', 'Petland'] },
  { key: 'saude',      label: 'Clínica / laboratório / saúde', keyword: 'clínica laboratório', obra: 'comercial', areaMin: 300, areaMax: 2500,
    chains: ['Hermes Pardini', 'DASA', 'Dr. Consulta', 'OdontoCompany', 'Sorridents', 'Clínic Farma'] },
  { key: 'educacao',   label: 'Educação / ensino', keyword: 'escola faculdade curso', obra: 'comercial', areaMin: 400, areaMax: 5000,
    chains: ['Kroton/Cogna', 'Wizard', 'Kumon', 'SESI/SENAI'] },
  { key: 'varejo',     label: 'Varejo popular / departamentos', keyword: 'loja departamento variedades', obra: 'loja', areaMin: 800, areaMax: 8000,
    chains: ['Havan', 'Pernambucanas', 'Lojas MM', 'Avenida'] },
  { key: 'farmacia',   label: 'Farmácia', keyword: 'farmácia drogaria', obra: 'comercial', areaMin: 150, areaMax: 800,
    chains: ['Droga Raia/Drogasil (RD)', 'Pague Menos', 'Drogal', 'Ultrafarma'] },
  { key: 'posto',      label: 'Posto de combustível / conveniência', keyword: 'posto de combustível', obra: 'comercial', areaMin: 800, areaMax: 5000,
    chains: ['Ipiranga', 'Shell', 'Vibra/BR', 'Ale'] },
  { key: 'logistica',  label: 'Galpão logístico / centro de distribuição', keyword: 'transportadora centro de distribuição', obra: 'galpao', areaMin: 3000, areaMax: 100000,
    chains: ['Mercado Livre', 'Amazon', 'Magalu', 'Jadlog', 'Loggi', 'Correios'] },
];

/**
 * Estudo de viabilidade BTS.
 * input: { cidade, bairro, endereco, area, zona, to, pavimentos, ca, obra, valorPedido, prazoMeses, ramoAlvo, yieldAlvo }
 */
async function analisarBTS(input = {}) {
  const cidade = String(input.cidade || 'Anápolis').trim();
  const bairro = String(input.bairro || '').trim();
  const endereco = String(input.endereco || '').trim() || null;
  const area = Number(input.area) || 0;
  if (!bairro || area <= 0) return { erro: 'Informe o bairro e a área do terreno (m²).' };

  // 1) Valor de mercado do terreno (motor real; BTS constrói novo → avalia a terra)
  let valorTerreno = 0, precoM2Terreno = 0, fontesPreco = [], confianca = 'baixa';
  try {
    const aval = await calcularPreco({ tipo: 'terreno', finalidade: 'venda', cidade, bairro, endereco, metragem: area });
    if (aval && !aval.erro && aval.precoRecomendado > 0) {
      valorTerreno = aval.precoRecomendado;
      precoM2Terreno = aval.precoM2Mercado || Math.round(aval.precoRecomendado / area);
      fontesPreco = (aval.fontesConsultadas || []).filter(Boolean);
      confianca = aval.confiancaFonte || 'media';
    }
  } catch (e) { console.warn('[BTS] avaliação terreno:', e.message); }
  if (!valorTerreno) {
    const lote = getBaseLote(cidade, bairro);
    precoM2Terreno = lote.m2; valorTerreno = Math.round(lote.m2 * area); fontesPreco = [lote.fonte];
  }
  const valorPedido = Number(input.valorPedido) > 0 ? Number(input.valorPedido) : null;
  const custoTerreno = valorPedido || valorTerreno;

  // 2) Potencial construtivo — BTS costuma ser térreo com estacionamento; footprint
  //    = área × TO × pavimentos. Se o usuário informar CA, usa área × CA.
  const zonaKey = TO_ZONA[input.zona] ? input.zona : 'corredor'; // BTS ⇒ eixo comercial por padrão
  const to = Number(input.to) > 0 ? Number(input.to) : TO_ZONA[zonaKey];
  const pavimentos = Number(input.pavimentos) > 0 ? Math.round(Number(input.pavimentos)) : 1;
  const areaConstruivel = Number(input.ca) > 0
    ? Math.round(area * Number(input.ca))
    : Math.round(area * to * pavimentos);
  const areaLocavel = Math.round(areaConstruivel * EFIC_COMERCIAL);

  // 3) Custo de obra + investimento total
  const obraKey = OBRA[input.obra] ? input.obra : 'comercial';
  const cub = OBRA[obraKey];
  const prazoMeses = Number(input.prazoMeses) > 0 ? Math.round(Number(input.prazoMeses)) : PRAZO_PADRAO;
  const custoObra = Math.round(areaConstruivel * cub);
  const custoIndireto = Math.round(custoObra * INDIRETOS_OBRA);
  const investimento = custoTerreno + custoObra + custoIndireto;

  // 4) Aluguel de mercado do ponto (comercial) → cap rate
  let aluguelM2 = 0;
  try {
    const a = await calcularPreco({ tipo: 'comercial', finalidade: 'aluguel', cidade, bairro, endereco, metragem: 300, conservacao: 'bom' });
    if (a && !a.erro && a.precoM2Mercado > 0) aluguelM2 = a.precoM2Mercado;
  } catch (e) { console.warn('[BTS] aluguel comercial:', e.message); }
  if (!aluguelM2) aluguelM2 = Math.round((getBaseVenda(cidade, bairro).m2 || 4000) * 0.004); // fallback: yield 0,4%/mês do valor de venda

  const aluguelMensal = Math.round(areaLocavel * aluguelM2);
  const aluguelAnual = aluguelMensal * 12;
  const yieldMes = investimento > 0 ? aluguelMensal / investimento : 0;
  const yieldAno = yieldMes * 12;
  const paybackAnos = aluguelAnual > 0 ? Math.round((investimento / aluguelAnual) * 10) / 10 : null;
  const yieldAlvo = Number(input.yieldAlvo) > 0 ? Number(input.yieldAlvo) : YIELD_ALVO_MES;
  const aluguelNecessario = Math.round(investimento * yieldAlvo); // p/ bater o cap rate alvo

  const yp = yieldMes * 100;
  const veredito = yp >= 0.9 ? '🟢 Atrativo' : yp >= 0.75 ? '🟡 Viável' : yp >= 0.6 ? '🟠 Marginal' : '🔴 Retorno baixo';

  // 5) Melhor ramo para o ponto + empresas em expansão
  let lat = null, lng = null;
  try {
    const { validarEndereco } = require('./geoValidacao');
    const geo = await validarEndereco(cidade, bairro, endereco || '');
    if (geo && geo.valido) { lat = geo.lat; lng = geo.lng; }
  } catch {}
  if (lat == null) { const c = coordsBairro(bairro); if (c) { lat = c.lat; lng = c.lng; } }

  const rendaM2 = getBaseVenda(cidade, bairro).m2 || 4000;
  const ramos = (lat != null) ? await melhorRamo(lat, lng, area, rendaM2).catch(() => []) : [];
  const empresas = await empresasExpansao(cidade, bairro, ramos, area).catch(() => null);

  const resultado = {
    cidade, bairro, endereco, area,
    valorTerreno, precoM2Terreno, valorPedido, custoTerreno, confianca, fontesPreco,
    zonaKey, to, pavimentos, ca: Number(input.ca) > 0 ? Number(input.ca) : null,
    areaConstruivel, areaLocavel, caEstimado: !(Number(input.ca) > 0),
    obraKey, cub, custoObra, custoIndireto, investimento, prazoMeses,
    aluguelM2, aluguelMensal, aluguelAnual, yieldMes, yieldAno, paybackAnos,
    yieldAlvo, aluguelNecessario, veredito,
    ramos, empresas,
  };
  resultado.parecer = await gerarParecerBTS(resultado).catch(() => null);
  return resultado;
}

/**
 * Ranqueia os melhores ramos para o ponto. Filtra o catálogo pela área do lote,
 * mede fluxo do entorno UMA vez e a concorrência de cada ramo candidato.
 */
async function melhorRamo(lat, lng, area, rendaM2) {
  // Candidatos que cabem na área do lote (com folga)
  let candidatos = CATALOGO_BTS.filter(c => area >= c.areaMin * 0.7 && area <= c.areaMax * 1.5);
  if (!candidatos.length) candidatos = CATALOGO_BTS.slice(0, 5);
  candidatos = candidatos.slice(0, 6); // limita custo de Places

  // Fluxo do entorno (geradores de movimento) — medido uma vez, compartilhado
  const [sup, esc, ban] = await Promise.all([
    placesNearby({ lat, lng, keyword: 'supermercado mercado', radius: 1000 }).then(r => (r.results || []).length).catch(() => 0),
    placesNearby({ lat, lng, keyword: 'escola colégio faculdade', radius: 1000 }).then(r => (r.results || []).length).catch(() => 0),
    placesNearby({ lat, lng, keyword: 'banco agência lotérica', radius: 1000 }).then(r => (r.results || []).length).catch(() => 0),
  ]);
  const fluxo = sup + esc + ban;

  const scored = await Promise.all(candidatos.map(async (c) => {
    const conc = await placesCountExato({ lat, lng, keyword: c.keyword, radius: 1000, maxPages: 2 })
      .then(r => r.total || 0).catch(() => 0);
    let score = 50;
    // Concorrência: 1-4 = faixa ideal (mercado existe, não saturado)
    if (conc === 0) score += 6;
    else if (conc <= 4) score += 24;
    else if (conc <= 12) score += 8;
    else if (conc <= 25) score -= 6;
    else score -= 20;
    score += Math.min(20, fluxo * 1.2);           // fluxo
    score += Math.min(15, Math.max(0, (rendaM2 - 3500) / 400)); // poder de compra
    score = Math.max(0, Math.min(100, Math.round(score)));
    return { key: c.key, label: c.label, chains: c.chains, concorrentes: conc, score };
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 4);
}

/**
 * Empresas que buscam expansão e poderiam querer o imóvel: base curada (dos
 * melhores ramos) + busca web ao vivo (Perplexity) com fontes.
 */
async function empresasExpansao(cidade, bairro, ramos, area) {
  const topRamos = (ramos || []).slice(0, 3);
  const curadas = [...new Set(topRamos.flatMap(r => r.chains || []))]; // redes conhecidas do perfil
  const labels = topRamos.map(r => r.label);

  let live = [], fontes = [];
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (apiKey && labels.length) {
    try {
      const prompt = `Liste empresas/redes REAIS que estão em expansão, abrindo unidades ou buscando pontos em ${cidade}-GO ou na região metropolitana de Goiânia/entorno em 2025-2026, nos ramos: ${labels.join(', ')}. `
        + `Foque em redes que operam por Build to Suit ou aluguel de longo prazo (atacarejo, varejo, academias, farmácias, fast-food, logística, saúde). `
        + `Responda em JSON: {"empresas":[{"nome":"...","ramo":"...","status":"o que se sabe da expansão"}]}. Máximo 8. Use SOMENTE informação real e verificável; se não houver, retorne lista vazia.`;
      const { data } = await axios.post('https://api.perplexity.ai/chat/completions', {
        model: 'sonar-pro',
        messages: [
          { role: 'system', content: 'Pesquisador de expansão de varejo no Brasil. SOMENTE dados reais e verificáveis. Nunca invente. Retorne SOMENTE JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1, max_tokens: 700,
      }, { timeout: 60000, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
      const s = data.choices[0].message.content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      try { live = (JSON.parse(s).empresas || []).map(e => ({ nome: semCit(e.nome), ramo: semCit(e.ramo), status: semCit(e.status) })); } catch {}
      fontes = (data.citations || []).slice(0, 6);
    } catch (e) { console.warn('[BTS] expansão web:', e.message); }
  }
  return { curadas, live, fontes };
}

function semCit(s) { return s == null ? s : String(s).replace(/\s*\[\d+\](\[\d+\])*/g, '').replace(/\s{2,}/g, ' ').trim(); }

async function gerarParecerBTS(r) {
  const client = getOpenAI();
  if (!client) return null;
  try {
    const m = (v) => `R$ ${Number(v).toLocaleString('pt-BR')}`;
    const top = (r.ramos || []).slice(0, 2).map(x => x.label).join(' ou ') || 'varejo de conveniência';
    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é um consultor de investimento imobiliário Build to Suit. Explica de forma clara e direta para um investidor/corretor. Português do Brasil.' },
        { role: 'user', content: `Dê um parecer de 4-6 frases sobre um estudo BTS de um terreno de ${r.area}m² no bairro ${r.bairro}, ${r.cidade}-GO. Investimento total ${m(r.investimento)} (terreno ${m(r.custoTerreno)} + obra ${m(r.custoObra)} + indiretos ${m(r.custoIndireto)}); área locável ${r.areaLocavel}m²; aluguel de mercado ${m(r.aluguelMensal)}/mês; cap rate ${(r.yieldMes * 100).toFixed(2)}%/mês (${(r.yieldAno * 100).toFixed(1)}%/ano); payback ${r.paybackAnos} anos. O melhor uso indicado é ${top}. Diga se o retorno é atraente para BTS (referência saudável ~0,8-1,0%/mês), qual o principal fator do resultado, 1 alavanca para melhorar o yield (ex: negociar terreno, reduzir obra, buscar inquilino âncora) e 1 ressalva (o cap rate depende de fechar contrato longo com inquilino sólido).` },
      ],
      temperature: 0.5, max_tokens: 380,
    });
    return resp.choices[0].message.content.trim();
  } catch (e) { console.warn('[BTS] parecer erro:', e.message); return null; }
}

function formatarBTS(r) {
  if (!r || r.erro) return `⚠️ ${r?.erro || 'Não foi possível montar o estudo BTS.'}`;
  const m = (v) => `R$ ${Number(v).toLocaleString('pt-BR')}`;
  const n = (v) => Number(v).toLocaleString('pt-BR');

  let t = `🏢 *BTS — Build to Suit · Estudo de Viabilidade*\n`;
  t += `${r.bairro}, ${r.cidade} · ${n(r.area)} m²\n\n`;

  t += `${r.veredito} — *cap rate: ${(r.yieldMes * 100).toFixed(2)}%/mês* (${(r.yieldAno * 100).toFixed(1)}%/ano)\n\n`;

  if (r.parecer) t += `💬 *Parecer:*\n${r.parecer}\n\n`;

  t += `🏗️ *O que dá pra construir:*\n`;
  t += `• Terreno: ${m(r.custoTerreno)} (${m(r.precoM2Terreno)}/m²) — confiança ${r.confianca}\n`;
  t += `• Área construível${r.caEstimado ? ` (TO ${Math.round(r.to * 100)}%${r.pavimentos > 1 ? ` × ${r.pavimentos} pav.` : ''})` : ` (CA ${r.ca})`}: *${n(r.areaConstruivel)} m²*\n`;
  t += `• Área locável (GLA, eficiência ${Math.round(EFIC_COMERCIAL * 100)}%): *${n(r.areaLocavel)} m²*\n\n`;

  t += `💰 *Conta do investidor BTS (obra ${r.prazoMeses} meses):*\n`;
  t += `• (+) Investimento total: *${m(r.investimento)}*\n`;
  t += `   – Terreno: ${m(r.custoTerreno)}\n`;
  t += `   – Obra (${r.obraKey} ${m(r.cub)}/m²): ${m(r.custoObra)}\n`;
  t += `   – Indiretos da obra (${Math.round(INDIRETOS_OBRA * 100)}%): ${m(r.custoIndireto)}\n`;
  t += `• (=) Aluguel de mercado: ${n(r.areaLocavel)} m² × ${m(r.aluguelM2)}/m² = *${m(r.aluguelMensal)}/mês*\n`;
  t += `• Cap rate: ${m(r.aluguelAnual)}/ano ÷ ${m(r.investimento)} = *${(r.yieldMes * 100).toFixed(2)}%/mês*\n`;
  t += `• Payback (só aluguel): *${r.paybackAnos} anos*\n`;
  t += `• Aluguel p/ render ${(r.yieldAlvo * 100).toFixed(2)}%/mês: ${m(r.aluguelNecessario)}/mês\n\n`;

  if (r.ramos && r.ramos.length) {
    t += `🎯 *Melhor uso para o ponto:*\n`;
    r.ramos.forEach((x, i) => {
      t += `${i + 1}. *${x.label}* — score ${x.score}/100 (${x.concorrentes} concorrentes em 1 km)\n`;
    });
    t += `\n`;
  }

  if (r.empresas) {
    t += `🏬 *Empresas que buscam expansão (possíveis inquilinos/compradores):*\n`;
    if (r.empresas.live && r.empresas.live.length) {
      r.empresas.live.forEach(e => { t += `• *${e.nome}*${e.ramo ? ` (${e.ramo})` : ''}${e.status ? ` — ${e.status}` : ''}\n`; });
    }
    if (r.empresas.curadas && r.empresas.curadas.length) {
      t += `• _Redes do perfil (referência):_ ${r.empresas.curadas.slice(0, 10).join(', ')}\n`;
    }
    if ((!r.empresas.live || !r.empresas.live.length) && (!r.empresas.curadas || !r.empresas.curadas.length)) {
      t += `• _Sem dados de expansão para este perfil no momento._\n`;
    }
    t += `\n`;
  }

  try {
    const { textoFontes } = require('./fontes');
    const bases = [
      'Google Maps (concorrência e fluxo do entorno)',
      'EBM/Aderni-GO · Planta Genérica de Valores — Anápolis (terreno e aluguel comercial)',
      'CUB-GO / Sinduscon (custo de obra)',
    ];
    if (r.empresas && r.empresas.live && r.empresas.live.length) bases.push('Perplexity (busca web de expansão de redes)');
    t += textoFontes({
      metodo: 'Estudo BTS: terreno por amostragem de mercado + custo de obra × aluguel de mercado (cap rate). Melhor uso por análise de ponto (Google Places); inquilinos por base curada + busca web.',
      data: new Date().toLocaleDateString('pt-BR'),
      grau: r.confianca === 'alta' ? 'II (amostra robusta)' : 'I (referência)',
      portais: r.fontesPreco,
      bases,
      links: (r.empresas && r.empresas.fontes) || [],
      obs: 'Cap rate depende de fechar contrato de locação longo (10-20 anos) com inquilino sólido. Coeficiente/taxa de ocupação e custo de obra são ESTIMATIVAS — confirmar no Plano Diretor de Anápolis e com orçamento de obra. Lista de empresas é inteligência de mercado (leads), não demanda confirmada.',
    });
  } catch {}
  return t;
}

module.exports = { analisarBTS, formatarBTS, CATALOGO_BTS };
