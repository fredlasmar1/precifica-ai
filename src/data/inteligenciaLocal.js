const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(process.cwd(), '.inteligencia-local.json');

/**
 * INTELIGÊNCIA LOCAL — Base de conhecimento que aprende com cada consulta.
 *
 * Estrutura:
 * {
 *   "anapolis": {
 *     "centro": {
 *       "terreno": {
 *         "venda": {
 *           "precoM2": 950,           // Preço/m² validado
 *           "validadoPor": "corretor", // "corretor" = Fred confirmou, "pesquisa" = Perplexity
 *           "amostras": 8,            // Quantos anúncios compõem essa média
 *           "min": 700, "max": 1200,  // Faixa observada
 *           "atualizadoEm": "2026-04-14",
 *           "historico": [             // Histórico de pesquisas
 *             { "data": "2026-04-14", "precoM2": 730, "fonte": "Perplexity", "amostras": 5 },
 *             { "data": "2026-04-14", "precoM2": 950, "fonte": "corretor" }
 *           ],
 *           "notas": "Rua Senador Eugênio Jardim é comercial forte, vale mais que média"
 *         },
 *         "aluguel": { ... }
 *       },
 *       "casa": { ... },
 *       "apartamento": { ... }
 *     },
 *     "jundiai": { ... }
 *   }
 * }
 */

let _db = {};

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      _db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      const cidades = Object.keys(_db).length;
      let bairros = 0;
      for (const c of Object.values(_db)) bairros += Object.keys(c).length;
      console.log(`[InteligênciaLocal] Carregado: ${cidades} cidades, ${bairros} bairros`);
    }
  } catch (err) {
    console.warn('[InteligênciaLocal] Erro ao carregar:', err.message);
    _db = {};
  }
}

function save() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(_db, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[InteligênciaLocal] Erro ao salvar:', err.message);
  }
}

function norm(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

/**
 * Busca o preço/m² da base local para um tipo/bairro/cidade/finalidade.
 * Retorna null se não tem dado.
 */
function consultar(cidade, bairro, tipo, finalidade) {
  const entry = _db[norm(cidade)]?.[norm(bairro)]?.[norm(tipo)]?.[norm(finalidade)];
  if (!entry) return null;

  // Verifica idade — dados com mais de 90 dias ficam com confiança reduzida
  const diasDesdeAtualização = entry.atualizadoEm
    ? Math.floor((Date.now() - new Date(entry.atualizadoEm).getTime()) / 86400000)
    : 999;

  return {
    precoM2: entry.precoM2,
    min: entry.min,
    max: entry.max,
    amostras: entry.amostras || 0,
    validadoPor: entry.validadoPor,
    atualizadoEm: entry.atualizadoEm,
    diasDesdeAtualização,
    confianca: entry.validadoPor === 'corretor' ? 'alta'
      : diasDesdeAtualização <= 30 ? 'media'
      : 'baixa',
    notas: entry.notas || null,
    fonte: 'Inteligência Local PrecificaAI'
  };
}

/**
 * Registra uma pesquisa da Perplexity na base.
 * NÃO sobrescreve dados validados pelo corretor.
 */
function registrarPesquisa(cidade, bairro, tipo, finalidade, precoM2, amostras, faixaMin, faixaMax) {
  const c = norm(cidade), b = norm(bairro), t = norm(tipo), f = norm(finalidade);
  if (!_db[c]) _db[c] = {};
  if (!_db[c][b]) _db[c][b] = {};
  if (!_db[c][b][t]) _db[c][b][t] = {};

  const existing = _db[c][b][t][f];
  const hoje = new Date().toISOString().split('T')[0];

  const novaAmostra = { data: hoje, precoM2, fonte: 'Perplexity', amostras };

  if (existing && existing.validadoPor === 'corretor') {
    // Não sobrescreve dado validado pelo corretor, só adiciona ao histórico
    if (!existing.historico) existing.historico = [];
    existing.historico.push(novaAmostra);
    console.log(`[InteligênciaLocal] Pesquisa registrada no histórico (não sobrescreveu dado do corretor): ${b}/${t}/${f}`);
  } else {
    // Atualiza com dados da pesquisa
    _db[c][b][t][f] = {
      precoM2: Math.round(precoM2),
      min: Math.round(faixaMin || precoM2 * 0.85),
      max: Math.round(faixaMax || precoM2 * 1.15),
      amostras: amostras || 0,
      validadoPor: 'pesquisa',
      atualizadoEm: hoje,
      historico: existing?.historico ? [...existing.historico, novaAmostra] : [novaAmostra],
      notas: existing?.notas || null
    };
    console.log(`[InteligênciaLocal] Dados atualizados: ${b}/${t}/${f} = R$${precoM2}/m² (${amostras} amostras)`);
  }

  save();
}

/**
 * Corretor valida/corrige o preço. Tem prioridade máxima.
 */
function validarPreco(cidade, bairro, tipo, finalidade, precoM2, faixaMin, faixaMax, notas) {
  const c = norm(cidade), b = norm(bairro), t = norm(tipo), f = norm(finalidade);
  if (!_db[c]) _db[c] = {};
  if (!_db[c][b]) _db[c][b] = {};
  if (!_db[c][b][t]) _db[c][b][t] = {};

  const existing = _db[c][b][t][f];
  const hoje = new Date().toISOString().split('T')[0];

  _db[c][b][t][f] = {
    precoM2: Math.round(precoM2),
    min: Math.round(faixaMin || precoM2 * 0.85),
    max: Math.round(faixaMax || precoM2 * 1.15),
    amostras: existing?.amostras || 0,
    validadoPor: 'corretor',
    atualizadoEm: hoje,
    historico: existing?.historico ? [...existing.historico, { data: hoje, precoM2, fonte: 'corretor' }] : [{ data: hoje, precoM2, fonte: 'corretor' }],
    notas: notas || existing?.notas || null
  };

  save();
  console.log(`[InteligênciaLocal] VALIDADO pelo corretor: ${b}/${t}/${f} = R$${precoM2}/m²`);
  return _db[c][b][t][f];
}

/**
 * Lista todos os dados de uma cidade (para dashboard/revisão).
 */
function listarCidade(cidade) {
  return _db[norm(cidade)] || {};
}

/**
 * Retorna estatísticas da base.
 */
function stats() {
  let cidades = 0, bairros = 0, registros = 0, validados = 0;
  for (const [c, bairrosObj] of Object.entries(_db)) {
    cidades++;
    for (const [b, tipos] of Object.entries(bairrosObj)) {
      bairros++;
      for (const [t, fins] of Object.entries(tipos)) {
        for (const [f, data] of Object.entries(fins)) {
          registros++;
          if (data.validadoPor === 'corretor') validados++;
        }
      }
    }
  }
  return { cidades, bairros, registros, validados, percentualValidado: registros > 0 ? Math.round((validados / registros) * 100) : 0 };
}

// Inicializa
load();

module.exports = { consultar, registrarPesquisa, validarPreco, listarCidade, stats };
