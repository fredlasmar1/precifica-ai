/**
 * REFERÊNCIAS DE VALOR — o quadro que responde "quanto vale de verdade AQUI"
 * ─────────────────────────────────────────────────────────────────────
 * O motor precifica pela amostra do bairro. Quando ela é curta (2 anúncios
 * no Jardim Europa), o parecer sai vago e o dono não consegue defender o
 * número. Este módulo junta TUDO o que o sistema já sabe sobre o local e
 * apresenta lado a lado, cada fonte com seu R$/m² e o valor que implica
 * para a área avaliada:
 *   1. anúncios no próprio bairro (mediana)
 *   2. anúncios nos bairros vizinhos (traduzidos pela razão PGV bairro/vizinho)
 *   3. Planta Genérica de Valores da Prefeitura (venal × fator de mercado)
 *   4. negócios fechados registrados na base
 * Nenhum número é inventado: fonte sem dado não entra.
 */
const { buscarComparativos } = require('./portais');
const { getAncora, filtrarCompsSanos } = require('./baseAnapolis');

const mediana = (arr) => {
  const s = (arr || []).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const cap = (s) => String(s || '').toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, sep, c) => sep + c.toUpperCase());

async function montarReferencias(dados, resultado) {
  const tipo = String(dados.tipo || '').toLowerCase();
  const finalidade = dados.finalidade === 'aluguel' ? 'aluguel' : 'venda';
  const cidade = dados.cidade || 'Anápolis';
  const bairro = dados.bairro || '';
  const area = Number(dados.metragem) || Number(dados.areaLote) || 0;
  if (!(area > 0)) return null;
  const unidade = finalidade === 'aluguel' ? 'R$/m²·mês' : 'R$/m²';
  const itens = [];

  // 1. bairro
  const comps = ((resultado.analiseIA || {}).comparativos || []).filter((c) => Number(c.preco) > 0);
  const compsM2 = comps.map((c) => Number(c.precoM2) || (Number(c.area) > 0 ? Number(c.preco) / Number(c.area) : 0)).filter((v) => v > 0);
  const m2Bairro = Number(resultado.precoM2Mercado) || mediana(compsM2);
  if (m2Bairro > 0 && comps.length) {
    itens.push({ chave: 'bairro', fonte: `Anúncios em ${bairro}`, detalhe: `${comps.length} anúncio(s) · mediana`, n: comps.length, m2: Math.round(m2Bairro), peso: comps.length >= 5 ? 3 : 1 });
  }

  // 2. vizinhos — só quando a amostra do bairro é curta (custa scraping)
  const ancoraBairro = getAncora(tipo, finalidade, cidade, bairro);
  const vizinhos = [...new Set([...(((resultado.geoInfo || {}).bairrosProximos) || []), ...(((resultado.geoInfo || {}).bairrosVizinhos) || [])])]
    .map((b) => String(b).replace(/\(.*?\)/g, '').trim()).filter((b) => b && b.toLowerCase() !== bairro.toLowerCase()).slice(0, 3);
  const vizinhosAmostra = [];
  if (comps.length < 5 && vizinhos.length) {
    for (const viz of vizinhos) {
      try {
        const r = await buscarComparativos({ tipo, finalidade, cidade, bairro: viz, quartos: dados.quartos || null, metragem: area });
        const lista = (r && r.imoveis) || [];
        const sanos = filtrarCompsSanos(lista, { tipo, finalidade, cidade, bairro: viz }).ok;
        if (sanos.length >= 2) {
          const med = mediana(sanos.map((c) => c.precoM2));
          const ancoraViz = getAncora(tipo, finalidade, cidade, viz);
          // Traduz o vizinho para o bairro avaliado pela razão das bases oficiais (PGV/EBM).
          const fator = ancoraViz.m2 > 0 && ancoraBairro.m2 > 0 ? Math.max(0.5, Math.min(2, ancoraBairro.m2 / ancoraViz.m2)) : 1;
          const m2Aj = Math.round(med * fator);
          vizinhosAmostra.push({ bairro: cap(viz), n: sanos.length, m2: med, fator: Math.round(fator * 100) / 100, m2Ajustado: m2Aj, comps: sanos.slice(0, 3).map((c) => ({ area: c.area, preco: c.preco, precoM2: c.precoM2, fonte: c.fonte, url: c.url || c.link })) });
          itens.push({ chave: 'vizinho', fonte: `Anúncios em ${cap(viz)} (vizinho)`, detalhe: `${sanos.length} anúncio(s) · ${unidade} ${med.toLocaleString('pt-BR')} × ${fator.toFixed(2)} (razão PGV/EBM entre os bairros)`, n: sanos.length, m2: m2Aj, m2Bruto: med, fator, peso: 1 });
        }
      } catch (e) { console.warn('[Referências] vizinho', viz, e.message); }
    }
  }

  // 3. base oficial
  if (ancoraBairro && ancoraBairro.m2 > 0) {
    itens.push({ chave: 'oficial', fonte: /PGV/i.test(ancoraBairro.fonte) ? 'Planta Genérica de Valores (Prefeitura)' : 'Base de referência (EBM/Aderni-GO)', detalhe: ancoraBairro.venal ? `venal R$ ${ancoraBairro.venal}/m² × fator de mercado` : ancoraBairro.fonte, m2: ancoraBairro.m2, venal: ancoraBairro.venal || null, peso: 2 });
  }

  // 4. fechamentos
  const f = resultado.fechamentos;
  if (f && f.n > 0 && f.m2 > 0) {
    itens.push({ chave: 'fechado', fonte: `Negócios fechados registrados (${f.n})`, detalhe: 'preço que fechou de fato, não o pedido', n: f.n, m2: f.m2, peso: 3 });
  }

  if (!itens.length) return null;
  itens.forEach((i) => { i.valor = Math.round(i.m2 * area); });
  const valores = itens.map((i) => i.valor);
  // Consolidado: mediana ponderada simples (repete cada fonte pelo peso).
  const pond = []; itens.forEach((i) => { for (let k = 0; k < (i.peso || 1); k++) pond.push(i.valor); });
  const consolidado = Math.round(mediana(pond) / 1000) * 1000;
  const pedido = Number(dados.valorPedido) || 0;
  return {
    area, unidade, itens, vizinhos: vizinhosAmostra,
    faixaMin: Math.min(...valores), faixaMax: Math.max(...valores), consolidado,
    pedidoM2: pedido > 0 ? Math.round(pedido / area) : null,
    fontesTotal: itens.length,
    leitura: leituraDasReferencias(itens, consolidado, pedido, area, bairro)
  };
}

/** Frase de dono: o que as fontes dizem juntas — sem inventar consenso. */
function leituraDasReferencias(itens, consolidado, pedido, area, bairro) {
  const brl = (v) => 'R$ ' + Math.round(v).toLocaleString('pt-BR');
  const min = Math.min(...itens.map((i) => i.valor)), max = Math.max(...itens.map((i) => i.valor));
  let t = `${itens.length} fonte(s) independentes apontam entre ${brl(min)} e ${brl(max)} para ${area.toLocaleString('pt-BR')} m² em ${bairro}; consolidado ${brl(consolidado)}.`;
  if (pedido > 0) {
    const acimaDe = itens.filter((i) => pedido > i.valor * 1.02).length;
    if (acimaDe === itens.length) t += ` O pedido de ${brl(pedido)} está acima de TODAS as referências (+${Math.round((pedido / max - 1) * 100)}% sobre a mais alta).`;
    else if (acimaDe === 0) t += ` O pedido de ${brl(pedido)} cabe em todas as referências.`;
    else t += ` O pedido de ${brl(pedido)} passa de ${acimaDe} das ${itens.length} referências.`;
  }
  return t;
}

module.exports = { montarReferencias };
