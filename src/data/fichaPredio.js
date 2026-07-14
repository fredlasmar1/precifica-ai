const axios = require('axios');
const { processosPorCnpj } = require('./escavador');

/**
 * FICHA DO PRÉDIO — dossiê de um edifício/condomínio para apoiar a avaliação.
 * Reúne: endereço, CNPJ (público), condomínio mensal, IPTU (de anúncio ou
 * estimado), padrão/lazer, perfil das unidades e processos contra o condomínio
 * (Direct Data, por CNPJ). Só roda quando o campo "Prédio" é informado.
 */

// IPTU estimado ≈ valor de mercado × fator (venal ~50% do mercado × alíquota
// residencial ~0,7%). Estimativa grosseira — não é o valor oficial.
const IPTU_FATOR = 0.0035;

async function dossiePredio(condominio, bairro, cidade) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;
  const prompt = `Pesquise informações REAIS sobre o edifício/condomínio residencial "${condominio}" em ${bairro}, ${cidade}-GO (estado de Goiás).

Retorne SOMENTE um JSON com (campos sem dado confirmado = null):
{
  "endereco": "endereço completo do prédio",
  "cnpj": "CNPJ do condomínio no formato XX.XXX.XXX/XXXX-XX — busque em bases públicas (Receita Federal, Econodata, CNPJ.biz, Solutudo, consulta-empresa). É informação PÚBLICA. Se realmente não achar, null",
  "valorCondominioMensal": "faixa ou valor típico do condomínio mensal em R$ (de anúncios reais)",
  "iptuAnual": número (valor do IPTU anual em R$ citado em anúncios, se houver),
  "padrao": "alto / médio-alto / médio / popular",
  "anoConstrucao": número (ano de construção/entrega do edifício, se confirmado; senão null),
  "lazer": ["itens de lazer: piscina, academia, salão, etc"],
  "perfilUnidades": "resumo APENAS de metragens e nº de quartos típicos. NÃO inclua preço, faixa de preço nem valor — preço NÃO é campo deste JSON",
  "perfilConfirmado": true se o perfil acima vier de fonte que cita o edifício "${condominio}" NOMINALMENTE; false se for inferido do bairro/entorno
}
Use SOMENTE dados reais e confirmados em ${cidade}-GO. NUNCA invente CNPJ nem valores.`;
  try {
    const { data } = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar-pro',
      messages: [
        { role: 'system', content: 'Pesquisador imobiliário. SOMENTE dados reais e confirmados. NUNCA invente CNPJ ou valores. Retorne SOMENTE JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1, max_tokens: 900,
    }, { timeout: 60000, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
    let s = data.choices[0].message.content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try { return JSON.parse(s); } catch { return null; }
  } catch (e) {
    console.warn('[FichaPredio] dossiê erro:', e.message);
    return null;
  }
}

function cnpjValido(c) { return String(c || '').replace(/\D/g, '').length === 14; }

/** Busca FOCADA do CNPJ (query de um campo só acerta mais que o dossiê inteiro). */
async function buscarCnpjPredio(condominio, cidade) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;
  try {
    const { data } = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar-pro',
      messages: [
        { role: 'system', content: 'Responda APENAS com o CNPJ no formato XX.XXX.XXX/XXXX-XX, ou a palavra "nenhum". Sem nenhum texto extra.' },
        { role: 'user', content: `Qual o CNPJ do Condomínio/Edifício "${condominio}" em ${cidade}-GO? Procure em Receita Federal, Econodata, CNPJ.biz, Solutudo, consulta-empresa. É informação pública.` },
      ],
      temperature: 0, max_tokens: 30,
    }, { timeout: 40000, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
    const m = data.choices[0].message.content.match(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/);
    return m ? m[0] : null;
  } catch { return null; }
}
// Remove marcadores de citação da Perplexity ([1], [2][3]...) e espaços duplos
function semCit(s) { return s == null ? s : String(s).replace(/\s*\[\d+\](\[\d+\])*/g, '').replace(/\s{2,}/g, ' ').trim(); }

/**
 * Guarda dura: derruba qualquer trecho com preço do texto livre do dossiê.
 * O prompt já proíbe, mas o campo é texto livre de LLM — e preço que escapa por
 * aqui vira "faixa do prédio" na tela sem UMA unidade real por trás. Foi assim
 * que o Residencial 24 de Abril ganhou um "R$ 700.000 a R$ 850.000" do nada,
 * na mesma ficha que dizia não ter unidade anunciada.
 * Preço só pode vir de `estimarPrecoPredio` (unidades verificáveis).
 */
function semPreco(s) {
  if (!s) return s;
  // Neutraliza o valor ANTES de separar: "R$ 700.000" contém ponto e seria
  // partido ao meio, deixando um "000" órfão no texto.
  const semMoeda = String(s).replace(/R\$\s?[\d.,]+\s*(mil|milh(ão|ões|oes))?/gi, '§');
  // Só separa em pontuação seguida de espaço/fim, senão "109,5 m²" viraria dois.
  const partes = semMoeda
    .split(/\s*[;,.](?=\s|$)\s*/)
    .filter((p) => p && !/§|pre[çc]o|valor/i.test(p));
  return partes.join(', ').trim() || null;
}

async function gerarFichaPredio({ condominio, bairro, cidade, valorMercado }) {
  if (!condominio) return null;
  const d = (await dossiePredio(condominio, bairro, cidade)) || {};
  // limpa marcadores de citação dos campos de texto
  ['endereco', 'padrao', 'perfilUnidades', 'valorCondominioMensal'].forEach(k => { if (typeof d[k] === 'string') d[k] = semCit(d[k]); });
  if (Array.isArray(d.lazer)) d.lazer = d.lazer.map(semCit);
  d.perfilUnidades = semPreco(d.perfilUnidades);

  // IPTU: prioriza o de anúncio; senão estima. O rótulo diz "a partir dos
  // anúncios" e não "valor venal × alíquota" porque o insumo é a mediana dos
  // anúncios, não a PGV — o rótulo antigo soava oficial sem ser.
  let iptu = null, iptuFonte = null;
  if (d.iptuAnual && Number(d.iptuAnual) > 0) { iptu = Math.round(Number(d.iptuAnual)); iptuFonte = 'informado em anúncio'; }
  else if (valorMercado > 0) { iptu = Math.round((valorMercado * IPTU_FATOR) / 10) * 10; iptuFonte = 'estimado a partir dos anúncios — não é o IPTU oficial'; }

  // CNPJ: se o dossiê não trouxe, tenta a busca focada
  let cnpj = cnpjValido(d.cnpj) ? d.cnpj : null;
  if (!cnpj) { const c = await buscarCnpjPredio(condominio, cidade); if (cnpjValido(c)) cnpj = c; }

  // Processos contra o condomínio (DirectData, por CNPJ)
  let processos = null;
  if (cnpjValido(cnpj)) processos = await processosPorCnpj(cnpj, 'GO');

  return {
    condominio,
    endereco: d.endereco || null,
    cnpj: cnpjValido(cnpj) ? cnpj : null,
    condominioMensal: d.valorCondominioMensal || null,
    iptu, iptuFonte,
    padrao: d.padrao || null,
    anoConstrucao: Number(d.anoConstrucao) > 1900 ? Number(d.anoConstrucao) : null,
    lazer: Array.isArray(d.lazer) ? d.lazer.filter(Boolean) : [],
    perfilUnidades: d.perfilUnidades || null,
    perfilConfirmado: d.perfilConfirmado === true,
    processos,
  };
}

/** Texto da ficha para o laudo (com *negrito* e emojis — uso só na tela). */
function formatarFichaPredio(f) {
  if (!f) return '';
  let t = `\n🏢 *FICHA DO PRÉDIO — ${f.condominio}*\n`;
  if (f.endereco) t += `• Endereço: ${f.endereco}\n`;
  if (f.cnpj) t += `• CNPJ (público): ${f.cnpj}\n`;
  if (f.padrao) t += `• Padrão: ${f.padrao}\n`;
  if (f.anoConstrucao) {
    const idade = new Date().getFullYear() - f.anoConstrucao;
    t += `• Construção: ${f.anoConstrucao} (${idade} anos)\n`;
  }
  if (f.lazer && f.lazer.length) t += `• Lazer: ${f.lazer.slice(0, 8).join(', ')}\n`;
  if (f.condominioMensal) t += `• Condomínio: ${typeof f.condominioMensal === 'number' ? 'R$ ' + f.condominioMensal.toLocaleString('pt-BR') + '/mês' : f.condominioMensal}\n`;
  if (f.iptu) t += `• IPTU: R$ ${f.iptu.toLocaleString('pt-BR')}/ano (${f.iptuFonte})\n`;
  if (f.perfilUnidades) {
    t += f.perfilConfirmado
      ? `• Unidades: ${f.perfilUnidades}\n`
      : `• Unidades (perfil do entorno — *não confirmado* para este prédio): ${f.perfilUnidades}\n`;
  }
  const dd = f.processos;
  if (dd && dd.disponivel) {
    t += dd.total > 0
      ? `• ⚖️ Processos do condomínio (CNPJ): *${dd.total}${dd.temMais ? '+' : ''} encontrado(s)* — verificar antes de fechar\n`
      : `• ⚖️ Processos do condomínio (CNPJ): nada consta ✅\n`;
  } else if (f.cnpj) {
    const motivo = (dd && dd.motivo) || 'sem token';
    const amigavel = /saldo|cr[ée]dito/i.test(motivo) ? 'Escavador sem saldo — adicione créditos no painel' : motivo;
    t += `• ⚖️ Processos: indisponível (${amigavel})\n`;
  }
  t += `_Ficha por amostragem de fontes públicas/anúncios. IPTU e condomínio variam por unidade; verifique o oficial._\n`;
  return t;
}

/** Resultado da aba "Prédios": ficha + unidades anunciadas + faixa de preço. */
function formatarBuscaPredio(ficha, unidades) {
  if (!ficha) return '⚠️ Não consegui montar a ficha desse prédio.';
  let t = `🏢 *${ficha.condominio}*\n`;
  t += formatarFichaPredio(ficha);
  const comps = (unidades && unidades.comparativos) || [];
  if (comps.length) {
    t += `\n🏠 *Unidades anunciadas no prédio (${comps.length}):*\n`;
    comps.slice(0, 8).forEach((c, i) => {
      t += `  ${i + 1}. ${c.area || '?'}m² • R$ ${Number(c.preco || 0).toLocaleString('pt-BR')} (R$ ${Number(c.precoM2 || 0).toLocaleString('pt-BR')}/m²)${c.quartos ? ` • ${c.quartos}q` : ''}\n`;
    });
    const m2 = comps.map(c => Number(c.precoM2)).filter(p => p > 0).sort((a, b) => a - b);
    if (m2.length) {
      const med = m2[Math.floor(m2.length / 2)];
      t += `\n💰 *Faixa do prédio:* R$ ${m2[0].toLocaleString('pt-BR')} – R$ ${m2[m2.length - 1].toLocaleString('pt-BR')}/m² (mediana R$ ${med.toLocaleString('pt-BR')}/m²)\n`;
    }
  } else {
    t += `\n🚫 *Sem base para precificar este prédio*\n`;
    t += `Nenhuma unidade anunciada aqui agora — e sem anúncio confirmado *não emitimos faixa de preço*.\n`;
    t += `Para precificar um prédio sem mercado ativo (método evolutivo, NBR 14653-2) precisamos de:\n`;
    if (!ficha.anoConstrucao) t += `  • Ano de construção\n`;
    t += `  • Fração ideal do terreno (matrícula)\n  • 1 transação real (ITBI ou matrícula)\n  • Estado de conservação (vistoria)\n`;
  }
  if (unidades && unidades.descartados > 0) {
    t += `\n_${unidades.descartados} anúncio(s) descartado(s) por R$/m² fora da faixa plausível do bairro (provável prédio homônimo ou preço inconsistente)._\n`;
  }
  if (unidades && unidades.suspeitaFabricacao) {
    t += `\n⚠️ _Os anúncios encontrados tinham preços quase idênticos entre si — padrão típico de dado fabricado. Foram descartados._\n`;
  }
  try {
    const { fontesPredio, textoFontes } = require('./fontes');
    t += textoFontes(fontesPredio(ficha, comps, (unidades && unidades.citacoes) || []));
  } catch {}
  return t;
}

module.exports = { gerarFichaPredio, formatarFichaPredio, formatarBuscaPredio };
