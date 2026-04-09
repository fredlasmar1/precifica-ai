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
 * Verifica se o agente já coletou todos os dados e está pronto para avaliar
 */
function isReadyToEvaluate(history) {
  // Checa se o assistente sinalizou que vai consultar o mercado
  const lastAssistant = [...history]
    .reverse()
    .find(m => m.role === 'assistant');
  
  if (!lastAssistant) return false;
  
  return lastAssistant.content.includes('consultando o mercado') ||
         lastAssistant.content.includes('aguarde um momento');
}

module.exports = { getSession, addMessage, clearSession, isReadyToEvaluate };
