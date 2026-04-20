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

  const prompt = `Pesquise informações REAIS e ATUAIS sobre o mercado imobiliário de ${cidadeNorm}-GO (estado de Goiás, Brasil). ATENÇÃO: ${cidadeNorm} fica em GOIÁS, não confunda com cidades homônimas de outros estados.

Retorne as seguintes informações:

1. PERFIL DA CIDADE: população, economia (destaque para DAIA se for Anápolis), posição no estado

2. MAPA DE BAIRROS — liste organizados por perfil:
   - Alto padrão e condomínios fechados: quais são, localização
   - Médio-alto e médio: quais são
   - Popular: quais são
   - Quais bairros fazem divisa entre si

3. CONDOMÍNIOS FECHADOS: nome, bairro, padrão (alto/médio), lotes ou casas

4. RUAS E AVENIDAS mais valorizadas para imóveis comerciais e residenciais

5. FAIXAS DE PREÇO POR M² (pesquise nos portais OLX, ZAP, VivaReal, 62imóveis, Imovelweb):
   a) Terrenos/lotes em condomínios fechados
   b) Terrenos/lotes abertos por bairro
   c) Casas novas por bairro
   d) Casas usadas por bairro
   e) Apartamentos novos e usados
   f) Galpões/comercial

6. PARTICULARIDADES: lote mínimo do município, DAIA/industrial, tendências de expansão da cidade, bairros em valorização

Fonte obrigatória: portais imobiliários REAIS com dados atuais de ${cidadeNorm}-GO.`;

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
