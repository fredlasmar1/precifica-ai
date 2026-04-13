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

  const cacheKey = `perfil_v2_${cidadeNorm}`.toLowerCase().replace(/\s/g, '_');
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[Conhecimento] Cache hit: ${cidadeNorm}`);
    return cached;
  }

  console.log(`[Conhecimento] Pesquisando perfil imobiliário de ${cidadeNorm}-GO na internet...`);

  const prompt = `Pesquise informações REAIS e ATUAIS sobre o mercado imobiliário da cidade de ${cidadeNorm}, no estado de Goiás (GO), Brasil.

Preciso de um perfil completo para usar como contexto em avaliações imobiliárias. Pesquise nos portais imobiliários (ZAP, OLX, VivaReal, 62imóveis) e fontes locais.

Retorne as seguintes informações:

1. PERFIL DA CIDADE:
   - População, economia, posição no estado
   - Distância de capitais e cidades vizinhas
   - Principais atividades econômicas (industrial, comercial, agrícola)

2. MAPA COMPLETO DE BAIRROS — lista TODOS os bairros que encontrar, organizados por região/zona da cidade:
   - ZONA NORTE: quais bairros ficam, perfil de cada um
   - ZONA SUL: quais bairros ficam, perfil de cada um
   - ZONA LESTE: quais bairros ficam, perfil de cada um
   - ZONA OESTE: quais bairros ficam, perfil de cada um
   - CENTRO: quais bairros/setores compõem a região central
   - Para CADA bairro: diga se é residencial, comercial, industrial ou misto
   - Para CADA bairro: diga o nível (alto padrão, médio, popular)
   - Quais bairros fazem DIVISA entre si (vizinhança)
   - Exemplo: "Anápolis City faz divisa com o Centro e Jundiaí"

3. CONDOMÍNIOS FECHADOS:
   - Liste os principais condomínios fechados da cidade
   - Em qual bairro cada um está localizado
   - Perfil (alto padrão, médio)

4. RUAS E AVENIDAS mais importantes e valorizadas:
   - Avenidas principais e o que fica nelas (comércio, residências nobres)
   - Ruas valorizadas em bairros nobres
   - Vias de acesso (rodovias, anéis viários)

5. FAIXAS DE PREÇO POR M² — pesquise nos portais imobiliários (ZAP, OLX, VivaReal, 62imóveis, Chaves na Mão) anúncios REAIS e monte as faixas:
   a) TERRENOS/LOTES VAZIOS por região/bairro:
      - Alto padrão (ex: Jundiaí): R$ ???/m²
      - Centro: R$ ???/m²
      - Médio: R$ ???/m²
      - Popular: R$ ???/m²
   b) CASAS USADAS (revenda) por região/bairro
   c) CASAS NOVAS por região/bairro
   d) APARTAMENTOS NOVOS por região/bairro
   e) APARTAMENTOS USADOS por região/bairro
   f) GALPÕES/COMERCIAL (se houver)

6. PARTICULARIDADES DO MERCADO LOCAL:
   - Metragem mínima de lotes por bairro (ex: Jundiaí tem lotes a partir de 300m²)
   - Regiões industriais (DAIA, etc.) — NÃO confundir com residencial
   - Bairros em expansão / loteamentos novos
   - Bairros com muita oferta vs pouca oferta
   - Diferença de preço entre bairros vizinhos e por quê
   - Sazonalidade ou tendências recentes do mercado

7. ARMADILHAS COMUNS EM PESQUISA DE PREÇO:
   - Bairros com nomes iguais a cidades de outros estados
   - Bairros novos que portais ainda não têm bem catalogados
   - Anúncios que misturam tipos (casa anunciada como terreno, etc.)

MUITO IMPORTANTE: baseie-se em anúncios e dados REAIS que encontrar na internet. Pesquise em múltiplos portais. NÃO invente dados — se não encontrar informação sobre algum bairro, diga que não encontrou.`;

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
      max_tokens: 4000
    }, {
      timeout: 60000,
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
