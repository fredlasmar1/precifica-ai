const axios = require('axios');
const NodeCache = require('node-cache');
const { getConhecimentoLocal } = require('./conhecimentoLocal');

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
    : 'nenhum diferencial especial';

  // Faixa de metragem: buscar imóveis com tamanho similar (±30%)
  const metMin = Math.round(metragem * 0.7);
  const metMax = Math.round(metragem * 1.3);

  const conservacaoLabel = {
    'novo': 'NOVOS ou na planta',
    'bom': 'em BOM ESTADO (usados/revenda)',
    'reformar': 'que PRECISAM DE REFORMA'
  };
  const estadoFiltro = conservacaoLabel[conservacao] || 'em bom estado';

  const finalidadeLabel = finalidade === 'aluguel' ? 'para ALUGAR' : 'à VENDA';

  // Busca contexto local da cidade (pesquisado na internet, cacheado 7 dias)
  // Limita a 3000 chars para não estourar o prompt e cortar a resposta JSON
  let contextoLocal = await getConhecimentoLocal(cidade);
  if (contextoLocal.length > 3000) {
    contextoLocal = contextoLocal.slice(0, 3000) + '\n[...contexto resumido por limite de tamanho]';
  }

  // Descrição precisa do que buscar por tipo
  const isTerreno = tipo === 'terreno';
  const isCasa = tipo === 'casa';
  const isApto = tipo === 'apartamento';

  let descricaoTipo;
  if (isTerreno) {
    descricaoTipo = `LOTES ou TERRENOS vazios (SEM construção) ${finalidadeLabel}. NÃO inclua casas, apartamentos ou qualquer imóvel construído. Apenas terrenos/lotes vazios para construir.`;
  } else if (isCasa) {
    descricaoTipo = `CASAS ${conservacao === 'novo' ? 'NOVAS' : 'de REVENDA (usadas)'} ${finalidadeLabel}. NÃO inclua terrenos, apartamentos ou lotes. Apenas casas construídas.`;
  } else if (isApto) {
    descricaoTipo = `APARTAMENTOS ${conservacao === 'novo' ? 'NOVOS ou na planta' : 'de REVENDA (usados)'} ${finalidadeLabel}. NÃO inclua casas, terrenos ou lotes.`;
  } else {
    descricaoTipo = `${tipo}s ${finalidadeLabel}`;
  }

  const prompt = `Preciso que você pesquise anúncios REAIS de imóveis para fazer uma análise comparativa de mercado.

IMÓVEL QUE ESTOU AVALIANDO:
- Tipo: ${tipo}
- Finalidade: ${finalidade}
- Bairro: ${bairro}, ${cidade} - GO (estado de Goiás, Brasil)
- Metragem: ${metragem}m²
${!isTerreno ? `- Quartos: ${quartos} | Vagas: ${vagas}` : '- É um terreno/lote vazio, sem construção'}
- Estado: ${conservacao}
- Diferenciais: ${difsTexto}

O QUE BUSCAR:
${descricaoTipo}

FILTROS OBRIGATÓRIOS (comparação justa — maçã com maçã):
1. Busque SOMENTE no bairro ${bairro} em ${cidade}-GO (ou bairro vizinho de perfil idêntico se não achar suficientes)
2. Busque SOMENTE imóveis com área entre ${metMin}m² e ${metMax}m² (similar ao avaliado)
${!isTerreno ? `3. Busque SOMENTE imóveis ${estadoFiltro} — não misture novos com usados` : '3. SOMENTE terrenos/lotes VAZIOS — se um anúncio menciona casa, sobrado ou construção, IGNORE'}
4. A cidade é ${cidade} no estado de GOIÁS (GO) — não confunda com cidades homônimas em outros estados
5. Busque entre 5 e 10 anúncios que atendam TODOS os filtros acima
6. Para cada anúncio, calcule o preço por m² (preço total ÷ área do ${isTerreno ? 'terreno' : 'imóvel'})

SITES PARA CONSULTAR: OLX, ZAP Imóveis, VivaReal, Imovelweb, Chaves na Mão, 62imóveis, QuintoAndar

${contextoLocal}

RETORNE SOMENTE um JSON válido neste formato:
{
  "comparativos": [
    {"area": número_m2, "preco": número_reais, "precoM2": número, "fonte": "nome do site", "detalhe": "breve descrição"}
  ],
  "precoMedioM2": número (média de preço/m² dos comparativos),
  "faixaMinM2": número (menor preço/m² encontrado),
  "faixaMaxM2": número (maior preço/m² encontrado),
  "anunciosAnalisados": número,
  "confianca": "alta" se achou 5+ imóveis com filtros exatos, "media" se achou 3-4, "baixa" se menos,
  "raciocinio": "resumo dos anúncios encontrados, com preços e fontes"
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
      max_tokens: 2000
    }, {
      timeout: 60000,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    const content = response.data.choices[0].message.content;

    // Perplexity pode retornar JSON dentro de code block
    let jsonStr = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    // Tenta parsear; se falhar (JSON truncado), tenta reparar
    let resultado;
    try {
      resultado = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.warn('[Perplexity] JSON incompleto, tentando reparar...');
      resultado = repararJSON(jsonStr);
      if (!resultado) {
        console.error('[Perplexity] Não foi possível reparar o JSON:', parseErr.message);
        console.error('[Perplexity] Conteúdo recebido:', content.slice(0, 500));
        return null;
      }
    }

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
      comparativos: resultado.comparativos || [],
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

/**
 * Tenta reparar JSON truncado (quando max_tokens corta no meio).
 * Estratégia: fecha arrays/objetos abertos e tenta parsear.
 */
function repararJSON(str) {
  try {
    // Remove trailing incompleto (string cortada, vírgula pendente)
    let s = str.replace(/,\s*$/, '').replace(/,\s*\]/, ']').replace(/,\s*\}/, '}');

    // Conta chaves/colchetes abertos e fecha os que faltam
    let opens = 0, opensArr = 0;
    for (const c of s) {
      if (c === '{') opens++;
      else if (c === '}') opens--;
      else if (c === '[') opensArr++;
      else if (c === ']') opensArr--;
    }

    // Se tem string aberta, fecha
    const lastQuote = s.lastIndexOf('"');
    const quoteCount = (s.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      s = s.slice(0, lastQuote + 1);
      // Reconta
      opens = 0; opensArr = 0;
      for (const c of s) {
        if (c === '{') opens++;
        else if (c === '}') opens--;
        else if (c === '[') opensArr++;
        else if (c === ']') opensArr--;
      }
    }

    // Remove vírgula pendente de novo após corte
    s = s.replace(/,\s*$/, '');

    // Fecha o que falta
    while (opensArr > 0) { s += ']'; opensArr--; }
    while (opens > 0) { s += '}'; opens--; }

    const parsed = JSON.parse(s);
    console.log('[Perplexity] JSON reparado com sucesso');
    return parsed;
  } catch {
    return null;
  }
}

module.exports = { estimarPrecoComIA };
