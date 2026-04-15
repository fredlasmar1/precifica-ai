const axios = require('axios');
const db = require('./database');

/**
 * Pesquisa NA INTERNET o perfil imobiliário de uma cidade via Perplexity.
 * Salva no Postgres. Revalida a cada 7 dias.
 */
async function getConhecimentoLocal(cidade) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return '';

  const cidadeNorm = (cidade || '').trim();
  if (!cidadeNorm) return '';

  // Busca no Postgres
  const existente = await db.buscarConhecimentoCidade(cidadeNorm);
  if (existente && existente.dias_desde < 7) {
    console.log(`[Conhecimento] DB hit: ${cidadeNorm} (${Math.round(existente.dias_desde)} dias)`);
    return existente.perfil_geral;
  }

  console.log(`[Conhecimento] Pesquisando perfil de ${cidadeNorm}-GO na internet...`);

  const prompt = `Pesquise informações REAIS e ATUAIS sobre o mercado imobiliário da cidade de ${cidadeNorm}, no estado de Goiás (GO), Brasil.

Retorne as seguintes informações:

1. PERFIL DA CIDADE: população, economia, posição no estado

2. MAPA DE BAIRROS — liste os bairros organizados por zona:
   - Para cada bairro: perfil (residencial/comercial/industrial), nível (alto/médio/popular)
   - Quais bairros fazem DIVISA entre si

3. CONDOMÍNIOS FECHADOS: principais, em qual bairro

4. RUAS E AVENIDAS mais valorizadas

5. FAIXAS DE PREÇO POR M² pesquisadas nos portais:
   a) Terrenos/lotes vazios por bairro
   b) Casas usadas por bairro
   c) Casas novas por bairro
   d) Apartamentos novos e usados por bairro

6. PARTICULARIDADES: metragem mínima de lotes, zonas industriais, tendências

IMPORTANTE: baseie-se em dados REAIS da internet.`;

  try {
    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar',
      messages: [
        { role: 'system', content: 'Pesquisador de mercado imobiliário brasileiro. Dados reais, factuais e organizados.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 2000
    }, {
      timeout: 60000,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });

    const conhecimento = response.data.choices[0].message.content;
    const citations = response.data.citations || [];

    // Salva no Postgres
    await db.salvarConhecimentoCidade(cidadeNorm, conhecimento, 'Perplexity', citations.slice(0, 10));
    console.log(`[Conhecimento] Perfil de ${cidadeNorm} salvo no DB (${conhecimento.length} chars)`);

    return conhecimento;
  } catch (err) {
    console.error(`[Conhecimento] Erro:`, err.response?.data || err.message);
    // Se tem dado antigo no DB, usa
    if (existente) return existente.perfil_geral;
    return '';
  }
}

module.exports = { getConhecimentoLocal };
