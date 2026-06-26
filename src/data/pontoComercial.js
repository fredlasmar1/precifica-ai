const axios = require('axios');
const OpenAI = require('openai');

let _openai = null;
function getOpenAI() {
  if (!_openai && process.env.OPENAI_API_KEY) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

/**
 * ANÁLISE DE PONTO COMERCIAL — "Buscador Inteligente Comercial"
 *
 * Para uma imobiliária corporativa: dado um endereço + o RAMO do cliente,
 * avalia se aquele ponto é bom para o negócio. Usa Google Places (diretório
 * real de negócios, com nomes e notas) para medir:
 *  - Concorrência direta do ramo no raio (saturação x oportunidade)
 *  - Qualidade da concorrência (nota média — concorrente fraco = brecha)
 *  - Geradores de movimento por perto (escolas, bancos, mercados, etc.)
 *  - Demanda (população/renda do bairro, via IBGE quando disponível)
 * E entrega um SCORE 0-100 + veredito explicável.
 *
 * O OSM é pobre em Anápolis; por isso a fonte principal é o Google Places.
 */

const PLACES_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';

// Geradores de movimento padrão (sempre consultados)
const GERADORES = [
  { chave: 'escola',       label: 'Escolas/faculdades', keyword: 'escola faculdade', peso: 1.0 },
  { chave: 'banco',        label: 'Bancos',             keyword: 'banco agência',     peso: 0.8 },
  { chave: 'supermercado', label: 'Supermercados',      keyword: 'supermercado',      peso: 1.0 },
  { chave: 'saude',        label: 'Saúde (clínica/hospital)', keyword: 'clínica hospital', peso: 0.8 },
  { chave: 'comida',       label: 'Restaurantes/lanchonetes', keyword: 'restaurante lanchonete', peso: 0.6 },
  { chave: 'shopping',     label: 'Shopping/galeria',   keyword: 'shopping galeria',  peso: 1.2 },
];

async function placesNearby({ lat, lng, keyword, radius }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return { erro: 'GOOGLE_PLACES_API_KEY não configurada', results: [] };
  try {
    const { data } = await axios.get(PLACES_URL, {
      params: { location: `${lat},${lng}`, radius, keyword, key: apiKey },
      timeout: 15000
    });
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.warn(`[Places] status ${data.status} p/ "${keyword}"`);
    }
    return { results: data.results || [], capado: (data.results || []).length >= 20 };
  } catch (err) {
    console.warn('[Places] erro:', err.message);
    return { erro: err.message, results: [] };
  }
}

/** Conta e resume concorrentes do ramo (nome, nota, nº avaliações, coords). */
function resumirConcorrentes(results) {
  const reais = results.filter(r => r.business_status !== 'CLOSED_PERMANENTLY');
  const comNota = reais.filter(r => r.rating > 0);
  const notaMedia = comNota.length
    ? Math.round((comNota.reduce((a, r) => a + r.rating, 0) / comNota.length) * 10) / 10
    : null;
  const top = [...reais]
    .sort((a, b) => (b.user_ratings_total || 0) - (a.user_ratings_total || 0))
    .slice(0, 6)
    .map(r => ({ nome: r.name, nota: r.rating || null, avaliacoes: r.user_ratings_total || 0 }));
  const pontos = reais
    .map(r => r.geometry?.location)
    .filter(l => l && l.lat && l.lng)
    .slice(0, 15)
    .map(l => [l.lat, l.lng]);
  return { total: reais.length, notaMedia, top, pontos };
}

/** Mapa estático (Google) com o ponto do imóvel (azul) e concorrentes (vermelho). */
async function gerarMapaEstatico(center, pontos) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey || !center) return null;
  try {
    const markers = [
      `markers=color:0x013EF8|size:mid|${center[0]},${center[1]}`,
      ...(pontos || []).slice(0, 12).map(p => `markers=color:red|size:small|${p[0]},${p[1]}`)
    ].join('&');
    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${center[0]},${center[1]}&zoom=15&size=600x320&scale=2&${markers}&key=${apiKey}`;
    const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 12000 });
    return `data:image/png;base64,${Buffer.from(data).toString('base64')}`;
  } catch (err) {
    console.warn('[Mapa] erro:', err.message);
    return null;
  }
}

/** Extrai o ramo do negócio de uma pergunta em linguagem natural (via IA). */
async function extrairRamo(pergunta) {
  const client = getOpenAI();
  const txt = String(pergunta || '').trim();
  if (!txt) return null;
  if (!client) return txt; // sem IA, usa o texto cru
  try {
    const r = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Extraia o ramo/segmento de negócio mencionado. Responda APENAS com o ramo em 1 a 3 palavras, minúsculo, sem pontuação. Se não houver, responda "nenhum".' },
        { role: 'user', content: txt }
      ],
      temperature: 0, max_tokens: 12
    });
    const ramo = r.choices[0].message.content.trim().toLowerCase().replace(/[.?!]/g, '');
    return ramo === 'nenhum' ? null : ramo;
  } catch { return txt; }
}

/**
 * Analisa um ponto comercial.
 * @param {number} lat, lng — coordenadas do imóvel
 * @param {string} ramo — ramo do cliente (texto livre: "farmácia", "academia"...)
 * @param {object} ctx — { cidade, bairro, perfilGuru } (perfilGuru opcional, p/ demanda)
 */
async function analisarPontoComercial(lat, lng, ramo, ctx = {}) {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return { erro: 'Busca comercial indisponível (Google Places não configurado).' };
  }
  const ramoLimpo = String(ramo || '').trim();
  if (!ramoLimpo) return { erro: 'Informe o ramo do cliente (ex: farmácia, academia, padaria).' };

  // 1) Concorrência direta — 500m e 1km
  const [c500, c1k] = await Promise.all([
    placesNearby({ lat, lng, keyword: ramoLimpo, radius: 500 }),
    placesNearby({ lat, lng, keyword: ramoLimpo, radius: 1000 }),
  ]);
  const conc500 = resumirConcorrentes(c500.results);
  const conc1k = resumirConcorrentes(c1k.results);

  // 2) Geradores de movimento (500m)
  const geradoresRes = await Promise.all(
    GERADORES.map(g => placesNearby({ lat, lng, keyword: g.keyword, radius: 500 })
      .then(r => ({ ...g, qtd: resumirConcorrentes(r.results).total, capado: r.capado })))
  );
  const movimentoScore = geradoresRes.reduce((acc, g) => acc + Math.min(g.qtd, 8) * g.peso, 0);

  // 3) Demanda (IBGE via perfilGuru, se veio)
  const mun = ctx.perfilGuru?.municipio || null;
  const populacao = mun?.populacao || null;
  const pibPerCapita = mun?.pibPerCapita || null;

  // ─── SCORE explicável (0-100) ───────────────────────────────────
  let score = 45;
  const motivos = [];

  // Concorrência (faca de dois gumes): nenhuma = arriscado; pouca = valida demanda; muita = saturado
  const n = conc500.total;
  if (n === 0)        { score += 4;  motivos.push('Sem concorrentes diretos em 500m — mercado inexplorado (pode ser oportunidade ou falta de demanda).'); }
  else if (n <= 4)    { score += 16; motivos.push(`${n} concorrente(s) em 500m — demanda validada e ainda sem saturação (faixa ideal).`); }
  else if (n <= 9)    { score += 6;  motivos.push(`${n} concorrentes em 500m — mercado competitivo, exige diferenciação.`); }
  else                { score -= 14; motivos.push(`${n}+ concorrentes em 500m — região saturada para esse ramo.`); }

  // Qualidade da concorrência: fraca = brecha
  if (n >= 2 && conc500.notaMedia != null) {
    if (conc500.notaMedia < 3.8) { score += 12; motivos.push(`Concorrência fraca (nota média ${conc500.notaMedia}⭐) — brecha para um negócio melhor.`); }
    else if (conc500.notaMedia >= 4.4) { score -= 6; motivos.push(`Concorrência forte e bem avaliada (nota média ${conc500.notaMedia}⭐) — difícil se destacar.`); }
  }

  // Movimento
  if (movimentoScore >= 18)      { score += 28; motivos.push('Altíssimo fluxo: muitos geradores de movimento por perto.'); }
  else if (movimentoScore >= 10) { score += 20; motivos.push('Bom fluxo de pessoas: vários geradores de movimento por perto.'); }
  else if (movimentoScore >= 4)  { score += 10; motivos.push('Fluxo moderado de pessoas na região.'); }
  else                           { score -= 4;  motivos.push('Baixo fluxo: poucos geradores de movimento por perto.'); }

  // Demanda (renda)
  if (pibPerCapita) {
    if (pibPerCapita >= 45000)      { score += 10; motivos.push(`Renda da região acima da média (PIB/cap R$ ${Number(pibPerCapita).toLocaleString('pt-BR')}).`); }
    else if (pibPerCapita >= 30000) { score += 5; }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let veredito, emoji;
  if (score >= 75)      { veredito = 'Ótimo ponto'; emoji = '🟢'; }
  else if (score >= 60) { veredito = 'Bom ponto'; emoji = '🟢'; }
  else if (score >= 45) { veredito = 'Ponto regular'; emoji = '🟡'; }
  else                  { veredito = 'Ponto arriscado / saturado'; emoji = '🔴'; }

  const analise = {
    ramo: ramoLimpo,
    bairro: ctx.bairro, cidade: ctx.cidade,
    score, veredito, emoji, motivos,
    concorrencia: { em500m: conc500, em1km: conc1k, capado500: c500.capado, capado1k: c1k.capado },
    movimento: { score: Math.round(movimentoScore), geradores: geradoresRes.map(g => ({ label: g.label, qtd: g.qtd, capado: g.capado })) },
    demanda: { populacao, pibPerCapita },
  };

  // Parecer (IA) e mapa estático em paralelo — não bloqueiam se falharem
  const [parecer, mapaDataUri] = await Promise.all([
    gerarParecerIA(analise),
    gerarMapaEstatico([lat, lng], conc500.pontos)
  ]);
  analise.parecer = parecer;
  analise.mapaDataUri = mapaDataUri;

  return analise;
}

/**
 * Gera um parecer profissional curto (2-4 frases) via IA a partir dos dados
 * já calculados. Usa gpt-4o-mini (barato, ~US$0,002/parecer). Falha = null.
 */
async function gerarParecerIA(a) {
  const client = getOpenAI();
  if (!client) return null;
  const resumo = {
    ramo: a.ramo, bairro: a.bairro, score: a.score, veredito: a.veredito,
    concorrentes_500m: a.concorrencia.em500m.total + (a.concorrencia.capado500 ? '+' : ''),
    nota_media_concorrencia: a.concorrencia.em500m.notaMedia,
    geradores_movimento: a.movimento.geradores.map(g => `${g.label}:${g.qtd}`).join(', '),
    pib_per_capita: a.demanda.pibPerCapita
  };
  try {
    const r = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é um consultor sênior de pontos comerciais de uma imobiliária corporativa em Anápolis-GO. Escreva pareceres objetivos, profissionais e diretos, sem enrolação.' },
        { role: 'user', content: `Com base nestes dados de análise de ponto, escreva um parecer profissional curto (2 a 4 frases) recomendando ou não o ponto para o ramo do cliente, citando o principal motivo e uma orientação prática (ex: diferenciação, público, localização). Não repita os números crus, interprete-os. Dados:\n${JSON.stringify(resumo)}` }
      ],
      temperature: 0.5,
      max_tokens: 220
    });
    return r.choices[0].message.content.trim().replace(/^parecer:\s*/i, '');
  } catch (err) {
    console.warn('[Parecer IA] erro:', err.message);
    return null;
  }
}

/** Monta o relatório em texto (mesmo estilo dos laudos, com *negrito*). */
function formatarRelatorioComercial(a) {
  if (!a || a.erro) return `⚠️ ${a?.erro || 'Não foi possível analisar o ponto.'}`;
  const c = a.concorrencia.em500m, c1k = a.concorrencia.em1km;
  let t = `🏪 *ANÁLISE DE PONTO COMERCIAL*\n`;
  t += `━━━━━━━━━━━━━━━━━━━━━\n`;
  t += `Ramo do cliente: *${a.ramo}*\n`;
  t += `📍 ${a.bairro ? a.bairro + ', ' : ''}${a.cidade || 'Anápolis'}\n\n`;

  t += `${a.emoji} *Veredito: ${a.veredito}*  (score ${a.score}/100)\n\n`;

  t += `🥊 *Concorrência (mesmo ramo):*\n`;
  t += `• Em 500m: *${c.total}${a.concorrencia.capado500 ? '+' : ''}* concorrente(s)`;
  t += c.notaMedia != null ? ` (nota média ${c.notaMedia}⭐)\n` : `\n`;
  t += `• Em 1km: *${c1k.total}${a.concorrencia.capado1k ? '+' : ''}* concorrente(s)\n`;
  if (c.top.length) {
    t += `• Principais por perto:\n`;
    c.top.forEach(x => { t += `   – ${x.nome}${x.nota ? ` (${x.nota}⭐, ${x.avaliacoes} aval.)` : ''}\n`; });
  }
  t += `\n`;

  t += `🚶 *Geradores de movimento (500m):*\n`;
  a.movimento.geradores.forEach(g => { t += `• ${g.label}: ${g.qtd}${g.capado ? '+' : ''}\n`; });
  t += `\n`;

  if (a.demanda.populacao || a.demanda.pibPerCapita) {
    t += `📊 *Demanda (IBGE):*\n`;
    if (a.demanda.populacao) t += `• População do município: ${Number(a.demanda.populacao).toLocaleString('pt-BR')}\n`;
    if (a.demanda.pibPerCapita) t += `• PIB per capita: R$ ${Number(a.demanda.pibPerCapita).toLocaleString('pt-BR')}\n`;
    t += `\n`;
  }

  t += `🔎 *Por que essa nota:*\n`;
  a.motivos.forEach(m => { t += `• ${m}\n`; });
  t += `\n`;

  if (a.parecer) {
    t += `💬 *Parecer Bens:*\n${a.parecer}\n\n`;
  }

  t += `_Análise por amostragem de negócios listados no Google Maps. Indicativa, para apoio à decisão._`;
  return t;
}

// ─── RECOMENDADOR: "melhor bairro para o seu negócio" ────────────────
const { getBaseVenda } = require('./baseAnapolis');

const BAIRROS_COORDS = {
  'Jundiaí': [-16.33371, -48.93792],
  'Anápolis City': [-16.32657, -48.92784],
  'Cidade Jardim': [-16.31494, -48.94422],
  'Bairro JK': [-16.34701, -48.93627],
  'Jardim Europa': [-16.337, -48.92658],
  'Maracanã': [-16.31313, -48.95682],
  'Vila Jaiara': [-16.28508, -48.97136],
  'Vila Santa Isabel': [-16.306, -48.94674],
  'Parque Brasília': [-16.32451, -48.91399],
  'Vila Góis': [-16.33994, -48.95934],
  'Centro': [-16.32865, -48.95343],
  'Jardim Alexandrina': [-16.29764, -48.96186],
  'Vila Brasil': [-16.32726, -48.96879],
  'Recanto do Sol': [-16.28281, -48.9291],
};

/** Análise leve de um bairro (2 chamadas Places) para ranquear. */
async function analiseRapidaBairro(nome, lat, lng, ramo) {
  const [conc, superm] = await Promise.all([
    placesNearby({ lat, lng, keyword: ramo, radius: 1000 }),
    placesNearby({ lat, lng, keyword: 'supermercado mercado', radius: 1000 }),
  ]);
  const concorrentes = resumirConcorrentes(conc.results).total;
  const movimento = resumirConcorrentes(superm.results).total;
  const renda = getBaseVenda('Anápolis', nome).m2 || 4000; // poder de compra (proxy)

  let score = 50;
  const fatores = [];
  if (concorrentes <= 2)       { score += 5;  fatores.push('pouca concorrência (mercado aberto)'); }
  else if (concorrentes <= 8)  { score += 18; fatores.push('concorrência saudável (demanda validada, sem saturar)'); }
  else if (concorrentes <= 15) { score += 8;  fatores.push('concorrência moderada'); }
  else                         { score -= 10; fatores.push('mercado saturado'); }

  score += Math.min(movimento, 8) * 2.5; // movimento/fluxo
  if (movimento >= 6) fatores.push('alto fluxo comercial');

  if (renda >= 6000)      { score += 12; fatores.push('alto poder de compra'); }
  else if (renda >= 5000) { score += 8;  fatores.push('bom poder de compra'); }
  else if (renda >= 4000) { score += 4; }

  return { bairro: nome, score: Math.max(0, Math.min(100, Math.round(score))), concorrentes, movimento, renda, fatores };
}

/**
 * Varre os principais bairros de Anápolis e ranqueia os melhores para o ramo.
 * @param {string} ramo — ramo do negócio (ex: "barbearia")
 * @returns { ramo, ranking:[...], resposta (texto IA) }
 */
async function melhorBairro(ramo) {
  if (!process.env.GOOGLE_PLACES_API_KEY) return { erro: 'Busca indisponível (Google Places não configurado).' };
  const ramoLimpo = String(ramo || '').trim();
  if (!ramoLimpo) return { erro: 'Diga o ramo do negócio (ex: barbearia, padaria, academia).' };

  const entradas = Object.entries(BAIRROS_COORDS);
  const ranking = (await Promise.all(
    entradas.map(([nome, [lat, lng]]) => analiseRapidaBairro(nome, lat, lng, ramoLimpo).catch(() => null))
  )).filter(Boolean).sort((a, b) => b.score - a.score);

  const resposta = await gerarRespostaMelhorBairro(ramoLimpo, ranking);
  return { ramo: ramoLimpo, ranking, resposta };
}

async function gerarRespostaMelhorBairro(ramo, ranking) {
  const client = getOpenAI();
  const top = ranking.slice(0, 5).map(r => ({ bairro: r.bairro, score: r.score, concorrentes: r.concorrentes, fluxo: r.movimento }));
  if (!client) return null;
  try {
    const r = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é um consultor de pontos comerciais de uma imobiliária corporativa em Anápolis-GO. Responda de forma direta, profissional e prática.' },
        { role: 'user', content: `Um cliente quer abrir um(a) "${ramo}" em Anápolis e pergunta qual o melhor bairro. Com base neste ranking (score 0-100, nº de concorrentes e fluxo comercial por bairro), responda em 3-5 frases qual(is) bairro(s) recomendar e por quê, citando os 2-3 melhores e uma ressalva prática. Ranking:\n${JSON.stringify(top)}` }
      ],
      temperature: 0.5, max_tokens: 300
    });
    return r.choices[0].message.content.trim();
  } catch (err) { console.warn('[MelhorBairro IA] erro:', err.message); return null; }
}

function formatarMelhorBairro(d) {
  if (!d || d.erro) return `⚠️ ${d?.erro || 'Não foi possível analisar.'}`;
  let t = `🏆 *MELHOR BAIRRO PARA: ${d.ramo.toUpperCase()}*\n`;
  t += `━━━━━━━━━━━━━━━━━━━━━\n`;
  t += `📍 Anápolis-GO · ${d.ranking.length} bairros analisados\n\n`;
  if (d.resposta) t += `💬 *Recomendação Bens:*\n${d.resposta}\n\n`;
  t += `📊 *Ranking:*\n`;
  d.ranking.forEach((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    t += `${medal} *${r.bairro}* — ${r.score}/100  (${r.concorrentes} concorrentes, fluxo ${r.movimento})\n`;
  });
  t += `\n_Análise por amostragem (Google Maps). Indicativa, para apoio à decisão._`;
  return t;
}

module.exports = { analisarPontoComercial, formatarRelatorioComercial, melhorBairro, formatarMelhorBairro, extrairRamo };
