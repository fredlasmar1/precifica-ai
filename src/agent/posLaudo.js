const { completar: completarLLM } = require('./llm');

/**
 * DEPOIS DO LAUDO, A CONVERSA CONTINUA.
 *
 * O Telegram ja fazia isso: com um laudo na sessao, "por que esse preco?" era
 * respondido com o laudo em contexto. O chat do SITE nao — ele so olhava se os
 * dados do imovel estavam completos e, estando, gerava o laudo de novo. Na
 * pratica:
 *
 *   "por que esse preco?"                        -> laudo inteiro outra vez
 *   "quanto ficaria a parcela do financiamento?" -> laudo inteiro outra vez
 *
 * Quem pergunta recebe de volta a mesma parede de texto e conclui que o sistema
 * nao entende pergunta. A regra passa a morar aqui, uma vez so, para os dois
 * canais responderem igual.
 */

/** O usuario quer avaliar OUTRO imovel, e nao perguntar sobre este? */
function ehNovaAvaliacao(texto) {
  const t = String(texto || '');
  const explicito = /\b(novo|nova|outro|outra|precificar|come[çc]ar|reiniciar|nova avalia)\b/i.test(t);
  // Descreveu um imovel do zero (tipo + referencia de lugar) sem dizer que e outro.
  const descreve = /\b(terreno|casa|apart|apto|comercial|sala|galp[aã]o|lote|sobrado)\b/i.test(t) &&
    /\b(bairro|rua|av\.|avenida|setor|jardim|vila|parque|residencial|em [A-Z])/i.test(t);
  return { sim: explicito || descreve, explicito, descreve };
}

function sistemaPosLaudo(laudoTexto, dados) {
  return `Você é o PrecificaAI, um especialista em precificação imobiliária.
O usuário acabou de receber um laudo e pode ter dúvidas ou querer aprofundar.

LAUDO GERADO:
${laudoTexto}

DADOS DO IMÓVEL AVALIADO:
${JSON.stringify(dados, null, 2)}

Responda de forma clara e direta, como um corretor experiente explicaria ao cliente.
Você pode:
- Explicar como chegamos ao preço sugerido
- Comparar com outros bairros ou tipos de imóvel
- Esclarecer o que significa cada indicador do laudo
- Sugerir como melhorar a precificação (reformas, diferenciais)
- Simular cenários ("e se fosse aluguel?", "e se tivesse piscina?")

Use SOMENTE os números que estão no laudo. Se a resposta exigir um número que
não está lá, diga o que falta em vez de estimar.
Não repita o laudo inteiro — responda a pergunta.
Se o usuário quiser avaliar outro imóvel, oriente-o a digitar /novo.`;
}

/**
 * @param {object} p  laudo (texto), dados, historico (opcional), pergunta
 * @returns {Promise<string>} a resposta, ou null se nao houver laudo
 */
async function responderSobreLaudo({ laudo, dados, historico = [], pergunta }) {
  if (!laudo) return null;
  return completarLLM({
    forte: true, maxTokens: 900, effort: 'low',
    messages: [
      { role: 'system', content: sistemaPosLaudo(laudo, dados) },
      ...historico.slice(-10),
      ...(historico.length && historico[historico.length - 1]?.content === pergunta
        ? [] : [{ role: 'user', content: pergunta }]),
    ],
  });
}

module.exports = { ehNovaAvaliacao, sistemaPosLaudo, responderSobreLaudo };
