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

// ── RADAR DE EXPANSÃO ────────────────────────────────────────────────
// Busca REVERSA: em vez de partir de um lote, parte da região e acha empresas
// em expansão que poderiam querer um imóvel aqui (inquilino/comprador BTS).
const REGIOES = {
  'anapolis':  { label: 'Anápolis-GO', alvo: 'Anápolis-GO' },
  'goiania':   { label: 'Goiânia-GO', alvo: 'Goiânia-GO' },
  'rmg':       { label: 'Região Metropolitana de Goiânia', alvo: 'Região Metropolitana de Goiânia (Aparecida de Goiânia, Senador Canedo, Trindade, Goianira, Nerópolis)' },
  'todas':     { label: 'Anápolis + Goiânia + RMG', alvo: 'Anápolis, Goiânia e a Região Metropolitana de Goiânia (Goiás)' },
};

function normRegiao(s) {
  const k = String(s || 'todas').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (k.includes('anapolis')) return 'anapolis';
  if (k.includes('metropolitana') || k === 'rmg') return 'rmg';
  if (k.includes('goiania')) return 'goiania';
  return 'todas';
}

/**
 * Radar de expansão: empresas em modo-expansão que poderiam querer um imóvel na região.
 * @param {string} regiao - anapolis | goiania | rmg | todas
 * @param {string} ramo - opcional (ex: "atacarejo", "academia"); vazio = amplo
 */
// Ramos varridos em paralelo quando o usuário NÃO especifica um ramo (busca ampla).
// Uma query por ramo é MUITO mais confiável que uma query genérica gigante.
const RAMOS_RADAR = ['atacarejo e supermercado', 'academia', 'farmácia e drogaria', 'fast-food e restaurante', 'home center e material de construção', 'logística e centro de distribuição'];

/** Uma consulta de radar (uma região, um ramo). Retorna { empresas, fontes }. */
async function _radarQuery(reg, ramoTxt, alvoMax) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  const prompt = `Liste empresas e redes REAIS do ramo "${ramoTxt}" que estão em expansão e poderiam querer abrir/instalar uma unidade em ${reg.alvo} em 2025-2026 (anúncios de expansão, novas lojas, busca de pontos, contratação local, franquias buscando a região). `
    + `Priorize quem opera por Build to Suit ou locação de longo prazo, e redes conhecidas por expandir no Centro-Oeste/Goiás. `
    + `Responda APENAS com JSON válido, sem texto antes ou depois: {"empresas":[{"nome":"...","ramo":"${ramoTxt}","sinal":"sinal concreto de expansão + data","cidadeAlvo":"cidade(s) de interesse na região","imovelBuscado":"tipo/área de imóvel típico (ex: loja 300m² em avenida, galpão 3000m²)","statusRegiao":"já tem unidade na região? está abrindo?","fonte":"URL da fonte"}]}. `
    + `Liste de 2 a ${alvoMax} empresas reais que você conhece estarem em expansão no Centro-Oeste. Não invente empresas nem fontes; se não souber a fonte, deixe "fonte" vazia mas mantenha a empresa.`;
  const { data } = await axios.post('https://api.perplexity.ai/chat/completions', {
    model: 'sonar-pro',
    messages: [
      { role: 'system', content: 'Pesquisador de expansão de varejo e franquias no Brasil, especialista no interior/Centro-Oeste. Use dados reais. Nunca invente empresas ou fontes. Retorne SOMENTE JSON válido, começando com { e terminando com }.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2, max_tokens: 1600,
  }, { timeout: 75000, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
  let s = String(data.choices[0].message.content || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  let empresas = [];
  try {
    empresas = (JSON.parse(s).empresas || []).map(e => ({
      nome: semCit(e.nome), ramo: semCit(e.ramo), sinal: semCit(e.sinal),
      cidadeAlvo: semCit(e.cidadeAlvo), imovelBuscado: semCit(e.imovelBuscado),
      statusRegiao: semCit(e.statusRegiao), fonte: semCit(e.fonte),
    })).filter(e => e.nome);
  } catch {}
  return { empresas, fontes: (data.citations || []).slice(0, 6) };
}

async function radarExpansao(regiao, ramo) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  const reg = REGIOES[normRegiao(regiao)] || REGIOES.todas;
  const ramoTxt = String(ramo || '').trim();
  if (!apiKey) return { erro: 'Busca web indisponível (PERPLEXITY_API_KEY não configurada).' };

  try {
    let empresas = [], fontes = [];
    if (ramoTxt) {
      // Ramo específico → uma consulta focada (até 8).
      const r = await _radarQuery(reg, ramoTxt, 8);
      empresas = r.empresas; fontes = r.fontes;
    } else {
      // Amplo → varre os ramos-chave em paralelo e junta (dedup por nome).
      const results = await Promise.all(
        RAMOS_RADAR.map(rm => _radarQuery(reg, rm, 4).catch(() => ({ empresas: [], fontes: [] })))
      );
      const seen = new Set();
      for (const r of results) {
        for (const e of r.empresas) {
          const k = (e.nome || '').toLowerCase();
          if (k && !seen.has(k)) { seen.add(k); empresas.push(e); }
        }
        fontes.push(...r.fontes);
      }
      fontes = [...new Set(fontes)].slice(0, 12);
      empresas = empresas.slice(0, 16);
    }
    return { regiao: reg.label, ramo: ramoTxt || null, empresas, fontes };
  } catch (e) {
    console.warn('[Radar] erro:', e.message);
    return { erro: 'Não consegui buscar agora. Tente de novo em instantes.' };
  }
}

function formatarRadar(r) {
  if (!r || r.erro) return `⚠️ ${r?.erro || 'Não foi possível rodar o radar.'}`;
  let t = `🎯 *RADAR DE EXPANSÃO*\n${r.regiao}${r.ramo ? ` · ${r.ramo}` : ''}\n\n`;
  if (!r.empresas || !r.empresas.length) {
    t += `Nenhuma empresa em expansão clara encontrada agora para esse filtro. Tente uma região mais ampla ou outro ramo.\n`;
    return t;
  }
  t += `*${r.empresas.length} empresa(s) em modo-expansão* que poderiam querer um imóvel aqui:\n\n`;
  r.empresas.forEach((e, i) => {
    t += `*${i + 1}. ${e.nome}*${e.ramo ? ` — ${e.ramo}` : ''}\n`;
    if (e.sinal) t += `   📈 ${e.sinal}\n`;
    if (e.cidadeAlvo) t += `   📍 Alvo: ${e.cidadeAlvo}\n`;
    if (e.imovelBuscado) t += `   🏗️ Busca: ${e.imovelBuscado}\n`;
    if (e.statusRegiao) t += `   🔎 Status: ${e.statusRegiao}\n`;
    if (e.fonte) t += `   🔗 ${e.fonte}\n`;
    t += `\n`;
  });
  try {
    const { textoFontes } = require('./fontes');
    t += textoFontes({
      metodo: 'Busca web de sinais de expansão (anúncios, vagas, franquias) por região e ramo.',
      data: new Date().toLocaleDateString('pt-BR'),
      bases: ['Perplexity sonar-pro (notícias e fontes públicas)'],
      links: r.fontes || [],
      obs: 'Leads de inteligência de mercado — sinais de expansão, NÃO demanda confirmada. Confirme o interesse direto com a empresa. Enriquecimento com eventos datados (Explorium: nova unidade/contratação) disponível sob demanda.',
    });
  } catch {}
  return t;
}

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
    const ehAnapolis = String(r.cidade || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes('anapolis');
    const bases = [
      'Google Maps (concorrência e fluxo do entorno)',
      ehAnapolis
        ? 'EBM/Aderni-GO · Planta Genérica de Valores — Anápolis (terreno e aluguel comercial)'
        : 'Mercado (VivaReal/ZAP) + multiplicador de bairro por cidade (terreno e aluguel comercial)',
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
      obs: `Cap rate depende de fechar contrato de locação longo (10-20 anos) com inquilino sólido. Coeficiente/taxa de ocupação e custo de obra são ESTIMATIVAS — confirmar no Plano Diretor de ${r.cidade || 'Anápolis'} e com orçamento de obra. Lista de empresas é inteligência de mercado (leads), não demanda confirmada.`,
    });
  } catch {}
  return t;
}

// ── CAMADA CNPJ — confirma filiais na Receita ────────────────────────
// Sinal DURO: filial registrada na Receita = expansão confirmada. Free APIs não
// buscam por município, então a verificação é DIRIGIDA por lead: acha os CNPJs da
// rede na região (Perplexity) e confirma CADA UM na Receita (BrasilAPI). CNPJ
// inventado/errado não passa (a Receita filtra por município + situação).
const RMG_CIDADES = ['aparecida de goiania', 'senador canedo', 'trindade', 'goianira', 'neropolis', 'goianapolis', 'hidrolandia', 'bela vista de goias', 'nova veneza', 'santo antonio de goias', 'abadia de goias', 'bonfinopolis', 'guapo', 'inhumas', 'terezopolis de goias'];
function _normTxt(s) { return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(); }
function cidadesDaRegiao(regKey) {
  if (regKey === 'anapolis') return ['anapolis'];
  if (regKey === 'goiania') return ['goiania'];
  if (regKey === 'rmg') return RMG_CIDADES;
  return ['anapolis', 'goiania', ...RMG_CIDADES];
}
const CUTOFF_NOVA = '2024-07-01'; // aberta nos últimos ~24 meses = "nova"

async function confirmarFiliais(empresa, regiao) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  const emp = String(empresa || '').trim();
  if (!emp) return { erro: 'Informe o nome da rede/empresa.' };
  const regKey = normRegiao(regiao);
  const reg = REGIOES[regKey] || REGIOES.todas;
  const cidades = cidadesDaRegiao(regKey);

  // 1) CNPJs candidatos da rede na região (Perplexity)
  let candidatos = [];
  if (apiKey) {
    try {
      const prompt = `Liste os CNPJs (14 dígitos, formato XX.XXX.XXX/XXXX-XX) de lojas, unidades ou filiais da rede "${emp}" localizadas em ${reg.alvo}. Inclua o CNPJ da matriz se ela ficar nessa região. Responda APENAS JSON válido: {"cnpjs":["..."]}. Só CNPJs REAIS e verificáveis; se não souber, retorne lista vazia. NUNCA invente CNPJ.`;
      const { data } = await axios.post('https://api.perplexity.ai/chat/completions', {
        model: 'sonar-pro',
        messages: [
          { role: 'system', content: 'Pesquisador de dados públicos de empresas (CNPJ) no Brasil. Responda SOMENTE JSON válido. NUNCA invente CNPJ — só cite CNPJ que você encontrar em fonte real.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0, max_tokens: 500,
      }, { timeout: 60000, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
      let s = String(data.choices[0].message.content || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const i = s.indexOf('{'), j = s.lastIndexOf('}');
      if (i >= 0 && j > i) s = s.slice(i, j + 1);
      try { candidatos = JSON.parse(s).cnpjs || []; } catch {}
    } catch (e) { console.warn('[Filiais] perplexity:', e.message); }
  }
  const digs = [...new Set(candidatos.map(c => String(c).replace(/\D/g, '')).filter(c => c.length === 14))].slice(0, 12);

  // 2) Confirma cada CNPJ na Receita (BrasilAPI) — filtra por município + situação
  const empTok = _normTxt(emp).split(' ').filter(w => w.length >= 3)[0] || _normTxt(emp);
  const verif = await Promise.all(digs.map(async (cnpj) => {
    try {
      const { data } = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { timeout: 15000 });
      const mun = _normTxt(data.municipio);
      const ativa = /ATIVA/i.test(data.descricao_situacao_cadastral || '');
      const naRegiao = cidades.some(c => mun.includes(c) || c.includes(mun));
      if (!ativa || !naRegiao) return null;
      const nomeBate = _normTxt(`${data.razao_social || ''} ${data.nome_fantasia || ''}`).includes(empTok);
      const abertura = data.data_inicio_atividade || '';
      return {
        cnpj: cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'),
        razao: data.razao_social, fantasia: data.nome_fantasia || null,
        municipio: data.municipio, uf: data.uf, abertura,
        cnae: data.cnae_fiscal_descricao, matrizFilial: data.descricao_identificador_matriz_filial,
        nova: abertura >= CUTOFF_NOVA, nomeBate,
      };
    } catch { return null; }
  }));
  const filiais = verif.filter(Boolean).sort((a, b) => (b.abertura || '').localeCompare(a.abertura || ''));
  return { empresa: emp, regiao: reg.label, filiais, checou: digs.length };
}

function formatarFiliais(r) {
  if (!r || r.erro) return `⚠️ ${r?.erro || 'Não foi possível confirmar filiais.'}`;
  let t = `🏢 *FILIAIS NA RECEITA — ${r.empresa}*\n${r.regiao}\n\n`;
  if (!r.filiais || !r.filiais.length) {
    t += `Nenhuma filial ativa de *${r.empresa}* confirmada na Receita para ${r.regiao}`;
    t += r.checou ? ` (checamos ${r.checou} CNPJ candidato(s)).\n` : `.\n`;
    t += `Pode ainda não ter unidade aqui — o que faz dela um *alvo de prospecção*, não um concorrente instalado.\n`;
    return t;
  }
  const novas = r.filiais.filter(f => f.nova).length;
  t += `*${r.filiais.length} unidade(s) confirmada(s)* na Receita${novas ? ` · ${novas} 🆕 nova(s) (últimos 24 meses)` : ''}:\n\n`;
  r.filiais.forEach((f) => {
    t += `• *${f.fantasia || f.razao}* — CNPJ ${f.cnpj}\n`;
    t += `   📍 ${f.municipio}-${f.uf} · ${f.matrizFilial || ''}\n`;
    t += `   📅 Aberta em ${f.abertura ? f.abertura.split('-').reverse().join('/') : '—'}${f.nova ? ' *🆕 NOVA*' : ''}\n`;
    if (f.cnae) t += `   🏷️ ${f.cnae}\n`;
    if (!f.nomeBate) t += `   ⚠️ _Razão social não bate exatamente com o nome buscado — confira._\n`;
    t += `\n`;
  });
  try {
    const { textoFontes } = require('./fontes');
    t += textoFontes({
      metodo: 'CNPJs da rede na região (busca web) confirmados individualmente na Receita Federal (município, situação, data de abertura).',
      data: new Date().toLocaleDateString('pt-BR'),
      bases: ['Receita Federal via BrasilAPI', 'Perplexity (localização dos CNPJs)'],
      obs: 'Confirmação por lead (não é varredura de todas as aberturas da cidade). Uma filial 🆕 recente é sinal duro de expansão ativa na região. CNPJ não localizado na busca pode existir mesmo assim.',
    });
  } catch {}
  return t;
}

module.exports = { analisarBTS, formatarBTS, CATALOGO_BTS, radarExpansao, formatarRadar, confirmarFiliais, formatarFiliais };
