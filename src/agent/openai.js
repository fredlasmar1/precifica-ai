const { completar } = require('./llm');
const { SYSTEM_PROMPT } = require('./prompt');

// Inicializa de forma lazy para não quebrar na ausência da chave no boot
/**
 * Envia histórico para o GPT-4o e retorna a resposta do agente
 */
async function chat(history) {
  // Migrado do GPT-4o para o Claude Opus 5 (07/09/2026). O `temperature: 0.4`
  // que estava aqui NAO existe mais no Opus 5 — passar devolve 400. O controle
  // equivalente e `effort`, e para coleta de dados 'low' ja e deterministico.
  return completar({
    forte: true,
    maxTokens: 1000,
    effort: 'low',
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
  });
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

  const bruto = await completar({
    forte: true,
    maxTokens: 2000,   // obrigatorio no Claude; o JSON tem ~20 campos
    effort: 'low',     // extracao e tarefa deterministica, nao precisa raciocinar fundo
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
  "metragem": número (SOMENTE para casas e apartamentos: área CONSTRUÍDA em m², NÃO o lote. Se o usuário informar só o lote, pergunte a área construída. Para terrenos: área do terreno. Para rurais: converter alqueires goianos: 1 alq = 48400m²),
  "areaLote": número ou null (área do lote/terreno em m² para casas — informar se o usuário mencionar. Ex: casa de 150m² construídos em lote de 360m² → metragem=150, areaLote=360),
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
    // `temperature: 0` e `response_format: json_object` sairam: o primeiro
    // devolve 400 no Opus 5, o segundo nao existe na API do Claude. O JSON e
    // garantido pela instrucao do prompt + a limpeza abaixo.
  });

  try {
    // O modelo pode devolver o JSON dentro de cerca de codigo. Limpa antes de
    // parsear em vez de deixar o try engolir e devolver null — null aqui
    // significa "nao consegui extrair nada", e um crase perdido viraria isso.
    let txt = String(bruto || '').trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const i = txt.indexOf('{'), f = txt.lastIndexOf('}');
    if (i >= 0 && f > i) txt = txt.slice(i, f + 1);
    return JSON.parse(txt);
  } catch (e) {
    console.warn('[Extracao] JSON invalido:', e.message, '| inicio:', String(bruto || '').slice(0, 120));
    return null;
  }
}

module.exports = { chat, extractPropertyData };
