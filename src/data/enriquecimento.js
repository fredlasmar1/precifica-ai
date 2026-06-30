const OpenAI = require('openai');
const { getAncora } = require('./baseAnapolis');

/**
 * ENRIQUECIMENTO DA AVALIAÇÃO — dados extras para deixar o laudo o mais
 * completo do mercado: rentabilidade (venda × aluguel), infraestrutura
 * próxima (Google Maps), tendência do bairro e simulação de financiamento.
 */
let _openai = null;
function getOpenAI() {
  if (!_openai && process.env.OPENAI_API_KEY) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

/** Rentabilidade: aluguel estimado, yield anual e payback (anos). */
function rentabilidade(tipo, cidade, bairro, metragem, valorVenda) {
  if (!valorVenda || !metragem) return null;
  const al = getAncora(tipo, 'aluguel', cidade, bairro);
  const aluguelMensal = Math.round((al.m2 || 0) * metragem);
  if (!aluguelMensal) return null;
  const anual = aluguelMensal * 12;
  return {
    aluguelMensal,
    yieldAnual: +((anual / valorVenda) * 100).toFixed(2),
    paybackAnos: +(valorVenda / anual).toFixed(1),
  };
}

/** Simulação de financiamento (Tabela Price, padrão de mercado). */
function financiamento(valor, opts = {}) {
  if (!valor) return null;
  const entradaPct = opts.entradaPct || 20;
  const taxaAnual = opts.taxaAnual || 10.5;
  const prazoMeses = opts.prazoMeses || 360;
  const entrada = Math.round((valor * entradaPct) / 100);
  const financiado = valor - entrada;
  const i = taxaAnual / 100 / 12;
  const f = Math.pow(1 + i, prazoMeses);
  const parcela = Math.round((financiado * i * f) / (f - 1));
  return { entrada, entradaPct, financiado, parcela, prazoMeses, taxaAnual, rendaNecessaria: Math.round(parcela / 0.30) };
}

function distM(la1, lo1, la2, lo2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Infraestrutura num raio de 1,5km (Google Places). */
async function infraestruturaProxima(lat, lng) {
  if (lat == null || lng == null) return null;
  let placesNearby;
  try { ({ placesNearby } = require('./pontoComercial')); } catch { return null; }
  const cats = [
    { categoria: 'Escolas', kw: 'escola' },
    { categoria: 'Saúde', kw: 'hospital posto de saúde' },
    { categoria: 'Mercados', kw: 'supermercado' },
    { categoria: 'Farmácias', kw: 'farmácia' },
    { categoria: 'Bancos', kw: 'banco' },
  ];
  const out = [];
  for (const c of cats) {
    try {
      const { results } = await placesNearby({ lat, lng, keyword: c.kw, radius: 1500 });
      const qtd = (results || []).length;
      let maisProximoM = null;
      const loc = qtd && results[0].geometry && results[0].geometry.location;
      if (loc) maisProximoM = Math.round(distM(lat, lng, loc.lat, loc.lng));
      out.push({ categoria: c.categoria, qtd, maisProximoM });
    } catch { out.push({ categoria: c.categoria, qtd: 0, maisProximoM: null }); }
  }
  return out;
}

/** Tendência do bairro (IA, 1-2 frases). */
async function tendenciaBairro(cidade, bairro, valorM2) {
  const client = getOpenAI();
  if (!client) return null;
  try {
    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você conhece o mercado imobiliário de Anápolis-GO. Responda em 1-2 frases curtas e simples, sem inventar números.' },
        { role: 'user', content: `O bairro ${bairro} em ${cidade}-GO tem valor de referência ~R$ ${Number(valorM2 || 0).toLocaleString('pt-BR')}/m². Em 1-2 frases, diga se é um bairro em valorização, estável ou de oportunidade, e por quê (perfil, localização, demanda). Sem números inventados.` },
      ],
      temperature: 0.4, max_tokens: 120,
    });
    return resp.choices[0].message.content.trim();
  } catch (e) { console.warn('[Enriquecimento] tendência erro:', e.message); return null; }
}

/** Calcula todos os enriquecimentos (best-effort, em paralelo). */
async function enriquecer({ tipo, cidade, bairro, metragem, valorVenda, precoM2, lat, lng }) {
  const [infra, tendencia] = await Promise.all([
    infraestruturaProxima(lat, lng).catch(() => null),
    tendenciaBairro(cidade, bairro, precoM2).catch(() => null),
  ]);
  return {
    rentabilidade: rentabilidade(tipo, cidade, bairro, metragem, valorVenda),
    financiamento: financiamento(valorVenda),
    infraestrutura: infra,
    tendencia,
  };
}

module.exports = { rentabilidade, financiamento, infraestruturaProxima, tendenciaBairro, enriquecer };
