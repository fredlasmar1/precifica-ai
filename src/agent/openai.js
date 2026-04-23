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
  // Para extração de dados: usa SOMENTE mensagens do usuário
  // Mensagens do assistente (perguntas, laudos) NÃO entram — evita contaminação de sessão anterior
  const historyLimpo = history.filter(msg => msg.role === 'user');

  // Última mensagem do usuário — tem prioridade máxima para bairro e endereço
  const ultimaMsgUsuario = [...history].reverse().find(m => m.role === 'user')?.content || '';

  const extraction = await getClient().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `Extraia os dados do imóvel da conversa e retorne SOMENTE um JSON válido, sem markdown, sem explicação.

REGRA CRÍTICA: Para "bairro" e "endereco", use SOMENTE o que o usuário disse nas suas próprias mensagens.
NUNCA use bairros ou endereços que apareceram em laudos ou respostas anteriores do assistente.
A última mensagem do usuário tem prioridade absoluta.

Última mensagem do usuário: "${ultimaMsgUsuario.replace(/"/g, "'")}"

Formato exato:
{
  "tipo": "casa|apartamento|terreno|comercial|rural",
  "finalidade": "venda|aluguel",
  "cidade": "nome da cidade",
  "bairro": "nome do bairro ou localidade EXATAMENTE como o usuário informou",
  "endereco": "rua, rodovia ou referência se informado, ou null se não informado",
  "condominio": "nome do condomínio ou edifício se informado, ou null",
  "metragem": número (em m² — converta alqueires goianos: 1 alq = 48400m², ex: 3.5 alq = 169400),
  "quartos": número,
  "vagas": número,
  "diferenciais": ["item1", "item2"],
  "conservacao": "novo|bom|reformar",
  "subTipoRural": "chacara|sitio|fazenda|null (chacara: ate 5 alq, sitio: 5-20 alq, fazenda: acima de 20 alq)",
  "areaAlqueires": número ou null (alqueires goianos informados pelo usuário),
  "acessoAsfalto": true|false (se tem acesso direto pelo asfalto),
  "margemAsfalto": true|false (se a propriedade BEIRA a rodovia/asfalto, sem estrada de chão entre a propriedade e o asfalto),
  "temAgua": true|false (nascente, poço, córrego ou represa),
  "temEnergia": true|false (energia elétrica),
  "benfeitorias": ["casa sede", "casa do peão", "curral", "galpao", "piscina", "pomar", "pasto formado", "represa"] (liste as mencionadas),
  "rodoviaReferencia": "nome da rodovia se margeia asfalto, ex: GO-415, BR-153, ou null"
}`
      },
      ...historyLimpo
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
