const PDFDocument = require('pdfkit');
const path = require('path');

/**
 * Gera o PDF do Parecer de Avaliação Mercadológica (PTAM por amostragem).
 * Identidade visual do Precifica (azul/branco + logo Bens). Estrutura
 * profissional inspirada no modelo Bens (método comparativo NBR 14653-2).
 * Duas versões: 'tecnica' (completa) e 'cliente' (simples/visual).
 */

// ── Identidade ───────────────────────────────────────────────────────
const BLUE = '#013EF8', INK = '#0e1729', MUTED = '#5a6a86', LABEL = '#8a98b3';
const LINE = '#d6e0f0', BAND = '#eef3ff', WHITE = '#FFFFFF', NAVY = '#0e1729';
const LOGO = path.join(__dirname, '..', '..', 'public', 'bens-logo-white.png');

const CORRETOR = 'Frederico Ivan Lasmar Alves';
const CRECI_F = 'CRECI-F 41.009';
const CRECI_J = 'CRECI-J 43.934';

const PAGE_W = 595.28, PAGE_H = 841.89;
const TOP = 92, BOTTOM = 64, LX = 44, RX = PAGE_W - 44, W = RX - LX;

function brl(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isNaN(n) ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}
function num(v) { if (v == null || v === '') return '—'; const n = Number(v); return Number.isNaN(n) ? String(v) : n.toLocaleString('pt-BR'); }
function txt(v) { return v == null || v === '' ? '—' : String(v); }
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

function gerarRelatorioPdf(dados, resultado, opts = {}) {
  const versao = opts.versao === 'cliente' ? 'cliente' : 'tecnica';
  const solicitante = opts.solicitante || '';
  const dataEmissao = new Date().toLocaleDateString('pt-BR');

  const a = resultado.analiseIA || {};
  const comps = Array.isArray(a.comparativos) ? a.comparativos : [];
  const ehVenda = (dados.finalidade || 'venda') !== 'aluguel';
  const nAmostras = a.anunciosAnalisados || comps.length || 0;
  const grau = nAmostras >= 10 ? 'Forte' : nAmostras >= 5 ? 'Médio' : 'Indicativo';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: TOP, bottom: BOTTOM, left: LX, right: 44 } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = TOP;
    const ensure = (need) => { if (y + need > PAGE_H - BOTTOM) { doc.addPage(); y = TOP; } };

    // Cabeçalho/rodapé desenhados no FIM (bufferPages) p/ evitar reentrância de texto
    const chrome = () => {
      // Header
      doc.rect(0, 0, PAGE_W, 64).fill(BLUE);
      try { doc.image(LOGO, LX, 22, { height: 20 }); } catch {}
      doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE)
        .text('Parecer de Avaliação Mercadológica', LX, 21, { width: W, align: 'right' });
      doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff')
        .text('Bens Imóveis · Inteligência Imobiliária', LX, 38, { width: W, align: 'right' });
      // Footer
      const fy = PAGE_H - 44;
      doc.moveTo(LX, fy).lineTo(RX, fy).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(7).fillColor(MUTED)
        .text(`Bens Imóveis · ${CRECI_J} · Anápolis-GO  —  documento gerado por Precifica Aí`, LX, fy + 6, { width: W * 0.75 });
      doc.font('Helvetica').fontSize(7).fillColor(MUTED)
        .text(`Emitido em ${dataEmissao}`, RX - 150, fy + 6, { width: 150, align: 'right' });
    };

    // ── Helpers de seção ──
    const band = (title) => {
      ensure(22);
      doc.rect(LX, y, W, 15).fill(BLUE);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(WHITE).text(title, LX + 8, y + 4, { lineBreak: false });
      y += 20;
    };
    const paragraph = (t, size = 8.5) => {
      ensure(28);
      doc.font('Helvetica').fontSize(size).fillColor(INK).text(t, LX, y, { width: W, align: 'justify', lineGap: 1.5 });
      y = doc.y + 8;
    };
    const cell = (x, w, label, value) => {
      doc.rect(x, y, w, 24).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(5.5).fillColor(LABEL).text(String(label).toUpperCase(), x + 5, y + 4, { width: w - 10, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(value || '—', x + 5, y + 12, { width: w - 10, height: 10, ellipsis: true, lineBreak: false });
    };

    // ── TÍTULO ──
    doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY)
      .text(versao === 'cliente' ? 'Avaliação do Imóvel' : 'PARECER DE AVALIAÇÃO MERCADOLÓGICA', LX, y, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(BLUE)
      .text(versao === 'cliente' ? 'Quanto vale o seu imóvel — por amostragem de mercado'
        : 'Opinião de valor por amostragem · Método Comparativo de Dados de Mercado',
        LX, y + 20, { width: W, align: 'center', characterSpacing: 0.5 });
    y += 40;

    // ── IDENTIFICAÇÃO ──
    cell(LX, W * 0.6, 'Solicitante', txt(solicitante));
    cell(LX + W * 0.6, W * 0.4, 'Finalidade', ehVenda ? 'Venda' : 'Locação'); y += 24;
    const end = [dados.endereco, dados.bairro].filter(Boolean).join(', ');
    cell(LX, W, 'Imóvel objeto', `${end || txt(dados.bairro)} — ${txt(dados.cidade)}/GO`); y += 24;
    cell(LX, W / 4, 'Tipo', cap(dados.tipo));
    cell(LX + W / 4, W / 4, 'Área (m²)', num(dados.metragem));
    cell(LX + W / 2, W / 4, 'Quartos / Vagas', `${num(dados.quartos)} / ${num(dados.vagas)}`);
    cell(LX + (3 * W) / 4, W / 4, 'Conservação', cap(dados.conservacao)); y += 24;
    cell(LX, W, 'Responsável técnico', `${CORRETOR} · ${CRECI_F}`); y += 24;
    y += 10;

    // ── RESULTADO DESTACADO ──
    ensure(66);
    doc.roundedRect(LX, y, W, 56, 8).fill(BLUE);
    doc.font('Helvetica').fontSize(8).fillColor('#cfe0ff').text('VALOR DE MERCADO ESTIMADO', LX + 16, y + 10);
    doc.font('Helvetica-Bold').fontSize(22).fillColor(WHITE).text(brl(resultado.precoRecomendado), LX + 16, y + 20);
    doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text('FAIXA DE MERCADO', RX - 230, y + 10, { width: 120 });
    doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text('R$/m²', RX - 100, y + 10, { width: 84 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(WHITE).text(`${brl(resultado.precoMinimo)} – ${brl(resultado.precoMaximo)}`, RX - 230, y + 22, { width: 125 });
    doc.font('Helvetica-Bold').fontSize(12).fillColor(WHITE).text(brl(resultado.precoM2Mercado), RX - 100, y + 21, { width: 84 });
    doc.font('Helvetica').fontSize(7).fillColor('#cfe0ff')
      .text(`Liquidez: ${txt(resultado.indiceLiquidez)}  ·  Tempo estimado: ${txt(resultado.tempoEstimadoDias)} dias  ·  Amostra: ${nAmostras} anúncios  ·  Fundamentação: ${grau}`, LX + 16, y + 44);
    y += 66;

    if (versao === 'tecnica') {
      // ── METODOLOGIA ──
      band('METODOLOGIA');
      paragraph(
        `Avaliação realizada pelo Método Comparativo de Dados de Mercado por amostragem (referência ABNT NBR 14653-2), ` +
        `a partir de ${nAmostras} imóveis comparáveis ofertados na mesma região e com características semelhantes ao avaliado. ` +
        `Os valores por metro quadrado foram tratados estatisticamente (mediana, exclusão de discrepantes e filtro por ` +
        `similaridade de área), resultando na faixa de valor de mercado acima. O resultado é ancorado em bases oficiais ` +
        `(Prefeitura de Anápolis / EBM-Aderni-GO) para sanidade. Grau de fundamentação: ${grau} (${nAmostras} amostras). ` +
        `Fontes: ${txt((resultado.fontesConsultadas || []).join(', '))}.`,
      );

      // ── AMOSTRA ──
      if (comps.length) {
        band('AMOSTRA DE MERCADO (COMPARÁVEIS REAIS)');
        sampleHeader();
        comps.slice(0, 24).forEach((c, i) => sampleRow(i, c));
        y += 6;
      }

      // ── DISPERSÃO ──
      if (comps.some((c) => Number(c.precoM2) > 0)) {
        ensure(150);
        band('DISPERSÃO DOS VALORES (R$/m²)');
        scatter(comps, Number(resultado.precoM2Mercado) || null);
      }

      // ── ANÁLISE ──
      if (a.raciocinio) { band('ANÁLISE'); paragraph(String(a.raciocinio)); }

      // ── AJUSTES ──
      if (Array.isArray(resultado.ajustesAplicados) && resultado.ajustesAplicados.length) {
        band('AJUSTES E CALIBRAÇÃO');
        resultado.ajustesAplicados.forEach((aj) => { ensure(14); doc.font('Helvetica').fontSize(8).fillColor(INK).text(`•  ${aj}`, LX + 4, y, { width: W - 8 }); y = doc.y + 3; });
        y += 6;
      }
    } else {
      // ── VERSÃO CLIENTE ──
      band('COMO CHEGAMOS NESSE VALOR');
      paragraph(
        `Analisamos ${nAmostras} anúncios reais de imóveis parecidos com o seu, na mesma região, publicados nos maiores ` +
        `portais do país. A partir desses preços calculamos o valor de mercado por amostragem — o mesmo método usado por ` +
        `avaliadores profissionais, só que com muito mais dados reais e atualizados. Veja abaixo alguns dos imóveis comparados:`,
      );
      if (comps.length) {
        sampleHeader();
        comps.slice(0, 8).forEach((c, i) => sampleRow(i, c));
        y += 8;
      }
      band('RESUMO');
      paragraph(
        `Pela análise de mercado, o valor sugerido para anúncio é de ${brl(resultado.precoMaximo)}, com faixa de ` +
        `negociação esperada entre ${brl(resultado.precoMinimo)} e ${brl(resultado.precoRecomendado)}. ` +
        `Tempo médio estimado de venda na região: ${txt(resultado.tempoEstimadoDias)} dias (${txt(resultado.indiceLiquidez)}).`,
      );
    }

    // ── RESSALVAS ──
    band('PRESSUPOSTOS E RESSALVAS');
    paragraph(
      `Este documento é uma avaliação mercadológica (opinião de valor) emitida por corretor de imóveis para fins de ` +
      `intermediação imobiliária, baseada em dados de oferta de mercado na data de emissão. Não constitui laudo pericial ` +
      `de engenharia de avaliações (ABNT NBR 14653) nem substitui avaliação para fins judiciais ou fiscais. Valores de ` +
      `oferta podem diferir do preço de fechamento.`, 8,
    );

    // ── ASSINATURA ──
    ensure(64);
    y += 16;
    const half = W / 2;
    doc.lineWidth(0.7).strokeColor(NAVY).moveTo(LX + half / 2 - 80, y).lineTo(LX + half / 2 + 80, y).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(LABEL).text('CORRETOR RESPONSÁVEL', LX + half / 2 - 80, y + 5, { width: 160, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(`${CORRETOR}`, LX + half / 2 - 90, y + 16, { width: 180, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`${CRECI_F} · Bens Imóveis (${CRECI_J})`, LX + half / 2 - 90, y + 28, { width: 180, align: 'center' });
    // selo lateral
    doc.roundedRect(LX + half + 30, y - 4, half - 50, 46, 8).lineWidth(1).strokeColor(BLUE).stroke();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(BLUE).text('Avaliação por amostragem', LX + half + 40, y + 6, { width: half - 70, align: 'center' });
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(`${nAmostras} anúncios reais · fundamentação ${grau}`, LX + half + 40, y + 22, { width: half - 70, align: 'center' });

    // Desenha cabeçalho/rodapé em todas as páginas (conteúdo já finalizado)
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) { doc.switchToPage(range.start + i); chrome(); }
    doc.flushPages();

    doc.end();

    // ===== helpers de tabela/gráfico =====
    function sampleHeader() {
      ensure(16);
      doc.rect(LX, y, W, 14).fill(BAND);
      const cols = [['Bairro', 0.26], ['Área m²', 0.12], ['Qtos', 0.08], ['Valor', 0.22], ['R$/m²', 0.16], ['Fonte', 0.16]];
      let cx = LX;
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MUTED);
      cols.forEach(([t, wp]) => { doc.text(String(t).toUpperCase(), cx + 4, y + 4, { width: W * wp - 6, lineBreak: false }); cx += W * wp; });
      y += 14;
    }
    function sampleRow(i, c) {
      ensure(14);
      if (i % 2 === 1) { doc.rect(LX, y, W, 13).fill('#f6f8fc'); }
      const cells = [[txt(c.bairro), 0.26], [num(c.area), 0.12], [num(c.quartos), 0.08], [brl(c.preco), 0.22], [brl(c.precoM2), 0.16], [txt(c.fonte), 0.16]];
      let cx = LX;
      doc.font('Helvetica').fontSize(7.5).fillColor(INK);
      cells.forEach(([t, wp]) => { doc.text(t, cx + 4, y + 3, { width: W * wp - 6, lineBreak: false }); cx += W * wp; });
      doc.moveTo(LX, y + 13).lineTo(RX, y + 13).lineWidth(0.3).strokeColor(LINE).stroke();
      y += 13;
    }
    function scatter(items, media) {
      const vals = items.map((c) => Number(c.precoM2)).filter((n) => !Number.isNaN(n) && n > 0);
      if (!vals.length) return;
      const h = 120, x0 = LX + 38, x1 = RX - 8, y0 = y + 8, y1 = y + h - 14;
      const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
      const sy = (v) => y1 - ((Math.max(min, Math.min(max, v)) - min) / span) * (y1 - y0);
      doc.lineWidth(0.5).strokeColor(LINE).moveTo(x0, y0).lineTo(x0, y1).stroke().moveTo(x0, y1).lineTo(x1, y1).stroke();
      doc.font('Helvetica').fontSize(6).fillColor(MUTED).text(brl(max), LX, y0 - 3, { width: 34, align: 'right' }).text(brl(min), LX, y1 - 3, { width: 34, align: 'right' });
      if (media) {
        const my = sy(media);
        doc.dash(2, { space: 2 }).moveTo(x0, my).lineTo(x1, my).strokeColor(BLUE).lineWidth(1).stroke().undash();
        doc.font('Helvetica-Bold').fontSize(6).fillColor(BLUE).text(`mediana ${brl(media)}`, x1 - 100, my - 8, { width: 100, align: 'right' });
      }
      const step = vals.length > 1 ? (x1 - x0 - 16) / (vals.length - 1) : 0;
      vals.forEach((v, i) => { doc.circle(x0 + 10 + i * step, sy(v), 2.2).fill(NAVY); });
      y += h + 6;
    }
  });
}

module.exports = { gerarRelatorioPdf };
