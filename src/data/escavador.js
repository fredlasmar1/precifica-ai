const axios = require('axios');

/**
 * Integração Escavador (api.escavador.com/api/v2) — processos judiciais.
 * Token (JWT) na env ESCAVADOR_TOKEN. Endpoint: /envolvido/processos?cpf_cnpj=
 * Cada consulta consome crédito da API paga do Escavador.
 */
const BASE = 'https://api.escavador.com/api/v2';

function soDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
function disponivel() { return !!process.env.ESCAVADOR_TOKEN; }

/** Processos por CNPJ. Retorna {disponivel,total,processos[],motivo}. */
async function processosPorCnpj(cnpj) {
  const token = process.env.ESCAVADOR_TOKEN;
  if (!token) return { disponivel: false, motivo: 'Escavador não configurado (falta o token)' };
  const c = soDigitos(cnpj);
  if (c.length !== 14) return { disponivel: false, motivo: 'CNPJ inválido' };
  try {
    const { data } = await axios.get(`${BASE}/envolvido/processos`, {
      params: { cpf_cnpj: c },
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeout: 30000,
    });
    if (data && data.error) return { disponivel: false, motivo: data.error };
    const items = Array.isArray(data?.items) ? data.items
      : Array.isArray(data?.data) ? data.data
      : Array.isArray(data) ? data : [];
    return {
      disponivel: true,
      total: items.length,
      processos: items.slice(0, 10).map(simplificar),
      temMais: !!(data?.links && data.links.next) || !!(data?.paginator && data.paginator.proxima_pagina),
    };
  } catch (e) {
    const st = e.response && e.response.status;
    const msg = e.response && e.response.data && e.response.data.error;
    return { disponivel: false, motivo: msg || (st === 401 ? 'token Escavador inválido (401)' : `erro ${st || e.message}`) };
  }
}

/** Reduz um processo do Escavador ao essencial. */
function simplificar(p) {
  if (!p || typeof p !== 'object') return {};
  return {
    numero: p.numero_cnj || p.numero || p.numeroProcesso || null,
    titulo: p.titulo_polo_ativo ? `${p.titulo_polo_ativo} x ${p.titulo_polo_passivo || ''}`.trim() : (p.titulo || null),
    tribunal: p.sigla_tribunal || p.tribunal || (p.fontes && p.fontes[0] && p.fontes[0].sigla) || null,
    status: p.situacao || p.status || null,
    ultimaMov: p.data_ultima_movimentacao || p.ultima_movimentacao || null,
  };
}

module.exports = { processosPorCnpj, disponivel };
