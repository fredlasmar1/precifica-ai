const OpenAI = require('openai');
const { getBaseVenda } = require('./baseAnapolis');

/**
 * AVALIAÇÃO DE EMPRESA / PASSAGEM DE PONTO — Anápolis.
 * Calcula uma faixa de valor por 3 métodos (rentabilidade, faturamento,
 * patrimonial) + parecer em linguagem simples. Não é laudo contábil; é um
 * parecer mercadológico de apoio à negociação (corretor pode emitir).
 */
let _openai = null;
function getOpenAI() {
  if (!_openai && process.env.OPENAI_API_KEY) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const brl0 = (v) => Math.round(n(v));

async function avaliarEmpresa(input = {}) {
  const ramo = String(input.ramo || '').trim();
  const bairro = String(input.bairro || '').trim();
  const cidade = String(input.cidade || 'Anápolis').trim();
  const faturamentoMensal = n(input.faturamentoMensal);
  let lucroMensal = n(input.lucroMensal);
  const dividas = n(input.dividas);
  const ativos = n(input.ativos); // equipamentos + estoque + reformas
  const anos = n(input.anosOperacao);
  const dependencia = (input.dependenciaDono || 'média').toLowerCase();

  if (faturamentoMensal <= 0) return { erro: 'Informe ao menos o faturamento mensal.' };

  // Lucro: se não veio, estima por margem típica (rótulo claro de estimativa)
  let lucroEstimado = false;
  if (lucroMensal <= 0) { lucroMensal = Math.round(faturamentoMensal * 0.15); lucroEstimado = true; }
  const margem = faturamentoMensal > 0 ? lucroMensal / faturamentoMensal : 0;

  // ── Multiplicador de risco (meses de lucro) ──
  let meses = 30;
  const fatores = [];
  if (anos >= 5)        { meses += 4; fatores.push('negócio consolidado (5+ anos no mercado)'); }
  else if (anos > 0 && anos < 2) { meses -= 6; fatores.push('negócio novo (menos de 2 anos)'); }
  if (dependencia === 'baixa')  { meses += 6; fatores.push('opera sem depender do dono (mais valioso)'); }
  else if (dependencia === 'alta') { meses -= 8; fatores.push('muito dependente do dono (mais arriscado)'); }
  if (margem >= 0.25)   { meses += 5; fatores.push('margem de lucro alta'); }
  else if (margem < 0.10) { meses -= 4; fatores.push('margem de lucro apertada'); }
  const renda = (getBaseVenda(cidade, bairro).m2) || 4000;
  if (renda >= 6000)    { meses += 3; fatores.push('ponto em região de alto poder de compra'); }
  else if (renda < 4000) { meses -= 2; }
  meses = Math.max(18, Math.min(48, meses));

  // ── Métodos ──
  const valorRentabilidade = brl0(lucroMensal * meses);          // going concern (inclui ponto/clientela)
  // Múltiplo de faturamento (regra de mercado) — calibrado pela margem p/ não
  // destoar do método de lucro (negócio de margem baixa vale menos meses).
  const mesesFat = margem >= 0.25 ? 8 : margem >= 0.15 ? 5 : margem >= 0.08 ? 3 : 2;
  const valorFaturamento = brl0(faturamentoMensal * mesesFat);
  const ativosLiquidos = brl0(ativos - dividas);                 // piso (liquidação)

  // ── Valor sugerido: rentabilidade − dívidas, com piso no patrimonial ──
  const valorSugerido = Math.max(brl0(valorRentabilidade - dividas), ativosLiquidos, 0);
  const faixaMin = brl0(valorSugerido * 0.85);
  const faixaMax = brl0(valorSugerido * 1.15);

  const resultado = {
    ramo, bairro, cidade,
    faturamentoMensal, lucroMensal, lucroEstimado, margem: Math.round(margem * 100),
    dividas, ativos,
    multiplicadorMeses: meses, fatores,
    metodos: {
      rentabilidade: valorRentabilidade,
      faturamento: valorFaturamento,
      patrimonial: ativosLiquidos,
    },
    valorSugerido, faixaMin, faixaMax,
  };
  resultado.parecer = await gerarParecerEmpresa(resultado);
  return resultado;
}

async function gerarParecerEmpresa(r) {
  const client = getOpenAI();
  if (!client) return null;
  try {
    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é um consultor que explica de forma MUITO SIMPLES, pra um cliente leigo. Frases curtas, sem jargão. Português do Brasil.' },
        { role: 'user', content: `Explique em 4-6 frases simples o valor estimado de uma empresa "${r.ramo}" no bairro ${r.bairro}, ${r.cidade}-GO à venda. Dados: fatura R$${r.faturamentoMensal}/mês, lucro R$${r.lucroMensal}/mês (margem ${r.margem}%)${r.lucroEstimado ? ' (lucro estimado)' : ''}, dívidas R$${r.dividas}, ativos R$${r.ativos}. Valor sugerido R$${r.valorSugerido} (faixa R$${r.faixaMin} a R$${r.faixaMax}). Diga o valor de forma clara, explique em palavras simples como chegamos (lucro × tempo de retorno), dê 1-2 dicas práticas de negociação e 1 ressalva (conferir os números com contador).` },
      ],
      temperature: 0.5, max_tokens: 380,
    });
    return resp.choices[0].message.content.trim();
  } catch (e) { console.warn('[ValuationEmpresa] parecer erro:', e.message); return null; }
}

function formatarEmpresa(r) {
  if (!r || r.erro) return `⚠️ ${r?.erro || 'Não foi possível avaliar.'}`;
  const m = (v) => `R$ ${Number(v).toLocaleString('pt-BR')}`;
  let t = `💼 *AVALIAÇÃO DE EMPRESA*\n`;
  t += `${r.ramo ? r.ramo + ' · ' : ''}${r.bairro ? r.bairro + ', ' : ''}${r.cidade}\n\n`;

  t += `💰 *Valor sugerido: ${m(r.valorSugerido)}*\n`;
  t += `Faixa de negociação: ${m(r.faixaMin)} a ${m(r.faixaMax)}\n\n`;

  if (r.parecer) t += `💬 *Em palavras simples:*\n${r.parecer}\n\n`;

  t += `📊 *Os números:*\n`;
  t += `• Faturamento: ${m(r.faturamentoMensal)}/mês\n`;
  t += `• Lucro: ${m(r.lucroMensal)}/mês (margem ${r.margem}%)${r.lucroEstimado ? ' — estimado' : ''}\n`;
  if (r.dividas) t += `• Dívidas: ${m(r.dividas)}\n`;
  if (r.ativos) t += `• Equipamentos/estoque: ${m(r.ativos)}\n\n`;

  t += `\n🧮 *Como calculamos (3 métodos):*\n`;
  t += `• Pela rentabilidade: lucro × ${r.multiplicadorMeses} meses = *${m(r.metodos.rentabilidade)}* (método principal)\n`;
  t += `• Pelo faturamento: *${m(r.metodos.faturamento)}*\n`;
  t += `• Pelo patrimônio (equipamentos − dívidas): *${m(r.metodos.patrimonial)}* (piso)\n`;
  if (r.fatores && r.fatores.length) {
    t += `\n🔎 *O que pesou no múltiplo:*\n`;
    r.fatores.forEach(f => { t += `• ${f}\n`; });
  }
  t += `\n_Parecer mercadológico de apoio à negociação. NÃO é avaliação contábil — confirme os números (faturamento, lucro, dívidas) com documentos e um contador antes de fechar._`;
  return t;
}

module.exports = { avaliarEmpresa, formatarEmpresa };
