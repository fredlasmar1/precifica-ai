const { completar: completarLLM } = require('../agent/llm');
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

/**
 * Rentabilidade: aluguel, yield anual e payback (anos).
 *
 * `aluguelReal` e o aluguel que o MOTOR apurou no mercado. Quando existe, manda.
 * Sem ele, cai na referencia publicada (EBM) — que e noticiario de lancamento e
 * puxa para cima. Era so essa a fonte, e o laudo saia com DOIS alugueis
 * diferentes: R$ 3.060 aqui contra R$ 2.790 no motor, para o mesmo imovel.
 */
function rentabilidade(tipo, cidade, bairro, metragem, valorVenda, aluguelReal = 0) {
  if (!valorVenda || !metragem) return null;
  let aluguelMensal = Math.round(Number(aluguelReal) || 0);
  let fonte = 'mercado (anúncios de aluguel do bairro)';
  if (!aluguelMensal) {
    const al = getAncora(tipo, 'aluguel', cidade, bairro);
    aluguelMensal = Math.round((al.m2 || 0) * metragem);
    fonte = 'estimado pela referência publicada — sem anúncio de aluguel na amostra';
  }
  if (!aluguelMensal) return null;
  const anual = aluguelMensal * 12;
  return {
    aluguelMensal,
    fonte,
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
      const r = await placesNearby({ lat, lng, keyword: c.kw, radius: 1500 });
      // qtd null = NAO CONSULTADO. Antes a recusa do Google virava qtd 0 e o
      // laudo afirmava "0 escolas, 0 bancos, 0 mercados" no bairro mais denso
      // de Anapolis, com cara de dado apurado.
      if (r.indisponivel) { out.push({ categoria: c.categoria, qtd: null, maisProximoM: null, indisponivel: true }); continue; }
      const results = r.results || [];
      let maisProximoM = null;
      for (const x of results) {
        const loc = x.geometry && x.geometry.location;
        if (!loc) continue;
        const dm = Math.round(distM(lat, lng, loc.lat, loc.lng));
        if (maisProximoM == null || dm < maisProximoM) maisProximoM = dm;
      }
      out.push({ categoria: c.categoria, qtd: results.length, maisProximoM });
    } catch { out.push({ categoria: c.categoria, qtd: null, maisProximoM: null, indisponivel: true }); }
  }
  // Nenhuma categoria respondeu (Google fora do ar): tenta o OpenStreetMap, que
  // e gratuito e nao depende de chave. A cobertura em Anapolis e MENOR que a do
  // Google — por isso cada linha sai marcada com a fonte, e o laudo diz de onde
  // veio. Fonte declarada e melhor que bloco vazio; fonte disfarcada, nunca.
  if (out.every(o => o.indisponivel)) {
    try {
      const { mapearInfraestrutura } = require('./osmApi');
      const osm = await mapearInfraestrutura(lat, lng, 1500);
      const c = osm && osm.categorias;
      if (c) {
        const linhas = [
          { categoria: 'Escolas',   qtd: c.educacao?.total || 0 },
          { categoria: 'Saúde',     qtd: c.saude?.total || 0 },
          { categoria: 'Mercados',  qtd: (c.comercio?.tipos?.supermarket || 0) + (c.comercio?.tipos?.convenience || 0) },
          { categoria: 'Farmácias', qtd: c.saude?.tipos?.pharmacy || 0 },
          { categoria: 'Bancos',    qtd: c.financeiro?.total || 0 },
        // Num mapa COLABORATIVO ausencia nao e prova de inexistencia: o Jundiai
        // tem escola, o OSM e que nao tem escola mapeada ali. Entao zero do OSM
        // vira null (nao mapeado) e a linha some, em vez de o laudo afirmar
        // "0 escolas" — o mesmo vicio do zero de falha do Google, noutra fonte.
        ].map(l => ({ ...l, qtd: l.qtd > 0 ? l.qtd : null, maisProximoM: null, fonte: 'OpenStreetMap' }));
        if (linhas.some(l => l.qtd > 0)) {
          console.log(`[Infra] Google indisponivel — OpenStreetMap respondeu (${osm.totalEstabelecimentos} estabelecimentos em 1,5km)`);
          return linhas;
        }
      }
    } catch (e) { console.warn('[Infra] OSM de reserva falhou:', e.message); }
    return null;
  }
  return out;
}

/** Tendência do bairro (IA, 1-2 frases). */
async function tendenciaBairro(cidade, bairro, valorM2) {
  const client = getOpenAI();
  if (!client) return null;
  try {
    const resp = await completarLLM({ forte: false, maxTokens: 120, messages: [
        { role: 'system', content: 'Você conhece o mercado imobiliário de Anápolis-GO. Responda em 1-2 frases curtas e simples, sem inventar números.' },
        { role: 'user', content: `O bairro ${bairro} em ${cidade}-GO tem valor de referência ~R$ ${Number(valorM2 || 0).toLocaleString('pt-BR')}/m². Em 1-2 frases, diga se é um bairro em valorização, estável ou de oportunidade, e por quê (perfil, localização, demanda). Sem números inventados.` },
      ] });
    return resp.choices[0].message.content.trim();
  } catch (e) { console.warn('[Enriquecimento] tendência erro:', e.message); return null; }
}

/** Calcula todos os enriquecimentos (best-effort, em paralelo). */
async function enriquecer({ tipo, cidade, bairro, metragem, valorVenda, precoM2, lat, lng, aluguelReal }) {
  const [infra, tendencia] = await Promise.all([
    infraestruturaProxima(lat, lng).catch(() => null),
    tendenciaBairro(cidade, bairro, precoM2).catch(() => null),
  ]);
  return {
    rentabilidade: rentabilidade(tipo, cidade, bairro, metragem, valorVenda, aluguelReal),
    financiamento: financiamento(valorVenda),
    infraestrutura: infra,
    tendencia,
  };
}

module.exports = { rentabilidade, financiamento, infraestruturaProxima, tendenciaBairro, enriquecer };
