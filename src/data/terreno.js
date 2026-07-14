// Análise de TERRENOS / LOTES com potencial construtivo (estudo de viabilidade
// de incorporação). Diferencial vs. avaliar terreno só por R$/m²: o valor real
// de um terreno é o que se pode CONSTRUIR e VENDER nele.
//
// Fluxo: valor de mercado do terreno (motor de avaliação real) → potencial
// construtivo (área × coeficiente de aproveitamento) → VGV (área vendável ×
// R$/m² de venda da região) → custo de obra (CUB-GO) → resultado do incorporador.

const OpenAI = require('openai');
const { calcularPreco } = require('./precificador');
const { getBaseVenda, getBaseLote } = require('./baseAnapolis');

let _openai = null;
function getOpenAI() {
  if (!_openai && process.env.OPENAI_API_KEY) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// Parâmetros urbanísticos típicos por zona — ESTIMATIVA (conferir Plano Diretor
// de Anápolis, Lei do Uso e Ocupação do Solo). ca = coef. de aproveitamento;
// to = taxa de ocupação (projeção máxima sobre o lote).
const ZONAS = {
  'residencial-baixa': { label: 'Residencial baixa densidade', ca: 1.0, to: 0.50, gabarito: 'até 2 pavimentos' },
  'residencial-media': { label: 'Residencial / mista média densidade', ca: 1.8, to: 0.60, gabarito: '4 a 6 pavimentos' },
  'corredor':          { label: 'Corredor / eixo comercial', ca: 3.0, to: 0.70, gabarito: '8 a 12 pavimentos' },
  'central':           { label: 'Central / alta densidade', ca: 4.0, to: 0.70, gabarito: '12+ pavimentos' },
};

// Custo de obra por m² construído (CUB-GO aprox., padrão residencial, ref. 2026).
const CUB = { popular: 1900, normal: 2500, alto: 3400 };

// ── Parâmetros do estudo de incorporação (calibrados p/ margem realista) ──
const EFICIENCIA = 0.78;          // área privativa vendável / área construída total
const FATOR_REALIZACAO = 0.90;    // preço de venda realizável vs. referência de tabela (desconto de negociação/lançamento)
const INDIRETOS_OBRA = 0.20;      // projeto, fundação/infra, administração da obra, BDI técnico (sobre o custo de obra)
const CUSTO_VENDAS = 0.08;        // comissão de corretagem + marketing/lançamento (sobre o VGV)
const IMPOSTO_VGV = 0.04;         // RET — Regime Especial de Tributação da incorporação (sobre o VGV)
const CUSTO_CAPITAL_MES = 0.012;  // custo financeiro do capital empregado (~1,2%/mês ≈ 15,4%/ano)
const PRAZO_PADRAO = 24;          // meses (obra + vendas) quando não informado

/**
 * Estudo de viabilidade de um terreno/lote.
 * input: { cidade, bairro, endereco, area, zona, ca, to, padrao, areaUnidade, valorPedido }
 */
async function analisarTerreno(input = {}) {
  const cidade = String(input.cidade || 'Anápolis').trim();
  const bairro = String(input.bairro || '').trim();
  const endereco = String(input.endereco || '').trim() || null;
  const area = Number(input.area) || 0;
  if (!bairro || area <= 0) return { erro: 'Informe o bairro e a área do terreno (m²).' };

  // 1) Valor de mercado do terreno — usa o motor de avaliação real (scraping/âncora PGV)
  let valorTerreno = 0, precoM2Terreno = 0, fontesPreco = [], confianca = 'baixa';
  try {
    const aval = await calcularPreco({ tipo: 'terreno', finalidade: 'venda', cidade, bairro, endereco, metragem: area });
    if (aval && !aval.erro && aval.precoRecomendado > 0) {
      valorTerreno = aval.precoRecomendado;
      precoM2Terreno = aval.precoM2Mercado || Math.round(aval.precoRecomendado / area);
      fontesPreco = (aval.fontesConsultadas || []).filter(Boolean);
      confianca = aval.confiancaFonte || 'media';
    }
  } catch (e) { console.warn('[Terreno] avaliação:', e.message); }
  if (!valorTerreno) {
    const lote = getBaseLote(cidade, bairro);
    precoM2Terreno = lote.m2;
    valorTerreno = Math.round(lote.m2 * area);
    fontesPreco = [lote.fonte];
  }
  const valorPedido = Number(input.valorPedido) > 0 ? Number(input.valorPedido) : null;
  // Para o estudo do incorporador, o custo do terreno é o que ele PAGA: o pedido (se informado) ou o de mercado.
  const custoTerreno = valorPedido || valorTerreno;

  // 2) Potencial construtivo
  const zonaKey = input.zona && ZONAS[input.zona] ? input.zona : 'residencial-media';
  const zona = ZONAS[zonaKey];
  const ca = Number(input.ca) > 0 ? Number(input.ca) : zona.ca;
  const to = Number(input.to) > 0 ? Number(input.to) : zona.to;
  const areaConstruivel = Math.round(area * ca);          // potencial construtivo máximo
  const areaProjecao = Math.round(area * to);             // footprint máximo no térreo
  const areaPrivativa = Math.round(areaConstruivel * EFICIENCIA); // área vendável

  // 3) VGV — Valor Geral de Vendas. Bruto = área vendável × R$/m² de referência;
  //    realizável = aplica o desconto de tabela/negociação (preço que sai de fato).
  const venda = getBaseVenda(cidade, bairro);
  const precoVendaM2 = venda.m2;
  const precoVendaRealizavel = Math.round(precoVendaM2 * FATOR_REALIZACAO);
  const vgvBruto = Math.round(areaPrivativa * precoVendaM2);
  const vgv = Math.round(areaPrivativa * precoVendaRealizavel); // VGV de trabalho (realizável)

  // 4) Cascata de custos da incorporação
  const padrao = input.padrao && CUB[input.padrao] ? input.padrao : 'normal';
  const cub = CUB[padrao];
  const prazoMeses = Number(input.prazoMeses) > 0 ? Math.round(Number(input.prazoMeses)) : PRAZO_PADRAO;

  const custoObra = Math.round(areaConstruivel * cub);
  const custoIndiretoObra = Math.round(custoObra * INDIRETOS_OBRA);          // projeto, infra, administração
  const custoVendas = Math.round(vgv * CUSTO_VENDAS);                        // comissão + marketing
  const impostos = Math.round(vgv * IMPOSTO_VGV);                            // RET incorporação
  // Custo financeiro: capital (terreno + obra) exposto ao longo do projeto,
  // com exposição média ~50% (desembolso gradual).
  const custoFinanceiro = Math.round((custoTerreno + custoObra) * CUSTO_CAPITAL_MES * prazoMeses * 0.5);
  const custoTotal = custoTerreno + custoObra + custoIndiretoObra + custoVendas + impostos + custoFinanceiro;

  // 5) Resultado do incorporador (sobre o VGV realizável)
  const lucro = vgv - custoTotal;
  const margem = vgv > 0 ? Math.round((lucro / vgv) * 100) : 0;
  const veredito = margem >= 20 ? '🟢 Atrativo' : margem >= 12 ? '🟡 Viável (apertado)' : margem >= 0 ? '🟠 Marginal' : '🔴 Inviável';

  // 6) Unidades possíveis (se informar área média da unidade)
  const areaUnidade = Number(input.areaUnidade) > 0 ? Number(input.areaUnidade) : null;
  const unidades = areaUnidade ? Math.floor(areaPrivativa / areaUnidade) : null;

  const resultado = {
    cidade, bairro, endereco, area,
    valorTerreno, precoM2Terreno, valorPedido, custoTerreno, confianca, fontesPreco,
    zonaKey, zonaLabel: zona.label, gabarito: zona.gabarito, ca, to,
    areaConstruivel, areaProjecao, areaPrivativa,
    precoVendaM2, precoVendaRealizavel, fatorRealizacao: FATOR_REALIZACAO,
    vgvBruto, vgv,
    padrao, cub, prazoMeses,
    custoObra, custoIndiretoObra, custoVendas, impostos, custoFinanceiro, custoTotal,
    lucro, margem, veredito,
    areaUnidade, unidades,
    caEstimado: !(Number(input.ca) > 0),
  };
  resultado.parecer = await gerarParecerTerreno(resultado).catch(() => null);
  return resultado;
}

async function gerarParecerTerreno(r) {
  const client = getOpenAI();
  if (!client) return null;
  try {
    const m = (v) => `R$ ${Number(v).toLocaleString('pt-BR')}`;
    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é um consultor de incorporação imobiliária. Explica de forma clara e direta para um corretor/investidor. Português do Brasil, sem jargão excessivo.' },
        { role: 'user', content: `Dê um parecer de 4-6 frases sobre a viabilidade de incorporar um terreno de ${r.area}m² no bairro ${r.bairro}, ${r.cidade}-GO (zona ${r.zonaLabel}, coef. de aproveitamento ${r.ca}). Potencial construtivo ${r.areaConstruivel}m², área vendável ${r.areaPrivativa}m². VGV realizável ${m(r.vgv)} (prazo ${r.prazoMeses} meses); custo total ${m(r.custoTotal)} = terreno ${m(r.custoTerreno)} + obra ${m(r.custoObra)} + indiretos ${m(r.custoIndiretoObra)} + vendas ${m(r.custoVendas)} + impostos ${m(r.impostos)} + custo financeiro ${m(r.custoFinanceiro)}; resultado ${m(r.lucro)} (margem ${r.margem}% sobre o VGV). Diga se vale a pena (margem de incorporação saudável costuma ser 15-25%), o que mais pesa no resultado, 1 alavanca para melhorar a margem e 1 ressalva (confirmar zoneamento/coeficiente no Plano Diretor de Anápolis).` },
      ],
      temperature: 0.5, max_tokens: 360,
    });
    return resp.choices[0].message.content.trim();
  } catch (e) { console.warn('[Terreno] parecer erro:', e.message); return null; }
}

function formatarTerreno(r) {
  if (!r || r.erro) return `⚠️ ${r?.erro || 'Não foi possível analisar o terreno.'}`;
  const m = (v) => `R$ ${Number(v).toLocaleString('pt-BR')}`;
  const n = (v) => Number(v).toLocaleString('pt-BR');

  let t = `🌳 *TERRENO / LOTE — Estudo de Viabilidade*\n`;
  t += `${r.bairro}, ${r.cidade} · ${n(r.area)} m²\n\n`;

  t += `${r.veredito} — *margem do incorporador: ${r.margem}%*\n\n`;

  if (r.parecer) t += `💬 *Parecer:*\n${r.parecer}\n\n`;

  t += `📐 *Valor do terreno (mercado):*\n`;
  t += `• ${m(r.valorTerreno)} (${m(r.precoM2Terreno)}/m²) — confiança ${r.confianca}\n`;
  if (r.valorPedido) t += `• Pedido do vendedor: *${m(r.valorPedido)}* (usado no estudo)\n`;
  t += `\n`;

  t += `🏗️ *Potencial construtivo:*\n`;
  t += `• Zona: ${r.zonaLabel} (${r.gabarito})\n`;
  t += `• Coef. de aproveitamento: *${r.ca}*${r.caEstimado ? ' (estimado)' : ''} → constrói até *${n(r.areaConstruivel)} m²*\n`;
  t += `• Projeção no térreo (TO ${Math.round(r.to * 100)}%): ${n(r.areaProjecao)} m²\n`;
  t += `• Área vendável (eficiência ${Math.round(EFICIENCIA * 100)}%): *${n(r.areaPrivativa)} m²*\n`;
  if (r.unidades) t += `• ≈ *${r.unidades} unidades* de ${n(r.areaUnidade)} m²\n`;
  t += `\n`;

  t += `💰 *Conta do incorporador (prazo ${r.prazoMeses || PRAZO_PADRAO} meses):*\n`;
  t += `• VGV potencial (tabela): ${n(r.areaPrivativa)} m² × ${m(r.precoVendaM2)}/m² = ${m(r.vgvBruto)}\n`;
  t += `• *VGV realizável* (−${Math.round((1 - (r.fatorRealizacao || FATOR_REALIZACAO)) * 100)}% tabela): ${m(r.precoVendaRealizavel)}/m² = *${m(r.vgv)}*\n`;
  t += `• (−) Terreno: ${m(r.custoTerreno)}\n`;
  t += `• (−) Obra (CUB ${r.padrao} ${m(r.cub)}/m²): ${m(r.custoObra)}\n`;
  t += `• (−) Indiretos da obra (projeto/infra/adm ${Math.round(INDIRETOS_OBRA * 100)}%): ${m(r.custoIndiretoObra)}\n`;
  t += `• (−) Vendas (comissão+marketing ${Math.round(CUSTO_VENDAS * 100)}% do VGV): ${m(r.custoVendas)}\n`;
  t += `• (−) Impostos (RET ${Math.round(IMPOSTO_VGV * 100)}% do VGV): ${m(r.impostos)}\n`;
  t += `• (−) Custo financeiro (${(CUSTO_CAPITAL_MES * 100).toFixed(1)}%/mês sobre capital): ${m(r.custoFinanceiro)}\n`;
  t += `• *Resultado: ${m(r.lucro)}* (margem ${r.margem}% sobre o VGV realizável)\n`;

  try {
    const { textoFontes } = require('./fontes');
    t += textoFontes({
      metodo: 'Avaliação do terreno por amostragem de mercado + estudo de massa (potencial construtivo × VGV − custos).',
      data: new Date().toLocaleDateString('pt-BR'),
      grau: r.confianca === 'alta' ? 'II (amostra robusta)' : 'I (referência)',
      portais: r.fontesPreco,
      bases: [
        'Planta Genérica de Valores — Prefeitura de Anápolis (terreno)',
        'EBM/Aderni-GO (R$/m² construído para o VGV)',
        'CUB-GO / Sinduscon (custo de obra)',
      ],
      obs: 'Coeficiente de aproveitamento e taxa de ocupação são ESTIMATIVAS — confirmar no Plano Diretor / Lei de Uso e Ocupação do Solo de Anápolis. Custo de obra e eficiência são parâmetros de referência. Estudo preliminar, não substitui projeto e viabilidade técnica.',
    });
  } catch {}
  return t;
}

module.exports = { analisarTerreno, formatarTerreno, ZONAS, CUB };
