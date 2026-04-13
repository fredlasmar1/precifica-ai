const OpenAI = require('openai');
const { SYSTEM_PROMPT } = require('./prompt');

// Inicializa de forma lazy para não quebrar na ausência da chave no boot
let _openai = null;
function getClient() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

/**
 * Envia histórico para o GPT-4o e retorna a resposta do agente
 */
async function chat(history) {
  const response = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history
    ],
    temperature: 0.4, // Mais determinístico para dados financeiros
    max_tokens: 1000
  });

  return response.choices[0].message.content;
}

/**
 * Extrai dados estruturados do imóvel a partir do histórico
 */
async function extractPropertyData(history) {
  const extraction = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `Extraia os dados do imóvel da conversa e retorne SOMENTE um JSON válido, sem markdown, sem explicação.
Formato exato:
{
  "tipo": "casa|apartamento|terreno|comercial",
  "finalidade": "venda|aluguel",
  "cidade": "nome da cidade",
  "bairro": "nome do bairro",
  "endereco": "rua e número se informado, ou null se não informado",
  "metragem": número,
  "quartos": número,
  "vagas": número,
  "diferenciais": ["item1", "item2"],
  "conservacao": "novo|bom|reformar"
}`
      },
      ...history
    ],
    temperature: 0,
    response_format: { type: 'json_object' }
  });

  try {
    return JSON.parse(extraction.choices[0].message.content);
  } catch {
    return null;
  }
}

module.exports = { chat, extractPropertyData };
