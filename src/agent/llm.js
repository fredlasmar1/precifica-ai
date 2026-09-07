const Anthropic = require('@anthropic-ai/sdk');

/**
 * CAMADA ÚNICA DE LLM — Anthropic Claude.
 *
 * O sistema tinha 14 chamadas espalhadas ao GPT-4o/4o-mini, cada uma montando o
 * request na mão. Passar todas por aqui deixa a troca de modelo, o ajuste de
 * custo e o tratamento de erro num lugar só.
 *
 * ⚠️ TRÊS DIFERENÇAS que quebram se ignoradas na vinda do OpenAI:
 *
 * 1. `system` é PARÂMETRO SEPARADO, não uma mensagem com role 'system'. Mandar
 *    como mensagem faz o Claude tratar instrução de operador como fala do
 *    usuário.
 * 2. `max_tokens` é OBRIGATÓRIO — sem ele a chamada falha.
 * 3. `temperature` foi REMOVIDO no Opus 5 e devolve **400**. O código antigo
 *    passava temperature em quase toda chamada; aqui ela é simplesmente
 *    ignorada, e o controle equivalente é `effort`.
 *
 * A resposta também muda de forma: vem em `content[]`, um array de blocos —
 * não `choices[0].message.content`. Só os blocos de texto interessam.
 */

const MODELO_FORTE  = 'claude-opus-5';    // onde estava gpt-4o: extração, matrícula, conversa
const MODELO_RAPIDO = 'claude-haiku-4-5'; // onde estava gpt-4o-mini: pareceres curtos

let _client = null;
function getClient() {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada');
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

/**
 * Aceita o MESMO formato que o código já usava com a OpenAI (lista de mensagens
 * com o system embutido) e devolve texto. Assim cada arquivo troca uma chamada,
 * não a lógica inteira.
 *
 * @param {object} p
 *   messages   [{role:'system'|'user'|'assistant', content}] — o system é extraído
 *   forte      true → Opus 5 (raciocínio); false → Haiku 4.5 (texto curto, barato)
 *   maxTokens  teto da resposta (obrigatório na API; default generoso)
 *   effort     'low' | 'medium' | 'high' — substitui o antigo temperature
 */
/**
 * Converte um bloco de conteudo do formato OpenAI para o do Claude.
 * A imagem e o caso que mais quebra: OpenAI usa
 *   { type: 'image_url', image_url: { url } }
 * e o Claude usa
 *   { type: 'image', source: { type: 'url', url } }
 * Passar o formato antigo nao da erro claro — o modelo simplesmente nao ve a foto.
 */
function blocoParaClaude(b) {
  if (!b || typeof b !== 'object') return { type: 'text', text: String(b ?? '') };
  if (b.type === 'image_url') {
    const url = String(b.image_url?.url || b.image_url || '');

    // ⚠️ AS IMAGENS DESTE SISTEMA SAO dataURL, NAO LINK.
    //
    // A matricula e as fotos chegam do navegador como
    // "data:image/jpeg;base64,...". A OpenAI aceitava isso no mesmo campo do
    // link; a Anthropic NAO — devolve 400 "Only HTTPS URLs are supported" e
    // exige source.type = 'base64' com o media_type separado.
    //
    // Sem esta conversao a leitura de matricula ficou quebrada desde a
    // migracao, e de um jeito que nao aparecia: quem envia a foto recebe um
    // erro generico, nao "nao consegui ver a imagem".
    const m = url.match(/^data:([^;,]+);base64,(.+)$/s);
    if (m) {
      return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
    }
    return { type: 'image', source: { type: 'url', url } };
  }
  if (b.type === 'text') return { type: 'text', text: String(b.text ?? '') };
  return b;   // ja esta no formato do Claude
}

async function completar({ messages = [], forte = false, maxTokens = 1024, effort = 'low' }) {
  // O system sai da lista e vira parâmetro próprio.
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const conversa = messages
    .filter((m) => m.role !== 'system' && m.content != null)
    .filter((m) => (Array.isArray(m.content) ? m.content.length : String(m.content).trim() !== ''))
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: Array.isArray(m.content) ? m.content.map(blocoParaClaude) : String(m.content),
    }));

  // A API exige que a conversa comece com 'user'.
  while (conversa.length && conversa[0].role !== 'user') conversa.shift();
  if (!conversa.length) throw new Error('nenhuma mensagem de usuário para enviar');

  const req = {
    model: forte ? MODELO_FORTE : MODELO_RAPIDO,
    max_tokens: maxTokens,
    messages: conversa,
  };
  if (system) req.system = system;
  // effort troca o antigo temperature: 'low' para texto curto e determinístico,
  // que é o caso da maioria dos pareceres deste sistema.
  if (forte) req.output_config = { effort };

  const resposta = await getClient().messages.create(req);

  // Segurança: a resposta pode vir recusada (política). Nunca ler content sem checar.
  if (resposta.stop_reason === 'refusal') {
    throw new Error(`recusado pelo modelo (${resposta.stop_details?.category || 'sem categoria'})`);
  }

  // Teto estourado = parecer cortado no meio da frase. Isso NAO da erro: a
  // chamada devolve 200 e o texto truncado segue para o cliente como se
  // estivesse pronto. Os tetos deste sistema vieram do gpt-4o-mini e o mesmo
  // texto em portugues gasta mais tokens aqui, entao o corte precisa gritar.
  if (resposta.stop_reason === 'max_tokens') {
    const quem = (system || '').trim().split(/\s+/).slice(0, 6).join(' ') || 'sem system';
    console.warn(`[LLM] resposta CORTADA no teto de ${maxTokens} tokens — "${quem}..." (aumente maxTokens)`);
  }

  return resposta.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** Atalho para os pareceres curtos que antes usavam gpt-4o-mini. */
async function parecer({ sistema, pergunta, maxTokens = 400 }) {
  return completar({
    forte: false,
    maxTokens,
    messages: [
      { role: 'system', content: sistema },
      { role: 'user', content: pergunta },
    ],
  });
}

module.exports = { completar, parecer, MODELO_FORTE, MODELO_RAPIDO };
