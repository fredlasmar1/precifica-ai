/**
 * FONTES E METODOLOGIA — bloco padronizado de credibilidade para os laudos.
 * Centraliza a origem de cada dado (método, amostra, data, links, bases oficiais)
 * para que todo relatório do Precifica Aí seja verificável.
 */
function hoje() { return new Date().toLocaleDateString('pt-BR'); }

const BASE_PGV = 'Planta Genérica de Valores — Prefeitura de Anápolis (2023)';
const BASE_EBM = 'EBM Anápolis / levantamento Aderni-GO (R$/m² por bairro)';
const BASE_IBGE = 'IBGE (população e renda do município)';
const BASE_MAPS = 'Google Maps (geolocalização e perfil do entorno)';
const BASE_RECEITA = 'Receita Federal / bases públicas de CNPJ';
const BASE_ESCAVADOR = 'Escavador (processos judiciais por CNPJ)';

/** Fontes da AVALIAÇÃO de imóvel. */
function fontesAvaliacao(dados, resultado) {
  const a = resultado.analiseIA || {};
  const comps = Array.isArray(a.comparativos) ? a.comparativos : [];
  const n = a.anunciosAnalisados || comps.length || 0;
  const grau = n >= 10 ? 'Forte' : n >= 5 ? 'Médio' : 'Indicativo';
  const links = [...new Set([...comps.map(c => c.url).filter(Boolean), ...(a.citacoes || [])])].slice(0, 8);
  const portais = [...new Set(comps.map(c => c.fonte).filter(Boolean))];
  return {
    metodo: 'Método Comparativo de Dados de Mercado por amostragem (ref. ABNT NBR 14653-2)',
    amostra: `${n} anúncios reais`, data: hoje(), grau,
    portais, links,
    bases: [BASE_PGV, BASE_EBM, BASE_IBGE, BASE_MAPS],
  };
}

/** Fontes da ANÁLISE DE PONTO COMERCIAL. */
function fontesComercial(a) {
  const links = [];
  if (a.precoComercial && a.precoComercial.fontes) links.push(...a.precoComercial.fontes);
  return {
    metodo: 'Análise de ponto por amostragem: concorrência e fluxo (Google Maps), demanda (IBGE), custo do ponto por anúncios reais',
    amostra: `${a.concorrencia?.em500m?.total || 0} concorrentes mapeados`, data: hoje(),
    bases: [BASE_MAPS, BASE_IBGE, BASE_EBM, 'Anúncios de imóveis comerciais (VivaReal/ZAP)'],
    obs: 'Ticket médio e faturamento são ESTIMATIVAS (perfil de renda da região), não dados auditados.',
  };
}

/** Fontes da AVALIAÇÃO DE EMPRESA. */
function fontesEmpresa(r) {
  return {
    metodo: 'Múltiplos de mercado: rentabilidade (lucro × tempo de retorno), faturamento e patrimonial',
    amostra: 'números declarados pelo vendedor (a conferir)', data: hoje(),
    bases: [BASE_EBM + ' — poder de compra do bairro'],
    obs: 'Parecer mercadológico de apoio à negociação. NÃO é avaliação contábil — confirme faturamento, lucro e dívidas com documentos e um contador.',
  };
}

/** Fontes da FICHA DO PRÉDIO. */
function fontesPredio(f) {
  const bases = [BASE_MAPS + ' (endereço)', 'Anúncios de imóveis (condomínio, IPTU, unidades)'];
  if (f.cnpj) bases.push(BASE_RECEITA);
  if (f.processos && f.processos.disponivel) bases.push(BASE_ESCAVADOR);
  return {
    metodo: 'Dossiê do edifício por amostragem de fontes públicas e anúncios de mercado',
    data: hoje(), bases,
    obs: 'IPTU e condomínio variam por unidade; o IPTU pode ser estimado. Confirme o oficial na Prefeitura.',
  };
}

/** Texto do bloco (com *negrito*/emoji) — para o laudo na tela. */
function textoFontes(f) {
  let t = `\n📋 *FONTES E METODOLOGIA*\n`;
  if (f.metodo) t += `• Método: ${f.metodo}\n`;
  if (f.amostra) t += `• Base: ${f.amostra} · coletado em ${f.data}\n`;
  else if (f.data) t += `• Consulta em ${f.data}\n`;
  if (f.grau) t += `• Grau de fundamentação: *${f.grau}*\n`;
  if (f.portais && f.portais.length) t += `• Portais de mercado: ${f.portais.join(', ')}\n`;
  if (f.bases && f.bases.length) { t += `• Bases oficiais e de referência:\n`; f.bases.forEach(b => { t += `   – ${b}\n`; }); }
  if (f.links && f.links.length) { t += `• Anúncios consultados (clique e verifique):\n`; f.links.forEach(u => { t += `   ${u}\n`; }); }
  if (f.obs) t += `• _${f.obs}_\n`;
  return t;
}

module.exports = { fontesAvaliacao, fontesComercial, fontesEmpresa, fontesPredio, textoFontes };
