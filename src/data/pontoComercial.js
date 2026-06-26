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

/** Conta e resume concorrentes do ramo (nome, nota, nº avaliações). */
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
  return { total: reais.length, notaMedia, top };
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

  // Parecer profissional via IA (não bloqueia o resultado se falhar)
  analise.parecer = await gerarParecerIA(analise);

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

module.exports = { analisarPontoComercial, formatarRelatorioComercial };
