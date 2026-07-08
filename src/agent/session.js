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
    lastAssistant.content.includes('aguarde um momento')
  )) return true;

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
