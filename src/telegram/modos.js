const { completar: completarLLM } = require('../agent/llm');

/**
 * O QUE O SISTEMA SABE FAZER — em um lugar só.
 *
 * O site tem 13 funções (avaliar, comercial, terreno, fazenda, prédio,
 * empresa, matrícula, FIPE...). O bot do Telegram expunha UMA: avaliação de
 * venda. Quem chegava pelo Telegram não descobria o resto — e o Telegram é
 * onde o corretor está.
 *
 * Cada modo aqui diz: o rótulo do botão, a rota que já existe e funciona, os
 * campos obrigatórios e como perguntar o que faltar. O bot não reimplementa
 * regra nenhuma — ele preenche e chama a mesma rota do site, então melhoria
 * feita lá aparece aqui no mesmo deploy.
 */

const MODOS = {
  venda: {
    rotulo: '🏠 Avaliar para VENDER', rota: '/avaliar',
    fixos: { finalidade: 'venda' },
    campos: ['tipo', 'cidade', 'bairro', 'metragem'],
    exemplo: 'apartamento 90m² no Jundiaí, Anápolis, 3 quartos',
    pergunta: 'O que você quer avaliar? Me diga o *tipo*, a *metragem* e o *bairro*.',
  },
  aluguel: {
    rotulo: '🔑 Avaliar para ALUGAR', rota: '/avaliar',
    fixos: { finalidade: 'aluguel' },
    campos: ['tipo', 'cidade', 'bairro', 'metragem'],
    exemplo: 'casa 150m² no Centro de Anápolis',
    pergunta: 'Qual imóvel vai para locação? Me diga o *tipo*, a *metragem* e o *bairro*.',
  },
  // ⚠️ ESTE BOTAO APONTAVA PARA /decisao — E OUTRA PERGUNTA.
  //
  // /decisao compara MANTER ALUGADO x VENDER E APLICAR: e para quem JA TEM o
  // imovel. Quem clica em "comprar? vale a pena" nao tem o imovel — quer saber
  // se o preco PEDIDO se sustenta. O bot recebeu "apartamento no Jundiai,
  // 189m², por R$ 1.600.000" e devolveu um estudo de renda fixa, sem nunca
  // dizer se 1,6 milhao era caro ou barato, e sem usar os 189m².
  comprar: {
    rotulo: '🤔 COMPRAR? vale a pena', rota: '/avaliar',
    fixos: { finalidade: 'venda' },
    campos: ['tipo', 'cidade', 'bairro', 'metragem', 'valorPedido'],
    exemplo: 'apartamento 90m² Jundiaí Anápolis pedindo 600 mil',
    pergunta: 'Me diga o imóvel e *por quanto estão pedindo*. Eu comparo com o mercado e digo se o preço se sustenta.',
  },

  // A pergunta do DONO, que e o que a /decisao responde de verdade.
  alugarOuVender: {
    rotulo: '⚖️ TENHO UM: alugar ou vender?', rota: '/decisao',
    campos: ['valorImovel'],
    exemplo: 'meu apartamento vale 600 mil e aluga por 2.500',
    pergunta: 'Quanto vale o imóvel hoje? Se souber por quanto ele aluga, mande junto — comparo manter alugado × vender e aplicar.',
  },
  ponto: {
    rotulo: '🏪 PONTO COMERCIAL', rota: '/ponto-comercial',
    campos: ['ramo', 'cidade', 'bairro'],
    exemplo: 'barbearia no Jundiaí, Anápolis, 120m², aluguel 8 mil',
    pergunta: 'Qual o *ramo* do cliente e em que *bairro*? Se souber a metragem e o aluguel pedido, mande junto — aí eu digo se o aluguel cabe.',
  },
  cabe: {
    rotulo: '📐 O ALUGUEL CABE?', rota: '/viabilidade-aluguel',
    campos: ['ramo', 'aluguelPedido'],
    exemplo: 'farmácia, aluguel de 6 mil, 80m² no Centro',
    pergunta: 'Qual o *ramo* e *quanto estão pedindo de aluguel*? Eu digo quanto o negócio precisa faturar para esse aluguel caber.',
  },
  terreno: {
    rotulo: '📄 TERRENO', rota: '/terreno',
    campos: ['bairro', 'area'],
    exemplo: 'terreno de 400m² no Jardim Europa',
    pergunta: 'Qual a *área do terreno* e o *bairro*?',
  },
  bts: {
    rotulo: '🏗️ BTS (built to suit)', rota: '/bts',
    campos: ['bairro', 'area'],
    exemplo: 'terreno de 2.000m² no DAIA',
    pergunta: 'Qual a *área do terreno* e o *bairro*? Eu levanto quem procura ponto nessa região.',
  },
  fazenda: {
    rotulo: '🌾 FAZENDA / CHÁCARA', rota: '/fazenda',
    campos: ['cidade', 'area', 'modo'],
    exemplo: 'fazenda de 50 alqueires em Anápolis, pastagem',
    pergunta: 'Qual a *área* (diga se é em alqueires ou hectares) e a *cidade*?',
  },
  predio: {
    rotulo: '🏢 PRÉDIO / CONDOMÍNIO', rota: '/predio',
    campos: ['condominio', 'cidade', 'bairro'],
    exemplo: 'Edifício Splendor, Jundiaí, Anápolis',
    pergunta: 'Qual o *nome do prédio* e o *bairro*?',
  },
  empresa: {
    rotulo: '🏭 AVALIAR EMPRESA', rota: '/avaliar-empresa',
    campos: ['ramo', 'faturamentoMensal'],
    exemplo: 'padaria que fatura 80 mil por mês, 5 anos de operação',
    pergunta: 'Qual o *ramo* e o *faturamento mensal*?',
  },
  melhorBairro: {
    rotulo: '🗺️ MELHOR BAIRRO PRA…', rota: '/melhor-bairro',
    campos: ['ramo'],
    exemplo: 'pizzaria',
    pergunta: 'Para qual *ramo* você quer saber o melhor bairro?',
  },
  rotatividade: {
    rotulo: '🔄 ESSE PONTO DÁ AZAR?', rota: '/rotatividade',
    campos: ['logradouro', 'cidade'],
    exemplo: 'Avenida Brasil, 100, Anápolis',
    pergunta: 'Qual a *rua/avenida* (e número, se souber)? Eu levanto quantos negócios já abriram e fecharam ali.',
  },
};

/** Ordem dos botões — os mais usados primeiro. */
const ORDEM = ['venda', 'aluguel', 'comprar', 'alugarOuVender', 'ponto', 'cabe',
               'terreno', 'bts', 'fazenda', 'predio', 'empresa', 'melhorBairro', 'rotatividade'];

/** Teclado inline do Telegram, 2 por linha. */
function tecladoMenu() {
  const linhas = [];
  for (let i = 0; i < ORDEM.length; i += 2) {
    linhas.push(ORDEM.slice(i, i + 2).map((id) => ({
      text: MODOS[id].rotulo, callback_data: 'modo:' + id,
    })));
  }
  linhas.push([
    { text: '📜 LER MATRÍCULA (foto)', callback_data: 'modo:matricula' },
    { text: '💰 REGISTRAR FECHAMENTO', callback_data: 'modo:fechou' },
  ]);
  return { inline_keyboard: linhas };
}

const ROTULO_CAMPO = {
  tipo: 'o tipo (casa, apartamento, terreno, comercial)',
  cidade: 'a cidade', bairro: 'o bairro', metragem: 'a metragem em m²',
  area: 'a área em m²', valorImovel: 'o valor que estão pedindo',
  ramo: 'o ramo do negócio', aluguelPedido: 'o aluguel pedido',
  condominio: 'o nome do prédio', faturamentoMensal: 'o faturamento mensal',
  logradouro: 'a rua ou avenida', modo: 'se a área é em alqueires ou hectares',
};

/**
 * Tira do texto os campos daquele modo. Leitura de formulário, não julgamento:
 * o modelo só transcreve o que está escrito — quem calcula qualquer coisa é a
 * rota, depois.
 */
async function extrairCampos(modo, texto) {
  const m = MODOS[modo];
  if (!m) return {};
  const campos = [...m.campos, 'quartos', 'vagas', 'metragem', 'endereco', 'numero'];
  const r = await completarLLM({
    forte: false, maxTokens: 300,
    messages: [
      { role: 'system', content: 'Você extrai campos de uma frase de corretor de imóveis em Goiás. Responda SOMENTE JSON. Campo ausente = null. NUNCA invente valor: se a frase não diz, é null. Números sem pontuação (520000, não "520 mil"). Cidade padrão: Anápolis.' },
      { role: 'user', content: `Extraia destes campos o que estiver na frase: ${[...new Set(campos)].join(', ')}.\nFrase: "${texto}"\nJSON:` },
    ],
  });
  let s = String(r || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const i = s.indexOf('{'), f = s.lastIndexOf('}');
  if (i >= 0 && f > i) s = s.slice(i, f + 1);
  let j;
  try {
    j = JSON.parse(s);
    for (const k of Object.keys(j)) if (j[k] === null || j[k] === '') delete j[k];
  } catch { j = {}; }

  // ── Três reforços em código, porque o modelo não precisa acertar tudo ──

  // 1. BAIRRO. Em "apartamento 90m² Jundiaí Anápolis pedindo 600 mil" o modelo
  //    devolveu cidade=Anápolis e bairro VAZIO — e o bot ficava pedindo um
  //    bairro que estava escrito na frase. E quando acerta, costuma devolver
  //    "maracana": a lista do sistema (177 grafias só de Anápolis) dá a grafia
  //    certa, que é a que o filtro de comparativos usa depois.
  {
    const { extrairBairro } = require('./fechou');
    const achado = extrairBairro(texto, j.cidade || 'Anápolis');
    if (achado) j.bairro = achado;
  }

  // 2. CIDADE. O sistema é de Anápolis; ninguém escreve a cidade toda vez.
  //    Sem isto o bot travava em "faltou a cidade" numa frase completa.
  if (!j.cidade) j.cidade = 'Anápolis';

  // 3. TIPO. A rota espera o nome inteiro; o corretor escreve "apto".
  if (j.tipo) {
    const t = String(j.tipo).toLowerCase();
    if (/^(apto|ap|apart)/.test(t))            j.tipo = 'apartamento';
    else if (/^(sobrado|resid)/.test(t))       j.tipo = 'casa';
    else if (/^(lote|[aá]rea)/.test(t))        j.tipo = 'terreno';
    else if (/(galp|barrac|loja|sala|escrit)/.test(t)) j.tipo = 'comercial';
  }

  return j;
}

/** O que ainda falta para poder chamar a rota. */
function faltando(modo, dados) {
  const m = MODOS[modo];
  if (!m) return [];
  return m.campos.filter((c) => dados[c] == null || dados[c] === '');
}

function textoDoQueFalta(modo, faltas) {
  const lista = faltas.map((f) => ROTULO_CAMPO[f] || f);
  const frase = lista.length === 1 ? lista[0] : lista.slice(0, -1).join(', ') + ' e ' + lista.slice(-1);
  return `Faltou ${frase}.\n\nExemplo: _${MODOS[modo].exemplo}_`;
}

module.exports = { MODOS, ORDEM, tecladoMenu, extrairCampos, faltando, textoDoQueFalta, ROTULO_CAMPO };
