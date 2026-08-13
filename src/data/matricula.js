/**
 * AVALIAÇÃO POR AMOSTRAGEM A PARTIR DA MATRÍCULA + FOTOS
 * ─────────────────────────────────────────────────────────────────────
 * A entrada aqui não é formulário: é DOCUMENTO. O corretor/advogado joga a
 * certidão de inteiro teor e o conjunto fotográfico, a IA lê os dois, ele
 * confere na tela, e sai o parecer técnico de valor (o mesmo formato do
 * modelo Balladão) com o Anexo I de pesquisa de mercado já preenchido.
 *
 * O que a IA faz: TRANSCREVER (matrícula) e DESCREVER (fotos).
 * O que o código faz: CALCULAR. Nenhum valor sai de LLM.
 *
 * Três métodos independentes, como no modelo:
 *   1. evolutivo   — terreno + custo de reedição depreciado × fator de comercialização
 *   2. comparativo — preço TOTAL das casas semelhantes do bairro, homogeneizado
 *   3. âncora      — avaliação anterior atualizada por valorização + regularização
 * Convergindo os três, a dispersão vira a medida de confiança.
 */

const OpenAI = require('openai');
const { buscarComparativos, filtrarHomonimos } = require('./portais');
const { getBaseVenda, getBaseLote } = require('./baseAnapolis');
const { rossHeidecke } = require('./depreciacao');

let _openai;
function getOpenAI() {
  if (!_openai && process.env.OPENAI_API_KEY) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ── Parâmetros do modelo (todos editáveis pelo usuário na tela) ──────
// CUB-GO residencial + BDI, projetos e taxas. O modelo do escritório usou
// R$ 3.100/m² para padrão normal alto — a escala abaixo mantém esse ponto.
const CUB_PADRAO = { popular: 2100, normal: 2700, 'normal-alto': 3100, alto: 3700 };
const VIDA_UTIL_CASA = 60;   // casa térrea/sobrado dura mais que apartamento
const IDADE_REFERENCIA = 8;  // idade típica do estoque anunciado, p/ calibrar o FC
// A mediana do bairro mistura padrões; o imóvel avaliado desvia dela por acabamento.
const FATOR_PADRAO = { popular: 0.85, normal: 1.0, 'normal-alto': 1.15, alto: 1.30 };
const FC_PADRAO = 0.92;          // fator de comercialização (custo de construir → preço de venda)
const FATOR_AREA_SECUNDARIA = 0.5; // garagem coberta, subsolo, varanda, depósito
const VALORIZACAO_ANO = 0.07;    // valorização anual do residencial em Anápolis
const GANHO_REGULARIZACAO = 0.03;// efeito do habite-se + averbação sobre liquidez
const MARGEM_ANUNCIO = 0.08;     // desconto médio entre pedido e fechado
const VENDA_RAPIDA = 0.87;       // 90 dias
const YIELD_LOCACAO = 0.0040;    // aluguel mensal ≈ 0,40% do valor
const ITBI_ALIQUOTA = 0.02;      // Anápolis — conferir na Prefeitura

// Descontos por situação documental (cumulativos, teto de 20%)
const DESC_SEM_AVERBACAO = 0.08; // não financiável, escritura exige regularizar antes
const DESC_SEM_TITULO = 0.05;    // vendedor é promitente comprador / cessão de direitos
const DESC_ONUS = 0.10;          // hipoteca, penhora, indisponibilidade
const DESC_TETO = 0.20;

// Ajuste de conservação na homogeneização da amostra (o comparável mediano
// do bairro é um imóvel em estado "bom").
const CONSERVACAO_FATOR = { novo: 1.10, otimo: 1.05, bom: 1.0, regular: 0.90, ruim: 0.78 };

const cubDoPadraoLocal = (padrao) => CUB_PADRAO[padrao] || CUB_PADRAO.normal;
const hoje = () => new Date().toLocaleDateString('pt-BR');
const brl = (v) => (v == null || Number.isNaN(Number(v)) ? '—'
  : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }));
const num = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR'));
const mediana = (arr) => {
  const s = (arr || []).filter((n) => Number(n) > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// ─────────────────────────────────────────────────────────────────────
// 1. LEITURA DA MATRÍCULA (visão) — transcreve, não interpreta valor
// ─────────────────────────────────────────────────────────────────────

const PROMPT_MATRICULA = `Você está transcrevendo uma CERTIDÃO DE INTEIRO TEOR de matrícula de imóvel brasileira.

REGRAS ABSOLUTAS:
- Transcreva SOMENTE o que está escrito. Nunca deduza, complete ou estime.
- Campo que não aparece no documento = null. NUNCA invente número de área, data, nome ou valor.
- Atenção especial: se NÃO houver averbação de construção, "areaConstruida" é null e "construcaoAverbada" é false. Muitas matrículas descrevem apenas o LOTE — nesse caso a área que aparece é do TERRENO, jamais a construída.
- Ônus: só marque "existe" se houver hipoteca, alienação fiduciária, penhora, arresto, sequestro, usufruto, servidão, cláusula de inalienabilidade ou indisponibilidade efetivamente registrada.
- Se o proprietário registral for diferente de quem consta como comprador em compromisso/promessa de compra e venda, registre os dois.
- NÚMEROS EXIGEM DOBRO DE ATENÇÃO. Número de lote, quadra, matrícula, CPF/CNPJ, área e valor são o que mais se lê errado em documento digitalizado. Releia cada um antes de responder e confira a coerência interna: as confrontações costumam citar os lotes vizinhos, então o lote do imóvel NÃO pode ser igual a nenhum dos confrontantes.
- Se um número estiver ilegível ou você ficar em dúvida, devolva null naquele campo em vez de arriscar. Campo vazio o usuário preenche; campo errado ele não percebe.

Responda SOMENTE com JSON válido nesta forma:
{
  "numero": "string", "livro": "string|null", "cartorio": "string", "comarca": "string",
  "dataAbertura": "DD/MM/AAAA|null", "dataCertidao": "DD/MM/AAAA|null", "horaCertidao": "string|null",
  "pedidoCertidao": "string|null", "seloDigital": "string|null", "registroAnterior": "string|null",
  "imovel": {
    "descricao": "string", "loteamento": "string|null", "lote": "string|null", "quadra": "string|null",
    "endereco": "string|null", "cep": "string|null", "cadastroMunicipal": "string|null", "cidade": "string|null", "uf": "string|null"
  },
  "areaTerreno": number|null,
  "medidas": { "frente": "string|null", "fundos": "string|null", "ladoDireito": "string|null", "ladoEsquerdo": "string|null" },
  "confrontacoes": "string|null",
  "construcaoAverbada": true|false,
  "areaConstruida": number|null,
  "obra": { "alvara": "string|null", "habitese": "string|null", "cnd": "string|null", "valorDeclarado": number|null, "dataAverbacao": "DD/MM/AAAA|null" },
  "proprietarios": [{ "nome": "string", "documento": "string|null", "qualificacao": "string|null", "estadoCivil": "string|null" }],
  "promessa": { "existe": true|false, "comprador": "string|null", "documento": "string|null", "data": "DD/MM/AAAA|null", "valor": number|null },
  "onus": { "existe": true|false, "itens": ["string"] },
  "atos": [{ "codigo": "R-1 / AV-2 / etc", "data": "DD/MM/AAAA|null", "resumo": "string" }],
  "observacoes": ["string"]
}`;

async function lerMatricula(paginas = []) {
  const ai = getOpenAI();
  if (!ai) throw new Error('OPENAI_API_KEY não configurada — não dá para ler a matrícula.');
  if (!paginas.length) throw new Error('Envie ao menos uma página da matrícula.');

  const content = [{ type: 'text', text: PROMPT_MATRICULA }];
  paginas.slice(0, 8).forEach((url) => content.push({ type: 'image_url', image_url: { url, detail: 'high' } }));

  const r = await ai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0,
    max_tokens: 3000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'Você transcreve documentos registrais com precisão literal. Nunca inventa dado ausente.' },
      { role: 'user', content }
    ]
  });
  const dados = JSON.parse(r.choices[0].message.content);

  // Rede de segurança do CÓDIGO (não da IA): matrícula sem averbação de
  // construção não pode sair com área construída, aconteça o que acontecer.
  if (!dados.construcaoAverbada) dados.areaConstruida = null;
  dados.alertas = alertasRegistrais(dados);
  return dados;
}

/** Achados que mudam valor e liquidez — derivados por regra, não por LLM. */
function alertasRegistrais(m) {
  const a = [];
  if (!m.construcaoAverbada) {
    a.push({
      nivel: 'alto',
      titulo: 'Construção não averbada',
      texto: 'A matrícula descreve apenas o terreno. Sem averbação da construção o imóvel não é financiável por banco e a escritura definitiva exige regularização prévia (habite-se, CND da obra e averbação).'
    });
  }
  const dono = (m.proprietarios || [])[0]?.nome || null;
  if (m.promessa?.existe && m.promessa.comprador && dono &&
      m.promessa.comprador.trim().toLowerCase() !== dono.trim().toLowerCase()) {
    a.push({
      nivel: 'alto',
      titulo: 'Quem vende não é o proprietário registral',
      texto: `O domínio ainda está em nome de ${dono}. ${m.promessa.comprador} figura como promitente comprador. Sem quitação e escritura definitiva, o que se negocia é cessão de direitos — o comprador não obtém a propriedade no registro.`
    });
  }
  if (m.onus?.existe) {
    a.push({
      nivel: 'alto',
      titulo: 'Ônus registrado na matrícula',
      texto: `Constam gravames: ${(m.onus.itens || []).join('; ')}. Exigir a baixa antes da escritura.`
    });
  } else {
    a.push({
      nivel: 'bom',
      titulo: 'Matrícula sem ônus',
      texto: 'Não há hipoteca, penhora, alienação fiduciária, usufruto ou indisponibilidade registrada até a data da certidão.'
    });
  }
  (m.proprietarios || []).forEach((p) => {
    if (/solteir/i.test(p.estadoCivil || '')) {
      a.push({
        nivel: 'medio',
        titulo: 'Estado civil declarado como solteiro',
        texto: `Obter de ${p.nome} declaração firmada de inexistência de união estável — havendo companheiro em comunhão parcial, a venda fica exposta a questionamento.`
      });
    }
    if (/constru|empres|comerciante|sócio/i.test(p.qualificacao || '')) {
      a.push({
        nivel: 'medio',
        titulo: 'Vendedor com atividade empresarial',
        texto: `${p.nome} está qualificado como ${p.qualificacao}. Reforçar as certidões pessoais e de distribuidores: alienação por devedor insolvente caracteriza fraude à execução (art. 792 do CPC) e a boa-fé do adquirente se prova pelas certidões (Súmula 375 do STJ).`
      });
    }
  });
  return a;
}

// ─────────────────────────────────────────────────────────────────────
// 2. LEITURA DAS FOTOS (visão) — descreve padrão e conservação
// ─────────────────────────────────────────────────────────────────────

const PROMPT_FOTOS = `Você é um avaliador imobiliário descrevendo um imóvel a partir de fotografias, para compor um parecer técnico.

REGRAS:
- Descreva apenas o que é VISÍVEL. Não afirme o que não aparece (número de quartos só se der para contar; metragem nunca).
- "areaConstruidaEstimada": só preencha se der para inferir pela implantação; caso contrário null. É estimativa grosseira e será rotulada como tal.
- Aponte com franqueza o que deprecia (acabamento bruto, infiltração, esquadria simples, sem armários) — isso é o que o comprador usará para negociar.
- Se as fotos parecerem ser de imóveis DIFERENTES (acabamentos ou ocupação incompatíveis), diga em "avisos".

Responda SOMENTE com JSON:
{
  "padrao": "popular|normal|normal-alto|alto",
  "padraoJustificativa": "string",
  "conservacao": "novo|otimo|bom|regular|ruim",
  "idadeAparente": "string",
  "ocupado": true|false,
  "pavimentos": number|null,
  "quartosVisiveis": number|null, "banheirosVisiveis": number|null, "vagasVisiveis": number|null,
  "areaConstruidaEstimada": number|null,
  "ambientes": [{ "ambiente": "string", "constatacao": "string" }],
  "pontosFortes": ["string"],
  "pontosAtencao": ["string"],
  "avisos": ["string"]
}`;

async function lerFotos(fotos = []) {
  const ai = getOpenAI();
  if (!ai || !fotos.length) return null;

  const content = [{ type: 'text', text: PROMPT_FOTOS }];
  fotos.slice(0, 16).forEach((url) => content.push({ type: 'image_url', image_url: { url, detail: 'low' } }));

  const r = await ai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.1,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'Você descreve imóveis a partir de fotos, com honestidade técnica. Não inventa o que não está na imagem.' },
      { role: 'user', content }
    ]
  });
  return JSON.parse(r.choices[0].message.content);
}

// ─────────────────────────────────────────────────────────────────────
// 3. PESQUISA DE MERCADO — o Anexo I que o modelo deixava em branco
// ─────────────────────────────────────────────────────────────────────

async function pesquisarMercado({ cidade, bairro, tipo = 'casa', metragem, quartos }) {
  const out = { casas: [], lotes: [], fontes: [], erro: null };
  const [casa, lote] = await Promise.allSettled([
    buscarComparativos({ tipo, finalidade: 'venda', cidade, bairro, metragem, quartos }),
    buscarComparativos({ tipo: 'terreno', finalidade: 'venda', cidade, bairro })
  ]);
  if (casa.status === 'rejected') console.warn('[Matrícula] portais casa:', casa.reason?.message);
  if (lote.status === 'rejected') console.warn('[Matrícula] portais lote:', lote.reason?.message);

  if (casa.status === 'fulfilled' && casa.value) {
    out.casas = casa.value.imoveis || [];
    out.medianaM2 = casa.value.precoMedioM2 || null;
    out.faixaM2 = [casa.value.faixaMinM2, casa.value.faixaMaxM2];
    out.precoMedio = casa.value.precoMedio || null;
    out.precoMinimo = casa.value.precoMinimo || null;
    out.precoMaximo = casa.value.precoMaximo || null;
    if (casa.value.fonte) out.fontes.push(casa.value.fonte);
  }
  if (lote.status === 'fulfilled' && lote.value) {
    out.lotes = lote.value.imoveis || [];
    out.loteM2 = lote.value.precoMedioM2 || null;
    if (lote.value.fonte) out.fontes.push(lote.value.fonte);
  }
  // Os portais dependem de ScraperAPI e do slug do bairro; quando não voltam
  // (medido em produção: zero anúncio para "Residencial Alphaville"), cai na
  // cascata canônica do precificador, que ainda tenta Perplexity e cache. Sem
  // isso o parecer inteiro rodava sem amostra nenhuma e não avisava direito.
  if (out.casas.length < 3) {
    try {
      const { calcularPreco } = require('./precificador');
      const r = await calcularPreco({
        tipo, finalidade: 'venda', cidade, bairro,
        metragem: metragem || null, quartos: quartos || null, conservacao: 'bom'
      });
      const comps = ((r || {}).analiseIA || {}).comparativos || [];
      const { usados } = filtrarHomonimos(comps, bairro);
      if (usados.length) {
        out.casas = usados.slice(0, 12);
        out.medianaM2 = mediana(usados.map((c) => c.precoM2)) || out.medianaM2;
        out.fontes.push('Pesquisa de mercado (precificador)');
        out.viaFallback = true;
      }
      if (!out.medianaM2 && r && r.precoM2Mercado) out.medianaM2 = r.precoM2Mercado;
      out.confiancaFonte = (r || {}).confiancaFonte || null;
    } catch (e) { console.warn('[Matrícula] fallback do precificador falhou:', e.message); }
  }

  out.medianaTotal = mediana(out.casas.map((c) => c.preco));
  out.n = out.casas.length + out.lotes.length;
  out.grau = out.n >= 10 ? 'Forte' : out.n >= 5 ? 'Médio' : out.n >= 1 ? 'Indicativo' : 'Sem amostra';
  return out;
}

/**
 * Quanto o preço realmente acompanha a metragem NESTE bairro. Mede a
 * elasticidade entre todos os pares da amostra (mediana, robusta a outlier)
 * em vez de assumir um expoente. Amostra fraca cai nos valores conservadores
 * observados em loteamento popular de Anápolis.
 */
function elasticidades(casas) {
  const validas = (casas || []).filter((c) => c.preco > 0 && c.area > 40 && c.area < 400);
  const el = { area: 0.25, terreno: 0.33, medido: false, n: validas.length };
  if (validas.length < 4) return el;
  const pares = [];
  for (let i = 0; i < validas.length; i++) {
    for (let j = i + 1; j < validas.length; j++) {
      const a = validas[i], b = validas[j];
      if (a.area === b.area) continue;
      const e = Math.log(b.preco / a.preco) / Math.log(b.area / a.area);
      if (Number.isFinite(e) && e > -3 && e < 3) pares.push(e);
    }
  }
  const m = mediana(pares.map((v) => v + 3));   // desloca p/ a mediana aceitar negativo
  if (m == null) return el;
  el.area = Math.round(Math.max(0.05, Math.min(0.60, m - 3)) * 100) / 100;
  el.medido = true;
  return el;
}

// ─────────────────────────────────────────────────────────────────────
// 4. AVALIAÇÃO — os três métodos
// ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} p premissas já conferidas pelo usuário na tela.
 *   Tudo que aqui entrar como número foi visto e aceito por ele — nada é
 *   silenciosamente adivinhado.
 */
function avaliar(p) {
  const cidade = p.cidade || 'Anápolis';
  const bairro = p.bairro || '';
  const areaTerreno = Number(p.areaTerreno) || 0;
  const areaConstruida = Number(p.areaConstruida) || 0;
  const areaSecundaria = Number(p.areaSecundaria) || 0;
  const padrao = CUB_PADRAO[p.padrao] ? p.padrao : 'normal';
  const conservacao = p.conservacao || 'bom';
  const idade = Number(p.idade) || 0;
  const mercado = p.mercado || {};
  const metodos = [];
  const premissas = [];

  // ── Premissa 1: R$/m² do terreno ───────────────────────────────────
  let terrenoM2 = Number(p.terrenoM2) || 0, terrenoFonte = 'informado por você';
  if (!terrenoM2) {
    if (mercado.loteM2 > 0) { terrenoM2 = mercado.loteM2; terrenoFonte = `mediana de ${mercado.lotes.length} lote(s) anunciado(s) no bairro`; }
    else { const b = getBaseLote(cidade, bairro); terrenoM2 = b.m2; terrenoFonte = b.fonte; }
  }
  // Lote pequeno tem R$/m² maior que lote grande (valor de entrada menor, público mais amplo).
  const fatorLote = areaTerreno > 0 && areaTerreno < 200 ? 1.20 : areaTerreno > 500 ? 0.88 : 1.0;
  const terrenoM2Ajustado = Math.round(terrenoM2 * fatorLote);
  const valorTerreno = Math.round(areaTerreno * terrenoM2Ajustado);
  premissas.push({
    item: 'Valor unitário do terreno', adotado: `${brl(terrenoM2Ajustado)}/m²`,
    faixa: `${brl(Math.round(terrenoM2Ajustado * 0.8))} a ${brl(Math.round(terrenoM2Ajustado * 1.2))}`,
    obs: fatorLote !== 1 ? `${terrenoFonte} · ajuste de ${Math.round((fatorLote - 1) * 100)}% por tamanho do lote` : terrenoFonte
  });

  // ── Premissa 2: R$/m² de construção (comparativo) ──────────────────
  let vendaM2 = Number(p.vendaM2) || 0, vendaFonte = 'informado por você';
  if (!vendaM2) {
    const b = getBaseVenda(cidade, bairro);
    const nAmostra = (mercado.casas || []).length;
    // Amostra pequena não pode mandar sozinha: um único anúncio caro joga o
    // comparativo para longe do evolutivo e o parecer sai com dois números
    // que se desmentem. Peso do mercado cresce com o tamanho da amostra —
    // mesma lógica de blend que o precificador já usa nas outras abas.
    const wMercado = mercado.medianaM2 > 0
      ? (nAmostra >= 5 ? 0.85 : nAmostra >= 3 ? 0.65 : 0.35)
      : 0;
    const bruto = wMercado > 0
      ? Math.round(mercado.medianaM2 * wMercado + b.m2 * (1 - wMercado))
      : b.m2;
    vendaM2 = Math.round(bruto * (FATOR_PADRAO[padrao] || 1));
    vendaFonte = wMercado >= 0.85
      ? `mediana de ${nAmostra} anúncios do bairro (${brl(mercado.medianaM2)}/m²) × fator ${FATOR_PADRAO[padrao]} do padrão ${padrao}`
      : wMercado > 0
        ? `${Math.round(wMercado * 100)}% mercado (${nAmostra} anúncio(s), ${brl(mercado.medianaM2)}/m²) + ${Math.round((1 - wMercado) * 100)}% base do bairro (${b.fonte}, ${brl(b.m2)}/m²) × fator ${FATOR_PADRAO[padrao]} do padrão ${padrao}`
        : `${b.fonte} (${brl(b.m2)}/m²) × fator do padrão ${padrao} — sem anúncio no bairro nesta consulta`;
  }
  premissas.push({
    item: 'Valor por m² de área construída', adotado: `${brl(vendaM2)}/m²`,
    faixa: `${brl(Math.round(vendaM2 * 0.9))} a ${brl(Math.round(vendaM2 * 1.1))}`, obs: vendaFonte
  });

  // ── Premissa 3: custo de reedição ──────────────────────────────────
  const cub = Number(p.cub) || CUB_PADRAO[padrao];
  // A área secundária é PARTE da área construída, não um acréscimo — garagem,
  // subsolo e varanda já entram na metragem averbada. Somá-la de novo dobrava
  // a construção (medido: inflava o imóvel em ~20%). Ela só entra aqui para
  // valer metade, que é o que o mercado paga por m² de área coberta não nobre.
  const secundaria = Math.min(areaSecundaria, areaConstruida);
  const areaEquivalente = Math.round(areaConstruida - secundaria * (1 - FATOR_AREA_SECUNDARIA));
  premissas.push({
    item: 'Custo unitário de reedição', adotado: `${brl(cub)}/m²`,
    faixa: `${brl(Math.round(cub * 0.9))} a ${brl(Math.round(cub * 1.1))}`,
    obs: `CUB-GO com BDI, projetos e taxas · padrão ${padrao}`
  });
  if (secundaria > 0) {
    premissas.push({
      item: 'Área equivalente de construção', adotado: `${num(areaEquivalente)} m²`,
      faixa: `${num(Math.round(areaEquivalente * 0.95))} a ${num(Math.round(areaEquivalente * 1.05))}`,
      obs: `dos ${num(areaConstruida)} m² construídos, ${num(secundaria)} m² são de área secundária (garagem, subsolo, varanda), computados com fator ${FATOR_AREA_SECUNDARIA}`
    });
  }

  // ── Método 1: evolutivo ────────────────────────────────────────────
  // Casa não é apartamento: a vida útil de 40 anos calibrada na aba Prédios
  // (que absorve obsolescência funcional de planta antiga, elevador, lazer)
  // deprecia casa térrea rápido demais. Com 60 anos, uma casa de 12 anos bem
  // conservada perde ~13%, não 20% — que era o que puxava o evolutivo para
  // baixo do mercado.
  const dep = rossHeidecke(idade, conservacao, VIDA_UTIL_CASA);

  // O fator de comercialização NÃO é constante — lição que a aba Prédios já
  // tinha aprendido (FC fixo de 0,90 dava 47% do preço real). E ele incide
  // sobre a CONSTRUÇÃO, não sobre o imóvel todo: o terreno já entra a preço
  // de mercado, multiplicá-lo de novo dobra o ajuste. Medido no Residencial
  // Alphaville em 13/08/2026: descontando o terreno do preço anunciado, a
  // construção implícita sai a R$ 2.654/m² contra CUB normal de R$ 2.700 —
  // ou seja, FC ~1,0. Um FC de 0,92 sobre o imóvel inteiro tirava R$ 40 mil
  // que o mercado paga.
  let fc = Number(p.fc) || 0, fcFonte = 'informado por você';
  if (!fc) {
    // O lote de referência é o das CASAS comparáveis, não o dos terrenos
    // vagos à venda (que são maiores): descontar 300 m² de uma casa que está
    // em 150 m² tirava metade do valor da construção e jogava o FC para 0,78.
    const loteCasas = mediana((mercado.casas || []).map((c) => c.lote).filter((a) => a > 0));
    const loteRef = loteCasas || Number(p.lotePadrao) || 250;
    const liquidos = (mercado.casas || [])
      .filter((c) => c.preco > 0 && c.area > 40 && c.area < 400)
      .map((c) => (c.preco - (Number(c.lote) > 0 ? c.lote : loteRef) * terrenoM2) / c.area)
      .filter((v) => v > 300);
    const liqMediano = mediana(liquidos);
    if (liqMediano > 0) {
      fc = Math.round(Math.max(0.70, Math.min(1.80, liqMediano / cub)) * 100) / 100;
      fcFonte = `medido em ${liquidos.length} anúncio(s) do bairro: descontado o terreno, a construção sai a ${brl(Math.round(liqMediano))}/m² contra CUB de ${brl(cub)}/m²`;
    } else {
      fc = FC_PADRAO;
      fcFonte = 'padrão do modelo (sem amostra do bairro para calibrar)';
    }
  }

  let evolutivo = null;
  if (areaTerreno > 0 && areaEquivalente > 0) {
    const custoNovo = Math.round(areaEquivalente * cub);
    const depreciacao = Math.round(custoNovo * dep.k);
    const construcao = Math.round((custoNovo - depreciacao) * fc);
    const subtotal = valorTerreno + construcao;
    evolutivo = {
      nome: 'Método evolutivo (terreno + construção)',
      valorTerreno, custoNovo, depreciacao, depreciacaoPct: Math.round(dep.k * 100),
      construcao, subtotal, fc, valor: subtotal,
      memoria: [
        ['Terreno', `${num(areaTerreno)} m² × ${brl(terrenoM2Ajustado)}/m² (preço de mercado do lote)`, valorTerreno],
        ['Construção — custo de reedição', `${num(areaEquivalente)} m² equivalentes × ${brl(cub)}/m²`, custoNovo],
        [`Depreciação de ${Math.round(dep.k * 100)}%`, `Ross-Heidecke · ${idade} ano(s) · conservação ${conservacao} · vida útil ${dep.vidaUtil} anos`, -depreciacao],
        ['Fator de comercialização sobre a construção', `× ${fc}`, construcao],
        ['Resultado pelo método evolutivo', 'terreno + construção depreciada e comercializada', subtotal]
      ]
    };
    metodos.push(evolutivo);
    premissas.push({
      item: 'Depreciação', adotado: `${Math.round(dep.k * 100)}%`,
      faixa: `${Math.max(0, Math.round(dep.k * 100) - 5)}% a ${Math.round(dep.k * 100) + 5}%`,
      obs: `Ross-Heidecke, vida útil de referência ${dep.vidaUtil} anos (casa), conservação ${conservacao}`
    });
    premissas.push({
      item: 'Fator de comercialização', adotado: String(fc), faixa: '0,80 a 1,60',
      obs: `${fcFonte} — corrige a diferença entre custo de construir e preço que o mercado paga`
    });
  }

  // ── Método 2: comparativo — o imóvel INTEIRO ───────────────────────
  // Ninguém vende metro quadrado de construção solto: vende casa, com o
  // terreno junto. O comparativo parte do preço TOTAL das casas semelhantes
  // do bairro e homogeneíza pelas diferenças (lote, área construída, padrão,
  // conservação). Antes eu multiplicava área construída × R$/m² e somava um
  // excedente de terreno — o que subestimava justamente o imóvel de lote
  // grande, que é onde está o valor nesse tipo de loteamento.
  let comparativo = null;
  const compsPreco = (mercado.casas || []).map((c) => c.preco).filter((v) => v > 0);
  const precoMedianoComp = mediana(compsPreco);
  const areaMedianaComp = mediana((mercado.casas || []).map((c) => c.area).filter((a) => a > 40 && a < 400));
  // idem no comparativo: o "lote típico" da amostra é o das casas anunciadas
  const loteMedianoComp = mediana((mercado.casas || []).map((c) => c.lote).filter((a) => a > 0))
    || mediana((mercado.lotes || []).map((l) => l.area))
    || Number(p.lotePadrao) || 250;

  if (precoMedianoComp > 0) {
    // Os expoentes saem da PRÓPRIA amostra, não de um palpite. No Residencial
    // Alphaville a elasticidade medida entre pares de anúncios foi 0,08 para
    // área construída e 0,33 para terreno — ou seja, casa de 89 m² sai a R$
    // 500 mil e casa de 200 m² a R$ 420 mil: o que manda é ser casa boa no
    // bairro, não o tamanho. Expoentes chutados em 0,55 inflavam o efeito da
    // metragem e distorciam os dois extremos.
    const el = elasticidades(mercado.casas || []);
    const fLote = areaTerreno > 0 ? Math.pow(areaTerreno / loteMedianoComp, el.terreno) : 1;
    const fArea = areaConstruida > 0 && areaMedianaComp > 0 ? Math.pow(areaConstruida / areaMedianaComp, el.area) : 1;
    const fPadrao = (FATOR_PADRAO[padrao] || 1) / 1.0;
    const fConserv = CONSERVACAO_FATOR[conservacao] != null ? CONSERVACAO_FATOR[conservacao] : 1;
    const valorComp = Math.round(precoMedianoComp * fLote * fArea * fPadrao * fConserv);
    comparativo = {
      nome: 'Método comparativo (imóvel inteiro)',
      base: precoMedianoComp, valor: valorComp,
      fLote: Math.round(fLote * 100) / 100, fArea: Math.round(fArea * 100) / 100,
      fPadrao, fConserv,
      cenarios: [
        ['Conservador', `mediana ${brl(precoMedianoComp)} × ajustes × 0,90`, Math.round(valorComp * 0.9)],
        ['Provável', `mediana de ${compsPreco.length} casa(s) do bairro ${brl(precoMedianoComp)} × ${Math.round(fLote * 100) / 100} (lote ${num(areaTerreno)} vs ${num(loteMedianoComp)} m²) × ${Math.round(fArea * 100) / 100} (área ${num(areaConstruida)} vs ${num(areaMedianaComp || areaConstruida)} m²) × ${fPadrao} (padrão) × ${fConserv} (conservação)`, valorComp],
        ['Otimista', `mediana ${brl(precoMedianoComp)} × ajustes × 1,10`, Math.round(valorComp * 1.1)]
      ],
      notaExcedente: `Preços de anúncio; o fechamento costuma sair abaixo do pedido. Amostra: ${compsPreco.length} casa(s), de ${brl(Math.min(...compsPreco))} a ${brl(Math.max(...compsPreco))}.`
    };
    metodos.push(comparativo);
    premissas.push({
      item: 'Preço da casa mediana do bairro', adotado: brl(precoMedianoComp),
      faixa: `${brl(Math.min(...compsPreco))} a ${brl(Math.max(...compsPreco))}`,
      obs: `mediana de ${compsPreco.length} casa(s) à venda no bairro — base do método comparativo, homogeneizada por lote, área, padrão e conservação`
    });
  } else if (areaConstruida > 0 && vendaM2 > 0) {
    // Sem amostra de preço total, resta o unitário sobre a base do bairro —
    // com o terreno somado à parte, e dito com todas as letras no parecer.
    const base = Math.round(areaConstruida * vendaM2);
    const valorComp = base + Math.round(areaTerreno * terrenoM2Ajustado * 0.35);
    comparativo = {
      nome: 'Método comparativo por valor unitário (sem amostra de preço total)',
      base, valor: valorComp,
      cenarios: [
        ['Conservador', `${num(areaConstruida)} m² × ${brl(Math.round(vendaM2 * 0.9))}/m² + terreno`, Math.round(valorComp * 0.9)],
        ['Provável', `${num(areaConstruida)} m² × ${brl(vendaM2)}/m² + parcela do terreno`, valorComp],
        ['Otimista', `${num(areaConstruida)} m² × ${brl(Math.round(vendaM2 * 1.1))}/m² + terreno`, Math.round(valorComp * 1.1)]
      ],
      notaExcedente: 'Não havia casa anunciada no bairro nesta consulta para comparar preço total; o valor saiu do indicador por metro quadrado da base de referência, o que é menos preciso.'
    };
    metodos.push(comparativo);
  }

  // ── Método 3: atualização do valor-âncora ──────────────────────────
  let ancora = null;
  const anterior = Number(p.avaliacaoAnterior) || 0;
  if (anterior > 0) {
    const anos = Number(p.anosDesdeAvaliacao) || 1;
    const valorizacao = Math.round(anterior * Math.pow(1 + VALORIZACAO_ANO, anos));
    const ganho = p.regularizouDepois ? Math.round(valorizacao * (1 + GANHO_REGULARIZACAO)) : valorizacao;
    ancora = {
      nome: 'Atualização do valor-âncora',
      valor: ganho,
      memoria: [
        ['Avaliação informada', `${anos} ano(s) atrás`, anterior],
        ['Valorização do período', `× ${(Math.pow(1 + VALORIZACAO_ANO, anos)).toFixed(2)} (${Math.round(VALORIZACAO_ANO * 100)}% a.a.)`, valorizacao],
        ...(p.regularizouDepois ? [['Ganho pela regularização documental', `× ${1 + GANHO_REGULARIZACAO}`, ganho]] : [])
      ]
    };
    metodos.push(ancora);
    premissas.push({
      item: 'Valorização anual do mercado', adotado: `${Math.round(VALORIZACAO_ANO * 100)}%`, faixa: '5% a 10%',
      obs: 'estimativa para o segmento residencial em Anápolis'
    });
  }

  if (!metodos.length) {
    return { erro: 'Sem dados suficientes: informe ao menos a área do terreno e a área construída (ou uma avaliação anterior).' };
  }

  // ── Convergência ───────────────────────────────────────────────────
  const valores = metodos.map((m) => m.valor);
  const media = Math.round(valores.reduce((a, b) => a + b, 0) / valores.length);
  const dispersao = valores.length > 1
    ? Math.round(((Math.max(...valores) - Math.min(...valores)) / Math.min(...valores)) * 1000) / 10
    : null;

  // ⚠️ Média de métodos que discordam é o pior número possível: parece
  // preciso e não é. Medido em produção: com a âncora do bairro contaminada,
  // evolutivo R$ 381 mil × comparativo R$ 1.024 mil davam uma "média" de
  // R$ 615 mil que nenhum dos dois métodos sustentava. Acima de 60% de
  // dispersão o parecer passa a usar o método MAIS CONSERVADOR e diz por quê.
  const divergente = dispersao != null && dispersao > 60;
  const base = divergente ? Math.min(...valores) : media;
  const valorBruto = Math.round(base / 5000) * 5000;
  const aviso = divergente ? {
    titulo: 'Métodos divergentes — valor a confirmar',
    texto: `Os métodos aplicados chegaram a resultados muito distantes entre si (${dispersao}% de diferença): ${metodos.map((mt) => `${mt.nome.split('(')[0].trim()} ${brl(mt.valor)}`).join(' × ')}. Isso quase sempre significa falta de amostra de mercado no bairro ou premissa de metragem/padrão fora da realidade. Adotou-se o resultado mais conservador, e o número NÃO deve ser usado antes de confirmar as premissas da seção 9 com dois ou três imóveis à venda na região.`
  } : null;

  // ── Ajuste documental ──────────────────────────────────────────────
  // O ajuste documental é decisão do dono do negócio, não do algoritmo: em
  // muita negociação o vendedor regulariza antes de fechar, e aí o desconto
  // não se aplica. Desligado, os achados registrais continuam no parecer —
  // só param de mexer no número.
  const descontos = [];
  let descTotal = 0;
  const aplicarDesc = p.aplicarDescontoDocumental !== false;
  if (aplicarDesc) {
    if (p.semAverbacao) { descontos.push({ motivo: 'Construção não averbada na matrícula (imóvel não financiável)', pct: DESC_SEM_AVERBACAO }); descTotal += DESC_SEM_AVERBACAO; }
    if (p.semTitulo) { descontos.push({ motivo: 'Vendedor não é o proprietário registral (cessão de direitos)', pct: DESC_SEM_TITULO }); descTotal += DESC_SEM_TITULO; }
    if (p.comOnus) { descontos.push({ motivo: 'Ônus real registrado na matrícula', pct: DESC_ONUS }); descTotal += DESC_ONUS; }
  }
  descTotal = Math.min(descTotal, DESC_TETO);
  const valor = descTotal > 0 ? Math.round((valorBruto * (1 - descTotal)) / 5000) * 5000 : valorBruto;

  // Amplitude = dispersão medida entre os métodos, com piso de ±6% (nunca
  // prometer precisão que a amostra não sustenta) e teto de ±20%.
  const amplitude = divergente ? 0.25 : Math.min(0.20, Math.max(0.06, (dispersao || 12) / 200));
  const faixaMin = Math.round((valor * (1 - amplitude)) / 5000) * 5000;
  const faixaMax = Math.round((valor * (1 + amplitude)) / 5000) * 5000;

  // ── Referências de negociação ──────────────────────────────────────
  const negociacao = [
    { ref: 'Preço de anúncio sugerido', valor: Math.round((valor * (1 + MARGEM_ANUNCIO)) / 5000) * 5000, racional: `Embute margem de negociação de ${Math.round(MARGEM_ANUNCIO * 100)}%, compatível com o desconto médio entre pedido e fechado.` },
    { ref: 'Valor de mercado', valor, racional: 'Preço provável de fechamento em condições normais, com exposição de seis a doze meses.' },
    { ref: 'Piso de negociação', valor: faixaMin, racional: 'Limite inferior da faixa técnica. Abaixo disso a venda fica desvantajosa frente ao custo de reposição.' },
    { ref: 'Venda rápida (até 90 dias)', valor: Math.round((valor * VENDA_RAPIDA) / 5000) * 5000, racional: `${Math.round(VENDA_RAPIDA * 100)}% do valor de mercado. Só se aplica havendo necessidade de liquidez imediata.` },
    { ref: 'Locação estimada', valor: Math.round((valor * YIELD_LOCACAO) / 50) * 50, racional: `${(YIELD_LOCACAO * 100).toFixed(2)}% do valor do imóvel ao mês — patamar usual na região.`, mensal: true }
  ];

  // ── Custos de transmissão ──────────────────────────────────────────
  const custos = [
    { item: 'ITBI', min: Math.round(valor * ITBI_ALIQUOTA), max: Math.round(valor * ITBI_ALIQUOTA), obs: `${ITBI_ALIQUOTA * 100}% sobre o valor. Alíquota e base de cálculo a confirmar na Prefeitura, que pode adotar valor venal de referência superior.` },
    { item: 'Escritura pública', min: Math.round(valor * 0.010), max: Math.round(valor * 0.014), obs: 'Tabela de emolumentos do Estado de Goiás, faixa do valor do negócio.' },
    { item: 'Registro do título', min: Math.round(valor * 0.0065), max: Math.round(valor * 0.010), obs: 'Emolumentos de registro no RI competente.' },
    { item: 'Certidões e diligências', min: 400, max: 800, obs: 'Certidões pessoais, protestos, distribuidores e certidão municipal.' }
  ];
  if (p.semAverbacao) {
    custos.push({ item: 'Regularização da construção', min: 8000, max: 15000, obs: 'Habite-se, CND da obra (INSS) e averbação na matrícula. Sem isso não há financiamento bancário.' });
  }
  const custoMin = custos.reduce((s, c) => s + c.min, 0);
  const custoMax = custos.reduce((s, c) => s + c.max, 0);

  return {
    cidade, bairro, padrao, conservacao, idade,
    areaTerreno, areaConstruida, areaSecundaria, areaEquivalente,
    terrenoM2: terrenoM2Ajustado, vendaM2, cub, fc,
    metodos, evolutivo, comparativo, ancora,
    media, dispersao, divergente, aviso, valorBruto, descontos, descontoTotal: Math.round(descTotal * 100),
    valor, faixaMin, faixaMax, amplitude: Math.round(amplitude * 100),
    valorM2Resultante: areaConstruida > 0 ? Math.round(valor / areaConstruida) : null,
    negociacao, custos, custoMin, custoMax,
    premissas, mercado, dataBase: hoje(),
    areaEstimada: !!p.areaEstimada,
    sensibilidade: p._semSensibilidade ? null : (p.areaEstimada ? sensibilidadeArea(p, mercado) : null)
  };
}

/**
 * Quando a construção não está averbada, a metragem é a maior incerteza do
 * trabalho — e o dono muitas vezes não tem como saber. Em vez de esconder
 * isso num número único, o parecer abre o valor por faixa de metragem.
 */
function sensibilidadeArea(p, mercado) {
  const base = Number(p.areaConstruida) || 0;
  if (!(base > 0)) return null;
  const passo = base >= 200 ? 20 : 10;
  const areas = [];
  for (let a = Math.max(passo, base - passo * 2); a <= base + passo * 2; a += passo) areas.push(Math.round(a));
  const linhas = areas.map((area) => {
    const r = avaliar({ ...p, areaConstruida: area, mercado, _semSensibilidade: true });
    return r.erro ? null : { area, valor: r.valor, faixaMin: r.faixaMin, faixaMax: r.faixaMax, atual: area === Math.round(base) };
  }).filter(Boolean);
  return linhas.length > 1 ? linhas : null;
}

// ─────────────────────────────────────────────────────────────────────
// 5. DILIGÊNCIAS — condicionadas ao que a matrícula mostrou
// ─────────────────────────────────────────────────────────────────────

function diligencias(m = {}, r = {}) {
  const imovel = [
    `Certidão de inteiro teor atualizada da matrícula nº ${m.numero || '—'}, com emissão inferior a 30 dias na data da escritura.`,
    'Certidão negativa de débitos municipais (IPTU e taxas) do cadastro do imóvel.',
    'Declarações de quitação junto à concessionária de energia e à SANEAGO.',
    'Confirmação de que o loteamento está regularmente registrado e, havendo associação de moradores, do valor da contribuição e da inexistência de débitos.'
  ];
  if (m.construcaoAverbada) {
    imovel.push('Cópia do habite-se e do alvará, conferindo se a área efetivamente construída corresponde à averbada — área a maior não averbada gera exigência, custo e eventual multa.');
  } else {
    imovel.unshift('REGULARIZAR A CONSTRUÇÃO: habite-se, CND da obra e averbação na matrícula. Enquanto não averbada, o imóvel não é financiável e a escritura sai apenas do terreno.');
  }
  const vendedor = [
    'Certidões dos distribuidores cíveis, execuções fiscais e falências da comarca do imóvel e do domicílio do vendedor.',
    'Certidão da Justiça Federal (Seção Judiciária de Goiás) e de execuções fiscais federais.',
    'Certidão Negativa de Débitos Trabalhistas (CNDT) e certidão da Justiça do Trabalho da 18ª Região.',
    'Certidão negativa de protestos de todos os tabelionatos da comarca.',
    'Certidão conjunta de tributos federais e dívida ativa da União, além da certidão estadual da SEFAZ-GO.'
  ];
  if ((m.proprietarios || []).some((p) => /solteir/i.test(p.estadoCivil || ''))) {
    vendedor.push('Declaração de inexistência de união estável com firma reconhecida — havendo companheiro, sua anuência expressa no instrumento.');
  }
  if (m.promessa?.existe) {
    vendedor.push(`Termo de quitação do compromisso de compra e venda e outorga da escritura definitiva por ${(m.proprietarios || [])[0]?.nome || 'o proprietário registral'} — sem isso, o que se transfere é posse e direitos, não a propriedade.`);
  }
  const contratacao = [
    'Vincular o pagamento, no contrato, à apresentação de todas as certidões, retendo parcela do preço até a averbação da transmissão na matrícula.',
    'Vistoria técnica no imóvel antes da assinatura, com registro fotográfico datado anexado ao contrato.',
    'Cláusula expressa de responsabilidade do vendedor por vícios ocultos e por débitos anteriores à imissão na posse.'
  ];
  return { imovel, vendedor, contratacao };
}

// ─────────────────────────────────────────────────────────────────────
// 6. TEXTO DO PARECER (tela)
// ─────────────────────────────────────────────────────────────────────

function formatar(m, fotos, r) {
  const i = m.imovel || {};
  const local = [i.loteamento, i.lote ? `Lote ${i.lote}` : null, i.quadra ? `Quadra ${i.quadra}` : null].filter(Boolean).join(', ');
  let t = `🏠 *PARECER TÉCNICO DE AVALIAÇÃO — POR AMOSTRAGEM*\n`;
  t += `Matrícula nº ${m.numero || '—'} · ${m.cartorio || ''}\n`;
  t += `${local || i.descricao || ''}\n`;
  t += `${i.endereco || ''}${i.cep ? ' · CEP ' + i.cep : ''}\n`;
  t += `Data-base: ${r.dataBase}\n\n`;

  if (r.aviso) t += `⚠️ *${r.aviso.titulo}*\n${r.aviso.texto}\n\n`;
  if (r.descontos.length) {
    t += `💰 *VALOR DE MERCADO DO IMÓVEL*\n*${brl(r.valorBruto)}* — é quanto vale a casa em si, regularizada\n`;
    t += `💰 *NO ESTADO DOCUMENTAL ATUAL*\n*${brl(r.valor)}* (${brl(r.faixaMin)} a ${brl(r.faixaMax)}) — depois do ajuste de −${r.descontoTotal}%\n`;
  } else {
    t += `💰 *VALOR DE MERCADO ESTIMADO*\n*${brl(r.valor)}*\n`;
    t += `Faixa técnica: ${brl(r.faixaMin)} a ${brl(r.faixaMax)} (±${r.amplitude}%)\n`;
  }
  if (r.valorM2Resultante) t += `Valor unitário resultante: ${brl(r.valorM2Resultante)}/m² de área construída\n`;
  t += `\n`;

  t += `📐 *O IMÓVEL*\n`;
  t += `• Terreno: ${num(r.areaTerreno)} m²${m.medidas?.frente ? ` (frente de ${m.medidas.frente})` : ''}\n`;
  t += `• Construção: ${r.areaConstruida ? num(r.areaConstruida) + ' m²' : 'não averbada'}`;
  t += m.construcaoAverbada ? ' (averbada na matrícula)\n' : ' — área informada/estimada, NÃO consta da matrícula\n';
  if (fotos) {
    t += `• Padrão: ${fotos.padrao} — ${fotos.padraoJustificativa || ''}\n`;
    t += `• Conservação: ${fotos.conservacao}${fotos.idadeAparente ? ` · ${fotos.idadeAparente}` : ''}\n`;
  }
  t += `\n`;

  t += `⚖️ *SITUAÇÃO REGISTRAL*\n`;
  (m.alertas || []).forEach((a) => {
    const ico = a.nivel === 'alto' ? '🔴' : a.nivel === 'medio' ? '🟡' : '🟢';
    t += `${ico} *${a.titulo}* — ${a.texto}\n`;
  });
  t += `\n`;

  t += `🧮 *APURAÇÃO — ${r.metodos.length} MÉTODO(S) INDEPENDENTE(S)*\n`;
  r.metodos.forEach((mt) => { t += `• ${mt.nome}: *${brl(mt.valor)}*\n`; });
  if (r.dispersao != null) {
    t += `• Média: ${brl(r.media)} · dispersão entre os métodos: ${r.dispersao}%`;
    t += r.dispersao <= 10 ? ' (boa convergência)\n' : r.dispersao <= 25 ? ' (convergência razoável)\n' : ' (⚠️ dispersão alta — confira as premissas)\n';
  }
  if (r.descontos.length) {
    t += `\n📉 *Ajuste documental aplicado: −${r.descontoTotal}%* (de ${brl(r.valorBruto)})\n`;
    r.descontos.forEach((d) => { t += `   – ${d.motivo}: −${Math.round(d.pct * 100)}%\n`; });
  }
  t += `\n`;

  t += `🤝 *REFERÊNCIAS PARA A NEGOCIAÇÃO*\n`;
  r.negociacao.forEach((n) => { t += `• ${n.ref}: *${brl(n.valor)}*${n.mensal ? '/mês' : ''}\n`; });
  t += `\n`;

  t += `💸 *CUSTOS DA TRANSMISSÃO*\n`;
  r.custos.forEach((c) => {
    t += `• ${c.item}: ${c.min === c.max ? brl(c.min) : `${brl(c.min)} a ${brl(c.max)}`}\n`;
  });
  t += `• Total estimado: ${brl(r.custoMin)} a ${brl(r.custoMax)} (${Math.round((r.custoMin / r.valor) * 100)}% a ${Math.round((r.custoMax / r.valor) * 100)}% do valor)\n\n`;

  const mk = r.mercado || {};
  t += `📊 *ANEXO I — PESQUISA DE MERCADO*\n`;
  if (mk.n > 0) {
    t += `Amostra de ${mk.n} anúncio(s) em ${r.bairro}, coletada em ${r.dataBase}. Grau de fundamentação: *${mk.grau}*.\n`;
    (mk.casas || []).slice(0, 8).forEach((c, k) => {
      t += `${k + 1}. ${c.area ? num(c.area) + ' m²' : '—'} · ${brl(c.preco)}${c.precoM2 ? ` · ${brl(Math.round(c.precoM2))}/m²` : ''}${c.fonte ? ` · ${c.fonte}` : ''}\n`;
      if (c.url) t += `   ${c.url}\n`;
    });
    if ((mk.lotes || []).length) {
      t += `Lotes: `;
      t += (mk.lotes || []).slice(0, 4).map((l) => `${num(l.area)} m² por ${brl(l.preco)}`).join(' · ') + '\n';
    }
  } else {
    t += `⚠️ Nenhum anúncio foi encontrado no bairro nesta consulta. As premissas vieram das bases de referência (PGV da Prefeitura / EBM), não de coleta de mercado — confirme com dois ou três imóveis à venda na região antes de fechar negócio.\n`;
  }
  t += `\n`;

  if (r.sensibilidade) {
    t += `📏 *E SE A METRAGEM FOR OUTRA?*\nA construção não está averbada, então a área é premissa. O valor por metragem:\n`;
    r.sensibilidade.forEach((l) => {
      t += `${l.atual ? '▶' : ' '} ${num(l.area)} m² → *${brl(l.valor)}*  (${brl(l.faixaMin)} a ${brl(l.faixaMax)})\n`;
    });
    t += `Cada 10 m² a mais ou a menos move o valor em torno de ${brl(Math.abs(Math.round(((r.sensibilidade[r.sensibilidade.length - 1].valor - r.sensibilidade[0].valor) / (r.sensibilidade.length - 1)))))}.\n\n`;
  }
  t += `📋 *PREMISSAS ADOTADAS*\n`;
  r.premissas.forEach((pr) => { t += `• ${pr.item}: *${pr.adotado}* (faixa ${pr.faixa}) — ${pr.obs}\n`; });
  t += `\n`;

  t += `⚠️ *LIMITAÇÕES*\n`;
  t += `• Não houve vistoria presencial — padrão e conservação foram avaliados pelas fotografias fornecidas.\n`;
  t += `• Não houve medição no local; as áreas são as ${m.construcaoAverbada ? 'constantes da matrícula' : 'informadas, já que a matrícula não traz área construída'}.\n`;
  t += `• Não foram examinadas instalações hidráulicas, elétricas, estruturais nem vícios ocultos.\n`;
  t += `• Parecer técnico de valor por amostragem, emitido por corretor inscrito no CRECI. Não é laudo nos moldes da NBR 14.653 e não substitui laudo de engenheiro/arquiteto com ART/RRT nem avaliação com CNAI, exigíveis para fins bancários, judiciais e tributários.\n`;
  t += `\nValidade recomendada: 180 dias da data-base.\n`;
  return t;
}

module.exports = {
  lerMatricula, lerFotos, pesquisarMercado, avaliar, diligencias, formatar,
  alertasRegistrais, CUB_PADRAO, FATOR_PADRAO
};
