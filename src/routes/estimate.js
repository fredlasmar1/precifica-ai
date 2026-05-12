const express = require('express')
const router = express.Router()
const { calcularPreco } = require('../data/precificador')

/**
 * Autenticação simples via header X-API-Key.
 * Bens Gestão (e outros consumidores externos) chamam com essa chave.
 */
function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY
  if (!expected) {
    return res.status(503).json({ error: 'API_KEY não configurada no servidor' })
  }
  const provided = req.header('X-API-Key')
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'API key inválida' })
  }
  next()
}

/**
 * POST /api/estimate
 *
 * Body esperado:
 * {
 *   tipo: 'casa'|'apartamento'|'terreno'|'comercial',
 *   finalidade: 'venda'|'aluguel',
 *   cidade: 'Anápolis',
 *   bairro: 'Jundiaí',
 *   endereco: 'Rua X, 123',
 *   metragem: 120,
 *   areaLote?: 250,
 *   quartos?: 3,
 *   vagas?: 2,
 *   conservacao?: 'novo'|'bom'|'regular',
 *   diferenciais?: ['piscina','varanda'],
 *   condominio?: 'Ed. Corporate Center'
 * }
 *
 * Resposta (200):
 * {
 *   precoM2: number,
 *   valorEstimado: number,
 *   faixaMin: number,
 *   faixaMax: number,
 *   confianca: 'alta'|'media'|'baixa',
 *   fonte: string,
 *   comparativos: Array<{...}>,
 *   analise: { raciocinio, perfilBairro, contextoGuru },
 *   dadosImovel: {...}
 * }
 */
router.post('/estimate', requireApiKey, async (req, res) => {
  const dados = req.body || {}

  if (!dados.tipo || !dados.cidade || !dados.bairro) {
    return res
      .status(400)
      .json({ error: 'Campos obrigatórios: tipo, cidade, bairro (mínimo)' })
  }

  try {
    const resultado = await calcularPreco({
      tipo: dados.tipo,
      finalidade: dados.finalidade || 'venda',
      cidade: dados.cidade,
      bairro: dados.bairro,
      endereco: dados.endereco || null,
      condominio: dados.condominio || null,
      metragem: dados.metragem != null ? Number(dados.metragem) : null,
      areaLote: dados.areaLote != null ? Number(dados.areaLote) : null,
      quartos: dados.quartos != null ? Number(dados.quartos) : null,
      vagas: dados.vagas != null ? Number(dados.vagas) : null,
      diferenciais: dados.diferenciais || [],
      conservacao: dados.conservacao || null,
    })

    if (resultado.erro) {
      return res.status(422).json({ error: resultado.mensagem || 'Falha ao calcular preço' })
    }

    res.json({
      precoM2: resultado.precoM2 ?? resultado.precoM2Base ?? null,
      valorEstimado: resultado.valorEstimado ?? resultado.valorTotal ?? null,
      faixaMin: resultado.faixaMin ?? null,
      faixaMax: resultado.faixaMax ?? null,
      confianca: resultado.confianca ?? null,
      fonte: resultado.fontePrincipal ?? resultado.fonte ?? null,
      comparativos: resultado.comparativos ?? [],
      analise: {
        raciocinio: resultado.raciocinio ?? null,
        perfilBairro: resultado.perfilBairro ?? null,
        contextoGuru: resultado.contextoGuru ?? null,
      },
      dadosImovel: dados,
    })
  } catch (err) {
    console.error('[estimate] erro:', err)
    res.status(500).json({ error: err.message || 'Erro inesperado' })
  }
})

module.exports = router
