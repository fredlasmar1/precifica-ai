const axios = require('axios');

/**
 * Integração Direct Data (apiv3.directd.com.br) — due diligence.
 * Padrão: GET /api/<API>?<params>&TOKEN=<token> → { metaDados, retorno }
 * Token na env DIRECTDATA_TOKEN. Mesma API usada no Hasta.
 */
const BASE = 'https://apiv3.directd.com.br/api';

function soDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
function disponivel() { return !!process.env.DIRECTDATA_TOKEN; }

/** Processos judiciais por CNPJ (endpoint TribunalJustica). */
async function processosPorCnpj(cnpj, uf = 'GO') {
  const token = process.env.DIRECTDATA_TOKEN;
  if (!token) return { disponivel: false, motivo: 'DirectData não configurada (falta o token)' };
  const c = soDigitos(cnpj);
  if (!c || c.length !== 14) return { disponivel: false, motivo: 'CNPJ inválido' };
  try {
    const { data } = await axios.get(`${BASE}/TribunalJustica`, {
      params: { Cnpj: c, Uf: uf, TOKEN: token }, timeout: 25000,
    });
    const meta = (data && data.metaDados) || {};
    const ret = data && data.retorno;
    const processos = Array.isArray(ret) ? ret : (ret && Array.isArray(ret.processos) ? ret.processos : []);
    return {
      disponivel: true,
      total: processos.length,
      resultado: meta.resultado || meta.mensagem || null,
      processos: processos.slice(0, 10),
      comprovante: meta.urlComprovante || null,
    };
  } catch (e) {
    const st = e.response && e.response.status;
    return { disponivel: false, motivo: st === 401 ? 'token DirectData inválido (401)' : `erro ${st || e.message}` };
  }
}

module.exports = { processosPorCnpj, disponivel };
