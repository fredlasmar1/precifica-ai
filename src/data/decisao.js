// Comparador de decisão do proprietário: MANTER ALUGADO × VENDER E INVESTIR EM TÍTULOS.
// Puxa as taxas reais (Selic/CDI/IPCA da BrasilAPI) e compara renda mensal,
// retorno a.a. e PATRIMÔNIO projetado nos dois cenários. Apoio à decisão — NÃO é
// recomendação de investimento em valor mobiliário.

const axios = require('axios');
const OpenAI = require('openai');
let _openai = null;
function getOpenAI() { if (!_openai && process.env.OPENAI_API_KEY) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); return _openai; }

async function getTaxas() {
  try {
    const { data } = await axios.get('https://brasilapi.com.br/api/taxas/v1', { timeout: 12000 });
    const map = {}; (data || []).forEach(x => { map[x.nome] = Number(x.valor); });
    return { selic: map.Selic || 14.25, cdi: map.CDI || 14.15, ipca: map.IPCA || 4.72, data: new Date().toLocaleDateString('pt-BR') };
  } catch (e) {
    return { selic: 14.25, cdi: 14.15, ipca: 4.72, data: new Date().toLocaleDateString('pt-BR'), fallback: true };
  }
}

async function analisarDecisao(input = {}) {
  const valorImovel = Number(input.valorImovel) || 0;
  if (valorImovel <= 0) return { erro: 'Informe o valor de mercado do imóvel.' };
  const taxas = await getTaxas();

  const aluguelMensal = Number(input.aluguelMensal) > 0 ? Number(input.aluguelMensal) : Math.round(valorImovel * 0.005);
  const aluguelEstimado = !(Number(input.aluguelMensal) > 0);
  const iptuAnual = Number(input.iptuAnual) >= 0 && input.iptuAnual !== '' && input.iptuAnual != null ? Number(input.iptuAnual) : Math.round(valorImovel * 0.007);
  const taxaAdmin = Number(input.taxaAdmin) >= 0 ? Number(input.taxaAdmin) : 8;       // % do aluguel
  const vacancia = Number(input.vacancia) >= 0 ? Number(input.vacancia) : 8;          // % ao ano
  const irAluguel = Number(input.irAluguel) >= 0 ? Number(input.irAluguel) : 15;      // % (efetivo)
  const valorizacao = Number(input.valorizacaoAnual) >= 0 ? Number(input.valorizacaoAnual) : Number(taxas.ipca.toFixed(2)); // %/ano
  const custoVenda = Number(input.custoVenda) >= 0 ? Number(input.custoVenda) : 6;    // % (corretagem/cartório)
  const impostoGanho = Number(input.impostoGanho) > 0 ? Number(input.impostoGanho) : 0; // R$ (IR ganho de capital, se houver)
  const taxaTitulos = Number(input.taxaTitulos) > 0 ? Number(input.taxaTitulos) : Number(taxas.cdi.toFixed(2)); // % a.a. bruto
  const irTitulos = Number(input.irTitulos) >= 0 ? Number(input.irTitulos) : 15;      // % (IR renda fixa, longo prazo)
  const anos = Number(input.horizonteAnos) > 0 ? Math.round(Number(input.horizonteAnos)) : 10;

  // ── Cenário A — MANTER E ALUGAR ──
  const aluguelAnualBruto = aluguelMensal * 12;
  const perdaVacancia = aluguelAnualBruto * vacancia / 100;
  const custoAdmin = aluguelAnualBruto * taxaAdmin / 100;
  const brutoAposCustos = aluguelAnualBruto - perdaVacancia - custoAdmin - iptuAnual;
  const irAluguelValor = Math.max(0, brutoAposCustos) * irAluguel / 100;
  const rendaLiquidaAnualA = Math.round(brutoAposCustos - irAluguelValor);
  const rendaMensalA = Math.round(rendaLiquidaAnualA / 12);
  const yieldLiquidoA = valorImovel > 0 ? (rendaLiquidaAnualA / valorImovel) * 100 : 0; // % a.a.
  const retornoTotalA = yieldLiquidoA + valorizacao; // renda + valorização

  // ── Cenário B — VENDER E INVESTIR ──
  const custoVendaValor = Math.round(valorImovel * custoVenda / 100);
  const liquidoVenda = Math.round(valorImovel - custoVendaValor - impostoGanho);
  const taxaTitulosLiq = taxaTitulos * (1 - irTitulos / 100); // % a.a. líquido
  const rendaAnualB = Math.round(liquidoVenda * taxaTitulosLiq / 100);
  const rendaMensalB = Math.round(rendaAnualB / 12);

  // ── Patrimônio projetado em N anos ──
  const rNet = taxaTitulosLiq / 100; // taxa líquida títulos (p/ reinvestir a renda do aluguel também, comparação justa)
  const fvAnnuity = rNet > 0 ? (Math.pow(1 + rNet, anos) - 1) / rNet : anos;
  const patrimonioA = Math.round(valorImovel * Math.pow(1 + valorizacao / 100, anos) + rendaLiquidaAnualA * fvAnnuity);
  const patrimonioB = Math.round(liquidoVenda * Math.pow(1 + rNet, anos));

  const difPatr = patrimonioA - patrimonioB;
  const vencedor = difPatr > 0 ? 'manter' : 'vender';
  const difRendaMensal = rendaMensalA - rendaMensalB;

  const r = {
    valorImovel, aluguelMensal, aluguelEstimado, anos, taxas,
    premissas: { iptuAnual, taxaAdmin, vacancia, irAluguel, valorizacao, custoVenda, impostoGanho, taxaTitulos, irTitulos },
    cenarioA: { rendaLiquidaAnual: rendaLiquidaAnualA, rendaMensal: rendaMensalA, yieldLiquido: +yieldLiquidoA.toFixed(2), retornoTotal: +retornoTotalA.toFixed(2), patrimonio: patrimonioA, aluguelAnualBruto, perdaVacancia: Math.round(perdaVacancia), custoAdmin: Math.round(custoAdmin), iptuAnual, irAluguelValor: Math.round(irAluguelValor) },
    cenarioB: { liquidoVenda, custoVendaValor, impostoGanho, rendaAnual: rendaAnualB, rendaMensal: rendaMensalB, taxaLiquida: +taxaTitulosLiq.toFixed(2), patrimonio: patrimonioB },
    vencedor, difPatr: Math.abs(difPatr), difPatrPct: patrimonioB > 0 ? Math.round((difPatr / patrimonioB) * 100) : 0,
    difRendaMensal,
  };
  r.parecer = await gerarParecerDecisao(r).catch(() => null);
  return r;
}

async function gerarParecerDecisao(r) {
  const client = getOpenAI();
  if (!client) return null;
  try {
    const m = (v) => `R$ ${Number(v).toLocaleString('pt-BR')}`;
    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é consultor imobiliário e de patrimônio. Explica de forma clara e equilibrada para o proprietário decidir. Português do Brasil. NÃO recomende um título específico; compare cenários e aponte trade-offs (liquidez, risco, trabalho, tributação, valorização).' },
        { role: 'user', content: `Compare, para a proprietária, MANTER o imóvel alugado vs VENDER e aplicar em títulos (renda fixa). Imóvel ${m(r.valorImovel)}; aluguel ${m(r.aluguelMensal)}/mês. Manter: renda líquida ${m(r.cenarioA.rendaMensal)}/mês (yield ${r.cenarioA.yieldLiquido}% a.a.) + valorização ${r.premissas.valorizacao}% a.a.; patrimônio em ${r.anos} anos ${m(r.cenarioA.patrimonio)}. Vender: líquido ${m(r.cenarioB.liquidoVenda)}, aplicado a ${r.cenarioB.taxaLiquida}% a.a. líquido = ${m(r.cenarioB.rendaMensal)}/mês; patrimônio em ${r.anos} anos ${m(r.cenarioB.patrimonio)}. Em 3-5 frases: diga qual tende a render mais no patrimônio, a diferença de renda mensal, e os trade-offs (o imóvel dá valorização e renda mas tem vacância/trabalho/liquidez baixa; os títulos têm liquidez/zero trabalho mas sem valorização de imóvel e renda tributada). Termine lembrando que não é recomendação de investimento e sugerindo validar com um profissional.` },
      ],
      temperature: 0.5, max_tokens: 380,
    });
    return resp.choices[0].message.content.trim();
  } catch (e) { console.warn('[Decisao] parecer:', e.message); return null; }
}

function formatarDecisao(r) {
  if (!r || r.erro) return `⚠️ ${r?.erro || 'Não foi possível montar a comparação.'}`;
  const m = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR')}`;
  const A = r.cenarioA, B = r.cenarioB;

  let t = `⚖️ *ALUGAR × VENDER E INVESTIR*\n`;
  t += `Imóvel: ${m(r.valorImovel)} · Aluguel: ${m(r.aluguelMensal)}/mês${r.aluguelEstimado ? ' _(estimado)_' : ''}\n`;
  t += `_Taxas de hoje: Selic ${r.taxas.selic}% · CDI ${r.taxas.cdi}% · IPCA ${r.taxas.ipca}% (${r.taxas.data})_\n`;

  t += `\n🏠 *CENÁRIO A — Manter alugado:*\n`;
  t += `• Renda líquida: *${m(A.rendaMensal)}/mês* (${m(A.rendaLiquidaAnual)}/ano)\n`;
  t += `   _bruto ${m(A.aluguelAnualBruto)} − vacância ${m(A.perdaVacancia)} − adm ${m(A.custoAdmin)} − IPTU ${m(A.iptuAnual)} − IR ${m(A.irAluguelValor)}_\n`;
  t += `• Yield líquido: *${A.yieldLiquido}% a.a.* + valorização ${r.premissas.valorizacao}% = *${A.retornoTotal}% a.a.*\n`;
  t += `• Patrimônio em ${r.anos} anos: *${m(A.patrimonio)}*\n`;

  t += `\n💵 *CENÁRIO B — Vender e investir:*\n`;
  t += `• Líquido da venda: *${m(B.liquidoVenda)}* _(− ${m(B.custoVendaValor)} custos${B.impostoGanho ? ` − ${m(B.impostoGanho)} IR ganho` : ''})_\n`;
  t += `• Renda dos títulos: *${m(B.rendaMensal)}/mês* (${B.taxaLiquida}% a.a. líquido)\n`;
  t += `• Patrimônio em ${r.anos} anos: *${m(B.patrimonio)}* _(reinvestindo)_\n`;

  t += `\n🎯 *VEREDITO:*\n`;
  if (r.vencedor === 'manter') {
    t += `📈 *Manter alugado* rende mais no patrimônio: *+${m(r.difPatr)}* em ${r.anos} anos (${r.difPatrPct >= 0 ? '+' : ''}${r.difPatrPct}%).\n`;
  } else {
    t += `📈 *Vender e investir* rende mais no patrimônio: *+${m(r.difPatr)}* em ${r.anos} anos.\n`;
  }
  const dr = r.difRendaMensal;
  t += `💰 Renda mensal: ${dr >= 0 ? `alugar entrega +${m(dr)}/mês` : `os títulos entregam +${m(-dr)}/mês`}.\n`;

  if (r.parecer) t += `\n💬 *Parecer:*\n${r.parecer}\n`;

  try {
    const { textoFontes } = require('./fontes');
    t += textoFontes({
      metodo: 'Comparação de cenários (fluxo de caixa + patrimônio projetado). Aluguel: renda líquida de custos/IR + valorização. Venda: líquido investido em renda fixa (líquida de IR), reinvestido.',
      data: r.taxas.data,
      bases: ['Taxas Selic/CDI/IPCA — Banco Central via BrasilAPI'],
      obs: 'Estudo comparativo de apoio à decisão, NÃO é recomendação de compra de valor mobiliário. Premissas (vacância, valorização, IR, taxa) são editáveis e afetam o resultado — valide com seu contador/assessor de investimentos. IR sobre ganho de capital na venda pode ter isenções (ex.: uso do valor na compra de outro imóvel em 180 dias).',
    });
  } catch {}
  return t;
}

module.exports = { analisarDecisao, formatarDecisao };
