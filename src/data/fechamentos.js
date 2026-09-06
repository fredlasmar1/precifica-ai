/**
 * FECHAMENTOS — o que o mercado REALMENTE pagou.
 *
 * Todo o motor do Precifica Aí funciona com preço PEDIDO: anúncio de portal,
 * busca da Perplexity, tabela de referência. Nenhuma dessas fontes sabe por
 * quanto o negócio fechou. É por isso que ninguém consegue responder se o
 * apartamento no Jundiaí é R$ 5,3 mil ou R$ 8,5 mil o m² — as duas respostas
 * saem de gente pedindo, não de gente pagando.
 *
 * Um fechamento vale mais que um anúncio porque é transação, não pretensão. E é
 * o único ativo que nenhum concorrente copia: a Perplexity lê os mesmos anúncios
 * para todo mundo; o que fechou na mão do corretor, só quem perguntou tem.
 *
 * Princípio do motor, o mesmo do resto do sistema: a MELHOR EVIDÊNCIA DISPONÍVEL
 * manda, e evidência fina alarga a faixa em vez de mudar o centro. Transação
 * ganha de anúncio; três fechamentos do bairro valem mais que oito pedidos.
 */

/** Mediana — resiste a um fechamento fora da curva melhor que a média. */
function mediana(arr) {
  const v = arr.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

/** Quantos fechamentos do próprio bairro bastam para o preço sair deles. */
const MINIMO_PARA_MANDAR = 3;

/**
 * Lê as linhas de `fechamentos` e devolve o sinal de mercado que elas sustentam.
 *
 * @returns null se não há nada; senão:
 *  { n, m2, manda, confianca, descontoMedio, diasMedio, erroMedioSistema, nota }
 */
function sinalDeMercado(rows = []) {
  const linhas = (rows || []).filter((r) => Number(r.valor_fechado) > 0 && Number(r.metragem) > 0);
  if (!linhas.length) return null;

  const m2s = linhas.map((r) => Number(r.valor_fechado) / Number(r.metragem));
  const m2 = mediana(m2s);
  const n = linhas.length;

  // Desconto de negociação: quanto o anunciado cede até fechar. Só entra quem
  // registrou o valor anunciado — e essa conta é útil MESMO com 1 ou 2 casos,
  // porque não move a avaliação, só informa a margem de negociação.
  const comAnuncio = linhas.filter((r) => Number(r.valor_anunciado) > 0);
  const descontos = comAnuncio.map((r) => (Number(r.valor_anunciado) - Number(r.valor_fechado)) / Number(r.valor_anunciado));
  const descontoMedio = descontos.length
    ? +(descontos.reduce((a, b) => a + b, 0) / descontos.length * 100).toFixed(1)
    : null;

  // Placar do próprio sistema: erramos para cima ou para baixo neste bairro?
  const comAval = linhas.filter((r) => Number(r.valor_avaliado) > 0);
  const erros = comAval.map((r) => (Number(r.valor_avaliado) - Number(r.valor_fechado)) / Number(r.valor_fechado));
  const erroMedioSistema = erros.length
    ? +(erros.reduce((a, b) => a + b, 0) / erros.length * 100).toFixed(1)
    : null;

  const dias = linhas.map((r) => Number(r.dias_ate_fechar)).filter((d) => d > 0);
  const diasMedio = dias.length ? Math.round(dias.reduce((a, b) => a + b, 0) / dias.length) : null;

  // A confiança de um fechamento é maior que a de um anúncio no mesmo n, mas
  // continua sendo função do tamanho da amostra — e é declarada, como o resto.
  const confianca = n >= 8 ? 'alta' : n >= 5 ? 'media' : 'baixa';

  return {
    n,
    m2: Math.round(m2),
    manda: n >= MINIMO_PARA_MANDAR,
    confianca,
    descontoMedio,
    erroMedioSistema,
    diasMedio,
    nota: n >= MINIMO_PARA_MANDAR
      ? `Preço apurado em ${n} negócio(s) FECHADO(S) neste bairro — o que foi pago, não o que foi pedido.`
      : `${n} negócio(s) fechado(s) registrado(s) aqui: ainda pouco para mandar no preço, mas já dizem a margem de negociação.`,
  };
}

/** Frase de negociação para o laudo — útil mesmo com amostra pequena. */
function textoNegociacao(sinal) {
  if (!sinal) return null;
  const partes = [];
  if (sinal.descontoMedio != null) {
    const d = sinal.descontoMedio;
    partes.push(d > 0
      ? `Nos negócios registrados neste bairro, o anunciado cedeu em média ${d}% até fechar.`
      : `Nos negócios registrados neste bairro, o fechado ficou ${Math.abs(d)}% ACIMA do anunciado — mercado aquecido.`);
  }
  if (sinal.diasMedio) partes.push(`Tempo médio até fechar: ${sinal.diasMedio} dias.`);
  return partes.length ? partes.join(' ') : null;
}

/** Placar honesto do sistema contra a realidade. */
function textoPlacar(p) {
  if (!p || !Number(p.total)) {
    return 'Ainda não há negócio fechado registrado. Cada "por quanto fechou?" respondido calibra o sistema para o próximo laudo.';
  }
  const linhas = [`📊 *O SISTEMA CONTRA A REALIDADE*`, `${p.total} negócio(s) fechado(s) registrado(s).`];
  if (p.erro_medio != null) {
    const e = +(Number(p.erro_medio) * 100).toFixed(1);
    linhas.push(Math.abs(e) < 5
      ? `Avaliação x fechamento: erro médio de ${e}% — dentro do aceitável.`
      : e > 0
        ? `⚠️ O sistema tem avaliado ${e}% ACIMA do que se paga. Está otimista.`
        : `⚠️ O sistema tem avaliado ${Math.abs(e)}% ABAIXO do que se paga. Está conservador.`);
  }
  if (p.desconto_medio != null) {
    linhas.push(`Do anúncio ao fechamento, o preço cede em média ${(Number(p.desconto_medio) * 100).toFixed(1)}%.`);
  }
  if (p.dias_medio) linhas.push(`Tempo médio até fechar: ${Math.round(Number(p.dias_medio))} dias.`);
  return linhas.join('\n');
}

module.exports = { sinalDeMercado, textoNegociacao, textoPlacar, mediana, MINIMO_PARA_MANDAR };
