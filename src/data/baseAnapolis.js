/**
 * BASE DE CALIBRAÇÃO — ANÁPOLIS-GO
 *
 * Âncoras de preço por bairro, usadas para manter a precificação dentro da
 * realidade do mercado e evitar que a amostra de anúncios "viaje" em valores
 * irreais. A amostra real de mercado (Perplexity/portais) continua mandando;
 * estas bases só ANCORAM o resultado (clamp/blend), nunca substituem dado real.
 *
 * Fontes:
 * - VENDA construído: EBM Anápolis / levantamento Aderni-GO ("10 bairros mais
 *   valorizados de Anápolis"), fornecido em 25/jun/2026. Valores ABSOLUTOS de
 *   R$/m² construído. Demais bairros: derivados do multiplicador de bairros.js
 *   re-ancorado para reproduzir a escala EBM.
 * - ALUGUEL: derivado da venda por yield mensal típico do interior de GO.
 * - LOTE (terreno): derivado como fração do R$/m² construído da região.
 *   (Estimativa inicial — calibrar com anúncios reais de terreno.)
 *
 * Atualize a tabela EBM_VENDA_M2 quando tiver novos levantamentos.
 */

const { getMultiplicadorBairro } = require('./bairros');
const { PGV_TERRENO_VENAL } = require('./pgvAnapolis');

// ── Constantes de calibração (ajustáveis) ────────────────────────────
const ALUGUEL_YIELD_MES = 0.0040;  // 0,40%/mês do valor de venda (calibrado c/ aluguéis reais
                                   // VivaReal jun/2026: Jundiaí ~0,43%, Maracanã ~0,32%)
const LOTE_FRACAO = 0.16;          // terreno ≈ 16% do R$/m² construído (fallback sem PGV)
const PGV_FATOR_MERCADO = 1.85;    // venal (ITBI) × isto ≈ mercado. Calibrado c/ terrenos reais
                                   // VivaReal jun/2026: Jundiaí 1,63x, Maracanã 1,98x, A.City 2,15x
const BASE_DERIVADA_M2 = 4000;     // base p/ bairros fora da EBM = mult × isto.
                                   // Calibrado p/ que bairros NÃO listados na EBM (fora do top-10)
                                   // fiquem abaixo do piso EBM (4.400) salvo mult claramente premium.

const VENDA_MIN = 2200, VENDA_MAX = 9500;   // limites sãos de R$/m² construído (venda)
const LOTE_MIN = 250,  LOTE_MAX = 3500;     // limites sãos de R$/m² de terreno

// ── ÂNCORA OFICIAL DE VENDA (EBM / Aderni-GO) — R$/m² construído ──────
const EBM_VENDA_M2 = {
  'jundiai': 8500,
  'anapolis city': 6800,
  'cidade jardim': 6400,
  'jk': 6000,
  'bairro jk': 6000,
  'setor jk': 6000,
  'jardim europa': 5800,
  'maracana': 5500,
  'vila jaiara': 4900,
  'vila santa isabel': 4800,
  'parque brasilia': 4600,
  'vila gois': 4400,
};

function norm(s) {
  return (s || '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // remove acentos
    .replace(/\s+/g, ' ');
}

// As âncoras oficiais EBM (venda) e PGV (terreno) são de ANÁPOLIS. Só podem casar
// quando a cidade é Anápolis — senão um bairro homônimo de Goiânia/RMG (ex: "Jardim
// Europa", "Cidade Jardim") pegaria o valor de Anápolis. Fora de Anápolis: só o
// multiplicador de bairro (BAIRROS_GOIANIA etc.) + scraping de mercado.
function isAnapolis(cidade) { return norm(cidade).includes('anapolis'); }

/**
 * Âncora de VENDA (R$/m² construído) para o bairro.
 * Retorna { m2, fonte: 'EBM'|'derivado', confianca: 'alta'|'media' }.
 */
function getBaseVenda(cidade, bairro) {
  const key = norm(bairro);

  // 1) Match na tabela EBM — SOMENTE Anápolis (a EBM/Aderni é de Anápolis).
  if (isAnapolis(cidade)) {
    if (EBM_VENDA_M2[key]) {
      return { m2: EBM_VENDA_M2[key], fonte: 'EBM/Aderni-GO', confianca: 'alta' };
    }
    // match por "contém" (ex: "vila jaiara setor norte" → "vila jaiara")
    for (const ebmKey of Object.keys(EBM_VENDA_M2)) {
      if (key.includes(ebmKey)) {
        return { m2: EBM_VENDA_M2[ebmKey], fonte: 'EBM/Aderni-GO (região)', confianca: 'alta' };
      }
    }
  }

  // 2) Derivado do multiplicador do bairro, re-ancorado à escala EBM
  const { mult, conhecido } = getMultiplicadorBairro(cidade, bairro);
  const m2 = clamp(Math.round(mult * BASE_DERIVADA_M2), VENDA_MIN, VENDA_MAX);
  return { m2, fonte: 'derivado (mult de bairro)', confianca: conhecido ? 'media' : 'baixa' };
}

/**
 * Âncora de ALUGUEL (R$/m²/mês) — derivada da venda por yield.
 */
function getBaseAluguel(cidade, bairro) {
  const venda = getBaseVenda(cidade, bairro);
  const m2 = Math.round(venda.m2 * ALUGUEL_YIELD_MES * 10) / 10; // 1 casa decimal
  return { m2, fonte: `derivado venda × ${(ALUGUEL_YIELD_MES * 100).toFixed(2)}%/mês`, confianca: 'media' };
}

/**
 * Normaliza p/ casar com as chaves do PGV (sem acento, sem prefixo de bairro).
 */
function normPgv(s) {
  return norm(s).replace(/\b(bairro|loteamento|condominio|residencial|conjunto|jardim|vila|parque|setor)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Valor VENAL de terreno (R$/m²) do PGV oficial da Prefeitura para o bairro.
 * Tenta match exato e depois "contém" (maior chave que casa).
 */
function pgvVenal(bairro) {
  const k = normPgv(bairro);
  if (!k) return null;
  if (PGV_TERRENO_VENAL[k]) return PGV_TERRENO_VENAL[k];
  let melhor = null, melhorLen = 0;
  for (const key of Object.keys(PGV_TERRENO_VENAL)) {
    if (key.length < 4) continue;
    if ((k.includes(key) || key.includes(k)) && key.length > melhorLen) {
      melhor = PGV_TERRENO_VENAL[key]; melhorLen = key.length;
    }
  }
  return melhor;
}

/**
 * Âncora de LOTE/TERRENO (R$/m²) — base oficial da Prefeitura (PGV venal ITBI)
 * convertida para mercado. Fallback: fração do R$/m² construído.
 */
function getBaseLote(cidade, bairro) {
  // PGV é a Planta Genérica da Prefeitura de ANÁPOLIS — só casa em Anápolis.
  const venal = isAnapolis(cidade) ? pgvVenal(bairro) : null;
  if (venal > 0) {
    const m2 = clamp(Math.round(venal * PGV_FATOR_MERCADO), LOTE_MIN, LOTE_MAX);
    return { m2, fonte: `Prefeitura/PGV (venal R$ ${venal}/m² × ${PGV_FATOR_MERCADO})`, confianca: 'alta', venal };
  }
  const venda = getBaseVenda(cidade, bairro);
  const m2 = clamp(Math.round(venda.m2 * LOTE_FRACAO), LOTE_MIN, LOTE_MAX);
  return { m2, fonte: 'estimado (fração do construído) — calibrar', confianca: 'baixa' };
}

/**
 * Âncora unificada para (tipo, finalidade, bairro).
 * Retorna { m2, fonte, confianca } na unidade certa:
 * - venda casa/apto/comercial → R$/m² construído
 * - venda terreno/lote        → R$/m² de terreno
 * - aluguel (qualquer)        → R$/m²/mês
 */
function getAncora(tipo, finalidade, cidade, bairro) {
  const t = (tipo || '').toLowerCase();
  const isTerreno = t === 'terreno' || t === 'lote';

  if (finalidade === 'aluguel') {
    const al = getBaseAluguel(cidade, bairro);
    // terreno p/ aluguel é raro; aplica fração menor
    return isTerreno ? { ...al, m2: Math.round(al.m2 * 0.25 * 10) / 10 } : al;
  }
  if (isTerreno) return getBaseLote(cidade, bairro);
  return getBaseVenda(cidade, bairro);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Bairros da FIPE (principais de Anápolis)
const FIPE_BAIRROS = [
  'Jundiaí', 'Anápolis City', 'Cidade Jardim', 'Bairro JK', 'Jardim Europa',
  'Maracanã', 'Bougainville', 'Alphaville Anápolis', 'Jardim Alexandrina',
  'Vila Jaiara', 'Vila Santa Isabel', 'Parque Brasília', 'Vila Góis',
  'Centro', 'Vila Brasil', 'Jardim das Américas',
];

/**
 * "FIPE de Anápolis": tabela de referência de R$/m² por bairro, para um
 * (tipo, finalidade). Apartamento/casa = R$/m² construído; terreno/lote =
 * R$/m² de terreno; aluguel = R$/m²·mês. Instantânea (bases oficiais EBM/PGV).
 */
function tabelaFipe(tipo, finalidade) {
  const linhas = FIPE_BAIRROS.map((b) => {
    const a = getAncora(tipo, finalidade, 'Anápolis', b);
    return { bairro: b, m2: a.m2, fonte: a.fonte };
  });
  linhas.sort((x, y) => y.m2 - x.m2);
  return linhas;
}

module.exports = {
  getAncora, getBaseVenda, getBaseAluguel, getBaseLote, tabelaFipe,
  EBM_VENDA_M2, ALUGUEL_YIELD_MES, LOTE_FRACAO, FIPE_BAIRROS,
};
