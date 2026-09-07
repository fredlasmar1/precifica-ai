const { pesquisar: pesquisarPplx } = require('./perplexity');
const axios = require('axios');

/**
 * ROTATIVIDADE DO ENDEREÇO — quantos negócios já morreram nesse ponto.
 *
 * O argumento que fecha contrato de administração não é "quer anunciar comigo?".
 * É chegar sabendo: "em 6 anos passaram 4 inquilinos nesse ponto, média de 14
 * meses cada — não é azar de inquilino, é o preço do aluguel para o ramo que o
 * senhor está aceitando".
 *
 * MÉTODO (o mesmo do confirmarFiliais, que já roda no bts.js): a Perplexity
 * PROPÕE os CNPJs candidatos; a Receita CONFIRMA. Modelo de linguagem inventa
 * CNPJ com facilidade — por isso nada entra no resultado sem passar pela
 * BrasilAPI e bater município E logradouro. A Perplexity aqui é geradora de
 * candidatos, não fonte.
 *
 * ⚠️ O QUE ISTO NÃO É: um censo do endereço. É o que se conseguiu CONFIRMAR.
 * Um endereço com 9 inquilinos históricos pode devolver 3 — os que a busca
 * achou. O resultado sempre diz quantos foram confirmados, e nunca afirma que
 * são todos. A versão completa disso é o dump de Dados Abertos da Receita, que
 * traz a baixa de todo CNPJ do município sem depender de busca.
 */

const BRASIL_API_CNPJ = 'https://brasilapi.com.br/api/cnpj/v1';

const norm = (t) => String(t || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(rua|avenida|av|r|travessa|tv|alameda|al|praca|rodovia|br|go)\b\.?/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/** Meses entre duas datas ISO. */
function mesesEntre(inicio, fim) {
  const a = new Date(inicio), b = new Date(fim);
  if (isNaN(a) || isNaN(b)) return null;
  const m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  return m >= 0 ? m : null;
}

/** Pergunta à Perplexity quais CNPJs já funcionaram no endereço. Só candidatos. */
async function candidatosNoEndereco({ logradouro, numero, cidade, uf = 'GO' }) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return [];
  const end = `${logradouro}${numero ? ', ' + numero : ''}, ${cidade}-${uf}`;
  try {
    const _pplx = await pesquisarPplx({
      tag: 'Perplexity/rotatividade', modelo: 'sonar-pro', maxTokens: 500, timeout: 60000,
      sistema: 'Pesquisador de dados públicos de empresas (CNPJ) no Brasil. Responda SOMENTE JSON válido. NUNCA invente CNPJ — cite apenas CNPJ que você encontrar em fonte real. Se não encontrar nenhum, devolva lista vazia.',
      pergunta: `Liste os CNPJs (14 dígitos) de empresas que estão ou já estiveram estabelecidas no endereço "${end}", incluindo as que já encerraram atividade. Responda APENAS JSON: {"cnpjs":["..."]}`,
    });

    let s = String(_pplx.texto || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) s = s.slice(i, j + 1);
    const lista = JSON.parse(s).cnpjs || [];
    return [...new Set(lista.map((c) => String(c).replace(/\D/g, '')).filter((c) => c.length === 14))].slice(0, 14);
  } catch (e) {
    console.warn('[Rotatividade] perplexity:', e.message);
    return [];
  }
}

/** Confirma um CNPJ na Receita e devolve só se o endereço bater de verdade. */
async function confirmarNaReceita(cnpj, { logradouro, cidade }) {
  try {
    const { data } = await axios.get(`${BRASIL_API_CNPJ}/${cnpj}`, { timeout: 20000 });
    const mesmaCidade = norm(data.municipio) === norm(cidade);
    const mesmaRua = norm(data.logradouro) && norm(logradouro)
      && (norm(data.logradouro).includes(norm(logradouro)) || norm(logradouro).includes(norm(data.logradouro)));
    if (!mesmaCidade || !mesmaRua) return null;   // candidato inventado ou de outro lugar

    const baixado = /BAIXADA|INAPTA|SUSPENSA/i.test(data.descricao_situacao_cadastral || '');
    return {
      cnpj,
      nome: data.nome_fantasia || data.razao_social,
      ramo: data.cnae_fiscal_descricao,
      abriu: data.data_inicio_atividade,
      situacao: data.descricao_situacao_cadastral,
      dataSituacao: data.data_situacao_cadastral,
      encerrado: baixado,
      porte: data.porte,
      endereco: `${data.logradouro || ''}, ${data.numero || 's/n'}`,
      bairro: data.bairro,
      // Só conta como "durou" quem já encerrou: empresa viva ainda está contando.
      duracaoMeses: baixado ? mesesEntre(data.data_inicio_atividade, data.data_situacao_cadastral) : null,
      mesesAberto: !baixado ? mesesEntre(data.data_inicio_atividade, new Date().toISOString()) : null,
    };
  } catch (e) {
    return null;   // 404 = CNPJ que não existe: exatamente o que o filtro serve para pegar
  }
}

/**
 * @returns { confirmados, propostos, empresas[], encerradas, ativas,
 *            duracaoMediaMeses, ramos[], nota }
 */
async function rotatividadeEndereco({ logradouro, numero, cidade = 'Anápolis', uf = 'GO' }) {
  if (!String(logradouro || '').trim()) {
    return { erro: 'Informe o logradouro (rua/avenida) para levantar a rotatividade.' };
  }

  const candidatos = await candidatosNoEndereco({ logradouro, numero, cidade, uf });
  if (!candidatos.length) {
    return {
      propostos: 0, confirmados: 0, empresas: [],
      nota: `Nenhum CNPJ localizado para ${logradouro}${numero ? ', ' + numero : ''} em ${cidade}. Isso NÃO significa que o ponto nunca teve inquilino — significa que a busca não achou. O levantamento completo depende da base de Dados Abertos da Receita.`,
    };
  }

  // Confirmação em série com respiro: a BrasilAPI é gratuita e tem limite.
  const empresas = [];
  for (const c of candidatos) {
    const ok = await confirmarNaReceita(c, { logradouro, cidade });
    if (ok) empresas.push(ok);
    await new Promise((r) => setTimeout(r, 350));
  }

  const encerradas = empresas.filter((e) => e.encerrado);
  const ativas = empresas.filter((e) => !e.encerrado);
  const duracoes = encerradas.map((e) => e.duracaoMeses).filter((m) => m > 0);
  const duracaoMediaMeses = duracoes.length
    ? Math.round(duracoes.reduce((a, b) => a + b, 0) / duracoes.length)
    : null;

  return {
    logradouro, numero: numero || null, cidade,
    propostos: candidatos.length,
    confirmados: empresas.length,
    empresas: empresas.sort((a, b) => String(a.abriu).localeCompare(String(b.abriu))),
    encerradas: encerradas.length,
    ativas: ativas.length,
    duracaoMediaMeses,
    ramos: [...new Set(empresas.map((e) => e.ramo).filter(Boolean))],
    nota: `${empresas.length} de ${candidatos.length} CNPJ(s) candidatos confirmados na Receita neste endereço. É o que se conseguiu confirmar, não o histórico completo do ponto.`,
  };
}

/** Texto para o corretor levar na conversa com o proprietário. */
function formatarRotatividade(r) {
  if (!r || r.erro) return r?.erro || '';
  let t = `🔁 *ROTATIVIDADE DO PONTO*\n${r.logradouro}${r.numero ? ', ' + r.numero : ''} — ${r.cidade}\n\n`;

  if (!r.confirmados) {
    t += `Nenhum CNPJ confirmado neste endereço.\n\n_${r.nota}_`;
    return t;
  }

  t += `*${r.confirmados} empresa(s)* confirmada(s) na Receita neste endereço: ${r.encerradas} já encerrou/encerraram, ${r.ativas} em atividade.\n`;
  if (r.duracaoMediaMeses) {
    const anos = (r.duracaoMediaMeses / 12).toFixed(1);
    t += `⏱️ *Quem fechou durou em média ${r.duracaoMediaMeses} meses* (${anos} anos).\n`;
  }
  t += `\n`;

  for (const e of r.empresas) {
    const quando = String(e.abriu || '').slice(0, 4);
    if (e.encerrado) {
      t += `• ${e.nome} — ${e.ramo || 'ramo n/d'}\n  abriu ${quando}, encerrou ${String(e.dataSituacao || '').slice(0, 4)}`;
      if (e.duracaoMeses) t += ` · durou ${e.duracaoMeses} meses`;
      t += `\n`;
    } else {
      t += `• ${e.nome} — ${e.ramo || 'ramo n/d'}\n  abriu ${quando}, ATIVA`;
      if (e.mesesAberto) t += ` há ${e.mesesAberto} meses`;
      t += `\n`;
    }
  }

  t += `\n_${r.nota}_`;
  return t;
}

module.exports = { rotatividadeEndereco, formatarRotatividade, mesesEntre };
