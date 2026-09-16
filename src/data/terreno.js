const { completar: completarLLM } = require('../agent/llm');
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

// ─────────────────────────────────────────────────────────────────────
// LEITURA DE FOTOS E MEDIÇÃO DO GOOGLE (visão) — a IA descreve, o código ajusta
// ─────────────────────────────────────────────────────────────────────
// O dono manda a foto da rua, a vista de satélite e/ou a captura do
// "Medir área" do Google Maps. A IA transcreve o que vê (área do polígono,
// esquina, aclive, muro, construção em cima); NENHUM valor sai dela — os
// ajustes de preço são regra de código, com linha própria no laudo.

const PROMPT_FOTOS_TERRENO = `Você é um avaliador imobiliário descrevendo um TERRENO/LOTE a partir de imagens: fotos da rua, vista de satélite e/ou capturas de tela do "Medir distância/área" do Google Maps.

REGRAS:
- Descreva SOMENTE o que está nas imagens. Nunca invente medida, área ou característica.
- Se houver uma captura do Google Maps com "Área: X m²" ou "Perímetro: Y m", transcreva os números EXATAMENTE em "areaGoogle"/"perimetroGoogle". Se não houver, null.
- Se a captura mostra o polígono e a escala, estime "frenteEstimada" (metros na rua) só se for possível ler; senão null.
- "esquina": true só se o lote claramente faz esquina com duas ruas.
- "topografia": "plano", "aclive" (sobe da rua), "declive" (desce da rua) ou null se não dá para ver.
- "edificacao": descreva construção existente sobre o lote (casa, barracão, ruína) ou null se vazio.
- "riscos": rede de alta tensão, córrego/APP, encosta, lixo, ocupação — só se visível.

Responda SOMENTE com JSON válido:
{
  "areaGoogle": number|null, "perimetroGoogle": number|null, "frenteEstimada": number|null,
  "formato": "regular|irregular|null", "esquina": true|false|null, "topografia": "plano|aclive|declive|null",
  "murado": true|false|null, "calcada": true|false|null, "pavimentacao": "asfalto|bloquete|terra|null",
  "edificacao": "string|null", "vegetacao": "limpo|mato|arvores|null",
  "entorno": "residencial|comercial|misto|industrial|rural|null", "padraoEntorno": "popular|medio|alto|null",
  "riscos": ["string"], "pontosFortes": ["string"], "pontosAtencao": ["string"], "avisos": ["string"]
}`;

function parseJSON(bruto) {
  let t = String(bruto || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const i = t.indexOf('{'), f = t.lastIndexOf('}');
  if (i >= 0 && f > i) t = t.slice(i, f + 1);
  return JSON.parse(t);
}

async function lerFotosTerreno(fotos = []) {
  if (!fotos.length) return null;
  const content = [{ type: 'text', text: PROMPT_FOTOS_TERRENO }];
  fotos.slice(0, 10).forEach((url) => content.push({ type: 'image_url', image_url: { url, detail: 'high' } }));
  const r = await completarLLM({
    forte: true, maxTokens: 1500, effort: 'low',
    messages: [
      { role: 'system', content: 'Você descreve terrenos a partir de imagens com honestidade técnica. Não inventa o que não está na imagem. Responda SOMENTE com JSON válido, sem markdown.' },
      { role: 'user', content }
    ]
  });
  const d = parseJSON(r);
  d.ajustes = ajustesPorLeitura(d);
  return d;
}

/** Poste e fiação comum não são risco; a IA tende a listar. Só o que pesa no preço fica. */
const RISCO_GRAVE = /alta tens|linh[ãa]o|c[óo]rrego|\bAPP\b|nascente|encosta|barranco|alag|inund|lix[ãa]o|ocupa[çc][ãa]o|invas|eros[ãa]o|torre de transmiss/i;
function riscosRelevantes(l = {}) { return (l.riscos || []).filter((r) => RISCO_GRAVE.test(r)); }

/** Fatores que o mercado cobra ou paga — regra de código, não palpite de IA. */
function ajustesPorLeitura(l = {}) {
  const a = [];
  if (l.esquina === true) a.push({ motivo: 'Lote de esquina (duas testadas, uso comercial possível)', pct: +0.08 });
  if (l.topografia === 'aclive') a.push({ motivo: 'Aclive em relação à rua (contenção e movimentação de terra)', pct: -0.08 });
  if (l.topografia === 'declive') a.push({ motivo: 'Declive em relação à rua (fundação e drenagem mais caras)', pct: -0.12 });
  if (l.formato === 'irregular') a.push({ motivo: 'Formato irregular (aproveitamento menor do projeto)', pct: -0.05 });
  if (l.edificacao) a.push({ motivo: `Construção existente a demolir/aproveitar: ${l.edificacao}`, pct: -0.04 });
  if (l.pavimentacao === 'terra') a.push({ motivo: 'Rua sem pavimentação', pct: -0.06 });
  const graves = riscosRelevantes(l);
  if (graves.length) a.push({ motivo: `Risco visível: ${graves.join('; ')}`, pct: -0.10 });
  if (l.murado === true) a.push({ motivo: 'Lote murado', pct: +0.02 });
  const total = Math.max(-0.30, Math.min(0.15, a.reduce((s, x) => s + x.pct, 0)));
  return { itens: a, total: Math.round(total * 100) / 100 };
}

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
  // Leitura de fotos/medição (se veio): ajusta o valor de mercado com linha própria.
  const leitura = input.leitura && typeof input.leitura === 'object' ? input.leitura : null;
  const ajustes = leitura ? (leitura.ajustes || ajustesPorLeitura(leitura)) : null;
  const valorTerrenoBase = valorTerreno;
  if (ajustes && ajustes.total) valorTerreno = Math.round(valorTerreno * (1 + ajustes.total) / 1000) * 1000;

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
    valorTerreno, valorTerrenoBase, precoM2Terreno, valorPedido, custoTerreno, confianca, fontesPreco,
    leitura, ajustes,
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
    const resp = await completarLLM({ forte: false, maxTokens: 700, messages: [
        { role: 'system', content: 'Você é um consultor de incorporação imobiliária. Explica de forma clara e direta para um corretor/investidor. Português do Brasil, sem jargão excessivo.' },
        { role: 'user', content: `Dê um parecer de 4-6 frases sobre a viabilidade de incorporar um terreno de ${r.area}m² no bairro ${r.bairro}, ${r.cidade}-GO (zona ${r.zonaLabel}, coef. de aproveitamento ${r.ca}). Potencial construtivo ${r.areaConstruivel}m², área vendável ${r.areaPrivativa}m². VGV realizável ${m(r.vgv)} (prazo ${r.prazoMeses} meses); custo total ${m(r.custoTotal)} = terreno ${m(r.custoTerreno)} + obra ${m(r.custoObra)} + indiretos ${m(r.custoIndiretoObra)} + vendas ${m(r.custoVendas)} + impostos ${m(r.impostos)} + custo financeiro ${m(r.custoFinanceiro)}; resultado ${m(r.lucro)} (margem ${r.margem}% sobre o VGV). Diga se vale a pena (margem de incorporação saudável costuma ser 15-25%), o que mais pesa no resultado, 1 alavanca para melhorar a margem e 1 ressalva (confirmar zoneamento/coeficiente no Plano Diretor de Anápolis).` },
      ] });
    return String(resp || '').trim();
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
  if (r.ajustes && r.ajustes.itens && r.ajustes.itens.length) {
    t += `• Pela amostra do bairro: ${m(r.valorTerrenoBase)} (${m(r.precoM2Terreno)}/m²) — confiança ${r.confianca}\n`;
    r.ajustes.itens.forEach((a) => { t += `• ${a.pct > 0 ? '+' : ''}${Math.round(a.pct * 100)}% — ${a.motivo}\n`; });
    t += `• *Ajustado pelo que as fotos mostram: ${m(r.valorTerreno)}* (${r.ajustes.total > 0 ? '+' : ''}${Math.round(r.ajustes.total * 100)}%)\n`;
  } else {
    t += `• ${m(r.valorTerreno)} (${m(r.precoM2Terreno)}/m²) — confiança ${r.confianca}\n`;
  }
  if (r.valorPedido) t += `• Pedido do vendedor: *${m(r.valorPedido)}* (usado no estudo)\n`;
  t += `\n`;

  const L = r.leitura;
  if (L) {
    t += `📷 *O que as fotos e a medição mostram:*\n`;
    if (L.areaGoogle) t += `• Área medida no Google: ${n(L.areaGoogle)} m²${L.perimetroGoogle ? ` · perímetro ${n(L.perimetroGoogle)} m` : ''}${Math.abs(L.areaGoogle - r.area) / r.area > 0.05 ? ` — ⚠️ difere ${Math.round(Math.abs(L.areaGoogle - r.area) / r.area * 100)}% da área informada (${n(r.area)} m²)` : ' — bate com a área informada'}\n`;
    if (L.frenteEstimada) t += `• Frente estimada: ${n(L.frenteEstimada)} m\n`;
    const car = [L.esquina === true ? 'esquina' : null, L.topografia, L.formato ? `formato ${L.formato}` : null, L.murado === true ? 'murado' : L.murado === false ? 'sem muro' : null, L.pavimentacao ? `rua de ${L.pavimentacao}` : null, L.vegetacao, L.entorno ? `entorno ${L.entorno}${L.padraoEntorno ? ' ' + L.padraoEntorno : ''}` : null].filter(Boolean);
    if (car.length) t += `• Características: ${car.join(' · ')}\n`;
    if (L.edificacao) t += `• Construção sobre o lote: ${L.edificacao}\n`;
    riscosRelevantes(L).forEach((x) => { t += `• 🔴 Risco: ${x}\n`; });
    (L.pontosAtencao || []).slice(0, 4).forEach((x) => { t += `• 🟡 ${x}\n`; });
    (L.avisos || []).slice(0, 2).forEach((x) => { t += `   – _${x}_\n`; });
    t += `\n`;
  }
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

module.exports = { analisarTerreno, formatarTerreno, lerFotosTerreno, ajustesPorLeitura, ZONAS, CUB };
