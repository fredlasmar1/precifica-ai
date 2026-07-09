const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

// Assinatura do corretor. Carregada do env ASSINATURA_BASE64 (mantida FORA do
// repositório público, por segurança) ou de public/assinatura.png como fallback.
// Desenhada em cima do nome, na linha de assinatura.
let _assinaturaBuf, _assinaturaTentada = false;
function assinaturaBuf() {
  if (_assinaturaTentada) return _assinaturaBuf;
  _assinaturaTentada = true;
  try {
    if (process.env.ASSINATURA_BASE64) {
      _assinaturaBuf = Buffer.from(process.env.ASSINATURA_BASE64, 'base64');
    } else {
      const p = path.join(__dirname, '..', '..', 'public', 'assinatura.png');
      if (fs.existsSync(p)) _assinaturaBuf = fs.readFileSync(p);
    }
  } catch (e) { _assinaturaBuf = null; }
  return _assinaturaBuf || null;
}
function desenharAssinatura(doc, cx, lineY) {
  const buf = assinaturaBuf();
  if (!buf) return;
  try {
    // Centralizada em cima da linha, sentando 2pt acima dela. Altura limitada
    // para não invadir o texto acima (o espaço acima da linha é fixo).
    const bw = 150, bh = 64;
    doc.image(buf, cx - bw / 2, lineY - bh - 2, { fit: [bw, bh], align: 'center', valign: 'bottom' });
  } catch (e) { /* imagem inválida: ignora silenciosamente */ }
}

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
const RAZAO = 'Bens Imóveis Corporativos';
const ENDERECO = 'Av. Mato Grosso, Ville Center Mall, sala 18 · Anápolis-GO';
const CONTATO = '(62) 9973-9596 · www.benscorporativos.com.br · @benscorporativos';

const PAGE_W = 595.28, PAGE_H = 841.89;
const TOP = 92, BOTTOM = 64, LX = 44, RX = PAGE_W - 44, W = RX - LX;

function brl(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isNaN(n) ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}
function num(v) { if (v == null || v === '') return '—'; const n = Number(v); return Number.isNaN(n) ? String(v) : n.toLocaleString('pt-BR'); }
// Remove emojis (a fonte Helvetica do PDF não os renderiza → viram lixo)
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{2190}-\u{21FF}]/gu, '')
    .replace(/\s{2,}/g, ' ').trim();
}
function txt(v) { if (v == null || v === '') return '—'; return clean(v) || '—'; }
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
        .text('Imóveis Corporativos · Anápolis-GO', LX, 38, { width: W, align: 'right' });
      // Footer (2 linhas — dados oficiais Bens)
      const fy = PAGE_H - 46;
      doc.page.margins.bottom = 0; // permite escrever na área do rodapé sem o PDFKit paginar
      doc.moveTo(LX, fy).lineTo(RX, fy).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED)
        .text(`${RAZAO} · ${CRECI_J} · ${ENDERECO}`, LX, fy + 5, { width: W, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED)
        .text(`${CONTATO}  ·  documento gerado por Precifica Aí`, LX, fy + 15, { width: W * 0.8, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED)
        .text(`Emitido em ${dataEmissao}`, RX - 120, fy + 15, { width: 120, align: 'right' });
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
      doc.font('Helvetica').fontSize(size).fillColor(INK).text(clean(t), LX, y, { width: W, align: 'justify', lineGap: 1.5 });
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
    doc.font('Helvetica-Bold').fontSize(12).fillColor(WHITE).text(brl(resultado.precoM2Imovel != null ? resultado.precoM2Imovel : resultado.precoM2Mercado), RX - 100, y + 21, { width: 84 });
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
        resultado.ajustesAplicados.forEach((aj) => { ensure(14); doc.font('Helvetica').fontSize(8).fillColor(INK).text(`•  ${clean(aj)}`, LX + 4, y, { width: W - 8 }); y = doc.y + 3; });
        y += 6;
      }

      // ── FICHA DO PRÉDIO ──
      const fp = resultado.fichaPredio;
      if (fp) {
        band(`FICHA DO PRÉDIO — ${String(fp.condominio || '').toUpperCase()}`);
        const linhas = [];
        if (fp.endereco) linhas.push(['Endereço', fp.endereco]);
        if (fp.cnpj) linhas.push(['CNPJ (público)', fp.cnpj]);
        if (fp.padrao) linhas.push(['Padrão', fp.padrao]);
        if (fp.lazer && fp.lazer.length) linhas.push(['Lazer', fp.lazer.slice(0, 8).join(', ')]);
        if (fp.condominioMensal) linhas.push(['Condomínio/mês', typeof fp.condominioMensal === 'number' ? brl(fp.condominioMensal) : String(fp.condominioMensal)]);
        if (fp.iptu) linhas.push(['IPTU/ano', `${brl(fp.iptu)} (${fp.iptuFonte})`]);
        if (fp.perfilUnidades) linhas.push(['Unidades', fp.perfilUnidades]);
        const dd = fp.processos;
        if (dd && dd.disponivel) linhas.push(['Processos (CNPJ do condomínio)', dd.total > 0 ? `${dd.total} encontrado(s) — verificar antes de fechar` : 'nada consta']);
        else if (fp.cnpj) linhas.push(['Processos', `due diligence indisponível (${(dd && dd.motivo) || 'sem DirectData'})`]);
        linhas.forEach(([k, v]) => {
          ensure(14);
          doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${k}: `, LX + 4, y, { continued: true, width: W - 8 });
          doc.font('Helvetica').fontSize(8).fillColor(INK).text(clean(String(v)));
          y = doc.y + 3;
        });
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

    // ── DADOS DA REGIÃO E DO IMÓVEL (enriquecimento) ──
    try {
      const enr = resultado.enriquecimento || {};
      const linha = (k, v) => { ensure(13); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${k}: `, LX + 4, y, { continued: true, width: W - 8 }); doc.font('Helvetica').fontSize(8).fillColor(INK).text(clean(String(v))); y = doc.y + 3; };
      const brlF = (v) => 'R$ ' + Number(v).toLocaleString('pt-BR');

      if (enr.rentabilidade || enr.financiamento) {
        band('RENTABILIDADE E FINANCIAMENTO');
        if (enr.rentabilidade) {
          const r = enr.rentabilidade;
          linha('Aluguel estimado', `${brlF(r.aluguelMensal)}/mês`);
          linha('Rentabilidade', `${r.yieldAnual.toLocaleString('pt-BR')}% ao ano · paga o imóvel em ~${r.paybackAnos} anos`);
        }
        if (enr.financiamento) {
          const f = enr.financiamento;
          linha('Financiamento', `entrada ${brlF(f.entrada)} (${f.entradaPct}%) · parcela ~${brlF(f.parcela)}/mês em ${Math.round(f.prazoMeses / 12)} anos (${f.taxaAnual}% a.a.)`);
          linha('Renda necessária', `~${brlF(f.rendaNecessaria)}/mês`);
        }
      }

      let fipeV = null, fipeA = null;
      try { const ba = require('./baseAnapolis'); fipeV = ba.getAncora(dados.tipo, 'venda', dados.cidade, dados.bairro); fipeA = ba.getAncora(dados.tipo, 'aluguel', dados.cidade, dados.bairro); } catch {}
      const temInfra = enr.infraestrutura && enr.infraestrutura.some((i) => i.qtd > 0);
      if (fipeV || temInfra || enr.tendencia) {
        band('LOCALIZAÇÃO E REGIÃO');
        if (fipeV) linha(`FIPE da região (${txt(dados.bairro)})`, `venda ${brlF(fipeV.m2)}/m² · aluguel R$ ${fipeA.m2.toLocaleString('pt-BR')}/m²·mês`);
        if (temInfra) {
          const partes = enr.infraestrutura.filter((i) => i.qtd > 0).map((i) => `${i.categoria} ${i.qtd}${i.maisProximoM ? ` (${i.maisProximoM}m)` : ''}`);
          linha('Infraestrutura (1,5 km)', partes.join(' · '));
        }
        if (enr.tendencia) { ensure(20); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text('Tendência: ', LX + 4, y, { continued: true, width: W - 8 }); doc.font('Helvetica').fontSize(8).fillColor(INK).text(clean(enr.tendencia)); y = doc.y + 4; }
      }
    } catch {}

    // ── FONTES E REFERÊNCIAS (técnica e cliente) ──
    try {
      const ff = require('./fontes').fontesAvaliacao(dados, resultado);
      band('FONTES E REFERÊNCIAS');
      const linha = (k, v) => { ensure(13); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${k}: `, LX + 4, y, { continued: true, width: W - 8 }); doc.font('Helvetica').fontSize(8).fillColor(INK).text(clean(String(v))); y = doc.y + 3; };
      linha('Método', ff.metodo);
      linha('Base', `${ff.amostra} · coletado em ${ff.data} · fundamentação ${ff.grau}`);
      if (ff.portais && ff.portais.length) linha('Portais de mercado', ff.portais.join(', '));
      if (ff.bases && ff.bases.length) {
        ensure(13); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text('Bases oficiais:', LX + 4, y); y = doc.y + 2;
        ff.bases.forEach((b) => { ensure(12); doc.font('Helvetica').fontSize(8).fillColor(INK).text(`• ${clean(b)}`, LX + 10, y, { width: W - 14 }); y = doc.y + 2; });
      }
      if (ff.links && ff.links.length) {
        ensure(13); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text('Anúncios consultados (links):', LX + 4, y); y = doc.y + 2;
        ff.links.slice(0, 6).forEach((u) => { ensure(12); doc.font('Helvetica').fontSize(7.5).fillColor(BLUE).text(clean(u), LX + 10, y, { width: W - 14, link: u, underline: true }); y = doc.y + 2; });
      }
      y += 6;
    } catch {}

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
    ensure(108);
    y += 62;
    desenharAssinatura(doc, LX + half / 2, y);
    doc.lineWidth(0.7).strokeColor(NAVY).moveTo(LX + half / 2 - 80, y).lineTo(LX + half / 2 + 80, y).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(LABEL).text('CORRETOR RESPONSÁVEL', LX + half / 2 - 80, y + 5, { width: 160, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(`${CORRETOR}`, LX + half / 2 - 90, y + 16, { width: 180, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${CRECI_F} · ${RAZAO} (${CRECI_J})`, LX + half / 2 - 90, y + 28, { width: 180, align: 'center' });
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

/**
 * PDF do Estudo de Viabilidade Comercial (aba Ponto Comercial).
 * Mesma identidade Bens. Recebe o objeto `analise` de analisarPontoComercial.
 */
function gerarDossiePdf(analise, opts = {}) {
  const a = analise || {};
  const solicitante = opts.solicitante || '';
  const dataEmissao = new Date().toLocaleDateString('pt-BR');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: TOP, bottom: BOTTOM, left: LX, right: 44 } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = TOP;
    const ensure = (need) => { if (y + need > PAGE_H - BOTTOM) { doc.addPage(); y = TOP; } };

    const chrome = () => {
      doc.rect(0, 0, PAGE_W, 64).fill(BLUE);
      try { doc.image(LOGO, LX, 22, { height: 20 }); } catch {}
      doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE).text('Estudo de Viabilidade Comercial', LX, 21, { width: W, align: 'right' });
      doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text('Bens Imóveis Corporativos · Inteligência Comercial', LX, 38, { width: W, align: 'right' });
      const fy = PAGE_H - 46;
      doc.page.margins.bottom = 0;
      doc.moveTo(LX, fy).lineTo(RX, fy).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${RAZAO} · ${CRECI_J} · ${ENDERECO}`, LX, fy + 5, { width: W, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${CONTATO}  ·  documento gerado por Precifica Aí`, LX, fy + 15, { width: W * 0.8, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`Emitido em ${dataEmissao}`, RX - 120, fy + 15, { width: 120, align: 'right' });
    };

    const band = (title) => { ensure(22); doc.rect(LX, y, W, 15).fill(BLUE); doc.font('Helvetica-Bold').fontSize(8).fillColor(WHITE).text(title, LX + 8, y + 4, { lineBreak: false }); y += 20; };
    const paragraph = (t, size = 8.5) => { ensure(28); doc.font('Helvetica').fontSize(size).fillColor(INK).text(clean(t), LX, y, { width: W, align: 'justify', lineGap: 1.5 }); y = doc.y + 8; };
    const kv = (k, v) => { ensure(13); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${k}: `, LX + 4, y, { continued: true, width: W - 8 }); doc.font('Helvetica').fontSize(8).fillColor(INK).text(clean(String(v))); y = doc.y + 3; };

    // Título
    doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text('ESTUDO DE VIABILIDADE COMERCIAL', LX, y, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(BLUE).text('Análise de ponto comercial por amostragem', LX, y + 20, { width: W, align: 'center' });
    y += 38;

    // Identificação
    const cell = (x, w, label, value) => {
      doc.rect(x, y, w, 24).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(5.5).fillColor(LABEL).text(String(label).toUpperCase(), x + 5, y + 4, { width: w - 10, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(value || '—', x + 5, y + 12, { width: w - 10, height: 10, ellipsis: true, lineBreak: false });
    };
    cell(LX, W * 0.55, 'Ramo do cliente', cap(a.ramo));
    cell(LX + W * 0.55, W * 0.45, 'Solicitante', txt(solicitante)); y += 24;
    cell(LX, W * 0.55, 'Local', `${txt(a.bairro)} — ${txt(a.cidade || 'Anápolis')}/GO`);
    cell(LX + W * 0.55, W * 0.45, 'Responsável', `${CORRETOR} · ${CRECI_F}`); y += 24;
    y += 10;

    // Veredito
    ensure(52);
    doc.roundedRect(LX, y, W, 44, 8).fill(BLUE);
    doc.font('Helvetica').fontSize(8).fillColor('#cfe0ff').text('VEREDITO', LX + 16, y + 9);
    doc.font('Helvetica-Bold').fontSize(17).fillColor(WHITE).text(`${txt(a.veredito)}`, LX + 16, y + 19);
    doc.font('Helvetica-Bold').fontSize(20).fillColor(WHITE).text(`${a.score}/100`, RX - 130, y + 13, { width: 114, align: 'right' });
    y += 54;

    // Mapa
    if (a.mapaDataUri && typeof a.mapaDataUri === 'string' && a.mapaDataUri.includes(',')) {
      try {
        const img = Buffer.from(a.mapaDataUri.split(',')[1], 'base64');
        const h = Math.round(W * 0.5);
        ensure(h + 6);
        doc.image(img, LX, y, { width: W, height: h });
        y += h + 8;
      } catch {}
    }

    // Concorrência
    band('CONCORRÊNCIA (MESMO RAMO)');
    const c5 = a.concorrencia?.em500m || {}, c1 = a.concorrencia?.em1km || {};
    kv('Em 500m', `${c5.total || 0}${a.concorrencia?.capado500 ? '+' : ''}${c5.notaMedia ? ` (nota média ${c5.notaMedia})` : ''}`);
    kv('Em 1km', `${c1.total || 0}${a.concorrencia?.capado1k ? '+' : ''}`);
    if (Array.isArray(c5.top) && c5.top.length) kv('Principais', c5.top.slice(0, 4).map(x => `${x.nome}${x.nota ? ` (${x.nota})` : ''}`).join(' · '));

    // Fluxo
    if (Array.isArray(a.movimento?.geradores)) {
      band('FLUXO / GERADORES DE MOVIMENTO (500m)');
      a.movimento.geradores.forEach((g) => kv(g.label, `${g.qtd}${g.capado ? '+' : ''}`));
    }

    // Demanda
    if (a.demanda?.populacao || a.demanda?.pibPerCapita) {
      band('DEMANDA (IBGE)');
      if (a.demanda.populacao) kv('População do município', Number(a.demanda.populacao).toLocaleString('pt-BR'));
      if (a.demanda.pibPerCapita) kv('PIB per capita', brl(a.demanda.pibPerCapita));
    }

    // Potencial financeiro
    if (a.ticket && (a.ticket.ticketMedio || a.ticket.faturamentoMensal)) {
      band('POTENCIAL FINANCEIRO (ESTIMADO)');
      if (a.ticket.ticketMedio) kv('Ticket médio', a.ticket.ticketMedio);
      if (a.ticket.faturamentoMensal) kv('Faturamento mensal', a.ticket.faturamentoMensal);
      if (a.ticket.racional) paragraph(a.ticket.racional);
    }

    // Melhores ruas
    if (a.ruas && Array.isArray(a.ruas.ruas) && a.ruas.ruas.length) {
      band('MELHORES RUAS PARA O PONTO');
      a.ruas.ruas.slice(0, 3).forEach((r) => {
        ensure(20);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BLUE).text(`• ${clean(r.nome)}`, LX + 4, y, { width: W - 8 });
        y = doc.y + 1;
        if (r.motivo) { doc.font('Helvetica').fontSize(8).fillColor(INK).text(clean(r.motivo), LX + 12, y, { width: W - 16, align: 'justify' }); y = doc.y + 4; }
      });
      y += 2;
    }

    // Custo comercial
    if (a.precoComercial && (a.precoComercial.vendaM2 || a.precoComercial.aluguelM2)) {
      band('CUSTO DO PONTO COMERCIAL');
      if (a.precoComercial.vendaM2) kv('Compra', `${brl(a.precoComercial.vendaM2)}/m²`);
      if (a.precoComercial.aluguelM2) kv('Aluguel', `${brl(a.precoComercial.aluguelM2)}/m² por mês`);
    }

    // Parecer
    if (a.parecer) { band('PARECER BENS'); paragraph(a.parecer); }

    // Ressalvas + assinatura
    // ── FONTES E METODOLOGIA ──
    try {
      const ff = require('./fontes').fontesComercial(a);
      band('FONTES E METODOLOGIA');
      kv('Método', ff.metodo);
      kv('Base', `${ff.amostra} · consulta em ${ff.data}`);
      if (ff.bases && ff.bases.length) {
        ensure(13); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text('Fontes:', LX + 4, y); y = doc.y + 2;
        ff.bases.forEach((b) => { ensure(12); doc.font('Helvetica').fontSize(8).fillColor(INK).text(`• ${clean(b)}`, LX + 10, y, { width: W - 14 }); y = doc.y + 2; });
      }
      y += 4;
    } catch {}

    band('RESSALVAS');
    paragraph('Estudo de apoio à decisão, baseado em negócios listados no Google Maps, dados públicos (IBGE) e anúncios de mercado na data de emissão. Ticket médio e faturamento são ESTIMATIVAS (escaladas pelo perfil de renda da região), não garantia de resultado. Custo do ponto comercial é por amostragem de oferta.', 8);

    ensure(60);
    y += 14;
    const half = W / 2;
    doc.lineWidth(0.7).strokeColor(NAVY).moveTo(LX + half / 2 - 80, y).lineTo(LX + half / 2 + 80, y).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(LABEL).text('CONSULTOR RESPONSÁVEL', LX + half / 2 - 80, y + 5, { width: 160, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(CORRETOR, LX + half / 2 - 90, y + 16, { width: 180, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${CRECI_F} · ${RAZAO} (${CRECI_J})`, LX + half / 2 - 90, y + 28, { width: 180, align: 'center' });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) { doc.switchToPage(range.start + i); chrome(); }
    doc.flushPages();
    doc.end();
  });
}

/**
 * PDF da Avaliação de Empresa / passagem de ponto. Recebe o `resultado` de
 * valuationEmpresa.avaliarEmpresa. Mesma identidade Bens.
 */
function gerarEmpresaPdf(r, opts = {}) {
  const solicitante = opts.solicitante || '';
  const dataEmissao = new Date().toLocaleDateString('pt-BR');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: TOP, bottom: BOTTOM, left: LX, right: 44 } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    let y = TOP;
    const ensure = (need) => { if (y + need > PAGE_H - BOTTOM) { doc.addPage(); y = TOP; } };
    const chrome = () => {
      doc.rect(0, 0, PAGE_W, 64).fill(BLUE);
      try { doc.image(LOGO, LX, 22, { height: 20 }); } catch {}
      doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE).text('Avaliação de Empresa', LX, 21, { width: W, align: 'right' });
      doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text('Bens Imóveis Corporativos · Passagem de ponto', LX, 38, { width: W, align: 'right' });
      const fy = PAGE_H - 46; doc.page.margins.bottom = 0;
      doc.moveTo(LX, fy).lineTo(RX, fy).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${RAZAO} · ${CRECI_J} · ${ENDERECO}`, LX, fy + 5, { width: W, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${CONTATO}  ·  documento gerado por Precifica Aí`, LX, fy + 15, { width: W * 0.8, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`Emitido em ${dataEmissao}`, RX - 120, fy + 15, { width: 120, align: 'right' });
    };
    const band = (title) => { ensure(22); doc.rect(LX, y, W, 15).fill(BLUE); doc.font('Helvetica-Bold').fontSize(8).fillColor(WHITE).text(title, LX + 8, y + 4, { lineBreak: false }); y += 20; };
    const paragraph = (t, size = 8.5) => { ensure(28); doc.font('Helvetica').fontSize(size).fillColor(INK).text(clean(t), LX, y, { width: W, align: 'justify', lineGap: 1.5 }); y = doc.y + 8; };
    const kv = (k, v) => { ensure(13); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${k}: `, LX + 4, y, { continued: true, width: W - 8 }); doc.font('Helvetica').fontSize(8).fillColor(INK).text(clean(String(v))); y = doc.y + 3; };

    doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text('AVALIAÇÃO DE EMPRESA', LX, y, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(BLUE).text('Parecer de valor para venda / passagem de ponto', LX, y + 20, { width: W, align: 'center' });
    y += 38;

    const cell = (x, w, label, value) => {
      doc.rect(x, y, w, 24).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(5.5).fillColor(LABEL).text(String(label).toUpperCase(), x + 5, y + 4, { width: w - 10, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(value || '—', x + 5, y + 12, { width: w - 10, height: 10, ellipsis: true, lineBreak: false });
    };
    cell(LX, W * 0.55, 'Ramo do negócio', cap(r.ramo));
    cell(LX + W * 0.55, W * 0.45, 'Solicitante', txt(solicitante)); y += 24;
    cell(LX, W * 0.55, 'Local', `${txt(r.bairro)} — ${txt(r.cidade || 'Anápolis')}/GO`);
    cell(LX + W * 0.55, W * 0.45, 'Responsável', `${CORRETOR} · ${CRECI_F}`); y += 24;
    y += 10;

    ensure(58);
    doc.roundedRect(LX, y, W, 50, 8).fill(BLUE);
    doc.font('Helvetica').fontSize(8).fillColor('#cfe0ff').text('VALOR SUGERIDO DA EMPRESA', LX + 16, y + 9);
    doc.font('Helvetica-Bold').fontSize(20).fillColor(WHITE).text(brl(r.valorSugerido), LX + 16, y + 20);
    doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text('FAIXA DE NEGOCIAÇÃO', RX - 200, y + 9, { width: 190, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(WHITE).text(`${brl(r.faixaMin)} – ${brl(r.faixaMax)}`, RX - 200, y + 22, { width: 190, align: 'right' });
    y += 60;

    band('OS NÚMEROS DO NEGÓCIO');
    kv('Faturamento', `${brl(r.faturamentoMensal)}/mês`);
    kv('Lucro líquido', `${brl(r.lucroMensal)}/mês (margem ${r.margem}%)${r.lucroEstimado ? ' — estimado' : ''}`);
    if (r.dividas) kv('Dívidas', brl(r.dividas));
    if (r.ativos) kv('Equipamentos/estoque', brl(r.ativos));

    band('COMO CHEGAMOS NO VALOR (3 MÉTODOS)');
    kv('Pela rentabilidade (principal)', `lucro × ${r.multiplicadorMeses} meses = ${brl(r.metodos.rentabilidade)}`);
    kv('Pelo faturamento', brl(r.metodos.faturamento));
    kv('Pelo patrimônio (piso)', `${brl(r.metodos.patrimonial)} (equipamentos − dívidas)`);
    if (Array.isArray(r.fatores) && r.fatores.length) {
      ensure(13); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text('O que pesou no múltiplo:', LX + 4, y); y = doc.y + 2;
      r.fatores.forEach((f) => { ensure(12); doc.font('Helvetica').fontSize(8).fillColor(INK).text(`• ${clean(f)}`, LX + 10, y, { width: W - 14 }); y = doc.y + 2; });
      y += 2;
    }

    if (r.parecer) { band('PARECER BENS'); paragraph(r.parecer); }

    try {
      const ff = require('./fontes').fontesEmpresa(r);
      band('FONTES E METODOLOGIA');
      kv('Método', ff.metodo);
      kv('Base', `${ff.amostra} · ${ff.data}`);
      if (ff.bases && ff.bases.length) ff.bases.forEach((b) => kv('Referência', b));
    } catch {}

    band('RESSALVAS');
    paragraph('Parecer mercadológico de apoio à negociação, emitido por corretor de imóveis. NÃO é avaliação contábil nem laudo pericial. Os valores dependem da veracidade dos números informados (faturamento, lucro, dívidas) — confirme com documentos e um contador antes de fechar.', 8);

    ensure(56);
    y += 14;
    const half = W / 2;
    doc.lineWidth(0.7).strokeColor(NAVY).moveTo(LX + half / 2 - 80, y).lineTo(LX + half / 2 + 80, y).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(LABEL).text('CONSULTOR RESPONSÁVEL', LX + half / 2 - 80, y + 5, { width: 160, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(CORRETOR, LX + half / 2 - 90, y + 16, { width: 180, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${CRECI_F} · ${RAZAO} (${CRECI_J})`, LX + half / 2 - 90, y + 28, { width: 180, align: 'center' });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) { doc.switchToPage(range.start + i); chrome(); }
    doc.flushPages();
    doc.end();
  });
}

/**
 * PDF do LAUDO DE REPASSE — valor de mercado vs preço de repasse (venda rápida).
 */
function gerarRepassePdf(dados, resultado, opts = {}) {
  const { calcularRepasse } = require('./repasse');
  const r = calcularRepasse(resultado, opts.desconto);
  const estrategia = opts.estrategia || '';
  const solicitante = opts.solicitante || '';
  const dataEmissao = new Date().toLocaleDateString('pt-BR');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: TOP, bottom: BOTTOM, left: LX, right: 44 } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    let y = TOP;
    const ensure = (need) => { if (y + need > PAGE_H - BOTTOM) { doc.addPage(); y = TOP; } };
    const chrome = () => {
      doc.rect(0, 0, PAGE_W, 64).fill(BLUE);
      try { doc.image(LOGO, LX, 22, { height: 20 }); } catch {}
      doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE).text('Oportunidade de Repasse', LX, 21, { width: W, align: 'right' });
      doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text('Bens Imóveis Corporativos · Venda rápida', LX, 38, { width: W, align: 'right' });
      const fy = PAGE_H - 46; doc.page.margins.bottom = 0;
      doc.moveTo(LX, fy).lineTo(RX, fy).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${RAZAO} · ${CRECI_J} · ${ENDERECO}`, LX, fy + 5, { width: W, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${CONTATO}  ·  documento gerado por Precifica Aí`, LX, fy + 15, { width: W * 0.8, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`Emitido em ${dataEmissao}`, RX - 120, fy + 15, { width: 120, align: 'right' });
    };
    const band = (title) => { ensure(22); doc.rect(LX, y, W, 15).fill(BLUE); doc.font('Helvetica-Bold').fontSize(8).fillColor(WHITE).text(title, LX + 8, y + 4, { lineBreak: false }); y += 20; };
    const paragraph = (t, size = 8.5) => { ensure(28); doc.font('Helvetica').fontSize(size).fillColor(INK).text(clean(t), LX, y, { width: W, align: 'justify', lineGap: 1.5 }); y = doc.y + 8; };
    const kv = (k, v) => { ensure(13); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${k}: `, LX + 4, y, { continued: true, width: W - 8 }); doc.font('Helvetica').fontSize(8).fillColor(INK).text(clean(String(v))); y = doc.y + 3; };

    doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text('LAUDO DE REPASSE', LX, y, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(BLUE).text('Oportunidade de compra abaixo do valor de mercado', LX, y + 20, { width: W, align: 'center' });
    y += 38;

    const cell = (x, w, label, value) => {
      doc.rect(x, y, w, 24).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(5.5).fillColor(LABEL).text(String(label).toUpperCase(), x + 5, y + 4, { width: w - 10, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(value || '—', x + 5, y + 12, { width: w - 10, height: 10, ellipsis: true, lineBreak: false });
    };
    const end = [dados.endereco, dados.bairro].filter(Boolean).join(', ');
    cell(LX, W * 0.6, 'Imóvel', `${cap(dados.tipo)} — ${end || txt(dados.bairro)}, ${txt(dados.cidade || 'Anápolis')}/GO`);
    cell(LX + W * 0.6, W * 0.4, 'Solicitante', txt(solicitante)); y += 24;
    cell(LX, W, 'Características', `${num(dados.metragem)}m²${dados.quartos ? ` · ${num(dados.quartos)} quartos` : ''}${dados.vagas ? ` · ${num(dados.vagas)} vaga(s)` : ''} · ${cap(dados.conservacao)}`); y += 24;
    y += 10;

    // Dois quadros: mercado x repasse
    const halfBox = (W - 12) / 2;
    ensure(64);
    doc.roundedRect(LX, y, halfBox, 58, 8).lineWidth(1).strokeColor(LINE).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('VALOR DE MERCADO', LX + 14, y + 12);
    doc.font('Helvetica-Bold').fontSize(17).fillColor(NAVY).text(brl(r.valorMercado), LX + 14, y + 24);
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(`venda em ~${r.tempoMercadoDias} dias`, LX + 14, y + 46);
    doc.roundedRect(LX + halfBox + 12, y, halfBox, 58, 8).fill(BLUE);
    doc.font('Helvetica').fontSize(8).fillColor('#cfe0ff').text(`PREÇO DE REPASSE (-${r.desconto}%)`, LX + halfBox + 26, y + 12);
    doc.font('Helvetica-Bold').fontSize(17).fillColor(WHITE).text(brl(r.repasse), LX + halfBox + 26, y + 24);
    doc.font('Helvetica').fontSize(7).fillColor('#cfe0ff').text(`venda em ~${r.tempoRepasseDias} dias`, LX + halfBox + 26, y + 46);
    y += 68;

    ensure(34);
    doc.roundedRect(LX, y, W, 28, 6).fill(BAND);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text(`O comprador economiza ${brl(r.economia)}  (${r.desconto}% abaixo do mercado)`, LX, y + 9, { width: W, align: 'center' });
    y += 38;

    if (estrategia) { band('ESTRATÉGIA DE VENDA'); paragraph(estrategia); }

    // Fontes do valor de mercado
    try {
      const ff = require('./fontes').fontesAvaliacao(dados, resultado);
      band('FONTES E METODOLOGIA');
      kv('Valor de mercado', ff.metodo);
      kv('Base', `${ff.amostra} · coletado em ${ff.data} · fundamentação ${ff.grau}`);
      if (ff.bases && ff.bases.length) ff.bases.forEach((b) => { ensure(12); doc.font('Helvetica').fontSize(8).fillColor(INK).text(`• ${clean(b)}`, LX + 10, y, { width: W - 14 }); y = doc.y + 2; });
    } catch {}

    band('RESSALVAS');
    paragraph('O valor de mercado é um parecer por amostragem (ABNT NBR 14653-2). O preço de repasse é uma sugestão comercial de venda rápida, definida com o vendedor — não é obrigação. O tempo de venda é estimativa baseada na liquidez da região.', 8);

    ensure(56);
    y += 14;
    const half = W / 2;
    ensure(108);
    y += 62;
    desenharAssinatura(doc, LX + half / 2, y);
    doc.lineWidth(0.7).strokeColor(NAVY).moveTo(LX + half / 2 - 80, y).lineTo(LX + half / 2 + 80, y).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(LABEL).text('CORRETOR RESPONSÁVEL', LX + half / 2 - 80, y + 5, { width: 160, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(CORRETOR, LX + half / 2 - 90, y + 16, { width: 180, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${CRECI_F} · ${RAZAO} (${CRECI_J})`, LX + half / 2 - 90, y + 28, { width: 180, align: 'center' });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) { doc.switchToPage(range.start + i); chrome(); }
    doc.flushPages();
    doc.end();
  });
}

/**
 * PDF do ESTUDO DE VIABILIDADE DE TERRENO/LOTE (potencial construtivo + incorporação).
 */
function gerarTerrenoPdf(r, opts = {}) {
  const solicitante = opts.solicitante || '';
  const dataEmissao = new Date().toLocaleDateString('pt-BR');
  const num = (v) => Number(v || 0).toLocaleString('pt-BR');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: TOP, bottom: BOTTOM, left: LX, right: 44 } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    let y = TOP;
    const ensure = (need) => { if (y + need > PAGE_H - BOTTOM) { doc.addPage(); y = TOP; } };
    const chrome = () => {
      doc.rect(0, 0, PAGE_W, 64).fill(BLUE);
      try { doc.image(LOGO, LX, 22, { height: 20 }); } catch {}
      doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE).text('Estudo de Viabilidade — Terreno', LX, 21, { width: W, align: 'right' });
      doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text('Bens Imóveis Corporativos · Potencial construtivo e incorporação', LX, 38, { width: W, align: 'right' });
      const fy = PAGE_H - 46; doc.page.margins.bottom = 0;
      doc.moveTo(LX, fy).lineTo(RX, fy).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${RAZAO} · ${CRECI_J} · ${ENDERECO}`, LX, fy + 5, { width: W, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${CONTATO}  ·  documento gerado por Precifica Aí`, LX, fy + 15, { width: W * 0.8, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`Emitido em ${dataEmissao}`, RX - 120, fy + 15, { width: 120, align: 'right' });
    };
    const band = (title) => { ensure(22); doc.rect(LX, y, W, 15).fill(BLUE); doc.font('Helvetica-Bold').fontSize(8).fillColor(WHITE).text(title, LX + 8, y + 4, { lineBreak: false }); y += 20; };
    const paragraph = (t, size = 8.5) => { ensure(28); doc.font('Helvetica').fontSize(size).fillColor(INK).text(clean(t), LX, y, { width: W, align: 'justify', lineGap: 1.5 }); y = doc.y + 8; };
    const kv = (k, v) => { ensure(13); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${k}: `, LX + 4, y, { continued: true, width: W - 8 }); doc.font('Helvetica').fontSize(8).fillColor(INK).text(clean(String(v))); y = doc.y + 3; };

    doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text('ESTUDO DE VIABILIDADE DE TERRENO', LX, y, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(BLUE).text('Avaliação + potencial construtivo + resultado do incorporador', LX, y + 20, { width: W, align: 'center' });
    y += 38;

    const cell = (x, w, label, value) => {
      doc.rect(x, y, w, 24).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(5.5).fillColor(LABEL).text(String(label).toUpperCase(), x + 5, y + 4, { width: w - 10, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(value || '—', x + 5, y + 12, { width: w - 10, height: 10, ellipsis: true, lineBreak: false });
    };
    cell(LX, W * 0.55, 'Local', `${txt(r.bairro)} — ${txt(r.cidade || 'Anápolis')}/GO`);
    cell(LX + W * 0.55, W * 0.45, 'Solicitante', txt(solicitante)); y += 24;
    cell(LX, W * 0.55, 'Terreno', `${num(r.area)} m² · ${txt(r.zonaLabel)}`);
    cell(LX + W * 0.55, W * 0.45, 'Responsável', `${CORRETOR} · ${CRECI_F}`); y += 24;
    y += 10;

    ensure(58);
    doc.roundedRect(LX, y, W, 50, 8).fill(BLUE);
    doc.font('Helvetica').fontSize(8).fillColor('#cfe0ff').text('RESULTADO DO INCORPORADOR', LX + 16, y + 9);
    doc.font('Helvetica-Bold').fontSize(20).fillColor(WHITE).text(`${brl(r.lucro)}`, LX + 16, y + 20);
    doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text('MARGEM SOBRE O VGV', RX - 200, y + 9, { width: 190, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(16).fillColor(WHITE).text(`${r.margem}%  ${clean(String(r.veredito || '')).replace(/[^A-Za-zÀ-ÿ ]/g, '').trim()}`, RX - 200, y + 20, { width: 190, align: 'right' });
    y += 60;

    band('VALOR DE MERCADO DO TERRENO');
    kv('Valor estimado', `${brl(r.valorTerreno)} (${brl(r.precoM2Terreno)}/m²) — confiança ${r.confianca}`);
    if (r.valorPedido) kv('Valor pedido (usado no estudo)', brl(r.valorPedido));

    band('POTENCIAL CONSTRUTIVO');
    kv('Zona', `${txt(r.zonaLabel)} (${txt(r.gabarito)})`);
    kv('Coef. de aproveitamento', `${r.ca}${r.caEstimado ? ' (estimado)' : ''} → constrói até ${num(r.areaConstruivel)} m²`);
    kv('Projeção no térreo', `${num(r.areaProjecao)} m² (taxa de ocupação ${Math.round((r.to || 0) * 100)}%)`);
    kv('Área vendável', `${num(r.areaPrivativa)} m²`);
    if (r.unidades) kv('Unidades possíveis', `≈ ${r.unidades} de ${num(r.areaUnidade)} m²`);

    band(`CONTA DO INCORPORADOR (PRAZO ${r.prazoMeses || 24} MESES)`);
    kv('VGV potencial (tabela)', `${num(r.areaPrivativa)} m² × ${brl(r.precoVendaM2)}/m² = ${brl(r.vgvBruto)}`);
    kv('VGV realizável', `${brl(r.precoVendaRealizavel)}/m² = ${brl(r.vgv)}`);
    kv('(−) Terreno', brl(r.custoTerreno));
    kv('(−) Obra', `CUB ${r.padrao} ${brl(r.cub)}/m² = ${brl(r.custoObra)}`);
    kv('(−) Indiretos da obra', brl(r.custoIndiretoObra));
    kv('(−) Vendas (comissão+marketing)', brl(r.custoVendas));
    kv('(−) Impostos (RET)', brl(r.impostos));
    kv('(−) Custo financeiro', brl(r.custoFinanceiro));
    kv('= Resultado', `${brl(r.lucro)} (margem ${r.margem}% sobre o VGV realizável)`);

    if (r.parecer) { band('PARECER BENS'); paragraph(r.parecer); }

    try {
      const { textoFontes } = require('./fontes');
      band('FONTES E METODOLOGIA');
      kv('Método', 'Avaliação do terreno por amostragem + estudo de massa (potencial construtivo × VGV − custos).');
      kv('Bases', 'Planta Genérica de Valores (Prefeitura de Anápolis), EBM/Aderni-GO, CUB-GO/Sinduscon, IBGE.');
      kv('Consulta em', dataEmissao);
    } catch {}

    band('RESSALVAS');
    paragraph('Estudo preliminar de viabilidade, de apoio à decisão. O coeficiente de aproveitamento e a taxa de ocupação são ESTIMATIVAS por zona — confirme no Plano Diretor / Lei de Uso e Ocupação do Solo de Anápolis. Custo de obra (CUB), eficiência, desconto de tabela e custo financeiro são parâmetros de referência. NÃO substitui projeto arquitetônico, estudo de massa oficial nem viabilidade técnica/jurídica do terreno.', 8);

    ensure(56);
    y += 14;
    const half = W / 2;
    ensure(108);
    y += 62;
    desenharAssinatura(doc, LX + half / 2, y);
    doc.lineWidth(0.7).strokeColor(NAVY).moveTo(LX + half / 2 - 80, y).lineTo(LX + half / 2 + 80, y).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(LABEL).text('CORRETOR RESPONSÁVEL', LX + half / 2 - 80, y + 5, { width: 160, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(CORRETOR, LX + half / 2 - 90, y + 16, { width: 180, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${CRECI_F} · ${RAZAO} (${CRECI_J})`, LX + half / 2 - 90, y + 28, { width: 180, align: 'center' });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) { doc.switchToPage(range.start + i); chrome(); }
    doc.flushPages();
    doc.end();
  });
}

function gerarBtsPdf(r, opts = {}) {
  const solicitante = opts.solicitante || '';
  const dataEmissao = new Date().toLocaleDateString('pt-BR');
  const num = (v) => Number(v || 0).toLocaleString('pt-BR');
  const pct = (v) => `${(Number(v || 0) * 100).toFixed(2)}%`;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: TOP, bottom: BOTTOM, left: LX, right: 44 } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    let y = TOP;
    const ensure = (need) => { if (y + need > PAGE_H - BOTTOM) { doc.addPage(); y = TOP; } };
    const chrome = () => {
      doc.rect(0, 0, PAGE_W, 64).fill(BLUE);
      try { doc.image(LOGO, LX, 22, { height: 20 }); } catch {}
      doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE).text('Estudo BTS — Build to Suit', LX, 21, { width: W, align: 'right' });
      doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text('Bens Imóveis Corporativos · Viabilidade de investimento por locação', LX, 38, { width: W, align: 'right' });
      const fy = PAGE_H - 46; doc.page.margins.bottom = 0;
      doc.moveTo(LX, fy).lineTo(RX, fy).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${RAZAO} · ${CRECI_J} · ${ENDERECO}`, LX, fy + 5, { width: W, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${CONTATO}  ·  documento gerado por Precifica Aí`, LX, fy + 15, { width: W * 0.8, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`Emitido em ${dataEmissao}`, RX - 120, fy + 15, { width: 120, align: 'right' });
    };
    const band = (title) => { ensure(22); doc.rect(LX, y, W, 15).fill(BLUE); doc.font('Helvetica-Bold').fontSize(8).fillColor(WHITE).text(title, LX + 8, y + 4, { lineBreak: false }); y += 20; };
    const paragraph = (t, size = 8.5) => { ensure(28); doc.font('Helvetica').fontSize(size).fillColor(INK).text(clean(t), LX, y, { width: W, align: 'justify', lineGap: 1.5 }); y = doc.y + 8; };
    const kv = (k, v) => { ensure(13); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${k}: `, LX + 4, y, { continued: true, width: W - 8 }); doc.font('Helvetica').fontSize(8).fillColor(INK).text(clean(String(v))); y = doc.y + 3; };

    doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text('ESTUDO DE VIABILIDADE BTS', LX, y, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(BLUE).text('Investimento + custo de obra × aluguel de mercado (cap rate) + melhor uso', LX, y + 20, { width: W, align: 'center' });
    y += 38;

    const cell = (x, w, label, value) => {
      doc.rect(x, y, w, 24).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(5.5).fillColor(LABEL).text(String(label).toUpperCase(), x + 5, y + 4, { width: w - 10, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(value || '—', x + 5, y + 12, { width: w - 10, height: 10, ellipsis: true, lineBreak: false });
    };
    cell(LX, W * 0.55, 'Local', `${txt(r.bairro)} — ${txt(r.cidade || 'Anápolis')}/GO`);
    cell(LX + W * 0.55, W * 0.45, 'Solicitante', txt(solicitante)); y += 24;
    cell(LX, W * 0.55, 'Terreno', `${num(r.area)} m² · locável ${num(r.areaLocavel)} m²`);
    cell(LX + W * 0.55, W * 0.45, 'Responsável', `${CORRETOR} · ${CRECI_F}`); y += 24;
    y += 10;

    ensure(58);
    doc.roundedRect(LX, y, W, 50, 8).fill(BLUE);
    doc.font('Helvetica').fontSize(8).fillColor('#cfe0ff').text('CAP RATE (RETORNO DO INVESTIDOR)', LX + 16, y + 9);
    doc.font('Helvetica-Bold').fontSize(20).fillColor(WHITE).text(`${pct(r.yieldMes)}/mês`, LX + 16, y + 20);
    doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text('AO ANO / VEREDITO', RX - 200, y + 9, { width: 190, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(16).fillColor(WHITE).text(`${(r.yieldAno * 100).toFixed(1)}%  ${clean(String(r.veredito || '')).replace(/[^A-Za-zÀ-ÿ ]/g, '').trim()}`, RX - 200, y + 20, { width: 190, align: 'right' });
    y += 60;

    band('O QUE DÁ PRA CONSTRUIR');
    kv('Valor do terreno', `${brl(r.custoTerreno)} (${brl(r.precoM2Terreno)}/m²) — confiança ${r.confianca}`);
    kv('Área construível', `${num(r.areaConstruivel)} m²${r.caEstimado ? ` (TO ${Math.round((r.to || 0) * 100)}%${r.pavimentos > 1 ? ` × ${r.pavimentos} pav.` : ''})` : ` (CA ${r.ca})`}`);
    kv('Área locável (GLA)', `${num(r.areaLocavel)} m²`);

    band(`CONTA DO INVESTIDOR BTS (OBRA ${r.prazoMeses || 12} MESES)`);
    kv('(+) Investimento total', brl(r.investimento));
    kv('   – Terreno', brl(r.custoTerreno));
    kv('   – Obra', `${txt(r.obraKey)} ${brl(r.cub)}/m² = ${brl(r.custoObra)}`);
    kv('   – Indiretos da obra', brl(r.custoIndireto));
    kv('(=) Aluguel de mercado', `${num(r.areaLocavel)} m² × ${brl(r.aluguelM2)}/m² = ${brl(r.aluguelMensal)}/mês`);
    kv('Cap rate', `${brl(r.aluguelAnual)}/ano ÷ ${brl(r.investimento)} = ${pct(r.yieldMes)}/mês (${(r.yieldAno * 100).toFixed(1)}%/ano)`);
    kv('Payback (só aluguel)', `${r.paybackAnos} anos`);
    kv(`Aluguel p/ render ${pct(r.yieldAlvo)}/mês`, `${brl(r.aluguelNecessario)}/mês`);

    if (r.ramos && r.ramos.length) {
      band('MELHOR USO PARA O PONTO');
      r.ramos.forEach((x, i) => kv(`${i + 1}. ${txt(x.label)}`, `score ${x.score}/100 · ${x.concorrentes} concorrentes em 1 km`));
    }

    if (r.empresas && ((r.empresas.live && r.empresas.live.length) || (r.empresas.curadas && r.empresas.curadas.length))) {
      band('EMPRESAS EM EXPANSÃO (POSSÍVEIS INQUILINOS/COMPRADORES)');
      (r.empresas.live || []).forEach(e => kv(txt(e.nome), `${txt(e.ramo || '')}${e.status ? ' — ' + txt(e.status) : ''}`));
      if (r.empresas.curadas && r.empresas.curadas.length) kv('Redes do perfil (referência)', r.empresas.curadas.slice(0, 12).join(', '));
    }

    if (r.parecer) { band('PARECER BENS'); paragraph(r.parecer); }

    band('FONTES E METODOLOGIA');
    kv('Método', 'Terreno por amostragem + custo de obra (CUB) × aluguel de mercado = cap rate. Melhor uso por análise de ponto (Google Places); inquilinos por base curada + busca web.');
    kv('Bases', 'EBM/Aderni-GO, Planta Genérica de Valores (Anápolis), CUB-GO/Sinduscon, Google Maps, IBGE.');
    if (r.empresas && r.empresas.fontes && r.empresas.fontes.length) kv('Fontes de expansão (web)', r.empresas.fontes.slice(0, 6).join('  ·  '));
    kv('Consulta em', dataEmissao);

    band('RESSALVAS');
    paragraph(`Estudo preliminar de viabilidade BTS, de apoio à decisão. O cap rate depende de fechar um contrato de locação longo (10-20 anos) com inquilino sólido — sem contrato, o retorno é apenas potencial. Coeficiente/taxa de ocupação, custo de obra (CUB) e eficiência são ESTIMATIVAS — confirme no Plano Diretor de ${txt(r.cidade) || 'Anápolis'} e com orçamento de obra. A lista de empresas é inteligência de mercado (leads qualificados), NÃO demanda confirmada. NÃO substitui projeto, viabilidade técnica/jurídica nem due diligence do inquilino.`, 8);

    ensure(56);
    y += 14;
    const half = W / 2;
    ensure(108);
    y += 62;
    desenharAssinatura(doc, LX + half / 2, y);
    doc.lineWidth(0.7).strokeColor(NAVY).moveTo(LX + half / 2 - 80, y).lineTo(LX + half / 2 + 80, y).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(LABEL).text('CORRETOR RESPONSÁVEL', LX + half / 2 - 80, y + 5, { width: 160, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(CORRETOR, LX + half / 2 - 90, y + 16, { width: 180, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${CRECI_F} · ${RAZAO} (${CRECI_J})`, LX + half / 2 - 90, y + 28, { width: 180, align: 'center' });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) { doc.switchToPage(range.start + i); chrome(); }
    doc.flushPages();
    doc.end();
  });
}

function gerarRadarPdf(r) {
  const dataEmissao = new Date().toLocaleDateString('pt-BR');
  const PORTE = { G: 'Grande (≥3.000m²)', M: 'Médio (600–3.000m²)', P: 'Pequeno (<600m²)' };
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: TOP, bottom: BOTTOM, left: LX, right: 44 } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    let y = TOP;
    const ensure = (need) => { if (y + need > PAGE_H - BOTTOM) { doc.addPage(); y = TOP; } };
    const chrome = () => {
      doc.rect(0, 0, PAGE_W, 64).fill(BLUE);
      try { doc.image(LOGO, LX, 22, { height: 20 }); } catch {}
      doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE).text('Radar de Expansão — Lista de Alvos', LX, 21, { width: W, align: 'right' });
      doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text('Bens Imóveis Corporativos · Prospecção de inquilinos Build to Suit', LX, 38, { width: W, align: 'right' });
      const fy = PAGE_H - 46; doc.page.margins.bottom = 0;
      doc.moveTo(LX, fy).lineTo(RX, fy).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${RAZAO} · ${CRECI_J} · ${ENDERECO}`, LX, fy + 5, { width: W, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${CONTATO}  ·  documento gerado por Precifica Aí`, LX, fy + 15, { width: W * 0.8, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`Emitido em ${dataEmissao}`, RX - 120, fy + 15, { width: 120, align: 'right' });
    };
    const kv = (k, v) => { ensure(12); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${k}: `, LX + 8, y, { continued: true, width: W - 16 }); doc.font('Helvetica').fontSize(8).fillColor(INK).text(clean(String(v))); y = doc.y + 2; };

    doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text('LISTA DE ALVOS — EXPANSÃO', LX, y, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(BLUE).text(`${txt(r.regiao)}${r.ramo ? ' · ' + txt(r.ramo) : ''}${r.porte ? ' · porte ' + (PORTE[r.porte] || '') : ''}`, LX, y + 20, { width: W, align: 'center' });
    y += 40;

    doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(`${(r.empresas || []).length} empresa(s) em modo-expansão que poderiam querer um imóvel na região.`, LX, y, { width: W });
    y = doc.y + 8;

    (r.empresas || []).forEach((e, i) => {
      ensure(56);
      doc.rect(LX, y, W, 15).fill(BLUE);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(WHITE).text(`${i + 1}. ${clean(e.nome)}${e.ramo ? '  ·  ' + clean(e.ramo) : ''}${e.porte ? '  ·  porte ' + e.porte : ''}`, LX + 8, y + 4, { width: W - 16, lineBreak: false });
      y += 19;
      if (e.sinal) kv('Sinal', e.sinal);
      if (e.cidadeAlvo) kv('Alvo', e.cidadeAlvo);
      if (e.imovelBuscado) kv('Imóvel que busca', e.imovelBuscado);
      if (e.statusRegiao) kv('Status na região', e.statusRegiao);
      const contato = [e.telefone ? `📞 ${e.telefone}` : '', e.email ? `✉ ${e.email}` : '', e.site].filter(Boolean).join('   ·   ');
      if (contato) kv('Contato', contato);
      if (e.canalExpansao) kv('Canal de expansão', e.canalExpansao);
      if (e.cnpjMatriz) kv('CNPJ matriz', e.cnpjMatriz + (e.cnpjEmail ? ` · e-mail: ${e.cnpjEmail}` : ''));
      if (e.fonte) kv('Fonte', e.fonte);
      y += 6;
    });

    ensure(40);
    doc.moveTo(LX, y).lineTo(RX, y).lineWidth(0.5).strokeColor(LINE).stroke(); y += 8;
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text('Leads de inteligência de mercado (sinais de expansão), NÃO demanda confirmada. Confirme o interesse direto com a empresa. Fonte: busca web (Perplexity) sobre notícias e anúncios públicos de expansão.', LX, y, { width: W, align: 'justify' });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) { doc.switchToPage(range.start + i); chrome(); }
    doc.flushPages();
    doc.end();
  });
}

function gerarFazendaPdf(r, opts = {}) {
  const solicitante = opts.solicitante || '';
  const dataEmissao = new Date().toLocaleDateString('pt-BR');
  const num = (v) => Number(v || 0).toLocaleString('pt-BR');
  const recreio = r.modo === 'recreio';
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: TOP, bottom: BOTTOM, left: LX, right: 44 } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    let y = TOP;
    const ensure = (need) => { if (y + need > PAGE_H - BOTTOM) { doc.addPage(); y = TOP; } };
    const chrome = () => {
      doc.rect(0, 0, PAGE_W, 64).fill(BLUE);
      try { doc.image(LOGO, LX, 22, { height: 20 }); } catch {}
      doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE).text(recreio ? 'Avaliação — Chácara de Recreio' : 'Avaliação de Imóvel Rural', LX, 21, { width: W, align: 'right' });
      doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text(recreio ? 'Bens Imóveis Corporativos · Chácara de lazer' : 'Bens Imóveis Corporativos · Terra nua + benfeitorias (ref. NBR 14653-3)', LX, 38, { width: W, align: 'right' });
      const fy = PAGE_H - 46; doc.page.margins.bottom = 0;
      doc.moveTo(LX, fy).lineTo(RX, fy).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${RAZAO} · ${CRECI_J} · ${ENDERECO}`, LX, fy + 5, { width: W, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${CONTATO}  ·  documento gerado por Precifica Aí`, LX, fy + 15, { width: W * 0.8, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`Emitido em ${dataEmissao}`, RX - 120, fy + 15, { width: 120, align: 'right' });
    };
    const band = (title) => { ensure(22); doc.rect(LX, y, W, 15).fill(BLUE); doc.font('Helvetica-Bold').fontSize(8).fillColor(WHITE).text(title, LX + 8, y + 4, { lineBreak: false }); y += 20; };
    const paragraph = (t, size = 8.5) => { ensure(28); doc.font('Helvetica').fontSize(size).fillColor(INK).text(clean(t), LX, y, { width: W, align: 'justify', lineGap: 1.5 }); y = doc.y + 8; };
    const kv = (k, v) => { ensure(13); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${k}: `, LX + 4, y, { continued: true, width: W - 8 }); doc.font('Helvetica').fontSize(8).fillColor(INK).text(clean(String(v))); y = doc.y + 3; };

    doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text(recreio ? 'AVALIAÇÃO — CHÁCARA DE RECREIO' : 'AVALIAÇÃO DE IMÓVEL RURAL', LX, y, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(BLUE).text(recreio ? 'Valor por m² de mercado + benfeitorias' : 'Terra nua por aptidão + benfeitorias · 2ª opinião pela renda (ref. NBR 14653-2/3)', LX, y + 20, { width: W, align: 'center' });
    y += 38;

    const cell = (x, w, label, value) => {
      doc.rect(x, y, w, 24).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(5.5).fillColor(LABEL).text(String(label).toUpperCase(), x + 5, y + 4, { width: w - 10, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(value || '—', x + 5, y + 12, { width: w - 10, height: 10, ellipsis: true, lineBreak: false });
    };
    const areaTxt = recreio ? `${num(r.areaM2)} m² (${(r.areaM2 / 10000).toLocaleString('pt-BR')} ha)` : `${num(r.areaAlq)} alq · ${num(r.areaHa)} ha`;
    cell(LX, W * 0.55, 'Local', `${txt(r.referencia || '')} ${txt(r.cidade || 'Anápolis')}/GO`.trim());
    cell(LX + W * 0.55, W * 0.45, 'Solicitante', txt(solicitante)); y += 24;
    cell(LX, W * 0.55, recreio ? 'Chácara de recreio' : 'Imóvel rural', areaTxt);
    cell(LX + W * 0.55, W * 0.45, 'Responsável', `${CORRETOR} · ${CRECI_F}`); y += 24;
    y += 10;

    // Destaque de valor
    if (recreio && r.soValorDefinido) {
      // Laudo de valor definido: UM único valor, sem referência de mercado.
      ensure(58);
      doc.roundedRect(LX, y, W, 50, 8).fill(BLUE);
      doc.font('Helvetica').fontSize(8).fillColor('#cfe0ff').text('VALOR DE AVALIAÇÃO', LX + 16, y + 9);
      doc.font('Helvetica-Bold').fontSize(20).fillColor(WHITE).text(brl(r.total), LX + 16, y + 20);
      doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text('POR METRO QUADRADO', RX - 210, y + 9, { width: 200, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE).text(`${brl(r.precoM2Final)}/m²`, RX - 210, y + 22, { width: 200, align: 'right' });
      y += 60;
    } else if (recreio) {
      const veredito = r.benfValorInformado != null;
      const refEsq = 'SÓ O TERRENO (terra nua)';
      const valEsq = r.terraNuaAj;
      const refDir = veredito ? 'VEREDITO FINAL (com benfeitorias)' : 'COM BENFEITORIAS (estimado)';
      ensure(66);
      doc.roundedRect(LX, y, W, 58, 8).fill(BLUE);
      doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text(refEsq, LX + 16, y + 9);
      doc.font('Helvetica-Bold').fontSize(14).fillColor(WHITE).text(brl(valEsq), LX + 16, y + 19);
      doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text(refDir, RX - 230, y + 9, { width: 220, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(veredito ? 17 : 14).fillColor(WHITE).text(brl(r.total), RX - 230, y + 18, { width: 220, align: 'right' });
      doc.font('Helvetica').fontSize(7).fillColor('#cfe0ff').text(`${brl(r.precoM2Final)}/m²${veredito ? '  ✓ dados completos' : ''}`, RX - 230, y + 40, { width: 220, align: 'right' });
      y += 68;
    } else {
      ensure(58);
      doc.roundedRect(LX, y, W, 50, 8).fill(BLUE);
      doc.font('Helvetica').fontSize(8).fillColor('#cfe0ff').text('VALOR DE MERCADO', LX + 16, y + 9);
      doc.font('Helvetica-Bold').fontSize(20).fillColor(WHITE).text(brl(r.total), LX + 16, y + 20);
      doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text('POR HECTARE / ALQUEIRE', RX - 210, y + 9, { width: 200, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE).text(`${brl(r.rHaFinal)}/ha · ${brl(r.rAlqFinal)}/alq`, RX - 210, y + 22, { width: 200, align: 'right' });
      y += 60;
    }

    if (recreio) {
      band('CARACTERÍSTICAS');
      kv('Distância da cidade', r.distanciaKm ? `${r.distanciaKm} km` : '—');
      kv('Acesso', r.acesso === 'beira' ? 'Beira de asfalto' : r.acesso === 'asfalto' ? 'Asfalto perto' : 'Estrada de chão');
      kv('Infraestrutura', [r.agua ? 'água' : null, r.energia ? 'energia' : null, r.condominio ? 'condomínio fechado' : null].filter(Boolean).join(', ') || '—');
      if (r.benfeitorias && r.benfeitorias.length) kv('Benfeitorias', r.benfeitorias.join(', '));

      if (r.soValorDefinido) {
        band('RESUMO DA AVALIAÇÃO');
        kv('Área total', `${num(r.areaM2)} m² (${(r.areaM2 / 10000).toLocaleString('pt-BR')} ha)`);
        kv('Valor por m²', `${brl(r.precoM2Final)}/m²`);
        kv('Valor de avaliação', brl(r.total));
      } else {
        band('COMPOSIÇÃO DO VALOR');
        kv('Terreno', `${num(r.areaM2)} m² × ${brl(r.precos.m2)}/m² = ${brl(r.terraNua)}`);
        kv('Terreno ajustado (acesso/distância/água)', brl(r.terraNuaAj));
        kv('Benfeitorias', `${brl(r.benfValor)}${r.benfValorInformado != null ? ' (valor informado)' : ' (estimado por percentual)'}`);
        kv('= Com benfeitorias', brl(r.totalMercado != null ? r.totalMercado : r.total));
        if (r.benfValorInformado == null) paragraph('Observação: o valor das benfeitorias foi estimado por percentual (dados incompletos). Para o veredito final preciso, informe o custo de construção da casa/estrutura — a casa costuma ser a maior parte do valor de uma chácara de recreio.', 8);
      }
    } else {
      band('APTIDÃO E TERRA NUA');
      kv('Aptidão', `${r.aptidao.lavoura}% lavoura · ${r.aptidao.pastagem}% pastagem · ${r.aptidao.reserva}% reserva`);
      kv('R$/ha por uso', `lavoura ${brl(r.precos.lavoura)} · pastagem ${brl(r.precos.pastagem)} · reserva ${brl(r.precos.reserva)}`);
      kv('R$/ha ponderado', `${brl(r.rHaMix)} (${r.precos.regiao})`);
      kv('Acesso / relevo / água', `${r.acesso || '—'} · ${r.relevo || '—'} · ${r.agua ? 'com água' : 'sem água'}`);
      kv('Terra nua', `${brl(r.terraNua)} → ajustada ${brl(r.terraNuaAj)}`);
      kv('Benfeitorias', brl(r.benfValor));

      band('2ª OPINIÃO — MÉTODO DA RENDA');
      kv('Renda estimada (arrendamento)', `${brl(r.rendaAnual)}/ano`);
      kv('Valor por capitalização (5,5%)', brl(r.valorRenda));
      if (r.vtn) kv('Piso VTN-INCRA', `${brl(r.vtn)}/ha (≈ ${brl(Math.round(r.vtn * r.areaHa))})`);
    }

    if (r.valorPedido) { band('COMPARAÇÃO'); kv('Valor pedido pelo vendedor', `${brl(r.valorPedido)} (${Math.round((r.valorPedido / r.total - 1) * 100)}% vs. avaliação)`); }

    if (r.parecer) { band('PARECER TÉCNICO'); paragraph(r.parecer); }

    band('DOCUMENTAÇÃO A CONFERIR');
    paragraph('Matrícula atualizada · Georreferenciamento (SIGEF) · CAR (Cadastro Ambiental Rural) · Reserva Legal averbada · ITR/CCIR em dia · ausência de embargo ambiental, sobreposição ou litígio possessório.', 8);

    band('FONTES E RESSALVAS');
    kv('Método', recreio ? 'Comparativo por R$/m² de chácaras de recreio + benfeitorias.' : 'Comparativo por aptidão (terra nua × R$/ha por uso) + benfeitorias, com 2ª opinião pela renda. Ref. ABNT NBR 14653-3.');
    kv('Fontes', recreio ? 'Anúncios de mercado (VivaReal/ZAP/Chaves na Mão/OLX).' : 'Scot/CEPEA/AgriFatto (R$/ha por uso), VTN-INCRA, base regional de Goiás.');
    kv('Consulta em', dataEmissao);
    paragraph('Estimativa mercadológica de apoio à decisão. O valor definitivo depende de vistoria in loco (aptidão/solo/relevo/água), documentação regular e do momento de mercado. Não substitui laudo NBR completo com vistoria. 1 alqueire goiano = 4,84 ha.', 8);

    ensure(56);
    y += 14;
    const half = W / 2;
    ensure(108);
    y += 62;
    desenharAssinatura(doc, LX + half / 2, y);
    doc.lineWidth(0.7).strokeColor(NAVY).moveTo(LX + half / 2 - 80, y).lineTo(LX + half / 2 + 80, y).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(LABEL).text('CORRETOR RESPONSÁVEL', LX + half / 2 - 80, y + 5, { width: 160, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(CORRETOR, LX + half / 2 - 90, y + 16, { width: 180, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${CRECI_F} · ${RAZAO} (${CRECI_J})`, LX + half / 2 - 90, y + 28, { width: 180, align: 'center' });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) { doc.switchToPage(range.start + i); chrome(); }
    doc.flushPages();
    doc.end();
  });
}

function gerarDecisaoPdf(r, opts = {}) {
  const solicitante = opts.solicitante || '';
  const dataEmissao = new Date().toLocaleDateString('pt-BR');
  const A = r.cenarioA, B = r.cenarioB;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: TOP, bottom: BOTTOM, left: LX, right: 44 } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    let y = TOP;
    const ensure = (need) => { if (y + need > PAGE_H - BOTTOM) { doc.addPage(); y = TOP; } };
    const chrome = () => {
      doc.rect(0, 0, PAGE_W, 64).fill(BLUE);
      try { doc.image(LOGO, LX, 22, { height: 20 }); } catch {}
      doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE).text('Alugar × Vender e Investir', LX, 21, { width: W, align: 'right' });
      doc.font('Helvetica').fontSize(7.5).fillColor('#cfe0ff').text('Bens Imóveis Corporativos · Estudo de decisão patrimonial', LX, 38, { width: W, align: 'right' });
      const fy = PAGE_H - 46; doc.page.margins.bottom = 0;
      doc.moveTo(LX, fy).lineTo(RX, fy).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${RAZAO} · ${CRECI_J} · ${ENDERECO}`, LX, fy + 5, { width: W, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`${CONTATO}  ·  documento gerado por Precifica Aí`, LX, fy + 15, { width: W * 0.8, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`Emitido em ${dataEmissao}`, RX - 120, fy + 15, { width: 120, align: 'right' });
    };
    const band = (title) => { ensure(22); doc.rect(LX, y, W, 15).fill(BLUE); doc.font('Helvetica-Bold').fontSize(8).fillColor(WHITE).text(title, LX + 8, y + 4, { lineBreak: false }); y += 20; };
    const paragraph = (t, size = 8.5) => { ensure(28); doc.font('Helvetica').fontSize(size).fillColor(INK).text(clean(t), LX, y, { width: W, align: 'justify', lineGap: 1.5 }); y = doc.y + 8; };
    const kv = (k, v) => { ensure(13); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${k}: `, LX + 4, y, { continued: true, width: W - 8 }); doc.font('Helvetica').fontSize(8).fillColor(INK).text(clean(String(v))); y = doc.y + 3; };

    doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text('ALUGAR × VENDER E INVESTIR', LX, y, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(BLUE).text('Estudo comparativo de decisão patrimonial', LX, y + 20, { width: W, align: 'center' });
    y += 38;

    const cell = (x, w, label, value) => {
      doc.rect(x, y, w, 24).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(5.5).fillColor(LABEL).text(String(label).toUpperCase(), x + 5, y + 4, { width: w - 10, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(value || '—', x + 5, y + 12, { width: w - 10, height: 10, ellipsis: true, lineBreak: false });
    };
    cell(LX, W * 0.34, 'Imóvel', brl(r.valorImovel));
    cell(LX + W * 0.34, W * 0.33, 'Aluguel/mês', brl(r.aluguelMensal));
    cell(LX + W * 0.67, W * 0.33, 'Solicitante', txt(solicitante)); y += 24;
    cell(LX, W * 0.5, 'Taxas hoje', `Selic ${r.taxas.selic}% · CDI ${r.taxas.cdi}% · IPCA ${r.taxas.ipca}%`);
    cell(LX + W * 0.5, W * 0.5, 'Horizonte', `${r.anos} anos`); y += 24;
    y += 10;

    // Dois cartões lado a lado
    const cardH = 96, gap = 10, cw = (W - gap) / 2;
    ensure(cardH + 6);
    const winA = r.vencedor === 'manter';
    // Cartão A
    doc.roundedRect(LX, y, cw, cardH, 8).fillAndStroke(winA ? BLUE : '#eef3fb', winA ? BLUE : LINE);
    let cy = y + 10;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(winA ? WHITE : NAVY).text('A · MANTER ALUGADO', LX + 12, cy); cy += 16;
    const lineA = (k, v, strong) => { doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 9 : 8).fillColor(winA ? WHITE : INK).text(`${k}: ${v}`, LX + 12, cy, { width: cw - 24 }); cy += strong ? 14 : 12; };
    lineA('Renda líquida', `${brl(A.rendaMensal)}/mês`, true);
    lineA('Yield líquido', `${A.yieldLiquido}% a.a.`);
    lineA('+ Valorização', `${r.premissas.valorizacao}% a.a. → ${A.retornoTotal}%`);
    lineA(`Patrimônio ${r.anos} anos`, brl(A.patrimonio), true);
    // Cartão B
    const bx = LX + cw + gap;
    const winB = r.vencedor === 'vender';
    doc.roundedRect(bx, y, cw, cardH, 8).fillAndStroke(winB ? BLUE : '#eef3fb', winB ? BLUE : LINE);
    cy = y + 10;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(winB ? WHITE : NAVY).text('B · VENDER E INVESTIR', bx + 12, cy); cy += 16;
    const lineB = (k, v, strong) => { doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 9 : 8).fillColor(winB ? WHITE : INK).text(`${k}: ${v}`, bx + 12, cy, { width: cw - 24 }); cy += strong ? 14 : 12; };
    lineB('Líquido da venda', brl(B.liquidoVenda), true);
    lineB('Renda títulos', `${brl(B.rendaMensal)}/mês`);
    lineB('Taxa líquida', `${B.taxaLiquida}% a.a.`);
    lineB(`Patrimônio ${r.anos} anos`, brl(B.patrimonio), true);
    y += cardH + 12;

    band('VEREDITO');
    if (r.vencedor === 'manter') kv('Maior patrimônio', `Manter alugado: +${brl(r.difPatr)} em ${r.anos} anos (${r.difPatrPct >= 0 ? '+' : ''}${r.difPatrPct}%)`);
    else kv('Maior patrimônio', `Vender e investir: +${brl(r.difPatr)} em ${r.anos} anos`);
    kv('Renda mensal', r.difRendaMensal >= 0 ? `Alugar entrega +${brl(r.difRendaMensal)}/mês` : `Títulos entregam +${brl(-r.difRendaMensal)}/mês`);

    if (r.parecer) { band('PARECER'); paragraph(r.parecer); }

    band('PREMISSAS (editáveis)');
    kv('Aluguel', `vacância ${r.premissas.vacancia}% · administração ${r.premissas.taxaAdmin}% · IPTU ${brl(r.premissas.iptuAnual)}/ano · IR ${r.premissas.irAluguel}%`);
    kv('Valorização do imóvel', `${r.premissas.valorizacao}% a.a.`);
    kv('Venda', `custos ${r.premissas.custoVenda}%${r.premissas.impostoGanho ? ` · IR ganho ${brl(r.premissas.impostoGanho)}` : ''}`);
    kv('Títulos', `${r.premissas.taxaTitulos}% a.a. bruto · IR ${r.premissas.irTitulos}%`);

    band('RESSALVAS');
    paragraph('Estudo comparativo de apoio à decisão — NÃO é recomendação de compra de valor mobiliário nem consultoria de investimentos. As premissas (vacância, valorização, IR, taxa dos títulos) afetam diretamente o resultado; valide com contador e assessor de investimentos. O IR sobre ganho de capital na venda pode ter isenções (ex.: uso do valor na compra de outro imóvel residencial em 180 dias). Taxas Selic/CDI/IPCA: Banco Central via BrasilAPI, em ' + r.taxas.data + '.', 8);

    ensure(56);
    y += 14;
    const half = W / 2;
    ensure(108);
    y += 62;
    desenharAssinatura(doc, LX + half / 2, y);
    doc.lineWidth(0.7).strokeColor(NAVY).moveTo(LX + half / 2 - 80, y).lineTo(LX + half / 2 + 80, y).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(LABEL).text('CORRETOR RESPONSÁVEL', LX + half / 2 - 80, y + 5, { width: 160, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(CORRETOR, LX + half / 2 - 90, y + 16, { width: 180, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${CRECI_F} · ${RAZAO} (${CRECI_J})`, LX + half / 2 - 90, y + 28, { width: 180, align: 'center' });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) { doc.switchToPage(range.start + i); chrome(); }
    doc.flushPages();
    doc.end();
  });
}

module.exports = { gerarRelatorioPdf, gerarDossiePdf, gerarEmpresaPdf, gerarRepassePdf, gerarTerrenoPdf, gerarBtsPdf, gerarRadarPdf, gerarFazendaPdf, gerarDecisaoPdf };
