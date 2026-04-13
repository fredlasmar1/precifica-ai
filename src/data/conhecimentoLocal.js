const axios = require('axios');
const NodeCache = require('node-cache');

// Cache de 7 dias — o perfil de uma cidade não muda toda semana
const cache = new NodeCache({ stdTTL: 604800 });

/**
 * Pesquisa NA INTERNET o perfil imobiliário de uma cidade via Perplexity.
 * Retorna texto com: bairros valorizados, ruas nobres, faixas de preço
 * por tipo, contexto econômico.
 *
 * Esse conhecimento é construído AUTOMATICAMENTE pela IA pesquisando
 * em tempo real — não é dado escrito manualmente.
 *
 * É cacheado por 7 dias e injetado no prompt de pesquisa de preço
 * para a Perplexity ter contexto local ao buscar comparativos.
 */
async function getConhecimentoLocal(cidade) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return '';

  const cidadeNorm = (cidade || '').trim();
  if (!cidadeNorm) return '';

  const cacheKey = `perfil_${cidadeNorm}`.toLowerCase().replace(/\s/g, '_');
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[Conhecimento] Cache hit: ${cidadeNorm}`);
    return cached;
  }

  console.log(`[Conhecimento] Pesquisando perfil imobiliário de ${cidadeNorm}-GO na internet...`);

  const prompt = `Pesquise informações REAIS e ATUAIS sobre o mercado imobiliário da cidade de ${cidadeNorm}, no estado de Goiás (GO), Brasil.

Preciso de um perfil completo para usar como contexto em avaliações imobiliárias. Pesquise nos portais imobiliários (ZAP, OLX, VivaReal, 62imóveis) e fontes locais.

Retorne as seguintes informações:

1. PERFIL DA CIDADE: população, economia, posição no estado, distância de capitais

2. CLASSIFICAÇÃO DOS BAIRROS por faixa de valor (do mais caro ao mais barato):
   - Bairros de ALTO PADRÃO (e por que são caros)
   - Bairros de MÉDIO PADRÃO
   - Bairros POPULARES (mais baratos)
   - Para cada bairro, descreva o perfil (residencial, comercial, condomínios, etc.)

3. RUAS E AVENIDAS mais valorizadas da cidade (se encontrar essa informação)

4. FAIXAS DE PREÇO POR M² observadas nos portais (pesquise anúncios reais):
   - Terrenos/lotes vazios: faixa de preço/m² por perfil de bairro
   - Casas usadas/revenda: faixa de preço/m² por perfil de bairro
   - Casas novas: faixa de preço/m² por perfil de bairro
   - Apartamentos novos: faixa de preço/m² por perfil de bairro
   - Apartamentos usados: faixa de preço/m² por perfil de bairro

5. PARTICULARIDADES do mercado local:
   - Bairros com lotes grandes (mínimo de metragem)
   - Regiões industriais ou comerciais (não confundir com residencial)
   - Tendências de valorização ou desvalorização
   - Qualquer informação relevante para precificação

IMPORTANTE: baseie-se em anúncios e dados REAIS que encontrar na internet, não em estimativas genéricas.`;

  try {
    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'Você é um pesquisador de mercado imobiliário brasileiro. Pesquise dados reais na internet e retorne informações detalhadas e factuais. Retorne em texto corrido organizado por seções.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 2000
    }, {
      timeout: 45000,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    const conhecimento = response.data.choices[0].message.content;
    const citations = response.data.citations || [];

    // Monta o contexto com fontes
    let resultado = `PERFIL IMOBILIÁRIO DE ${cidadeNorm.toUpperCase()}-GO (pesquisado automaticamente na internet):\n\n`;
    resultado += conhecimento;
    if (citations.length > 0) {
      resultado += `\n\nFontes consultadas: ${citations.slice(0, 5).join(', ')}`;
    }
    resultado += `\n\nUse este perfil para VALIDAR os resultados da pesquisa de preço. Se um preço encontrado estiver muito fora das faixas acima, desconfie — pode ser imóvel do tipo errado ou de outra cidade.`;

    console.log(`[Conhecimento] Perfil de ${cidadeNorm} obtido (${conhecimento.length} chars), cacheando por 7 dias`);
    cache.set(cacheKey, resultado);
    return resultado;

  } catch (err) {
    console.error(`[Conhecimento] Erro ao pesquisar ${cidadeNorm}:`, err.response?.data || err.message);
    return '';
  }
}

module.exports = { getConhecimentoLocal };
