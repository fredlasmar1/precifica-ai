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
 * Critério secundário (failsafe rural): usuário forneceu área + localização + acesso.
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

  // Critério 2 (failsafe): verifica se tem campos mínimos na conversa para rural
  // Evita que o GPT responda com preços inventados sem passar pelo Perplexity
  const textoConversa = history.map(m => m.content).join(' ').toLowerCase();
  const temTipoRural = /ch[aá]cara|s[ií]tio|fazenda|rural/i.test(textoConversa);
  if (!temTipoRural) return false;

  const temArea = /\d+[\.,]?\d*\s*(alqueires?|alq\.?|hectares?|ha)/i.test(textoConversa);
  const temLocalizacao = /goi[aâ]n[aá]polis|an[aá]polis|goi[aâ]nia|go-\d+|br-\d+|rodovia|munic/i.test(textoConversa);
  const temAcesso = /asfalto|estrada|ch[aã]o|rodovia|go-|br-/i.test(textoConversa);

  if (temTipoRural && temArea && (temLocalizacao || temAcesso)) {
    console.log('[Session] Failsafe rural: campos mínimos detectados, disparando laudo');
    return true;
  }

  return false;
}

module.exports = { getSession, addMessage, clearSession, isReadyToEvaluate };
