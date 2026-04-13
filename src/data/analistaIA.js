const axios = require('axios');
const NodeCache = require('node-cache');

// Cache de 12h — mesma consulta não precisa ir à internet de novo
const cache = new NodeCache({ stdTTL: 43200 });

/**
 * Usa Perplexity (modelo sonar) para pesquisar preços REAIS na internet.
 *
 * Diferente do GPT-4o que chuta baseado em treinamento antigo,
 * a Perplexity faz busca em tempo real nos portais imobiliários
 * (ZAP, OLX, VivaReal, etc.) e retorna dados com fontes.
 *
 * Retorna { precoMedioM2, faixaMinM2, faixaMaxM2, confianca, analise, fontes }
 */
async function estimarPrecoComIA(dadosImovel) {
  const { tipo, finalidade, cidade, bairro, metragem, quartos, vagas, diferenciais, conservacao } = dadosImovel;

  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    console.warn('[Perplexity] PERPLEXITY_API_KEY não configurada');
    return null;
  }

  const cacheKey = `pplx_${tipo}_${finalidade}_${cidade}_${bairro}_${quartos}_${metragem}`
    .toLowerCase().replace(/\s/g, '_');

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const difsTexto = Array.isArray(diferenciais) && diferenciais.length > 0
    ? diferenciais.join(', ')
    : 'sem diferenciais especiais';

  const prompt = `Pesquise o preço REAL por metro quadrado de ${tipo}s para ${finalidade} no bairro ${bairro}, ${cidade}, Goiás, Brasil.

Características do imóvel que estou avaliando:
- ${metragem}m², ${quartos} quartos, ${vagas} vagas
- Diferenciais: ${difsTexto}
- Conservação: ${conservacao}

INSTRUÇÕES OBRIGATÓRIAS:
1. Consulte sites de imóveis reais: ZAP Imóveis, OLX, VivaReal, Imovelweb, Chaves na Mão, QuintoAndar
2. Busque anúncios reais de ${tipo}s ${finalidade === 'aluguel' ? 'para alugar' : 'à venda'} no bairro ${bairro} em ${cidade}-GO
3. Calcule a MÉDIA de preço por m² dos anúncios encontrados
4. Se não encontrar anúncios nesse bairro específico, busque em bairros similares de ${cidade}
5. Seja preciso — use os preços DOS ANÚNCIOS, não estimativas genéricas

Retorne SOMENTE um JSON válido neste formato exato:
{
  "precoMedioM2": número (média de preço/m² dos anúncios encontrados),
  "faixaMinM2": número (menor preço/m² encontrado),
  "faixaMaxM2": número (maior preço/m² encontrado),
  "anunciosAnalisados": número (quantos anúncios você consultou),
  "confianca": "alta" ou "media" ou "baixa",
  "raciocinio": "explicação breve com os preços que encontrou e de onde vieram"
}`;

  try {
    console.log(`[Perplexity] Pesquisando preços reais: ${tipo} ${finalidade} ${bairro}, ${cidade}...`);

    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'Você é um pesquisador de mercado imobiliário. Pesquise preços REAIS em portais de imóveis brasileiros. Retorne SOMENTE JSON válido, sem markdown, sem texto extra.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 800
    }, {
      timeout: 30000,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    const content = response.data.choices[0].message.content;

    // Perplexity pode retornar JSON dentro de code block
    const jsonStr = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const resultado = JSON.parse(jsonStr);

    // Validação de sanidade
    if (!resultado.precoMedioM2 || resultado.precoMedioM2 <= 0) {
      console.warn('[Perplexity] Resposta inválida:', resultado);
      return null;
    }

    const min = finalidade === 'aluguel' ? 5 : 500;
    const max = finalidade === 'aluguel' ? 300 : 50000;
    if (resultado.precoMedioM2 < min || resultado.precoMedioM2 > max) {
      console.warn(`[Perplexity] Preço/m² fora da faixa de sanidade (${min}-${max}):`, resultado.precoMedioM2);
      return null;
    }

    // Extrai fontes citadas pela Perplexity (se disponíveis)
    const citations = response.data.citations || [];

    const analise = {
      precoMedioM2: Math.round(resultado.precoMedioM2),
      faixaMinM2: Math.round(resultado.faixaMinM2 || resultado.precoMedioM2 * 0.85),
      faixaMaxM2: Math.round(resultado.faixaMaxM2 || resultado.precoMedioM2 * 1.15),
      anunciosAnalisados: resultado.anunciosAnalisados || 0,
      confianca: resultado.confianca || 'media',
      raciocinio: resultado.raciocinio || '',
      fonte: 'Pesquisa de mercado (Perplexity)',
      citacoes: citations.slice(0, 5)
    };

    console.log(`[Perplexity] Resultado: R$ ${analise.precoMedioM2}/m² (${analise.confianca}) — ${analise.anunciosAnalisados} anúncios`);

    cache.set(cacheKey, analise);
    return analise;

  } catch (err) {
    console.error('[Perplexity] Erro:', err.response?.data || err.message);
    return null;
  }
}

module.exports = { estimarPrecoComIA };
