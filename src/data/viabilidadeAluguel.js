/**
 * VIABILIDADE DO ALUGUEL — "esse ponto te quebra?"
 *
 * A empresa não quebra porque escolheu um ponto "ruim" no abstrato. Ela quebra
 * porque assinou um aluguel que o faturamento daquele ponto não sustenta, e só
 * descobre no oitavo mês. O aluguel é custo fixo: entra igual no mês bom e no
 * mês ruim.
 *
 * Por isso este módulo NÃO estima faturamento. Estimar faturamento é adivinhar,
 * e foi exatamente isso que a aba Comercial fazia — pedia ao GPT-4o uma "faixa
 * realista" e devolvia "R$ 30.000 a R$ 50.000" com cara de pesquisa. É esse
 * número que faz o empresário assinar o contrato.
 *
 * A pergunta é invertida: dado o aluguel que estão pedindo, QUANTO ELE PRECISA
 * FATURAR para esse aluguel caber na régua do ramo dele? Isso é aritmética a
 * partir de números que o próprio dono tem (aluguel pedido, ticket médio), não
 * profecia. E o resultado é o número que faz alguém desistir de um mau contrato:
 *
 *   "R$ 8.000 de aluguel só fecha faturando R$ 80.000/mês.
 *    No seu ticket de R$ 60, são 51 clientes por dia útil. Você dá conta?"
 *
 * O segundo eixo é real e não depende de estimativa nenhuma: comparar o aluguel
 * PEDIDO com o aluguel de MERCADO do bairro, que o motor já sabe calcular.
 */

/**
 * Teto de aluguel sobre faturamento, por ramo (% do faturamento bruto mensal).
 *
 * FONTE ÚNICA — todo número de régua do negócio mora aqui. São referências de
 * mercado do varejo/serviço brasileiro, não medição da região: `saudavel` é a
 * faixa em que o negócio respira, `teto` é onde o aluguel começa a comer o
 * lucro. Ramo com muita área parada (academia, escola) tolera percentual maior
 * porque o m² é barato; ramo de giro alto e margem fina (supermercado, posto)
 * tolera muito menos.
 *
 * ⚠️ CALIBRAR com os negócios reais que o Fred vê fechar em Anápolis.
 */
const TETO_ALUGUEL = {
  // ── Alimentação: aluguel é o segundo maior custo depois da folha ──
  restaurante:  { saudavel: 8,  teto: 12, label: 'Restaurante' },
  lanchonete:   { saudavel: 8,  teto: 12, label: 'Lanchonete / fast-food' },
  padaria:      { saudavel: 6,  teto: 10, label: 'Padaria' },
  bar:          { saudavel: 8,  teto: 12, label: 'Bar / conveniência' },

  // ── Serviço com cadeira/agenda: fatura por hora de profissional ──
  barbearia:    { saudavel: 8,  teto: 12, label: 'Barbearia / salão' },
  salao:        { saudavel: 8,  teto: 12, label: 'Salão de beleza' },
  estetica:     { saudavel: 8,  teto: 12, label: 'Clínica de estética' },
  academia:     { saudavel: 12, teto: 18, label: 'Academia' },
  educacao:     { saudavel: 12, teto: 18, label: 'Escola / curso' },
  saude:        { saudavel: 8,  teto: 12, label: 'Clínica / consultório' },

  // ── Varejo: margem média, giro médio ──
  varejo:       { saudavel: 8,  teto: 12, label: 'Loja de varejo' },
  roupas:       { saudavel: 8,  teto: 12, label: 'Loja de roupas' },
  pet:          { saudavel: 6,  teto: 10, label: 'Pet shop' },
  materiais:    { saudavel: 5,  teto: 8,  label: 'Material de construção' },

  // ── Giro alto e margem fina: quase não cabe aluguel ──
  farmacia:     { saudavel: 4,  teto: 6,  label: 'Farmácia' },
  mercado:      { saudavel: 3,  teto: 5,  label: 'Mercado / hortifruti' },
  atacarejo:    { saudavel: 2,  teto: 4,  label: 'Atacarejo / supermercado' },
  posto:        { saudavel: 2,  teto: 4,  label: 'Posto de combustível' },

  // ── B2B / back office: não depende de fluxo de rua ──
  escritorio:   { saudavel: 5,  teto: 8,  label: 'Escritório / serviços' },
  logistica:    { saudavel: 3,  teto: 6,  label: 'Galpão / logística' },

  default:      { saudavel: 7,  teto: 10, label: 'Comércio em geral' },
};

/** Sinônimos que o corretor digita → chave do catálogo. */
const APELIDOS = {
  'restaurante': 'restaurante', 'pizzaria': 'restaurante', 'self service': 'restaurante',
  'lanchonete': 'lanchonete', 'fast food': 'lanchonete', 'hamburgueria': 'lanchonete',
  'açaí': 'lanchonete', 'acai': 'lanchonete', 'sorveteria': 'lanchonete', 'cafeteria': 'lanchonete',
  'padaria': 'padaria', 'panificadora': 'padaria',
  'bar': 'bar', 'distribuidora': 'bar', 'conveniência': 'bar', 'conveniencia': 'bar',
  'barbearia': 'barbearia', 'barbeiro': 'barbearia',
  'salão': 'salao', 'salao': 'salao', 'cabeleireiro': 'salao', 'manicure': 'salao',
  'estética': 'estetica', 'estetica': 'estetica',
  'academia': 'academia', 'crossfit': 'academia', 'pilates': 'academia', 'box': 'academia',
  'escola': 'educacao', 'curso': 'educacao', 'faculdade': 'educacao', 'creche': 'educacao',
  'clínica': 'saude', 'clinica': 'saude', 'consultório': 'saude', 'consultorio': 'saude',
  'laboratório': 'saude', 'laboratorio': 'saude', 'odontologia': 'saude', 'dentista': 'saude',
  'loja': 'varejo', 'variedades': 'varejo', 'papelaria': 'varejo', 'presentes': 'varejo',
  'roupas': 'roupas', 'boutique': 'roupas', 'calçados': 'roupas', 'calcados': 'roupas', 'moda': 'roupas',
  'pet shop': 'pet', 'petshop': 'pet', 'pet': 'pet', 'veterinária': 'pet', 'veterinaria': 'pet',
  'material de construção': 'materiais', 'materiais': 'materiais', 'construção': 'materiais',
  'farmácia': 'farmacia', 'farmacia': 'farmacia', 'drogaria': 'farmacia',
  'mercado': 'mercado', 'mercadinho': 'mercado', 'hortifruti': 'mercado', 'supermercado': 'mercado',
  'atacarejo': 'atacarejo', 'atacado': 'atacarejo',
  'posto': 'posto', 'combustível': 'posto', 'combustivel': 'posto',
  'escritório': 'escritorio', 'escritorio': 'escritorio', 'coworking': 'escritorio',
  'contabilidade': 'escritorio', 'advocacia': 'escritorio', 'imobiliária': 'escritorio',
  'galpão': 'logistica', 'galpao': 'logistica', 'logística': 'logistica', 'logistica': 'logistica',
  'transportadora': 'logistica', 'depósito': 'logistica', 'deposito': 'logistica',
};

const semAcento = (t) => String(t || '').toLowerCase().trim()
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Resolve o texto livre do ramo para a régua correspondente. */
function reguaDoRamo(ramo) {
  const bruto = String(ramo || '').toLowerCase().trim();
  const chave = APELIDOS[bruto] || APELIDOS[semAcento(bruto)];
  if (chave) return { ...TETO_ALUGUEL[chave], chave, reconhecido: true };

  // Match parcial: "clinica de estetica" casa com "estetica"
  for (const [apelido, k] of Object.entries(APELIDOS)) {
    if (semAcento(bruto).includes(semAcento(apelido))) {
      return { ...TETO_ALUGUEL[k], chave: k, reconhecido: true };
    }
  }
  return { ...TETO_ALUGUEL.default, chave: 'default', reconhecido: false };
}

const brl = (v) => 'R$ ' + Math.round(Number(v) || 0).toLocaleString('pt-BR');

/**
 * @param {object} p
 *  ramo           texto livre ("barbearia", "pizzaria"...)
 *  aluguelPedido  R$/mês que estão pedindo pelo ponto
 *  metragem       m² da loja (opcional, só para o R$/m²)
 *  ticketMedio    R$ por venda/atendimento — NÚMERO DO DONO, não estimado
 *  diasUteis      dias de operação no mês (padrão 26)
 *  aluguelMercadoM2  R$/m²/mês de aluguel comercial do bairro, vindo do motor
 *  faturamentoAtual  se o dono já tem faturamento (mudança de ponto), entra aqui
 */
function analisarAluguel(p = {}) {
  const aluguelPedido = Number(p.aluguelPedido) || 0;
  if (aluguelPedido <= 0) {
    return { erro: 'Informe o aluguel que estão pedindo pelo ponto — é dele que sai toda a conta.' };
  }

  const regua = reguaDoRamo(p.ramo);
  const metragem = Number(p.metragem) || 0;
  const ticket = Number(p.ticketMedio) || 0;
  const diasUteis = Number(p.diasUteis) > 0 ? Number(p.diasUteis) : 26;

  // ── O número central: quanto precisa faturar para o aluguel caber ──
  // Aritmética pura a partir do aluguel pedido e da régua do ramo.
  const faturamentoSaudavel = Math.round(aluguelPedido / (regua.saudavel / 100));
  const faturamentoMinimo   = Math.round(aluguelPedido / (regua.teto / 100));

  const conta = {
    ramoReconhecido: regua.reconhecido,
    ramoLabel: regua.label,
    percentualSaudavel: regua.saudavel,
    percentualTeto: regua.teto,
    aluguelPedido,
    faturamentoSaudavel,   // aluguel ocupa o % confortável
    faturamentoMinimo,     // aluguel ocupa o % teto — abaixo disso o ponto sufoca
    porDiaUtil: Math.round(faturamentoMinimo / diasUteis),
    diasUteis,
  };

  // ── Traduz para clientes/dia, se o dono souber o ticket dele ──
  if (ticket > 0) {
    conta.ticketMedio = ticket;
    conta.clientesMes = Math.ceil(faturamentoMinimo / ticket);
    conta.clientesDia = Math.ceil(faturamentoMinimo / ticket / diasUteis);
    conta.clientesDiaSaudavel = Math.ceil(faturamentoSaudavel / ticket / diasUteis);
  }

  // ── Segundo eixo, este SEM estimativa: o aluguel está caro para o bairro? ──
  const mercadoM2 = Number(p.aluguelMercadoM2) || 0;
  if (mercadoM2 > 0 && metragem > 0) {
    // A comparacao herda a qualidade da amostra que produziu o R$/m² do bairro.
    // Cravar "216% acima" com 4 anuncios de confianca baixa e o mesmo vicio de
    // afirmar sem base — o numero entra, mas declarando o que o sustenta.
    const conf = p.confiancaMercado || null;
    const amostra = Number(p.amostraMercado) || 0;
    const aluguelMercado = Math.round(mercadoM2 * metragem);
    const desvio = (aluguelPedido - aluguelMercado) / aluguelMercado;
    conta.mercado = {
      aluguelMercado,
      m2Pedido: Math.round(aluguelPedido / metragem),
      m2Mercado: Math.round(mercadoM2),
      desvioPct: Math.round(desvio * 100),
      veredito: desvio > 0.20 ? 'acima' : desvio < -0.20 ? 'abaixo' : 'na faixa',
      confianca: conf,
      amostra,
      // Amostra fina nao invalida a comparacao, mas muda o que se pode dizer
      // dela: vira indicio para conferir, nao veredito de preco.
      firme: conf === 'alta' || amostra >= 8,
    };
  }

  // ── Se o dono já fatura (troca de ponto), a conta vira direta ──
  const fatAtual = Number(p.faturamentoAtual) || 0;
  if (fatAtual > 0) {
    const peso = (aluguelPedido / fatAtual) * 100;
    conta.pesoNoFaturamentoAtual = +peso.toFixed(1);
    conta.aluguelMaximoParaSeuFaturamento = Math.round(fatAtual * (regua.teto / 100));
    conta.vereditoDireto = peso <= regua.saudavel ? 'cabe'
      : peso <= regua.teto ? 'aperta'
      : 'nao_cabe';
  }

  return conta;
}

/** Texto para o laudo/WhatsApp. Fala com o dono, não com o analista. */
function formatarAluguel(c) {
  if (!c || c.erro) return c?.erro || '';
  let t = `💸 *O ALUGUEL CABE NO NEGÓCIO?*\n`;
  t += `Ramo: ${c.ramoLabel}${c.ramoReconhecido ? '' : ' (régua genérica — ramo não reconhecido)'}\n`;
  t += `Aluguel pedido: *${brl(c.aluguelPedido)}/mês*\n\n`;

  t += `📐 *A régua do seu ramo:* o aluguel deve ficar entre ${c.percentualSaudavel}% e ${c.percentualTeto}% do que você fatura.\n\n`;

  t += `🎯 *Então, para esse aluguel:*\n`;
  t += `• Você precisa faturar *no mínimo ${brl(c.faturamentoMinimo)}/mês* — e nesse ponto o aluguel já come ${c.percentualTeto}% de tudo.\n`;
  t += `• Para respirar, o certo é *${brl(c.faturamentoSaudavel)}/mês*.\n`;
  t += `• O mínimo dá *${brl(c.porDiaUtil)} por dia* em ${c.diasUteis} dias de operação.\n`;

  if (c.clientesDia) {
    t += `• No seu ticket de ${brl(c.ticketMedio)}, são *${c.clientesDia} clientes por dia* só para o aluguel caber `;
    t += `(e ${c.clientesDiaSaudavel}/dia para o negócio respirar).\n`;
  } else {
    t += `_Informe seu ticket médio e eu traduzo isso em clientes por dia._\n`;
  }
  t += `\n`;

  if (c.mercado) {
    const m = c.mercado;
    const emoji = m.veredito === 'acima' ? '🔴' : m.veredito === 'abaixo' ? '🟢' : '🟡';
    t += `${emoji} *O preço do ponto:* pedem ${brl(m.m2Pedido)}/m², e o aluguel comercial do bairro está em ${brl(m.m2Mercado)}/m².\n`;
    if (!m.firme) {
      t += `_Atenção: esse R$/m² do bairro saiu de ${m.amostra || 'poucos'} anúncio(s) (confiança ${m.confianca || 'baixa'}) — use como indício para conferir, não como preço fechado._\n`;
    }
    if (m.veredito === 'acima')  t += `Está *${m.desvioPct}% acima* do bairro — há espaço real para negociar (o mercado diz ${brl(m.aluguelMercado)}).\n`;
    if (m.veredito === 'abaixo') t += `Está *${Math.abs(m.desvioPct)}% abaixo* do bairro — preço bom; entenda por quê antes de fechar (localização, estado, restrição de uso).\n`;
    if (m.veredito === 'na faixa') t += `Está na faixa do bairro — o preço é justo; a decisão é se o faturamento acima é alcançável.\n`;
    t += `\n`;
  }

  if (c.vereditoDireto) {
    const v = c.vereditoDireto;
    const emoji = v === 'cabe' ? '🟢' : v === 'aperta' ? '🟡' : '🔴';
    const frase = v === 'cabe' ? 'Cabe. O aluguel fica dentro da régua do seu ramo.'
      : v === 'aperta' ? 'Aperta. Fica acima do confortável e abaixo do limite — só feche com margem de caixa.'
      : 'NÃO cabe. Nesse faturamento o aluguel passa do limite do ramo e vira o problema do negócio.';
    t += `${emoji} *No seu faturamento de hoje:* o aluguel seria ${c.pesoNoFaturamentoAtual}% da receita. ${frase}\n`;
    t += `Para o seu faturamento atual, o aluguel máximo é *${brl(c.aluguelMaximoParaSeuFaturamento)}/mês*.\n\n`;
  }

  t += `_Régua de mercado do varejo/serviço, não medição desta região. O aluguel é custo FIXO: entra igual no mês bom e no mês ruim._`;
  return t;
}

module.exports = { analisarAluguel, formatarAluguel, reguaDoRamo, TETO_ALUGUEL };
