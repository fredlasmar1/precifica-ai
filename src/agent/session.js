const NodeCache = require('node-cache');

// Sessões ficam em memória por 2 horas
const cache = new NodeCache({ stdTTL: 7200 });

/**
 * Retorna o histórico de mensagens de um número
 */
function getSession(phone) {
  return cache.get(phone) || [];
}

/**
 * Adiciona uma mensagem ao histórico
 */
function addMessage(phone, role, content) {
  const history = getSession(phone);
  history.push({ role, content });
  cache.set(phone, history);
  return history;
}

/**
 * Limpa a sessão (nova avaliação)
 */
function clearSession(phone) {
  cache.del(phone);
}

/**
 * Verifica se o agente já coletou todos os dados e está pronto para avaliar.
 * Critério principal: GPT sinalizou com a frase gatilho.
 * Critério secundário (failsafe rural): todos os campos coletados na conversa.
 */
function isReadyToEvaluate(history) {
  // Critério 1: assistente disse a frase gatilho
  const lastAssistant = [...history]
    .reverse()
    .find(m => m.role === 'assistant');

  if (lastAssistant && (
    lastAssistant.content.includes('consultando o mercado') ||
    lastAssistant.content.includes('aguarde um momento') ||
    /vou (consultar|buscar|pesquisar)|j[aá] (vou|estou) (consultar|buscar)/i.test(lastAssistant.content)
  )) return true;

  // ─── FAILSAFE URBANO ────────────────────────────────────────────
  // Antes existia failsafe SÓ para rural. Para apartamento, casa, terreno e
  // comercial o laudo dependia exclusivamente de o GPT dizer a frase exata —
  // e quando ele resolvia fazer mais uma pergunta, o laudo NUNCA saía.
  //
  // Medido no bot em 07/09/2026: a mensagem "apartamento de 90m2 no Jundiaí em
  // Anápolis, venda, 3 quartos 1 vaga, bom estado" traz TUDO que o /api/avaliar
  // exige, e o bot respondeu pedindo o nome do condomínio — que no site é
  // explicitamente opcional. O corretor ficava preso numa pergunta que não
  // muda o laudo.
  //
  // A régua aqui é a MESMA do /api/avaliar: tipo, finalidade, localização e
  // metragem. Condomínio, endereço e diferenciais são opcionais e nunca
  // seguram o laudo.
  const textoUsuario = history.filter(m => m.role === 'user').map(m => m.content).join(' ');

  const tipoUrbano = /apartamento|\bapto\b|\bap\b|casa|sobrado|terreno|lote|comercial|\bsala\b|loja|galp[aã]o|pr[eé]dio/i.test(textoUsuario);
  if (tipoUrbano) {
    const temFinalidade = /venda|vender|comprar|compra|aluguel|alugar|loca[cç][aã]o/i.test(textoUsuario);
    const temMetragem   = /\d[\d.,]*\s*(m2|m²|metros?\b|mts?\b)/i.test(textoUsuario);
    const temLocal      = /an[aá]polis|goi[aâ]nia|ner[oó]polis|goian[eé]sia|jundia[ií]|centro|eldorado|maracan[aã]|vila |setor |jardim |res(idencial)? |bairro |\bem\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/i.test(textoUsuario);

    if (temFinalidade && temMetragem && temLocal) {
      console.log('[Session] Failsafe urbano: tipo+finalidade+metragem+local presentes, disparando laudo');
      return true;
    }
  }

  // Critério 2 (failsafe rural): só dispara quando TODOS os campos estiverem na conversa
  // Evita disparar no meio da coleta de dados
  const textoConversa = history.map(m => m.content).join(' ');

  const temTipoRural = /ch[aá]cara|s[ií]tio|fazenda|rural/i.test(textoConversa);
  if (!temTipoRural) return false;

  const temArea       = /\d[\d,.]?\d*\s*(alqueires?|alq\.?|hectares?|\bha\b)/i.test(textoConversa);
  const temLocalizacao = /goian[aá]polis|an[aá]polis|goi[aâ]nia|ner[oó]polis|campo limpo|silv[aâ]nia|GO-\d+|BR-\d+/i.test(textoConversa);
  const temAcesso     = /beira.*asfalto|asfalto.*beira|estrada de ch[aã]o|acesso.*asfalto|asfalto.*acesso|ch[aã]o at[eé]/i.test(textoConversa);
  const temAgua       = /[aá]gua|nascente|po[cç]o|c[oó]rrego|represa|a[cç]ude|mina|sem [aá]gua|n[aã]o tem [aá]gua/i.test(textoConversa);
  const temEnergia    = /energia|el[eé]tric|luz el[eé]|sem luz|n[aã]o tem energia|tem energia/i.test(textoConversa);
  const temBenfeitorias = /curral|galp[aã]o|galp\.|casa do pe[aã]o|casa sede|pasto|piscina|arrendad|nenhum|sem benfeitoria/i.test(textoConversa);

  if (temTipoRural && temArea && temLocalizacao && temAcesso && temAgua && temEnergia && temBenfeitorias) {
    console.log('[Session] Failsafe rural: todos os campos coletados, disparando laudo');
    return true;
  }

  return false;
}

module.exports = { getSession, addMessage, clearSession, isReadyToEvaluate };
