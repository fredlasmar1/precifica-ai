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

// ── Constantes de calibração (ajustáveis) ────────────────────────────
const ALUGUEL_YIELD_MES = 0.0042;  // 0,42%/mês do valor de venda (yield bruto interior GO)
const LOTE_FRACAO = 0.16;          // terreno ≈ 16% do R$/m² construído da região
const BASE_DERIVADA_M2 = 4600;     // base p/ bairros fora da EBM = mult × isto (calibrado p/ reproduzir EBM)

const VENDA_MIN = 2200, VENDA_MAX = 9500;   // limites sãos de R$/m² construído (venda)
const LOTE_MIN = 250,  LOTE_MAX = 2200;     // limites sãos de R$/m² de terreno

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

/**
 * Âncora de VENDA (R$/m² construído) para o bairro.
 * Retorna { m2, fonte: 'EBM'|'derivado', confianca: 'alta'|'media' }.
 */
function getBaseVenda(cidade, bairro) {
  const key = norm(bairro);

  // 1) Match direto na tabela EBM (inclui aliases simples)
  if (EBM_VENDA_M2[key]) {
    return { m2: EBM_VENDA_M2[key], fonte: 'EBM/Aderni-GO', confianca: 'alta' };
  }
  // match por "contém" (ex: "vila jaiara setor norte" → "vila jaiara")
  for (const ebmKey of Object.keys(EBM_VENDA_M2)) {
    if (key.includes(ebmKey)) {
      return { m2: EBM_VENDA_M2[ebmKey], fonte: 'EBM/Aderni-GO (região)', confianca: 'alta' };
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
 * Âncora de LOTE/TERRENO (R$/m² de terreno) — fração do R$/m² construído.
 * Estimativa inicial; deve ser calibrada com anúncios reais de terreno.
 */
function getBaseLote(cidade, bairro) {
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

module.exports = {
  getAncora, getBaseVenda, getBaseAluguel, getBaseLote,
  EBM_VENDA_M2, ALUGUEL_YIELD_MES, LOTE_FRACAO,
};
