const express = require('express')
const router = express.Router()
const { calcularPreco } = require('../data/precificador')

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
 * Recebe dados estruturados do imóvel e devolve laudo de mercado.
 */
router.post('/estimate', requireApiKey, async (req, res) => {
  const dados = req.body || {}

  if (!dados.tipo || !dados.cidade || !dados.bairro) {
    return res
      .status(400)
      .json({ error: 'Campos obrigatórios: tipo, cidade, bairro' })
  }

  try {
    const r = await calcularPreco({
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

    if (r?.erro) {
      return res.status(422).json({ error: r.mensagem || 'Falha ao calcular preço' })
    }

    // Normaliza saída do motor para formato estável da API.
    res.json({
      precoM2: r.precoM2Imovel ?? null,
      precoM2Mercado: r.precoM2Mercado ?? null,
      valorEstimado: r.precoRecomendado ?? null,
      faixaMin: r.precoMinimo ?? null,
      faixaMax: r.precoMaximo ?? null,
      confianca: r.analiseIA?.confianca ?? r.confiancaFonte ?? null,
      fonte: Array.isArray(r.fontesConsultadas) ? r.fontesConsultadas.filter(Boolean).join(', ') : null,
      anunciosAnalisados: r.analiseIA?.anunciosAnalisados ?? r.comparativosEncontrados ?? 0,
      comparativos: r.analiseIA?.comparativos ?? [],
      ajustesAplicados: r.ajustesAplicados ?? [],
      tempoEstimadoDias: r.tempoEstimadoDias ?? null,
      indiceLiquidez: r.indiceLiquidez ?? null,
      analise: {
        raciocinio: r.analiseIA?.raciocinio ?? null,
        faixaM2: r.analiseIA?.faixaM2 ?? null,
        citacoes: r.analiseIA?.citacoes ?? [],
      },
      geo: r.geoInfo
        ? {
            enderecoValidado: r.geoInfo.enderecoValidado ?? null,
            bairrosVizinhos: r.geoInfo.bairrosVizinhos ?? [],
            distanciaCentroKm: r.geoInfo.distanciaCentroKm ?? null,
          }
        : null,
      dadosImovel: dados,
    })
  } catch (err) {
    console.error('[estimate] erro:', err)
    res.status(500).json({ error: err.message || 'Erro inesperado' })
  }
})

module.exports = router
