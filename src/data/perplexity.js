const axios = require('axios');

/**
 * CAMADA ÚNICA DA PERPLEXITY.
 *
 * O sistema tinha 16 chamadas soltas montando o request na mão. Cada uma
 * PEDIA no prompt ("use portais reais, não invente") e nenhuma usava os
 * parâmetros de busca da API. Pedir educadamente não restringe nada.
 *
 * Medido em 07/09/2026, mesma pergunta (apartamento à venda no Jundiaí):
 *
 *   sem filtro ......... 18 fontes, US$ 0,0158 — e trouxe casamineira.com.br,
 *                        lugarcerto.com.br e lopes.com.br: imobiliárias de
 *                        MINAS GERAIS numa consulta sobre Anápolis.
 *   com PORTAIS ........ 20 fontes, US$ 0,0137, todas em portal real.
 *   com recency=month .. os preços caíram de 10 para 4.
 *
 * Daí as duas regras desta camada:
 *
 *  • search_domain_filter SÓ em busca de anúncio imobiliário. Em busca de
 *    CNPJ ou de empresa ele atrapalha — o dado não está em portal de imóvel.
 *  • search_recency_filter NUNCA. Anúncio de imóvel não é notícia: um anúncio
 *    bom fica meses no ar e é exatamente ele que o filtro descarta. Para saber
 *    a idade do dado existe `last_updated` em cada resultado, que não custa
 *    busca nenhuma.
 */

// Portais que realmente devolveram anúncio de Anápolis no teste. 62imoveis é
// regional de Goiás e foi o que mais entregou. QuintoAndar ficou de fora: só
// apareceu quando o recency o favoreceu, e trouxe menos preço.
const PORTAIS_IMOVEIS = [
  'olx.com.br',
  'zapimoveis.com.br',
  'vivareal.com.br',
  'imovelweb.com.br',
  'chavesnamao.com.br',
  '62imoveis.com.br',
  'netimoveis.com',
  'wimoveis.com.br',
];

let gastoSessaoUSD = 0;

/**
 * @param {object} p
 *   sistema     texto do role:'system'
 *   pergunta    texto do role:'user'
 *   modelo      'sonar-pro' (padrão) ou 'sonar' (mais barato, resposta curta)
 *   maxTokens   teto da resposta
 *   portais     true → restringe a busca aos portais de imóvel (só p/ anúncio)
 *   dominios    lista própria de domínios, se for outro tipo de fonte
 *   tag         nome que aparece no log
 * @returns {{texto:string, fontes:string[], resultados:object[], custoUSD:number}}
 */
async function pesquisar({
  sistema, pergunta, modelo = 'sonar-pro', maxTokens = 1200,
  portais = false, dominios = null, tag = 'Perplexity', timeout = 60000,
}) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY não configurada');

  const body = {
    model: modelo,
    messages: [
      ...(sistema ? [{ role: 'system', content: sistema }] : []),
      { role: 'user', content: pergunta },
    ],
    temperature: 0.1,
    max_tokens: maxTokens,
  };

  const filtro = dominios || (portais ? PORTAIS_IMOVEIS : null);
  if (filtro && filtro.length) body.search_domain_filter = filtro;

  const { data } = await axios.post('https://api.perplexity.ai/chat/completions', body, {
    timeout,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  });

  const texto = String(data?.choices?.[0]?.message?.content || '');
  const fontes = Array.isArray(data?.citations) ? data.citations : [];

  // search_results traz o SNIPPET da página e o last_updated. É o dado bruto
  // do anúncio; o texto do modelo é só o resumo dele. Quem quiser conferir um
  // preço sem depender do resumo olha aqui.
  const resultados = (Array.isArray(data?.search_results) ? data.search_results : [])
    .map((r) => ({
      url: r.url || null,
      titulo: r.title || null,
      snippet: r.snippet || null,
      data: r.date || null,
      atualizado: r.last_updated || null,
    }));

  const custoUSD = Number(data?.usage?.cost?.total_cost) || 0;
  gastoSessaoUSD += custoUSD;
  console.log(
    `[${tag}] ${modelo}${filtro ? ' (portais)' : ''} · ${fontes.length} fontes · ` +
    `US$ ${custoUSD.toFixed(4)} · acumulado US$ ${gastoSessaoUSD.toFixed(3)}`
  );

  return { texto, fontes, resultados, custoUSD };
}

/** Tira o code block que a Perplexity insiste em pôr em volta do JSON. */
function limparJSON(texto) {
  return String(texto || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
}

/** Anúncio mais recente da amostra, para dizer a idade do dado sem chutar. */
function maisRecente(resultados) {
  const datas = (resultados || []).map((r) => r.atualizado || r.data).filter(Boolean).sort();
  return datas.length ? datas[datas.length - 1] : null;
}

module.exports = { pesquisar, limparJSON, maisRecente, PORTAIS_IMOVEIS, gasto: () => gastoSessaoUSD };
