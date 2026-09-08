const { BAIRROS } = require('../data/bairros');

/**
 * "/fechou apto 90m2 Jundiai 520 mil" → registro de preço PAGO.
 *
 * Toda fonte do motor é preço PEDIDO — anúncio. Esta é a única entrada de preço
 * PAGO, e é o dado que nenhum concorrente copia: a Perplexity lê os mesmos
 * anúncios para todo mundo; o que fechou na mão do corretor, só quem perguntou
 * tem. A tabela existe desde o Bloco 5 e estava com ZERO linhas depois de 240
 * avaliações — porque registrar exigia abrir o site, e o corretor está no
 * Telegram.
 *
 * Duas decisões que valem mais que o parser:
 *
 * 1. NADA é gravado sem o corretor confirmar o que o bot entendeu. Fechamento
 *    errado é pior que nenhum: com 3 num bairro, ele VIRA o preço daquele
 *    bairro. Um dígito a mais entra no laudo de todo mundo.
 * 2. A leitura é em código, não por modelo. Bairro sai da lista que o sistema
 *    já tem (177 grafias só de Anápolis), valor e metragem saem de regex. Sem
 *    custo por registro e sem chance de o modelo "arredondar" um número.
 */

const TIPOS = [
  [/\b(apartamento|apto|ap|flat|kitnet|kitinete)\b/i, 'apartamento'],
  [/\b(sobrado)\b/i,                                   'casa'],
  [/\b(casa|resid[eê]ncia)\b/i,                        'casa'],
  [/\b(terreno|lote|[aá]rea)\b/i,                      'terreno'],
  [/\b(galp[aã]o|barrac[aã]o)\b/i,                     'comercial'],
  [/\b(sala|loja|ponto|comercial|escrit[oó]rio)\b/i,   'comercial'],
  [/\b(ch[aá]cara|s[ií]tio|fazenda)\b/i,               'rural'],
];

/** "520.000,50" → 520000.5 ; "1,2" → 1.2 */
function numeroBR(txt) {
  let s = String(txt).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}(\D|$)/.test(s + ' ')) s = s.replace(/\./g, '');
  return Number(s);
}

/**
 * O valor fechado. Aceita "520 mil", "1,2 milhão", "R$ 520.000", "520000".
 *
 * Número solto abaixo de mil NÃO vira valor: "fechou por 520" tanto pode ser
 * 520 mil quanto erro de digitação, e chutar aqui contamina o preço do bairro.
 * Nesse caso o campo volta vazio e o bot pergunta.
 */
function extrairValor(texto) {
  const t = texto.replace(/\s+/g, ' ');
  let m = t.match(/(?:r\$\s*)?(\d[\d.,]*)\s*(milh[õo]es?|milh[aã]o|mi)\b/i);
  if (m) return Math.round(numeroBR(m[1]) * 1e6);
  m = t.match(/(?:r\$\s*)?(\d[\d.,]*)\s*(mil|k)\b/i);
  if (m) return Math.round(numeroBR(m[1]) * 1000);
  m = t.match(/r\$\s*(\d[\d.,]*)/i);
  if (m) { const n = numeroBR(m[1]); if (n >= 1000) return Math.round(n); }
  const candidatos = (t.match(/\d[\d.,]*/g) || []).map(numeroBR).filter((n) => n >= 1000);
  return candidatos.length ? Math.round(Math.max(...candidatos)) : null;
}

function extrairMetragem(texto) {
  const m = texto.match(/(\d[\d.,]*)\s*(m2|m²|metros?\b|mts?\b)/i);
  if (!m) return null;
  const n = numeroBR(m[1]);
  return n > 0 && n < 1e7 ? n : null;
}

/**
 * Bairro pela lista que o sistema já tem. Casa a grafia MAIS LONGA que aparece
 * no texto: "jardim" casaria antes de "jardim europa" e mandaria o negócio para
 * o bairro errado.
 */
function extrairBairro(texto, cidade) {
  // BAIRROS e indexado em MINUSCULA ('anapolis'), nao pelo nome exibido. Ja
  // custou um filtro que nunca rodava neste repo — aqui a chave e normalizada.
  const semAcento = (x) => String(x).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tabela = BAIRROS[String(cidade).toLowerCase()]
              || BAIRROS[semAcento(cidade)]
              || BAIRROS['anapolis'] || {};
  const alvo = ' ' + String(texto).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') + ' ';
  let achado = null, achadoSemAcento = '';
  for (const chave of Object.keys(tabela)) {
    const k = semAcento(chave);
    if (k.length < 4) continue;
    if (alvo.includes(' ' + k + ' ') || alvo.includes(' ' + k + ',')) {
      if (!achado || k.length > achadoSemAcento.length) { achado = chave; achadoSemAcento = k; }
    }
  }
  if (!achado) return null;

  // A tabela guarda a mesma rua em varias grafias ("jundiai" e "jundiaí"). O
  // corretor pode ter digitado sem acento; o que vai para o banco e para o
  // laudo do proximo cliente e a grafia certa.
  const comAcento = Object.keys(tabela).find(
    (c) => semAcento(c) === achadoSemAcento && /[\u00c0-\u00ff]/i.test(c)
  );
  return apresentar(comAcento || achado);
}

/** "vila jaiara" → "Vila Jaiara"; preposicao fica minuscula. */
const MIUDAS = new Set(['de', 'da', 'das', 'do', 'dos', 'e']);
function apresentar(nome) {
  return String(nome).split(/\s+/).map((p, i) => {
    const b = p.toLowerCase();
    if (i > 0 && MIUDAS.has(b)) return b;
    return b.charAt(0).toUpperCase() + b.slice(1);
  }).join(' ');
}

const CIDADES = ['Anápolis', 'Goiânia', 'Aparecida de Goiânia', 'Senador Canedo', 'Trindade', 'Brasília'];

function extrairCidade(texto) {
  const alvo = String(texto).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const c of CIDADES) {
    const k = c.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (alvo.includes(k)) return c;
  }
  return null;
}

/**
 * @param {string} texto     o que o corretor escreveu (sem o "/fechou")
 * @param {object} doLaudo   dados do último laudo da sessão, se houver — o que
 *                           faltar na frase é herdado dele, e é assim que o
 *                           registro fica ligado ao que o sistema tinha dito
 *                           (valor_avaliado alimenta o placar sistema × real).
 */
function interpretarFechamento(texto = '', doLaudo = null) {
  const t = String(texto).trim();
  const cidade = extrairCidade(t) || doLaudo?.cidade || 'Anápolis';

  // A metragem sai do texto antes da busca do valor: em "90m² por 520 mil" o
  // 90 é metragem, não preço.
  const metragemTexto = extrairMetragem(t);
  const semMetragem = metragemTexto
    ? t.replace(/(\d[\d.,]*)\s*(m2|m²|metros?\b|mts?\b)/i, ' ')
    : t;

  let tipo = null;
  for (const [re, nome] of TIPOS) if (re.test(t)) { tipo = nome; break; }

  const finalidade = /\b(aluguel|alug(ou|ar|ada|ado)|loca[cç][aã]o)\b/i.test(t) ? 'aluguel' : 'venda';

  const dados = {
    cidade,
    bairro:    extrairBairro(t, cidade) || doLaudo?.bairro || null,
    tipo:      tipo || doLaudo?.tipo || null,
    finalidade,
    metragem:  metragemTexto || Number(doLaudo?.metragem) || null,
    valorFechado: extrairValor(semMetragem),
    valorAvaliado: Number(doLaudo?.valorAvaliado) || null,
    laudoId: doLaudo?.laudoId || null,
    herdado: [],
  };

  if (doLaudo) {
    if (!extrairBairro(t, cidade) && doLaudo.bairro) dados.herdado.push('bairro');
    if (!tipo && doLaudo.tipo) dados.herdado.push('tipo');
    if (!metragemTexto && doLaudo.metragem) dados.herdado.push('metragem');
  }

  // buscarFechamentos() exige metragem > 0 para calcular R$/m²: sem ela o
  // registro entra no banco e nunca vira preço. Por isso é obrigatória aqui.
  const faltando = [];
  if (!dados.valorFechado) faltando.push('por quanto fechou');
  if (!dados.bairro)       faltando.push('o bairro');
  if (!dados.metragem)     faltando.push('a metragem');
  if (!dados.tipo)         faltando.push('o tipo (apartamento, casa, terreno, comercial)');
  dados.faltando = faltando;

  return dados;
}

const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });

/** O que o bot mostra ANTES de gravar. Quem confere é o corretor, não o parser. */
function textoConfirmacao(d) {
  const m2 = d.metragem > 0 ? Math.round(d.valorFechado / d.metragem) : null;
  let t = '📝 *Confirma o fechamento?*\n\n';
  t += `• ${d.tipo.charAt(0).toUpperCase() + d.tipo.slice(1)} · ${d.finalidade}\n`;
  t += `• ${d.metragem}m² · ${d.bairro}, ${d.cidade}\n`;
  t += `• Fechou por *${brl(d.valorFechado)}*`;
  if (m2) t += ` (${brl(m2)}/m²)`;
  t += '\n';
  if (d.valorAvaliado) {
    const dif = Math.round(((d.valorFechado - d.valorAvaliado) / d.valorAvaliado) * 100);
    t += `• O sistema tinha dito ${brl(d.valorAvaliado)} — ${dif === 0 ? 'na mosca' : (dif > 0 ? `fechou ${dif}% acima` : `fechou ${Math.abs(dif)}% abaixo`)}\n`;
  }
  if (d.herdado.length) t += `\n_Herdei ${d.herdado.join(', ')} do último laudo._\n`;
  t += '\nResponda *sim* para gravar ou *não* para cancelar.';
  return t;
}

/**
 * Procura o bairro em TODAS as cidades da tabela e devolve em qual ele existe.
 *
 * "Apartamento no Jundiaí, 189m², por R$ 1.600.000" não diz a cidade — e o
 * modelo respondeu cidade="Jundiaí", bairro="Jundiaí". O laudo saiu
 * "Jundiaí - Jundiaí/GO" e avaliou o imóvel R$ 217 mil mais barato, porque a
 * cidade errada leva a outra base de preço. O bairro, porém, é conhecido: ele
 * está na tabela de Anápolis, e é a tabela que sabe disso.
 */
function bairroComCidade(texto) {
  for (const cidade of ['Anápolis', 'Goiânia']) {
    const b = extrairBairro(texto, cidade);
    if (b) return { bairro: b, cidade };
  }
  return null;
}

module.exports = { interpretarFechamento, textoConfirmacao, extrairValor, extrairBairro, bairroComCidade, brl };
