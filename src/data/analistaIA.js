const OpenAI = require('openai');
const NodeCache = require('node-cache');

// Cache de 12h — o GPT-4o não precisa ser chamado toda hora para a mesma consulta
const cache = new NodeCache({ stdTTL: 43200 });

let _openai = null;
function getClient() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

/**
 * Usa GPT-4o como analista de mercado imobiliário.
 * Chamado quando NENHUM portal retornou dados de comparativos.
 *
 * O GPT-4o tem conhecimento extenso sobre o mercado imobiliário
 * brasileiro (preços por cidade, bairro, tipologia) e consegue
 * estimar faixas de preço/m² de forma muito mais inteligente
 * do que tabelas estáticas.
 *
 * Retorna { precoMedioM2, faixaMinM2, faixaMaxM2, confianca, analise }
 */
async function estimarPrecoComIA(dadosImovel) {
  const { tipo, finalidade, cidade, bairro, metragem, quartos, vagas, diferenciais, conservacao } = dadosImovel;

  const cacheKey = `ia_${tipo}_${finalidade}_${cidade}_${bairro}_${quartos}_${conservacao}`
    .toLowerCase().replace(/\s/g, '_');

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const prompt = `Você é um analista de mercado imobiliário especializado em Goiás, Brasil.

Com base no seu conhecimento do mercado imobiliário atual, estime o PREÇO POR METRO QUADRADO para este imóvel:

- Tipo: ${tipo}
- Finalidade: ${finalidade}
- Cidade: ${cidade}, GO
- Bairro: ${bairro}
- Metragem: ${metragem}m²
- Quartos: ${quartos}
- Vagas: ${vagas}
- Diferenciais: ${Array.isArray(diferenciais) ? diferenciais.join(', ') : 'nenhum'}
- Conservação: ${conservacao}

INSTRUÇÕES:
1. Considere o perfil socioeconômico do bairro "${bairro}" em ${cidade}
2. Compare com bairros similares na mesma cidade
3. Leve em conta se é ${finalidade} (valores de aluguel são MUITO menores que venda)
4. Para ALUGUEL, o preço/m² típico em GO fica entre R$10-50/m². Para VENDA, entre R$2.000-12.000/m²
5. Considere os diferenciais e estado de conservação no ajuste
6. Seja realista com os preços de ${cidade} — não use referências de capitais como SP ou RJ

Retorne SOMENTE um JSON válido neste formato:
{
  "precoMedioM2": número (sua melhor estimativa de preço por m²),
  "faixaMinM2": número (limite inferior razoável),
  "faixaMaxM2": número (limite superior razoável),
  "confianca": "alta|media|baixa",
  "raciocinio": "explicação breve de 1-2 frases do porquê desse valor"
}`;

  try {
    const response = await getClient().chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2, // Baixo para consistência em valores financeiros
      max_tokens: 500,
      response_format: { type: 'json_object' }
    });

    const resultado = JSON.parse(response.choices[0].message.content);

    // Validação básica — o modelo pode alucinar
    if (!resultado.precoMedioM2 || resultado.precoMedioM2 <= 0) {
      console.warn('[AnalistaIA] Resposta inválida:', resultado);
      return null;
    }

    // Sanidade: para venda, m² > 500 e < 30000. Para aluguel, m² > 5 e < 200.
    const min = finalidade === 'aluguel' ? 5 : 500;
    const max = finalidade === 'aluguel' ? 200 : 30000;
    if (resultado.precoMedioM2 < min || resultado.precoMedioM2 > max) {
      console.warn(`[AnalistaIA] Preço/m² fora da faixa de sanidade (${min}-${max}):`, resultado.precoMedioM2);
      return null;
    }

    const analise = {
      precoMedioM2: Math.round(resultado.precoMedioM2),
      faixaMinM2: Math.round(resultado.faixaMinM2 || resultado.precoMedioM2 * 0.85),
      faixaMaxM2: Math.round(resultado.faixaMaxM2 || resultado.precoMedioM2 * 1.15),
      confianca: resultado.confianca || 'media',
      raciocinio: resultado.raciocinio || '',
      fonte: 'Análise IA (GPT-4o)'
    };

    cache.set(cacheKey, analise);
    return analise;

  } catch (err) {
    console.error('[AnalistaIA] Erro:', err.message);
    return null;
  }
}

module.exports = { estimarPrecoComIA };
