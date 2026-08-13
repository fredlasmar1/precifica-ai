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
        if (fp.anoConstrucao) linhas.push(['Construção', `${fp.anoConstrucao} (${new Date().getFullYear() - fp.anoConstrucao} anos)`]);
        if (fp.lazer && fp.lazer.length) linhas.push(['Lazer', fp.lazer.slice(0, 8).join(', ')]);
        if (fp.condominioMensal) linhas.push(['Condomínio/mês', typeof fp.condominioMensal === 'number' ? brl(fp.condominioMensal) : String(fp.condominioMensal)]);
        if (fp.iptu) linhas.push(['IPTU/ano', `${brl(fp.iptu)} (${fp.iptuFonte})`]);
        if (fp.perfilUnidades) linhas.push([fp.perfilConfirmado ? 'Unidades' : 'Unidades (perfil do entorno — NÃO confirmado neste prédio)', fp.perfilUnidades]);
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

/**
 * PARECER TÉCNICO DE AVALIAÇÃO POR AMOSTRAGEM (matrícula + fotos).
 * Estrutura de 16 seções, papel timbrado da Bens Imóveis Corporativos e
 * assinatura do corretor responsável — a mesma identidade dos outros nove
 * relatórios do sistema.
 */
function gerarMatriculaPdf(r, opts = {}) {
  const solicitante = opts.solicitante || r.solicitante || '';
  const dataEmissao = new Date().toLocaleDateString('pt-BR');
  const m = r.matricula || {};
  const im = m.imovel || {};
  const fotos = r.leituraFotos || null;
  const mk = r.mercado || {};
  const ACCENT = BLUE, SOFT = '#cfe0ff';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: TOP, bottom: BOTTOM, left: LX, right: 44 } });
    const chunks = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    let y = TOP;
    const ensure = (need) => { if (y + need > PAGE_H - BOTTOM) { doc.addPage(); y = TOP; } };

    const chrome = () => {
      doc.rect(0, 0, PAGE_W, 64).fill(ACCENT);
      try { doc.image(LOGO, LX, 22, { height: 20 }); } catch {}
      doc.font('Helvetica-Bold').fontSize(11).fillColor(WHITE).text('Parecer técnico de avaliação', LX, 21, { width: W, align: 'right' });
      doc.font('Helvetica').fontSize(7.5).fillColor(SOFT)
        .text(`Matrícula nº ${txt(m.numero)}${m.cartorio ? ' · ' + clean(m.cartorio) : ''}`, LX, 38, { width: W, align: 'right' });
      const fy = PAGE_H - 46; doc.page.margins.bottom = 0;
      doc.moveTo(LX, fy).lineTo(RX, fy).lineWidth(0.5).strokeColor(LINE).stroke();
      const rodape = [`${RAZAO} · ${CRECI_J} · ${ENDERECO}`, `${CONTATO}  ·  documento gerado por Precifica Aí`];
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(rodape[0], LX, fy + 5, { width: W, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(rodape[1], LX, fy + 15, { width: W * 0.8, lineBreak: false });
      doc.font('Helvetica').fontSize(6.8).fillColor(MUTED).text(`Emitido em ${dataEmissao}`, RX - 120, fy + 15, { width: 120, align: 'right' });
    };
    const band = (t) => { ensure(24); doc.rect(LX, y, W, 15).fill(ACCENT); doc.font('Helvetica-Bold').fontSize(8).fillColor(WHITE).text(clean(t).toUpperCase(), LX + 8, y + 4, { lineBreak: false }); y += 21; };
    const p = (t, size = 8.5) => { if (!t) return; ensure(30); doc.font('Helvetica').fontSize(size).fillColor(INK).text(clean(t), LX, y, { width: W, align: 'justify', lineGap: 1.6 }); y = doc.y + 7; };
    const kv = (k, v) => { ensure(14); doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${clean(k)}: `, LX + 4, y, { continued: true, width: W - 8 }); doc.font('Helvetica').fontSize(8).fillColor(INK).text(clean(String(v))); y = doc.y + 3; };
    const bullet = (t) => { ensure(16); doc.font('Helvetica').fontSize(8).fillColor(INK).text(`•  ${clean(t)}`, LX + 6, y, { width: W - 12, align: 'justify', lineGap: 1.4 }); y = doc.y + 4; };
    const linhaTabela = (cols, larguras, bold = false, alturaMin = 14) => {
      const h = Math.max(alturaMin, ...cols.map((c, i) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).heightOfString(clean(String(c ?? '')), { width: larguras[i] - 8 }) + 6));
      ensure(h + 2);
      let x = LX;
      cols.forEach((c, i) => {
        doc.rect(x, y, larguras[i], h).lineWidth(0.4).strokeColor(LINE).stroke();
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(INK)
          .text(clean(String(c ?? '')), x + 4, y + 3, { width: larguras[i] - 8 });
        x += larguras[i];
      });
      y += h;
    };

    // ── Capa ──────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text('PARECER TÉCNICO DE AVALIAÇÃO IMOBILIÁRIA', LX, y, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor(ACCENT).text('Estimativa de valor de mercado por amostragem', LX, y + 22, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`Matrícula nº ${txt(m.numero)}${m.cartorio ? ', ' + clean(m.cartorio) : ''}`, LX, y + 36, { width: W, align: 'center' });
    y += 58;

    const idn = [
      ['Imóvel avaliado', txt(im.descricao)],
      ['Endereço', `${txt(im.endereco)}${im.cep ? ', CEP ' + clean(im.cep) : ''}`],
      ['Matrícula', `Nº ${txt(m.numero)}${m.livro ? ', ' + clean(m.livro) : ''}, ${txt(m.cartorio)}`],
      ...(im.cadastroMunicipal ? [['Cadastro municipal', clean(im.cadastroMunicipal)]] : []),
      ['Área do terreno', `${num(r.areaTerreno)} m²`],
      ['Área construída', r.areaConstruida ? `${num(r.areaConstruida)} m²${m.construcaoAverbada ? ' (averbada)' : ' (NÃO averbada — informada/estimada)'}` : 'não averbada e não informada'],
      ['Proprietário registral', (m.proprietarios || []).map((x) => `${x.nome}${x.documento ? ', ' + x.documento : ''}`).join('; ') || '—'],
      ...(m.promessa?.existe ? [['Promitente comprador', `${txt(m.promessa.comprador)}${m.promessa.data ? ' (compromisso de ' + m.promessa.data + ')' : ''}`]] : []),
      ['Finalidade', 'Subsidiar decisão negocial quanto a aquisição, venda ou garantia'],
      ['Data-base', r.dataBase || dataEmissao],
      ['Natureza do trabalho', 'Parecer técnico de valor por amostragem, sem vistoria presencial'],
      ...(solicitante ? [['Solicitante', clean(solicitante)]] : [])
    ];
    idn.forEach(([k, v]) => linhaTabela([k, v], [W * 0.28, W * 0.72]));
    y += 12;

    // ── 1. Sumário executivo ──────────────────────────────────────────
    band('1. Sumário executivo');
    p(`Este documento apresenta a estimativa de valor de mercado do imóvel identificado acima, elaborada a partir da certidão de inteiro teor da matrícula nº ${txt(m.numero)}${m.dataCertidao ? ', expedida em ' + clean(m.dataCertidao) : ''}${fotos ? ', e do conjunto fotográfico fornecido' : ''}.`);
    if (r.aviso) {
      ensure(56);
      doc.roundedRect(LX, y, W, 46, 6).fill('#fff7ed');
      doc.roundedRect(LX, y, W, 46, 6).lineWidth(0.8).strokeColor('#fdba74').stroke();
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#9a3412').text(clean(r.aviso.titulo), LX + 10, y + 7, { width: W - 20 });
      doc.font('Helvetica').fontSize(7.2).fillColor('#7c2d12').text(clean(r.aviso.texto), LX + 10, y + 19, { width: W - 20, align: 'justify' });
      y += 56;
    }
    ensure(72);
    doc.roundedRect(LX, y, W, 64, 8).fill(ACCENT);
    const temDesconto = (r.descontos || []).length > 0;
    doc.font('Helvetica').fontSize(8).fillColor(SOFT).text(temDesconto ? 'VALOR DE MERCADO DO IMÓVEL (REGULARIZADO)' : 'VALOR DE MERCADO ESTIMADO', LX + 16, y + 10);
    doc.font('Helvetica-Bold').fontSize(24).fillColor(WHITE).text(brl(temDesconto ? r.valorBruto : r.valor), LX + 16, y + 22);
    if (temDesconto) {
      doc.font('Helvetica').fontSize(7.5).fillColor(SOFT).text('NO ESTADO DOCUMENTAL ATUAL', RX - 210, y + 10, { width: 200, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(17).fillColor(WHITE).text(brl(r.valor), RX - 210, y + 24, { width: 200, align: 'right' });
      doc.font('Helvetica').fontSize(7).fillColor(SOFT).text(`ajuste de -${r.descontoTotal}% · faixa ${brl(r.faixaMin)} a ${brl(r.faixaMax)}`, RX - 210, y + 45, { width: 200, align: 'right' });
      doc.font('Helvetica').fontSize(7.5).fillColor(SOFT).text('a casa em si, sem a pendência registral', LX + 16, y + 50);
    } else {
      doc.font('Helvetica').fontSize(7.5).fillColor(SOFT).text(`Faixa técnica: ${brl(r.faixaMin)} a ${brl(r.faixaMax)}`, LX + 16, y + 50);
      if (r.valorM2Resultante) doc.font('Helvetica').fontSize(7.5).fillColor(SOFT).text(`${brl(r.valorM2Resultante)}/m² de área construída`, RX - 200, y + 50, { width: 190, align: 'right' });
    }
    y += 76;
    (m.alertas || []).slice(0, 4).forEach((a) => {
      bullet(`${a.titulo}: ${a.texto}`);
    });
    if (r.descontos && r.descontos.length) {
      bullet(`Ajuste documental de -${r.descontoTotal}% aplicado sobre ${brl(r.valorBruto)}, pelos motivos indicados na seção 7. Regularizada a pendência, o valor volta ao patamar cheio.`);
    }

    // ── 2. Objeto e finalidade ────────────────────────────────────────
    band('2. Objeto e finalidade do trabalho');
    p(`O objeto deste parecer é a estimativa do valor provável de negociação, em condições normais de mercado, do imóvel descrito na matrícula nº ${txt(m.numero)}.`);
    p('Por valor de mercado entende-se a quantia mais provável pela qual o bem seria negociado, voluntária e conscientemente, em uma data de referência, entre comprador e vendedor que ajam sem pressão indevida e com prazo razoável de exposição. Não se confunde com o valor de anúncio, com o valor de venda urgente, nem com o valor fiscal adotado pela Prefeitura ou pela Receita Federal.');

    // ── 3. Documentos analisados ──────────────────────────────────────
    band('3. Documentos e elementos analisados');
    bullet(`Certidão de inteiro teor da matrícula nº ${txt(m.numero)}${m.livro ? ', ' + clean(m.livro) : ''}, ${txt(m.cartorio)}${m.dataCertidao ? ', expedida em ' + clean(m.dataCertidao) : ''}${m.horaCertidao ? ' às ' + clean(m.horaCertidao) : ''}${m.pedidoCertidao ? ', pedido nº ' + clean(m.pedidoCertidao) : ''}${m.seloDigital ? ', selo digital nº ' + clean(m.seloDigital) : ''}.`);
    if (fotos) bullet(`Conjunto fotográfico do imóvel${(fotos.ambientes || []).length ? ', compreendendo ' + (fotos.ambientes || []).map((a) => a.ambiente).join(', ') : ''}.`);
    if (mk.n > 0) bullet(`Pesquisa de mercado com ${mk.n} anúncio(s) de imóveis à venda no bairro, coletada em ${r.dataBase} (relacionada no Anexo I).`);
    p('Não foram apresentados planta aprovada, projeto arquitetônico, memorial descritivo, carnê de IPTU, certidões pessoais do proprietário nem laudo de vistoria, salvo quando expressamente indicado.');

    // ── 4. Limitações ─────────────────────────────────────────────────
    band('4. Limitações do trabalho');
    bullet('Não houve vistoria presencial. Padrão de acabamento e estado de conservação foram avaliados exclusivamente pelas fotografias fornecidas, que retratam o imóvel de forma parcial.');
    bullet(m.construcaoAverbada
      ? `Não houve medição no local. As áreas utilizadas são as constantes da matrícula: ${num(r.areaTerreno)} m² de terreno e ${num(r.areaConstruida)} m² de construção averbada.`
      : `Não houve medição no local. A matrícula NÃO traz área construída — a construção não está averbada. A área de ${num(r.areaConstruida)} m² usada neste parecer é premissa informada, e alterada a área, altera-se o resultado.`);
    bullet(mk.n > 0
      ? `A pesquisa de mercado é de preços de ANÚNCIO, não de transações registradas. Preço pedido costuma ficar acima do preço de fechamento.`
      : 'Não foi possível coletar anúncios no bairro nesta consulta; as premissas vieram das bases oficiais de referência. Recomenda-se confirmar com dois ou três imóveis à venda na região.');
    bullet('Não foram examinadas instalações hidráulicas, elétricas, estruturais e de impermeabilização, nem eventual existência de vícios ocultos.');
    bullet('Não foram consultadas certidões pessoais do proprietário, de distribuição judicial, protestos ou débitos tributários incidentes sobre o imóvel.');
    p('Em razão dessas limitações, os valores devem ser tratados como estimativa técnica de referência, sujeita a ajuste após a confirmação das premissas da seção 9. Para fins judiciais, bancários ou tributários, recomenda-se laudo formal firmado por engenheiro ou arquiteto com registro no CREA ou CAU, ou por corretor com CNAI.');

    // ── 5. O terreno ──────────────────────────────────────────────────
    band('5. Descrição do imóvel: o terreno');
    const md = m.medidas || {};
    if (md.frente || md.fundos) {
      [['Frente', md.frente], ['Fundos', md.fundos], ['Lado direito', md.ladoDireito], ['Lado esquerdo', md.ladoEsquerdo]]
        .filter(([, v]) => v).forEach(([k, v]) => linhaTabela([k, clean(v)], [W * 0.28, W * 0.72]));
      linhaTabela(['Área total', `${num(r.areaTerreno)} m²`], [W * 0.28, W * 0.72]);
      y += 8;
    } else {
      kv('Área total', `${num(r.areaTerreno)} m²`);
    }
    if (m.confrontacoes) p(clean(m.confrontacoes));
    if (m.registroAnterior) kv('Origem', clean(m.registroAnterior));

    // ── 6. A construção e o padrão ────────────────────────────────────
    band('6. Descrição do imóvel: a construção e o padrão de acabamento');
    if (m.construcaoAverbada && m.obra) {
      const o = m.obra;
      [['Alvará de construção', o.alvara], ['Habite-se', o.habitese], ['CND da obra', o.cnd],
       ['Averbação na matrícula', o.dataAverbacao], ['Valor da obra declarado', o.valorDeclarado ? brl(o.valorDeclarado) : null]]
        .filter(([, v]) => v).forEach(([k, v]) => linhaTabela([k, clean(String(v))], [W * 0.28, W * 0.72]));
      y += 8;
    } else {
      p('A matrícula não registra averbação de construção. Do ponto de vista registral, o imóvel é um terreno — a edificação existe de fato, mas não de direito, e essa diferença tem efeito direto sobre liquidez, financiabilidade e preço.');
    }
    if (fotos) {
      kv('Padrão de acabamento', `${cap(fotos.padrao || '')}${fotos.padraoJustificativa ? ' — ' + clean(fotos.padraoJustificativa) : ''}`);
      kv('Conservação', `${cap(fotos.conservacao || '')}${fotos.idadeAparente ? ' · ' + clean(fotos.idadeAparente) : ''}${fotos.ocupado ? ' · imóvel ocupado' : ' · imóvel desocupado'}`);
      y += 4;
      if ((fotos.ambientes || []).length) {
        linhaTabela(['Elemento', 'Constatação a partir das fotografias'], [W * 0.26, W * 0.74], true);
        fotos.ambientes.slice(0, 14).forEach((a) => linhaTabela([a.ambiente, a.constatacao], [W * 0.26, W * 0.74]));
        y += 8;
      }
      if ((fotos.pontosAtencao || []).length) {
        kv('Pontos de atenção', fotos.pontosAtencao.join('; '));
      }
    }

    // ── 7. Situação registral ─────────────────────────────────────────
    band('7. Situação registral e jurídica');
    if ((m.atos || []).length) {
      linhaTabela(['Ato', 'Data', 'Conteúdo'], [W * 0.12, W * 0.15, W * 0.73], true);
      m.atos.slice(0, 10).forEach((a) => linhaTabela([a.codigo, a.data || '—', a.resumo], [W * 0.12, W * 0.15, W * 0.73]));
      y += 8;
    }
    (m.alertas || []).forEach((a) => {
      const tag = a.nivel === 'alto' ? '[ATENÇÃO] ' : a.nivel === 'medio' ? '[CONFIRMAR] ' : '[FAVORÁVEL] ';
      bullet(`${tag}${a.titulo}. ${a.texto}`);
    });
    if (m.dataCertidao) {
      p(`Para fins de transmissão imobiliária, a certidão apresentada tem validade de 30 dias (art. 1º, IV, do Decreto nº 93.240/1986). Emitida em ${clean(m.dataCertidao)}, será necessária certidão atualizada na data da escritura.`);
    }

    // ── 8. Metodologia ────────────────────────────────────────────────
    band('8. Metodologia adotada');
    p(`O valor foi apurado por ${r.metodos.length} caminho(s) independente(s), comparando-se depois as respostas. Quando métodos distintos convergem para a mesma faixa, a confiança no resultado aumenta.`);
    linhaTabela(['Método', 'Como funciona'], [W * 0.3, W * 0.7], true);
    if (r.evolutivo) linhaTabela(['Evolutivo', 'Soma o valor do terreno ao custo de reprodução da construção, depreciado pelo tempo e pelo estado de conservação (Ross-Heidecke), aplicando ao final um fator de comercialização que corrige a diferença entre o custo de construir e o preço que o mercado paga.'], [W * 0.3, W * 0.7]);
    if (r.comparativo) linhaTabela(['Comparativo por valor unitário', 'Aplica sobre a área construída o valor por metro quadrado praticado na região para imóveis de padrão, idade e localização semelhantes, com o terreno já embutido no indicador.'], [W * 0.3, W * 0.7]);
    if (r.ancora) linhaTabela(['Atualização do valor-âncora', 'Parte de avaliação anterior informada, atualiza-a pela valorização do período e acrescenta o efeito de eventual regularização documental ocorrida depois.'], [W * 0.3, W * 0.7]);
    y += 10;

    // ── 9. Premissas ──────────────────────────────────────────────────
    band('9. Premissas adotadas e o que precisa ser confirmado');
    p('As premissas abaixo são o coração do trabalho. Alterada qualquer uma delas, altera-se o resultado.');
    linhaTabela(['Premissa', 'Adotada', 'Faixa possível', 'Observação'], [W * 0.26, W * 0.16, W * 0.2, W * 0.38], true);
    (r.premissas || []).forEach((pr) => linhaTabela([pr.item, pr.adotado, pr.faixa, pr.obs], [W * 0.26, W * 0.16, W * 0.2, W * 0.38]));
    y += 10;

    // ── 9.1 Sensibilidade da metragem ─────────────────────────────────
    if (r.sensibilidade) {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text('9.1. E se a metragem for outra?', LX, y); y = doc.y + 5;
      p('A construção não está averbada na matrícula, de modo que a área construída é premissa, e não dado registral. A tabela abaixo mostra o valor apurado em cada metragem plausível, para que o resultado possa ser lido sem depender de uma medição que ainda não existe. Confirmada a área — pelo cadastro do IPTU, pelo habite-se, pelo anúncio ou por medição no local — basta ler a linha correspondente.');
      linhaTabela(['Área construída', 'Valor de mercado', 'Faixa técnica'], [W * 0.3, W * 0.32, W * 0.38], true);
      r.sensibilidade.forEach((l) => linhaTabela([
        `${num(l.area)} m²${l.atual ? '  (premissa adotada)' : ''}`, brl(l.valor), `${brl(l.faixaMin)} a ${brl(l.faixaMax)}`
      ], [W * 0.3, W * 0.32, W * 0.38], !!l.atual));
      y += 10;
    }

    // ── 10. Apuração ──────────────────────────────────────────────────
    band('10. Apuração do valor');
    if (r.evolutivo) {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text('10.1. Método evolutivo', LX, y); y = doc.y + 5;
      linhaTabela(['Componente', 'Cálculo', 'Valor'], [W * 0.34, W * 0.4, W * 0.26], true);
      r.evolutivo.memoria.forEach(([c, calc, v]) => linhaTabela([c, calc, v == null ? '' : brl(v)], [W * 0.34, W * 0.4, W * 0.26]));
      y += 10;
    }
    if (r.comparativo) {
      ensure(60);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text('10.2. Método comparativo por valor unitário', LX, y); y = doc.y + 5;
      linhaTabela(['Cenário', 'Cálculo', 'Valor'], [W * 0.24, W * 0.5, W * 0.26], true);
      r.comparativo.cenarios.forEach(([c, calc, v]) => linhaTabela([c, calc, brl(v)], [W * 0.24, W * 0.5, W * 0.26]));
      y += 6;
      if (r.comparativo.notaExcedente) p(r.comparativo.notaExcedente, 7.5);
      y += 4;
    }
    if (r.ancora) {
      ensure(60);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text('10.3. Atualização do valor-âncora', LX, y); y = doc.y + 5;
      linhaTabela(['Etapa', 'Cálculo', 'Valor'], [W * 0.34, W * 0.4, W * 0.26], true);
      r.ancora.memoria.forEach(([c, calc, v]) => linhaTabela([c, calc, brl(v)], [W * 0.34, W * 0.4, W * 0.26]));
      y += 10;
    }

    // ── 11. Conclusão ─────────────────────────────────────────────────
    band('11. Conclusão de valor');
    r.metodos.forEach((mt) => linhaTabela([mt.nome, brl(mt.valor)], [W * 0.62, W * 0.38]));
    linhaTabela(['Média aritmética', brl(r.media)], [W * 0.62, W * 0.38], true);
    if (r.descontos && r.descontos.length) {
      r.descontos.forEach((d) => linhaTabela([`(-) ${d.motivo}`, `-${Math.round(d.pct * 100)}%`], [W * 0.62, W * 0.38]));
    }
    linhaTabela(['Valor adotado, com arredondamento', brl(r.valor)], [W * 0.62, W * 0.38], true);
    y += 8;
    if (r.dispersao != null) {
      p(`A dispersão entre o menor e o maior resultado é de aproximadamente ${r.dispersao}%${r.dispersao <= 10 ? ', o que indica boa convergência metodológica' : r.dispersao <= 25 ? ', dentro do razoável para avaliação por amostragem' : ' — dispersão alta, que recomenda confirmar as premissas antes de usar o número'}. Adota-se, portanto, o valor de ${brl(r.valor)}, com faixa de referência entre ${brl(r.faixaMin)} e ${brl(r.faixaMax)}.`);
    }

    // ── 12. Negociação ────────────────────────────────────────────────
    band('12. Referências para a negociação');
    linhaTabela(['Referência', 'Valor', 'Racional'], [W * 0.26, W * 0.18, W * 0.56], true);
    (r.negociacao || []).forEach((n) => linhaTabela([n.ref, `${brl(n.valor)}${n.mensal ? '/mês' : ''}`, n.racional], [W * 0.26, W * 0.18, W * 0.56]));
    y += 8;
    if (fotos && (fotos.pontosFortes || []).length) p(`Argumentos que sustentam preço mais alto: ${fotos.pontosFortes.join('; ')}.`);
    if (fotos && (fotos.pontosAtencao || []).length) p(`Argumentos que o comprador usará para reduzir preço: ${fotos.pontosAtencao.join('; ')}.`);

    // ── 13. Custos ────────────────────────────────────────────────────
    band('13. Custos estimados da transmissão');
    linhaTabela(['Item', 'Estimativa', 'Observação'], [W * 0.26, W * 0.22, W * 0.52], true);
    (r.custos || []).forEach((c) => linhaTabela([c.item, c.min === c.max ? brl(c.min) : `${brl(c.min)} a ${brl(c.max)}`, c.obs], [W * 0.26, W * 0.22, W * 0.52]));
    linhaTabela(['Total estimado', `${brl(r.custoMin)} a ${brl(r.custoMax)}`, `Equivale a ${Math.round((r.custoMin / r.valor) * 100)}% a ${Math.round((r.custoMax / r.valor) * 100)}% do valor do imóvel`], [W * 0.26, W * 0.22, W * 0.52], true);
    y += 10;

    // ── 14. Diligências ───────────────────────────────────────────────
    band('14. Diligências recomendadas antes de fechar negócio');
    const dg = r.diligencias || {};
    if ((dg.imovel || []).length) { doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text('Sobre o imóvel', LX, y); y = doc.y + 4; dg.imovel.forEach(bullet); }
    if ((dg.vendedor || []).length) { ensure(30); doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text('Sobre o vendedor', LX, y); y = doc.y + 4; dg.vendedor.forEach(bullet); }
    if ((dg.contratacao || []).length) { ensure(30); doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text('Sobre a contratação', LX, y); y = doc.y + 4; dg.contratacao.forEach(bullet); }

    // ── 15. Anexo I ───────────────────────────────────────────────────
    band('15. Anexo I — pesquisa de mercado');
    if (mk.n > 0) {
      p(`Amostra coletada em ${r.dataBase} nos portais ${(mk.fontes || []).join(', ') || 'consultados'}. Grau de fundamentação: ${mk.grau}. São preços de anúncio, verificáveis pelos links.`);
      linhaTabela(['Nº', 'Área', 'Preço pedido', 'R$/m²', 'Fonte / link'], [W * 0.06, W * 0.12, W * 0.18, W * 0.14, W * 0.5], true);
      const linhas = [...(mk.casas || []).map((c) => ({ ...c, t: '' })), ...(mk.lotes || []).map((l) => ({ ...l, t: 'lote ' }))];
      linhas.slice(0, 14).forEach((c, i) => linhaTabela([
        String(i + 1), `${c.t}${c.area ? num(c.area) + ' m²' : '—'}`, brl(c.preco),
        c.precoM2 ? brl(Math.round(c.precoM2)) : '—', c.url || c.fonte || '—'
      ], [W * 0.06, W * 0.12, W * 0.18, W * 0.14, W * 0.5]));
      y += 8;
      if (r.vendaM2) p(`O valor por metro quadrado adotado na seção 9 (${brl(r.vendaM2)}/m²) deve ser comparado com esta amostra. Divergência superior a 10% para mais ou para menos recomenda revisão do resultado.`, 7.5);
    } else {
      p('Não foi possível coletar anúncios no bairro nesta consulta. A planilha abaixo fica preparada para que o escritório insira de três a seis imóveis efetivamente ofertados na região, o que permitirá refinar o resultado.');
      linhaTabela(['Nº', 'Endereço / bairro', 'Terreno m²', 'Constr. m²', 'Preço pedido', 'R$/m²', 'Fonte'], [W * 0.06, W * 0.28, W * 0.12, W * 0.12, W * 0.16, W * 0.12, W * 0.14], true);
      for (let i = 1; i <= 6; i++) linhaTabela([String(i), '', '', '', '', '', ''], [W * 0.06, W * 0.28, W * 0.12, W * 0.12, W * 0.16, W * 0.12, W * 0.14], false, 16);
      y += 8;
    }

    // ── 15.1 Métricas do sistema (as mesmas dos outros laudos da Bens) ─
    const mb = r.metricas || {};
    const enr = mb.enriquecimento || {};
    const infra = (enr.infraestrutura || []).filter((i) => i.qtd > 0);
    if (enr.rentabilidade || enr.financiamento || mb.fipeVenda || infra.length || enr.tendencia) {
      band('15.1. Rentabilidade, financiamento e região');
      if (enr.rentabilidade) {
        kv('Aluguel estimado', `${brl(enr.rentabilidade.aluguelMensal)}/mês — rentabilidade de ${enr.rentabilidade.yieldAnual}% ao ano, paga o imóvel em cerca de ${enr.rentabilidade.paybackAnos} anos`);
      }
      if (enr.financiamento) {
        const f = enr.financiamento;
        kv('Financiamento', `entrada de ${brl(f.entrada)} (${f.entradaPct}%), parcela de aproximadamente ${brl(f.parcela)} por ${Math.round(f.prazoMeses / 12)} anos a ${f.taxaAnual}% a.a.`);
        kv('Renda necessária do comprador', `${brl(f.rendaNecessaria)}/mês`);
      }
      if (mb.fipeVenda) kv(`Referência da região (${txt(r.bairro)})`, `venda ${brl(mb.fipeVenda.m2)}/m² · aluguel R$ ${mb.fipeAluguel ? mb.fipeAluguel.m2 : '—'}/m² por mês · fonte ${txt(mb.fipeVenda.fonte)}`);
      if (infra.length) kv('Infraestrutura em 1,5 km', infra.map((i) => `${i.categoria}: ${i.qtd}${i.maisProximoM ? ` (mais próximo a ${i.maisProximoM} m)` : ''}`).join(' · '));
      if (enr.tendencia) p(`Tendência do bairro: ${enr.tendencia}`);
    }

    // ── Anexo II — registro fotográfico ───────────────────────────────
    const fotosImg = (opts.imagens && opts.imagens.fotos) || [];
    if (fotosImg.length) {
      doc.addPage(); y = TOP;
      band('Anexo II — registro fotográfico do imóvel');
      p('As fotografias abaixo são as que fundamentaram a avaliação de padrão de acabamento e estado de conservação descrita na seção 6.');
      const cols = 3, gap = 8, cw = (W - gap * (cols - 1)) / cols, ch = cw * 0.75;
      fotosImg.slice(0, 24).forEach((src, i) => {
        const col = i % cols;
        if (col === 0) { ensure(ch + 6); }
        try { doc.image(src, LX + col * (cw + gap), y, { fit: [cw, ch], align: 'center', valign: 'center' }); } catch {}
        if (col === cols - 1 || i === Math.min(fotosImg.length, 24) - 1) y += ch + gap;
      });
      y += 6;
    }

    // ── Anexo III — a certidão ────────────────────────────────────────
    const docImg = (opts.imagens && opts.imagens.matricula) || [];
    if (docImg.length) {
      docImg.slice(0, 8).forEach((src, i) => {
        doc.addPage(); y = TOP;
        if (i === 0) { band('Anexo III — certidão de inteiro teor da matrícula'); }
        else { doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text(`Anexo III — certidão, página ${i + 1}`, LX, y); y = doc.y + 6; }
        try {
          doc.image(src, LX, y, { fit: [W, PAGE_H - y - BOTTOM - 10], align: 'center', valign: 'top' });
        } catch {}
      });
      doc.addPage(); y = TOP;
    }

    // ── 16. Encerramento ──────────────────────────────────────────────
    band('16. Encerramento');
    p(`O presente parecer foi elaborado com base exclusivamente nos documentos e informações relacionados na seção 3, observadas as limitações da seção 4, e reflete a melhor estimativa possível a partir desses elementos. Sua validade recomendada é de 180 dias contados da data-base, período após o qual se sugere revisão em razão da variação do mercado.`);
    p(`${clean(r.cidade || 'Anápolis')}, ${dataEmissao}.`);

    ensure(120);
    y += 62;
    const cx = LX + W / 2;
    // Quem assina avaliação é o CORRETOR (CRECI/CNAI), nas duas marcas — o
    // timbre do escritório muda o papel, não quem responde tecnicamente pelo
    // valor. A assinatura digitalizada entra nos dois casos.
    const assina = clean(opts.assina || CORRETOR);
    const registro = clean(opts.registro || CRECI_F);
    desenharAssinatura(doc, cx, y);
    doc.lineWidth(0.7).strokeColor(NAVY).moveTo(cx - 90, y).lineTo(cx + 90, y).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(LABEL).text('CORRETOR RESPONSÁVEL', cx - 90, y + 5, { width: 180, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(assina, cx - 100, y + 16, { width: 200, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK)
      .text(`${registro} · ${RAZAO} (${CRECI_J})`, cx - 100, y + 28, { width: 200, align: 'center' });
    y += 52;

    ensure(58);
    doc.roundedRect(LX, y, W, 50, 6).lineWidth(0.6).strokeColor(LINE).stroke();
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY).text('Aviso importante ao destinatário', LX + 10, y + 7);
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(
      'Este documento é um parecer técnico de valor por amostragem, emitido por corretor de imóveis inscrito no CRECI, elaborado sem vistoria presencial. Não constitui laudo de avaliação nos moldes da NBR 14.653 da ABNT e não substitui laudo firmado por engenheiro ou arquiteto com ART/RRT, nem avaliação com CNAI, exigíveis para fins bancários, judiciais e tributários. Os valores apresentados são estimativas de referência para orientação negocial.',
      LX + 10, y + 19, { width: W - 20, align: 'justify' });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) { doc.switchToPage(range.start + i); chrome(); }
    doc.flushPages();
    doc.end();
  });
}

module.exports = { gerarRelatorioPdf, gerarDossiePdf, gerarEmpresaPdf, gerarRepassePdf, gerarTerrenoPdf, gerarBtsPdf, gerarRadarPdf, gerarFazendaPdf, gerarDecisaoPdf, gerarMatriculaPdf };
