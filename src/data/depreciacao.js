const { getAncora } = require('./baseAnapolis');
const { ZONAS, CUB } = require('./terreno');

/**
 * DEPRECIAÇÃO E MÉTODO EVOLUTIVO (ref. ABNT NBR 14653-2, item 8.2.2).
 *
 * Existe para responder a pergunta que o comparativo não responde: quanto vale
 * um apartamento em prédio ANTIGO que não tem NENHUM anúncio? Sem mercado ativo
 * não há comparável — e a âncora EBM/Aderni é preço de prédio NOVO (lançamento),
 * então usá-la crua superestima um prédio de 30 anos em 30-50%.
 *
 * O evolutivo não depende de anúncio nenhum:
 *   VI = (VT + CB_depreciado) × FC
 *   VT = valor do terreno (fração ideal da unidade no lote)
 *   CB = custo de reedição da construção (CUB-GO), depreciado por Ross-Heidecke
 *   FC = fator de comercialização
 */

// Vida útil de referência p/ edifício de concreto armado (prática de avaliação BR).
const VIDA_UTIL_ANOS = 60;

// Piso residual da construção: prédio DE PÉ e em uso nunca vale zero de
// benfeitoria, por mais velho que seja. Ross puro chega a 100% aos 60 anos.
const RESIDUAL_MIN = 0.20;

// Heidecke — coeficiente por estado de conservação (tabela clássica), mapeado
// para os estados que o app já usa no formulário.
const HEIDECKE = {
  novo: 0.0000,      // a. novo
  bom: 0.0032,       // b. entre novo e regular
  regular: 0.0252,   // c. regular
  reformar: 0.1810,  // e. reparos simples
};

// Fator de comercialização (FC) = mercado ÷ custo. NÃO é constante: em bairro
// disputado a terra é escassa e o mercado paga MUITO acima do custo de reedição.
// Medido aqui: no Jundiaí o FC real é ~2,0 — um FC fixo de 0,90 dava 47% do
// preço de mercado verificado do Ed. Rio Pison. Por isso o FC é CALIBRADO pela
// âncora do bairro (é o que a NBR manda: FC se extrai do mercado), e não chutado.
// Limites só para não propagar âncora/CUB absurdos.
const FC_MIN = 0.6, FC_MAX = 3.0;

// Amplitude da faixa em torno do valor central. O evolutivo é estimativa, não
// laudo: entregar número cravado seria mentir sobre a precisão.
const AMPLITUDE = 0.12;

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Ross-Heidecke — fração depreciada do CUSTO DA CONSTRUÇÃO (não do imóvel todo:
 * o terreno não deprecia).
 *   Ross (idade):        Kr = ½·(i/n + (i/n)²)  — devagar no começo, acelera no fim
 *   Heidecke (estado):   C incide sobre o que sobrou do Ross
 *   Total:               K = Kr + C·(1 − Kr)
 */
function rossHeidecke(idade, conservacao = 'bom', vidaUtil = VIDA_UTIL_ANOS) {
  const i = Math.max(0, Number(idade) || 0);
  const r = Math.min(1, i / vidaUtil);
  const kRoss = 0.5 * (r + r * r);
  const c = HEIDECKE[conservacao] != null ? HEIDECKE[conservacao] : HEIDECKE.bom;
  const kBruto = kRoss + c * (1 - kRoss);
  const k = Math.min(kBruto, 1 - RESIDUAL_MIN);
  return { k, kRoss, c, vidaUtil, residualAplicado: kBruto > k };
}

/** CUB-GO do padrão declarado na ficha ('alto'/'médio-alto'/'médio'/'popular'). */
function cubDoPadrao(padrao) {
  const p = norm(padrao);
  if (/popular/.test(p)) return { valor: CUB.popular, label: 'popular' };
  // médio-alto ANTES de alto: senão "médio-alto" casa em /alto/ e vira padrão alto.
  if (/alto/.test(p) && /medio/.test(p)) return { valor: Math.round((CUB.normal + CUB.alto) / 2), label: 'médio-alto' };
  if (/alto/.test(p)) return { valor: CUB.alto, label: 'alto' };
  return { valor: CUB.normal, label: 'médio' };
}

/**
 * Coeficiente de aproveitamento presumido do prédio = quantos m² construídos
 * existem por m² de lote. Define a fatia de terreno que cabe a cada unidade:
 * quanto MAIOR o CA (prédio alto, muitas unidades), MENOR a fração ideal de cada
 * uma. Prédio antigo costuma ser baixo e espaçado → CA menor → mais terreno por
 * unidade, o que compensa parte da depreciação da construção.
 */
function caPresumido(anoConstrucao) {
  if (anoConstrucao && anoConstrucao < 2000) {
    return { ca: 1.5, fonte: 'presumido — prédio anterior a 2000 (4-6 pavimentos típicos)' };
  }
  const z = ZONAS['residencial-media'];
  return { ca: z.ca, fonte: `presumido — zona ${z.label} (${z.gabarito})` };
}

/**
 * Composição de custo de um m² construído do prédio + o FC calibrado no bairro.
 *
 * O FC sai da própria âncora: prédio NOVO no bairro vale a âncora de venda, e
 * custa (terreno + CUB). Logo FC = âncora ÷ custo_novo. Com isso o evolutivo
 * herda o prêmio de localização — que o custo de reedição, sozinho, ignora.
 */
function composicao({ cidade, bairro, padrao, ca, anoConstrucao }) {
  const terreno = getAncora('terreno', 'venda', cidade, bairro);
  const venda = getAncora('apartamento', 'venda', cidade, bairro);
  if (!terreno || !(terreno.m2 > 0) || !venda || !(venda.m2 > 0)) return null;

  const cubInfo = cubDoPadrao(padrao);
  const caInfo = ca > 0 ? { ca: Number(ca), fonte: 'informado' } : caPresumido(anoConstrucao);

  // Fração ideal de terreno por m² construído = 1 m² de lote ÷ CA m² construídos.
  const terrenoM2 = Math.round(terreno.m2 / caInfo.ca);
  const custoNovo = terrenoM2 + cubInfo.valor;
  const fcBruto = venda.m2 / custoNovo;
  const fc = Math.min(FC_MAX, Math.max(FC_MIN, fcBruto));

  return {
    terreno, venda, cubInfo, caInfo, terrenoM2, custoNovo,
    fc, fcClampado: fc !== fcBruto,
    // Peso da construção no custo — só ela deprecia; o terreno não.
    pesoConstrucao: cubInfo.valor / custoNovo,
  };
}

/**
 * Estimativa evolutiva de R$/m² e valor total de uma unidade.
 * Devolve a MEMÓRIA DE CÁLCULO — a decisão de produto é mostrar a conta, não só
 * o número: sem anúncio por trás, um valor nu seria indistinguível de um chute.
 */
function estimarEvolutivo({ cidade, bairro, area, anoConstrucao, conservacao = 'bom', padrao, ca, anoRef }) {
  const ano = Number(anoConstrucao);
  if (!(ano > 1900)) return null; // sem ano de construção não há evolutivo

  const anoAtual = Number(anoRef) || new Date().getFullYear();
  const idade = Math.max(0, anoAtual - ano);

  const c = composicao({ cidade, bairro, padrao, ca, anoConstrucao: ano });
  if (!c) return null;

  const dep = rossHeidecke(idade, conservacao);
  const construcaoM2 = Math.round(c.cubInfo.valor * (1 - dep.k));
  const valorM2 = Math.round((c.terrenoM2 + construcaoM2) * c.fc);

  const faixaMinM2 = Math.round(valorM2 * (1 - AMPLITUDE));
  const faixaMaxM2 = Math.round(valorM2 * (1 + AMPLITUDE));
  const a = Number(area) > 0 ? Number(area) : null;

  // Confiança: roda sobre presumidos (CA, padrão, conservação). Nunca é "alta" —
  // se fosse, não precisaríamos avisar que é estimativa.
  const confianca = (c.terreno.confianca === 'alta' && c.venda.confianca === 'alta' && ca > 0) ? 'media' : 'baixa';

  return {
    metodo: 'evolutivo',
    idade, anoConstrucao: ano, conservacao,
    terrenoM2: c.terrenoM2, terrenoFonte: c.terreno.fonte, terrenoBairroM2: c.terreno.m2,
    ancoraBairroM2: c.venda.m2, ancoraFonte: c.venda.fonte,
    ca: c.caInfo.ca, caFonte: c.caInfo.fonte,
    cub: c.cubInfo.valor, cubLabel: c.cubInfo.label,
    depreciacao: dep.k, depreciacaoPct: Math.round(dep.k * 100),
    residualAplicado: dep.residualAplicado,
    vidaUtil: dep.vidaUtil,
    fc: Math.round(c.fc * 100) / 100, fcClampado: c.fcClampado, custoNovo: c.custoNovo,
    construcaoM2, valorM2, faixaMinM2, faixaMaxM2,
    area: a,
    valorTotal: a ? Math.round(valorM2 * a) : null,
    faixaMin: a ? Math.round(faixaMinM2 * a) : null,
    faixaMax: a ? Math.round(faixaMaxM2 * a) : null,
    confianca,
  };
}

const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR');

/** Bloco de texto com a conta à vista (tela do app). */
function formatarEvolutivo(e, condominio) {
  if (!e) return '';
  let t = `\n💰 *ESTIMATIVA${e.area ? '' : ' (por m²)'} — sem anúncios no prédio*\n`;
  t += `Método: evolutivo (NBR 14653-2) — terreno + custo de reedição depreciado.\n\n`;
  t += `  Terreno (fração ideal)      ${brl(e.terrenoM2)}/m²\n`;
  t += `    ${brl(e.terrenoBairroM2)}/m² de lote no bairro ÷ CA ${String(e.ca).replace('.', ',')} (${e.caFonte})\n`;
  t += `  Custo de reedição CUB-GO    ${brl(e.cub)}/m² (padrão ${e.cubLabel})\n`;
  t += `  Depreciação (${e.idade} anos, ${e.conservacao})  −${e.depreciacaoPct}%  → ${brl(e.construcaoM2)}/m²\n`;
  t += `    Ross-Heidecke, vida útil ${e.vidaUtil} anos${e.residualAplicado ? ' (piso residual de 20% aplicado — prédio de pé não vale zero)' : ''}\n`;
  t += `  Fator de comercialização    ×${String(e.fc).replace('.', ',')}\n`;
  t += `    calibrado no bairro: ${brl(e.ancoraBairroM2)}/m² (prédio novo) ÷ ${brl(e.custoNovo)}/m² de custo\n`;
  t += `  ──────────────────────────────────────────\n`;
  t += `  *Estimativa: ${brl(e.faixaMinM2)} – ${brl(e.faixaMaxM2)}/m²*\n`;
  if (e.valorTotal) {
    t += `  *Unidade de ${e.area}m²: ${brl(e.faixaMin)} – ${brl(e.faixaMax)}*\n`;
  }
  t += `\n⚠️ _*Estimativa, não laudo.* Prédio de ${e.anoConstrucao}, padrão ${e.cubLabel}. Confiança: ${String(e.confianca).toUpperCase()}._\n`;
  t += `_CA e estado de conservação são presumidos. Para laudo: vistoria + fração ideal da matrícula + 1 transação real (ITBI)._\n`;
  if (!e.area) t += `_Informe a *área* da unidade para o valor total._\n`;
  return t;
}

/**
 * Fator de idade aplicável ao R$/m² vindo do MERCADO DO BAIRRO.
 * Usar quando o preço saiu de comparáveis do bairro (estoque de idades variadas)
 * e o imóvel avaliado é mais velho que esse estoque. NÃO usar quando o preço veio
 * de unidades do próprio prédio: ali a idade já está no comparável, e descontar
 * de novo seria contar duas vezes.
 *
 * Deprecia só o EXCEDENTE de idade sobre o estoque de referência, e só sobre a
 * parcela CONSTRUÍDA (o terreno não deprecia) — daí precisar da composição real
 * do bairro em vez de um peso fixo: no Jundiaí a construção é ~80% do custo, num
 * bairro de terra barata é bem menos.
 */
const IDADE_REFERENCIA = 8; // idade média presumida do estoque anunciado

function fatorIdadeMercado({ idade, conservacao = 'bom', cidade, bairro, padrao, ca, anoConstrucao }) {
  const i = Number(idade);
  if (!(i > IDADE_REFERENCIA)) return null;
  const c = composicao({ cidade, bairro, padrao, ca, anoConstrucao });
  if (!c) return null;

  const k = rossHeidecke(i, conservacao).k;
  const kRef = rossHeidecke(IDADE_REFERENCIA, conservacao).k;
  const atual = c.terrenoM2 + c.cubInfo.valor * (1 - k);
  const ref = c.terrenoM2 + c.cubInfo.valor * (1 - kRef);
  const fator = atual / ref;
  return {
    fator, pct: Math.round((1 - fator) * 100), idade: i, k,
    idadeReferencia: IDADE_REFERENCIA, pesoConstrucao: c.pesoConstrucao,
  };
}

module.exports = {
  rossHeidecke, estimarEvolutivo, formatarEvolutivo, fatorIdadeMercado,
  cubDoPadrao, caPresumido, composicao, VIDA_UTIL_ANOS, HEIDECKE,
};
