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
function fontesPredio(f, comps = [], citacoes = [], evolutivo = null) {
  const n = comps.length;
  const bases = [BASE_MAPS + ' (endereço)', 'Anúncios de imóveis (condomínio, IPTU, unidades)'];
  if (f.cnpj) bases.push(BASE_RECEITA);
  if (f.processos && f.processos.disponivel) bases.push(BASE_ESCAVADOR);
  const links = [...new Set([...comps.map(c => c.url).filter(Boolean), ...citacoes])].slice(0, 8);

  // Sem anúncio no prédio o método MUDA (comparativo → evolutivo), e o bloco de
  // fontes tem que mudar junto: dizer "sem base de preço" embaixo de uma
  // estimativa publicada seria o mesmo tipo de contradição que originou o chute.
  if (!n && evolutivo) {
    return {
      metodo: 'Método EVOLUTIVO (ref. ABNT NBR 14653-2, 8.2.2): terreno (fração ideal) + custo de reedição CUB-GO depreciado por Ross-Heidecke × fator de comercialização',
      amostra: `nenhuma unidade anunciada neste prédio — estimativa por custo, sem mercado`,
      data: hoje(),
      grau: 'Indicativo (estimativa — não é laudo)',
      links, bases: bases.concat([BASE_PGV + ' — terreno', BASE_EBM + ' — calibração do fator de comercialização', 'CUB-GO / Sinduscon (custo de reedição)']),
      obs: `Estimativa por custo depreciado, NÃO por mercado: ${evolutivo.idade} anos, CA e estado de conservação presumidos. Para laudo: vistoria + fração ideal da matrícula + transação real (ITBI).`,
    };
  }
  return {
    metodo: 'Dossiê do edifício por amostragem de fontes públicas e anúncios de mercado',
    amostra: n ? `${n} unidade(s) anunciada(s) neste prédio` : 'nenhuma unidade anunciada neste prédio',
    data: hoje(),
    grau: n >= 3 ? 'Médio' : n >= 1 ? 'Indicativo' : 'Sem base de preço',
    links, bases,
    obs: n
      ? 'IPTU e condomínio variam por unidade; o IPTU, quando estimado, deriva dos anúncios e NÃO é o valor oficial. Confirme na Prefeitura.'
      : 'Sem unidade anunciada, esta ficha NÃO precifica o prédio. Metragens sem confirmação vêm do entorno, não deste edifício.',
  };
}

/** Texto do bloco (negrito e emoji) — para o laudo na tela. */
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
