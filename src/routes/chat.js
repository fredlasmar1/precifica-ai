const express = require('express');
const router = express.Router();
const { getSession, addMessage, clearSession, isReadyToEvaluate } = require('../agent/session');
const { chat, extractPropertyData } = require('../agent/openai');
const { calcularPreco, formatarReais } = require('../data/precificador');
const { fontesAvaliacao, textoFontes } = require('../data/fontes');

/**
 * POST /api/chat
 * Recebe mensagem do usuário e retorna resposta do agente
 */
router.post('/chat', async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId e message são obrigatórios' });
  }

  // Comando de reset
  if (/reiniciar|nova avalia[çc][aã]o|reset/i.test(message)) {
    clearSession(sessionId);
    return res.json({
      response: '🔄 Sessão reiniciada! Vamos começar uma nova avaliação.\n\nQual tipo de imóvel você quer avaliar? (casa, apartamento, terreno ou comercial)',
      type: 'text'
    });
  }

  try {
    const history = addMessage(sessionId, 'user', message);
    const jaColetouDados = isReadyToEvaluate(history.slice(0, -1));

    if (jaColetouDados) {
      // Extrai e precifica
      const dadosImovel = await extractPropertyData(history);
      if (!dadosImovel) {
        const msg = '⚠️ Não consegui organizar os dados da conversa. Pode me passar o resumo do imóvel novamente? (tipo, finalidade, cidade, bairro, metragem, quartos, vagas e estado de conservação)';
        addMessage(sessionId, 'assistant', msg);
        return res.json({ response: msg, type: 'text' });
      }

      const resultado = await calcularPreco(dadosImovel);
      if (resultado.erro) {
        addMessage(sessionId, 'assistant', resultado.mensagem);
        return res.json({ response: resultado.mensagem, type: 'text' });
      }
      const laudo = gerarLaudo(dadosImovel, resultado);
      salvarLaudoImovel(dadosImovel, resultado);

      addMessage(sessionId, 'assistant', laudo);
      return res.json({ response: laudo, type: 'laudo', dados: dadosImovel, resultado });
    }

    // Conversa normal
    const resposta = await chat(history);
    addMessage(sessionId, 'assistant', resposta);

    // Verifica se agora está pronto para precificar
    const historicoAtual = [...history, { role: 'assistant', content: resposta }];
    if (isReadyToEvaluate(historicoAtual)) {
      const dadosImovel = await extractPropertyData(historicoAtual);
      if (dadosImovel) {
        const resultado = await calcularPreco(dadosImovel);
        if (resultado.erro) {
          addMessage(sessionId, 'assistant', resultado.mensagem);
          return res.json({ response: resposta, followUp: resultado.mensagem, type: 'text' });
        }
        const laudo = gerarLaudo(dadosImovel, resultado);
        salvarLaudoImovel(dadosImovel, resultado);
        addMessage(sessionId, 'assistant', laudo);

        return res.json({
          response: resposta,
          followUp: laudo,
          type: 'laudo',
          dados: dadosImovel,
          resultado
        });
      }
    }

    return res.json({ response: resposta, type: 'text' });

  } catch (err) {
    console.error('[Chat API] Erro:', err);
    const userMsg =
      '⚠️ Tive um problema técnico ao processar sua mensagem. ' +
      'Tente novamente em instantes ou digite *reiniciar* para começar uma nova avaliação.';
    return res.status(500).json({ error: userMsg, debug: err.message });
  }
});

/**
 * DELETE /api/chat/:sessionId
 * Limpa sessão
 */
router.delete('/chat/:sessionId', (req, res) => {
  clearSession(req.params.sessionId);
  res.json({ ok: true });
});

/**
 * POST /api/avaliar
 * Avaliação direta via formulário do site (campos estruturados, sem auth).
 * Pula a coleta conversacional do LLM e chama o MESMO motor (calcularPreco)
 * e o MESMO laudo formatado usados pelo chat e pelo Telegram.
 */
router.post('/avaliar', async (req, res) => {
  const b = req.body || {};

  const tipo = String(b.tipo || '').trim().toLowerCase();
  const finalidade = String(b.finalidade || 'venda').trim().toLowerCase();
  const cidade = String(b.cidade || '').trim();
  const bairro = String(b.bairro || '').trim();
  const metragem = b.metragem != null && b.metragem !== '' ? Number(b.metragem) : null;
  const areaLote = b.areaLote != null && b.areaLote !== '' ? Number(b.areaLote) : null;

  const faltando = [];
  if (!tipo) faltando.push('tipo');
  if (!cidade) faltando.push('cidade');
  if (!bairro) faltando.push('bairro');
  if ((!metragem || metragem <= 0) && (!areaLote || areaLote <= 0)) faltando.push('metragem');
  if (faltando.length) {
    return res.status(400).json({ error: `Preencha: ${faltando.join(', ')}.` });
  }

  const dadosImovel = {
    tipo,
    finalidade: finalidade === 'aluguel' ? 'aluguel' : 'venda',
    cidade,
    bairro,
    endereco: String(b.endereco || '').trim() || null,
    condominio: String(b.condominio || '').trim() || null,
    metragem,
    areaLote,
    quartos: b.quartos != null && b.quartos !== '' ? Number(b.quartos) : null,
    vagas: b.vagas != null && b.vagas !== '' ? Number(b.vagas) : null,
    diferenciais: String(b.diferenciais || '').trim(),
    conservacao: String(b.conservacao || 'bom').trim().toLowerCase(),
    idade: b.idade != null && b.idade !== '' ? Number(b.idade) : null
  };

  try {
    // Quadro completo: avalia a finalidade pedida E a outra (venda↔aluguel) em
    // PARALELO — mesmo tempo de espera, dobro da informação (preço + yield).
    const outraFinal = dadosImovel.finalidade === 'venda' ? 'aluguel' : 'venda';
    const [resultado, rOutra] = await Promise.all([
      calcularPreco(dadosImovel),
      calcularPreco({ ...dadosImovel, finalidade: outraFinal }).catch(() => null),
    ]);
    if (resultado.erro) {
      return res.status(422).json({ error: resultado.mensagem });
    }
    let laudo = gerarLaudo(dadosImovel, resultado);
    if (rOutra && !rOutra.erro && rOutra.precoRecomendado > 0) {
      const fmt = (v) => 'R$ ' + Number(v).toLocaleString('pt-BR');
      const venda = dadosImovel.finalidade === 'venda' ? resultado.precoRecomendado : rOutra.precoRecomendado;
      const aluguel = dadosImovel.finalidade === 'aluguel' ? resultado.precoRecomendado : rOutra.precoRecomendado;
      const yieldMes = venda > 0 ? (aluguel / venda * 100) : 0;
      const paybackAnos = (venda > 0 && aluguel > 0) ? (venda / (aluguel * 12)).toFixed(1) : '—';
      laudo += `\n━━━━━━━━━━━━━━━━━━\n📈 *VENDA × ALUGUEL — quadro completo:*\n`;
      laudo += `• Preço de venda: *${fmt(venda)}*\n`;
      laudo += `• Aluguel de mercado: *${fmt(aluguel)}/mês*\n`;
      laudo += `• Rentabilidade (yield): *${yieldMes.toFixed(2)}%/mês* (${(yieldMes * 12).toFixed(1)}%/ano) · payback ~${paybackAnos} anos\n`;
      resultado.precoVenda = venda; resultado.precoAluguel = aluguel; resultado.yieldMes = +yieldMes.toFixed(2);
    }
    salvarLaudoImovel(dadosImovel, resultado);
    return res.json({ type: 'laudo', response: laudo, dados: dadosImovel, resultado });
  } catch (err) {
    console.error('[Avaliar API] Erro:', err);
    return res.status(500).json({
      error: '⚠️ Tive um problema técnico ao avaliar. Tente novamente em instantes.',
      debug: err.message
    });
  }
});

/**
 * POST /api/ponto-comercial
 * Buscador inteligente comercial: dado endereço + ramo do cliente, avalia
 * concorrência, geradores de movimento e demanda → veredito de ponto comercial.
 */
router.post('/ponto-comercial', async (req, res) => {
  const b = req.body || {};
  const cidade = String(b.cidade || 'Anápolis').trim();
  const bairro = String(b.bairro || '').trim();
  const endereco = String(b.endereco || '').trim();
  const ramo = String(b.ramo || '').trim();

  if (!bairro || !ramo) {
    return res.status(400).json({ error: 'Informe o bairro e o ramo do cliente (ex: farmácia, academia).' });
  }

  try {
    const { validarEndereco } = require('../data/geoValidacao');
    const { perfilarLocal } = require('../data/guruAnapolis');
    const { analisarPontoComercial, formatarRelatorioComercial, coordsBairro } = require('../data/pontoComercial');

    const geo = await validarEndereco(cidade, bairro, endereco);
    let lat, lng;
    if (geo && geo.valido) { lat = geo.lat; lng = geo.lng; }
    else {
      const c = coordsBairro(bairro); // fallback p/ bairros conhecidos (ex: "Centro" sem rua)
      if (c) { lat = c.lat; lng = c.lng; }
      else return res.status(422).json({ error: 'Não consegui localizar esse endereço/bairro em Goiás. Confira e tente de novo.' });
    }

    let perfilGuru = null;
    try { perfilGuru = await perfilarLocal(cidade, bairro, lat, lng); } catch {}

    const analise = await analisarPontoComercial(lat, lng, ramo, { cidade, bairro, perfilGuru });
    if (analise.erro) return res.status(422).json({ error: analise.erro });

    const texto = formatarRelatorioComercial(analise);
    try {
      require('../data/database').salvarLaudo({
        kind: 'comercial', titulo: analise.ramo, tipo: 'comercial',
        cidade: analise.cidade, bairro: analise.bairro, valor: 0,
        dados: { ramo: analise.ramo, bairro: analise.bairro }, resultado: analise,
      });
    } catch {}
    return res.json({ type: 'comercial', response: texto, analise });
  } catch (err) {
    console.error('[PontoComercial API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao analisar o ponto comercial. Tente novamente.', debug: err.message });
  }
});

/**
 * POST /api/melhor-bairro
 * Recomendador: varre os bairros de Anápolis e ranqueia os melhores para o ramo.
 * Aceita { ramo } direto OU { pergunta } em linguagem natural ("qual o melhor
 * bairro para uma barbearia?").
 */
router.post('/melhor-bairro', async (req, res) => {
  const b = req.body || {};
  try {
    const { melhorBairro, formatarMelhorBairro, extrairRamo } = require('../data/pontoComercial');
    let ramo = String(b.ramo || '').trim();
    if (!ramo && b.pergunta) ramo = await extrairRamo(b.pergunta);
    if (!ramo) return res.status(400).json({ error: 'Não identifiquei o ramo. Ex: "qual o melhor bairro para uma barbearia?"' });

    const d = await melhorBairro(ramo);
    if (d.erro) return res.status(422).json({ error: d.erro });
    return res.json({ type: 'melhor-bairro', response: formatarMelhorBairro(d), ramo, ranking: d.ranking });
  } catch (err) {
    console.error('[MelhorBairro API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao buscar o melhor bairro. Tente novamente.', debug: err.message });
  }
});

/**
 * POST /api/predio — aba "Prédios": ficha completa de um edifício
 * (endereço, CNPJ, condomínio, IPTU, lazer, processos) + unidades anunciadas.
 */
router.post('/predio', async (req, res) => {
  const b = req.body || {};
  const condominio = String(b.condominio || '').trim();
  const bairro = String(b.bairro || '').trim();
  const cidade = String(b.cidade || 'Anápolis').trim();
  if (!condominio || !bairro) {
    return res.status(400).json({ error: 'Informe o nome do prédio e o bairro.' });
  }
  try {
    const { estimarPrecoPredio } = require('../data/analistaIA');
    const { gerarFichaPredio, formatarBuscaPredio } = require('../data/fichaPredio');
    const { filtrarCompsSanos } = require('../data/baseAnapolis');

    // Unidades anunciadas no prédio — única origem legítima de preço nesta ficha.
    // Duas travas antes de um número virar "faixa do prédio":
    // 1) suspeitaFabricacao (preços quase idênticos entre si = dado inventado);
    //    o laudo de unidade já descartava, a aba Prédios exibia mesmo assim.
    // 2) R$/m² fora da faixa plausível do bairro (pega prédio homônimo de outra
    //    cidade e preço inconsistente).
    // Cache por condomínio (3 dias). `precos_mercado` já é chaveada por
    // condominio — a aba ignorava e disparava 2-3 chamadas Perplexity a cada
    // busca, inclusive para repetir a MESMA pesquisa. Pior: sem cache, duas
    // buscas do mesmo prédio podiam devolver unidades diferentes (o LLM não é
    // determinístico). Cacheia inclusive o resultado VAZIO — descobrir que um
    // prédio não tem anúncio custa as mesmas 3 chamadas.
    const db = require('../data/database');
    let unidades = null, veioDoCache = false;
    try {
      const c = await db.buscarPreco(cidade, bairro, 'apartamento', 'venda', condominio);
      if (c && Number(c.dias_desde) < 3) {
        const cs = Array.isArray(c.comparativos) ? c.comparativos : [];
        unidades = { comparativos: cs, precoMedioM2: Number(c.preco_m2) || 0, anunciosAnalisados: cs.length, confianca: c.confianca, citacoes: [] };
        veioDoCache = true;
        console.log(`[Predio] cache hit: ${condominio} (${cs.length} unid, ${Math.round(c.dias_desde * 24)}h)`);
      }
    } catch (e) { console.warn('[Predio] cache leitura:', e.message); }

    if (!unidades) unidades = await estimarPrecoPredio({ finalidade: 'venda', cidade, bairro, condominio });
    const fabricada = !!(unidades && unidades.suspeitaFabricacao);
    const brutos = (unidades && !fabricada) ? (unidades.comparativos || []) : [];
    const { ok: comps, descartados } = filtrarCompsSanos(brutos, { tipo: 'apartamento', finalidade: 'venda', cidade, bairro });
    let valorRef = 0;
    if (comps.length) {
      const precos = comps.map(c => Number(c.preco)).filter(p => p > 0).sort((a, b) => a - b);
      valorRef = precos[Math.floor(precos.length / 2)] || 0;
    }

    // Grava o que veio da Perplexity (inclusive vazio) — só o que é NOVO.
    if (!veioDoCache) {
      try {
        await db.salvarPreco({
          cidade, bairro, tipo: 'apartamento', finalidade: 'venda', condominio,
          preco_m2: (unidades && unidades.precoMedioM2) || 0,
          faixa_min: (unidades && unidades.faixaMinM2) || null,
          faixa_max: (unidades && unidades.faixaMaxM2) || null,
          amostras: comps.length,
          confianca: (unidades && unidades.confianca) || 'baixa',
          fonte: `Prédio: ${condominio}`,
          comparativos: comps,
        });
      } catch (e) { console.warn('[Predio] cache gravação:', e.message); }
    }

    // Memória do prédio (tabela `predios`, 30 dias). Sem ela, cada busca
    // reconstruía a ficha via LLM e ano/padrão MUDAVAM entre duas buscas do
    // mesmo prédio — e padrão vale 2x no preço, então a estimativa balançava.
    let memoria = null;
    try { memoria = await db.buscarPredio(cidade, bairro, condominio); } catch (e) { console.warn('[Predio] memoria leitura:', e.message); }
    const memoriaFresca = memoria && Number(memoria.dias_desde) < 30;

    const ficha = await gerarFichaPredio({
      condominio, bairro, cidade, valorMercado: valorRef,
      cache: memoriaFresca ? memoria : null,
    });

    // Ano/padrão informados pelo corretor MANDAM no que a IA achou — quem conhece
    // o prédio é ele — e ficam gravados como verdade (salvarPredio nunca deixa a
    // IA sobrescrever um 'informado').
    const anoInformado = Number(b.anoConstrucao) > 1900 ? Number(b.anoConstrucao) : null;
    if (ficha && anoInformado) { ficha.anoConstrucao = anoInformado; ficha.anoFonte = 'informado'; }
    const padraoInformado = String(b.padrao || '').trim();
    if (ficha && padraoInformado) { ficha.padrao = padraoInformado; ficha.padraoFonte = 'informado'; }

    // Grava o que aprendemos (inclusive a correção do dono).
    if (ficha) {
      try {
        await db.salvarPredio({
          cidade, bairro, condominio,
          endereco: ficha.endereco, cnpj: ficha.cnpj,
          ano_construcao: ficha.anoConstrucao, ano_fonte: ficha.anoFonte,
          padrao: ficha.padrao, padrao_fonte: ficha.padraoFonte,
          condominio_mensal: typeof ficha.condominioMensal === 'string' ? ficha.condominioMensal : (ficha.condominioMensal ? String(ficha.condominioMensal) : null),
          lazer: ficha.lazer, perfil_unidades: ficha.perfilUnidades,
          perfil_confirmado: ficha.perfilConfirmado,
        });
      } catch (e) { console.warn('[Predio] memoria gravação:', e.message); }
    }
    const conservacao = b.conservacao || b.aptoConservacao || 'bom';

    // Sem anúncio no prédio o comparativo não tem o que comparar; com o ano, dá
    // pra estimar pelo custo depreciado (evolutivo).
    // MAS: se o usuário pediu o laudo de uma unidade (área informada), o laudo roda
    // sobre o mercado REAL do bairro — e mercado real ganha de custo estimado.
    // Publicar os dois na mesma tela colocaria dois números discordantes lado a
    // lado, que é exatamente o defeito que esta ficha veio corrigir.
    const temLaudoDeUnidade = !!(b.modoApto && Number(b.aptoArea) > 0);
    let evolutivo = null;
    if (!comps.length && ficha && ficha.anoConstrucao && !temLaudoDeUnidade) {
      // Calibra o FC no mercado REAL do bairro (mesma fonte do laudo), não na
      // âncora EBM: a EBM é o topo do mercado e inflava a estimativa ~2x.
      // Passa pelo cache do bairro (linha condominio='') — sem ele o scraping
      // devolvia mediana diferente a cada rodada (4.857 / 5.217 / 6.180) e a
      // estimativa do MESMO prédio balançava junto. É a mesma linha que o
      // calcularPreco usa, então os dois se aproveitam do trabalho um do outro.
      let mercadoRefM2 = null;
      try {
        const cacheBairro = await db.buscarPreco(cidade, bairro, 'apartamento', 'venda', '');
        if (cacheBairro && Number(cacheBairro.dias_desde) < 3 && Number(cacheBairro.preco_m2) > 0) {
          mercadoRefM2 = Number(cacheBairro.preco_m2);
        } else {
          const { buscarComparativos } = require('../data/portais');
          const mkt = await buscarComparativos({ tipo: 'apartamento', finalidade: 'venda', cidade, bairro });
          if (mkt && mkt.precoMedioM2 > 0) {
            mercadoRefM2 = mkt.precoMedioM2;
            await db.salvarPreco({
              cidade, bairro, tipo: 'apartamento', finalidade: 'venda', condominio: '',
              preco_m2: mercadoRefM2, faixa_min: mkt.precoMinimo || null, faixa_max: mkt.precoMaximo || null,
              amostras: (mkt.imoveis || []).length, confianca: mkt.confianca || 'media',
              fonte: mkt.fonte || 'portais', comparativos: mkt.imoveis || [],
            });
          }
        }
      } catch (e) { console.warn('[Predio] mercado ref:', e.message); }
      try {
        evolutivo = require('../data/depreciacao').estimarEvolutivo({
          cidade, bairro, area: Number(b.aptoArea) || null,
          anoConstrucao: ficha.anoConstrucao, padrao: ficha.padrao, conservacao,
          mercadoRefM2,
        });
      } catch (e) { console.warn('[Predio] evolutivo:', e.message); }
    }

    let texto = formatarBuscaPredio(ficha, {
      ...(unidades || {}), comparativos: comps,
      descartados: descartados.length, suspeitaFabricacao: fabricada,
    }, evolutivo);

    // Modo "Prédio + Apartamento": mostra o panorama das unidades (venda já veio
    // na ficha; aqui adiciona ALUGUEL) e, SÓ se a área for informada, o laudo da unidade.
    let apto = null;
    if (b.modoApto) {
      try {
        const unidadesAlug = await estimarPrecoPredio({ finalidade: 'aluguel', cidade, bairro, condominio });
        const brutosA = (unidadesAlug && !unidadesAlug.suspeitaFabricacao) ? (unidadesAlug.comparativos || []) : [];
        const { ok: compsA } = filtrarCompsSanos(brutosA, { tipo: 'apartamento', finalidade: 'aluguel', cidade, bairro });
        if (compsA.length) {
          texto += `\n🏠 *Unidades para ALUGUEL neste prédio (${compsA.length}):*\n`;
          compsA.slice(0, 8).forEach((c, i) => {
            texto += `  ${i + 1}. ${c.area || '?'}m² • R$ ${Number(c.preco || 0).toLocaleString('pt-BR')}/mês${c.precoM2 ? ` (R$ ${Number(c.precoM2).toLocaleString('pt-BR')}/m²·mês)` : ''}${c.quartos ? ` • ${c.quartos}q` : ''}\n`;
          });
        } else {
          texto += `\n_Nenhuma unidade para aluguel anunciada neste prédio agora._\n`;
        }
      } catch (e) { console.warn('[Predio] aluguel:', e.message); }

      const aptoArea = Number(b.aptoArea) || 0;
      if (aptoArea > 0) {
        const { calcularPreco } = require('../data/precificador');
        const finalidade = b.aptoFinalidade === 'aluguel' ? 'aluguel' : 'venda';
        // Idade e padrão saem do dossiê do prédio: sem eles o laudo usaria a
        // âncora do bairro (preço de prédio NOVO) para um prédio velho.
        const dadosApto = {
          tipo: 'apartamento', finalidade, cidade, bairro, condominio,
          metragem: aptoArea, quartos: b.aptoQuartos, vagas: b.aptoVagas, conservacao,
          idade: ficha && ficha.anoConstrucao ? new Date().getFullYear() - ficha.anoConstrucao : undefined,
          padrao: ficha && ficha.padrao ? ficha.padrao : undefined,
        };
        try {
          apto = await calcularPreco(dadosApto);
          if (apto && !apto.erro) {
            texto += `\n\n━━━━━━━━━━━━━━━━━━\n🏠 *LAUDO DA UNIDADE* (${finalidade === 'aluguel' ? 'aluguel' : 'venda'}, ${aptoArea}m² no ${condominio})\n\n` + gerarLaudo(dadosApto, apto);
            salvarLaudoImovel(dadosApto, apto);
          }
        } catch (e) { console.warn('[Predio] avaliação apto:', e.message); }
      } else {
        texto += comps.length
          ? `\n💡 _As metragens acima são de unidades realmente anunciadas neste prédio. Quer o laudo de uma específica? Informe a **área** (e a finalidade)._\n`
          : `\n💡 _Sem anúncio confirmado, não dá pra saber as metragens reais deste prédio. Se você souber a **área** da unidade, informe que eu faço o laudo pela referência do bairro — lembrando que ela ainda não desconta a idade do prédio._\n`;
      }
    }
    try {
      require('../data/database').salvarLaudo({
        kind: 'predio', titulo: condominio, tipo: 'predio', cidade, bairro,
        valor: valorRef || (evolutivo && evolutivo.valorTotal) || 0, dados: { condominio, bairro, cidade },
        resultado: { ficha, unidades: comps, evolutivo },
      });
    } catch (e) { console.warn('[Predio] salvar:', e.message); }
    return res.json({ type: 'predio', response: texto, ficha, unidades: comps, apto });
  } catch (err) {
    console.error('[Predio API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao pesquisar o prédio. Tente novamente.' });
  }
});

/**
 * POST /api/fazenda — Avaliação de propriedade rural (chácara/sítio/fazenda).
 * body: { cidade, referencia, subtipo, area, unidade, acesso, agua, energia, benfeitorias, finalidade }
 */
router.post('/fazenda', async (req, res) => {
  const b = req.body || {};
  const recreio = b.modo === 'recreio';
  const area = recreio ? Number(b.areaM2 || b.area) : Number(b.area);
  if (!(area > 0)) return res.status(400).json({ error: recreio ? 'Informe a área da chácara em m².' : 'Informe a área da propriedade (alqueires ou hectares).' });
  try {
    const fz = require('../data/fazenda');
    const r = recreio ? await fz.avaliarChacara(b) : await fz.avaliarFazenda(b);
    if (r.erro) return res.status(422).json({ error: r.erro });
    const resposta = recreio ? fz.formatarChacara(r) : fz.formatarFazenda(r);
    try {
      const titulo = recreio ? `Chácara ${Number(r.areaM2).toLocaleString('pt-BR')} m²` : `${(r.subtipo || 'rural')} ${r.areaAlq} alq`;
      require('../data/database').salvarLaudo({
        kind: 'fazenda', titulo, tipo: 'rural',
        finalidade: (r.dados && r.dados.finalidade) || 'venda', cidade: r.cidade, bairro: r.referencia,
        valor: r.total, dados: r.dados,
        resultado: { view: r, texto: resposta, modo: recreio ? 'recreio' : 'produtiva' },
      });
    } catch (e) { console.warn('[Fazenda] salvar:', e.message); }
    return res.json({ type: 'fazenda', response: resposta, resultado: r });
  } catch (err) {
    console.error('[Fazenda API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao avaliar a propriedade. Tente novamente.', debug: err.message });
  }
});

/**
 * POST /api/decisao — Comparador: manter alugado × vender e investir em títulos.
 */
router.post('/decisao', async (req, res) => {
  const b = req.body || {};
  if (!(Number(b.valorImovel) > 0)) return res.status(400).json({ error: 'Informe o valor de mercado do imóvel.' });
  try {
    const { analisarDecisao, formatarDecisao } = require('../data/decisao');
    const r = await analisarDecisao(b);
    if (r.erro) return res.status(422).json({ error: r.erro });
    return res.json({ type: 'decisao', response: formatarDecisao(r), resultado: r });
  } catch (err) {
    console.error('[Decisao API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao montar a comparação. Tente novamente.', debug: err.message });
  }
});

/** POST /api/relatorio-decisao — PDF do comparador alugar × vender. */
router.post('/relatorio-decisao', async (req, res) => {
  const { resultado, solicitante } = req.body || {};
  if (!resultado || !resultado.cenarioA) return res.status(400).json({ error: 'Faça a comparação primeiro.' });
  try {
    const { gerarDecisaoPdf } = require('../data/relatorioPdf');
    const pdf = await gerarDecisaoPdf(resultado, { solicitante });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="alugar-ou-vender.pdf"');
    res.send(pdf);
  } catch (err) {
    console.error('[RelatDecisao API] Erro:', err);
    res.status(500).json({ error: '⚠️ Erro ao gerar o PDF. Tente novamente.' });
  }
});

/**
 * POST /api/avaliar-empresa — Calculadora de avaliação de empresa / passagem de ponto.
 */
router.post('/avaliar-empresa', async (req, res) => {
  const b = req.body || {};
  if (!b.faturamentoMensal || Number(b.faturamentoMensal) <= 0) {
    return res.status(400).json({ error: 'Informe ao menos o faturamento mensal.' });
  }
  try {
    const { avaliarEmpresa, formatarEmpresa } = require('../data/valuationEmpresa');
    const resultado = await avaliarEmpresa(b);
    if (resultado.erro) return res.status(422).json({ error: resultado.erro });
    try {
      require('../data/database').salvarLaudo({
        kind: 'empresa', titulo: resultado.ramo, tipo: 'empresa',
        cidade: resultado.cidade, bairro: resultado.bairro, valor: resultado.valorSugerido,
        dados: { ramo: resultado.ramo, bairro: resultado.bairro }, resultado,
      });
    } catch {}
    return res.json({ type: 'empresa', response: formatarEmpresa(resultado), resultado });
  } catch (err) {
    console.error('[Empresa API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao avaliar a empresa. Tente novamente.' });
  }
});

/** POST /api/relatorio-empresa — PDF da avaliação de empresa. */
router.post('/relatorio-empresa', async (req, res) => {
  const { resultado, solicitante } = req.body || {};
  if (!resultado) return res.status(400).json({ error: 'Faça uma avaliação de empresa primeiro.' });
  try {
    const { gerarEmpresaPdf } = require('../data/relatorioPdf');
    const pdf = await gerarEmpresaPdf(resultado, { solicitante });
    const slug = String(resultado.ramo || 'empresa').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="avaliacao-empresa-${slug}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[RelatEmpresa API] Erro:', err);
    res.status(500).json({ error: '⚠️ Erro ao gerar o PDF. Tente novamente.' });
  }
});

/**
 * POST /api/repasse — transforma a avaliação em repasse: desconto sugerido,
 * preço de repasse, economia, tempo acelerado e estratégia de venda.
 * Body: { dados, resultado, desconto? }
 */
router.post('/repasse', async (req, res) => {
  const { dados, resultado, desconto } = req.body || {};
  if (!resultado || !resultado.precoRecomendado) return res.status(400).json({ error: 'Faça uma avaliação primeiro.' });
  try {
    const { calcularRepasse, descontoSugerido, estrategiaRepasse } = require('../data/repasse');
    const sugerido = descontoSugerido(resultado.indiceLiquidez);
    const r = calcularRepasse(resultado, desconto != null ? desconto : sugerido);
    const estrategia = await estrategiaRepasse(dados || {}, r);
    return res.json({ ...r, descontoSugerido: sugerido, estrategia });
  } catch (err) {
    console.error('[Repasse API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao calcular o repasse. Tente novamente.' });
  }
});

/** POST /api/relatorio-repasse — PDF do laudo de repasse. */
router.post('/relatorio-repasse', async (req, res) => {
  const { dados, resultado, desconto, estrategia, solicitante } = req.body || {};
  if (!resultado || !resultado.precoRecomendado) return res.status(400).json({ error: 'Faça uma avaliação primeiro.' });
  try {
    const { gerarRepassePdf } = require('../data/relatorioPdf');
    const pdf = await gerarRepassePdf(dados || {}, resultado, { desconto, estrategia, solicitante });
    const slug = String(dados?.bairro || 'imovel').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="repasse-${slug}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[RelatRepasse API] Erro:', err);
    res.status(500).json({ error: '⚠️ Erro ao gerar o PDF. Tente novamente.' });
  }
});

/**
 * GET /api/fipe?tipo=&finalidade= — "FIPE de Anápolis": R$/m² por bairro.
 */
router.get('/fipe', (req, res) => {
  try {
    const { tabelaFipe } = require('../data/baseAnapolis');
    const tipo = String(req.query.tipo || 'apartamento').toLowerCase();
    const finalidade = String(req.query.finalidade || 'venda').toLowerCase();
    res.json({ tipo, finalidade, tabela: tabelaFipe(tipo, finalidade) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/terreno — Estudo de viabilidade de terreno/lote (potencial construtivo).
 */
router.post('/terreno', async (req, res) => {
  const b = req.body || {};
  if (!b.bairro || !(Number(b.area) > 0)) {
    return res.status(400).json({ error: 'Informe o bairro e a área do terreno (m²).' });
  }
  try {
    const { analisarTerreno, formatarTerreno } = require('../data/terreno');
    const resultado = await analisarTerreno(b);
    if (resultado.erro) return res.status(422).json({ error: resultado.erro });
    try {
      require('../data/database').salvarLaudo({
        kind: 'terreno', titulo: `Terreno ${resultado.area}m²`, tipo: 'terreno',
        finalidade: 'venda', cidade: resultado.cidade, bairro: resultado.bairro,
        endereco: resultado.endereco, valor: resultado.valorTerreno,
        dados: { bairro: resultado.bairro, area: resultado.area, zona: resultado.zonaKey },
        resultado,
      });
    } catch (e) { console.warn('[Terreno] salvar:', e.message); }
    return res.json({ type: 'terreno', response: formatarTerreno(resultado), resultado });
  } catch (err) {
    console.error('[Terreno API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao analisar o terreno. Tente novamente.' });
  }
});

/**
 * POST /api/bts — Estudo de viabilidade BTS (Build to Suit): investimento × aluguel
 * de mercado (cap rate) + melhor uso do ponto + empresas em expansão.
 */
router.post('/bts', async (req, res) => {
  const b = req.body || {};
  if (!b.bairro || !(Number(b.area) > 0)) {
    return res.status(400).json({ error: 'Informe o bairro e a área do terreno (m²).' });
  }
  try {
    const { analisarBTS, formatarBTS } = require('../data/bts');
    const resultado = await analisarBTS(b);
    if (resultado.erro) return res.status(422).json({ error: resultado.erro });
    try {
      require('../data/database').salvarLaudo({
        kind: 'bts', titulo: `BTS ${resultado.area}m²`, tipo: 'terreno',
        finalidade: 'aluguel', cidade: resultado.cidade, bairro: resultado.bairro,
        endereco: resultado.endereco, valor: resultado.investimento,
        dados: { bairro: resultado.bairro, area: resultado.area, zona: resultado.zonaKey },
        resultado,
      });
    } catch (e) { console.warn('[BTS] salvar:', e.message); }
    return res.json({ type: 'bts', response: formatarBTS(resultado), resultado });
  } catch (err) {
    console.error('[BTS API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao montar o estudo BTS. Tente novamente.', debug: err.message });
  }
});

/**
 * POST /api/radar — Radar de Expansão: busca reversa de empresas em expansão que
 * poderiam querer um imóvel na região (inquilino/comprador BTS). body: { regiao, ramo }
 */
router.post('/radar', async (req, res) => {
  const b = req.body || {};
  try {
    const { radarExpansao, formatarRadar } = require('../data/bts');
    const resultado = await radarExpansao(b.regiao, b.ramo, b.porte);
    if (resultado.erro) return res.status(422).json({ error: resultado.erro });
    return res.json({ type: 'radar', response: formatarRadar(resultado), resultado });
  } catch (err) {
    console.error('[Radar API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao rodar o radar. Tente novamente.', debug: err.message });
  }
});

/**
 * POST /api/filiais — Camada CNPJ: confirma na Receita as filiais de uma rede na
 * região (sinal duro de expansão). body: { empresa, regiao }
 */
router.post('/filiais', async (req, res) => {
  const b = req.body || {};
  if (!String(b.empresa || '').trim()) return res.status(400).json({ error: 'Informe o nome da rede/empresa.' });
  try {
    const { confirmarFiliais, formatarFiliais } = require('../data/bts');
    const resultado = await confirmarFiliais(b.empresa, b.regiao);
    if (resultado.erro) return res.status(422).json({ error: resultado.erro });
    return res.json({ type: 'filiais', response: formatarFiliais(resultado), resultado });
  } catch (err) {
    console.error('[Filiais API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao confirmar filiais na Receita. Tente novamente.', debug: err.message });
  }
});

/**
 * POST /api/captacao — Captação de área: busca imóveis à venda que batem com o
 * spec do inquilino-alvo. body: { cidade, bairro, tipo, areaMin, areaMax }
 */
router.post('/captacao', async (req, res) => {
  const b = req.body || {};
  try {
    const { captarArea, formatarCaptacao } = require('../data/bts');
    const resultado = await captarArea(b);
    if (resultado.erro) return res.status(422).json({ error: resultado.erro });
    return res.json({ type: 'captacao', response: formatarCaptacao(resultado), resultado });
  } catch (err) {
    console.error('[Captacao API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao buscar áreas. Tente novamente.', debug: err.message });
  }
});

/** POST /api/relatorio-fazenda — PDF do laudo rural (fazenda produtiva ou chácara). */
router.post('/relatorio-fazenda', async (req, res) => {
  const { resultado, solicitante } = req.body || {};
  if (!resultado || !(resultado.total > 0)) return res.status(400).json({ error: 'Faça uma avaliação rural primeiro.' });
  try {
    const { gerarFazendaPdf } = require('../data/relatorioPdf');
    const pdf = await gerarFazendaPdf(resultado, { solicitante });
    res.setHeader('Content-Type', 'application/pdf');
    const nome = (resultado.modo === 'recreio' ? 'chacara' : 'fazenda') + '-' + (resultado.cidade || 'go').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="laudo-${nome}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[RelatFazenda API] Erro:', err);
    res.status(500).json({ error: '⚠️ Erro ao gerar o PDF. Tente novamente.' });
  }
});

/** POST /api/relatorio-radar — PDF da lista de alvos do Radar de Expansão. */
router.post('/relatorio-radar', async (req, res) => {
  const { resultado } = req.body || {};
  if (!resultado || !Array.isArray(resultado.empresas)) return res.status(400).json({ error: 'Rode o Radar primeiro.' });
  try {
    const { gerarRadarPdf } = require('../data/relatorioPdf');
    const { buscarContato } = require('../data/bts');
    // Enriquece cada empresa com CONTATO real (site/telefone/email + CNPJ Receita)
    // na hora de gerar o PDF, em lotes p/ não estourar rate limit.
    const emp = resultado.empresas;
    const LOTE = 5;
    for (let i = 0; i < emp.length; i += LOTE) {
      const bloco = emp.slice(i, i + LOTE);
      const contatos = await Promise.all(bloco.map(e => buscarContato(e.nome).catch(() => null)));
      bloco.forEach((e, k) => {
        const c = contatos[k]; if (!c || c.erro) return;
        e.site = e.site || c.site;
        e.telefone = e.telefone || c.telefone || c.cnpjTel;
        e.email = e.email || c.emailExpansao || c.emailGeral || c.cnpjEmail;
        e.canalExpansao = c.canalExpansao || null;
        e.cnpjMatriz = c.cnpjMatriz || null;
        e.cnpjEmail = c.cnpjEmail || null;
      });
    }
    const pdf = await gerarRadarPdf(resultado);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="alvos-expansao-${(resultado.regiao || 'regiao').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[RelatRadar API] Erro:', err);
    res.status(500).json({ error: '⚠️ Erro ao gerar o PDF. Tente novamente.' });
  }
});

/**
 * POST /api/contato — Como chegar na rede: canal de expansão/imóveis + email e
 * telefone do CNPJ (Receita). body: { empresa }
 */
router.post('/contato', async (req, res) => {
  const b = req.body || {};
  if (!String(b.empresa || '').trim()) return res.status(400).json({ error: 'Informe o nome da rede/empresa.' });
  try {
    const { buscarContato, formatarContato } = require('../data/bts');
    const resultado = await buscarContato(b.empresa);
    if (resultado.erro) return res.status(422).json({ error: resultado.erro });
    return res.json({ type: 'contato', response: formatarContato(resultado), resultado });
  } catch (err) {
    console.error('[Contato API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao buscar contato. Tente novamente.', debug: err.message });
  }
});

/**
 * POST /api/email-prospeccao — Gera e-mail/WhatsApp de prospecção PERSONALIZADO
 * (rede-alvo + dados do imóvel específico). body: { empresa, cidade, bairro, area, tipo, endereco, detalhes, sinal, formato }
 */
router.post('/email-prospeccao', async (req, res) => {
  const b = req.body || {};
  if (!String(b.empresa || '').trim()) return res.status(400).json({ error: 'Informe a rede/empresa-alvo.' });
  try {
    const { gerarEmailProspeccao, formatarEmailProspeccao } = require('../data/bts');
    const resultado = await gerarEmailProspeccao(b);
    if (resultado.erro) return res.status(422).json({ error: resultado.erro });
    return res.json({ type: 'email-prospeccao', response: formatarEmailProspeccao(resultado), resultado });
  } catch (err) {
    console.error('[EmailProsp API] Erro:', err);
    return res.status(500).json({ error: '⚠️ Erro ao gerar o e-mail. Tente novamente.', debug: err.message });
  }
});

/** POST /api/relatorio-bts — PDF do estudo de viabilidade BTS. */
router.post('/relatorio-bts', async (req, res) => {
  const { resultado, solicitante } = req.body || {};
  if (!resultado) return res.status(400).json({ error: 'Faça um estudo BTS primeiro.' });
  try {
    const { gerarBtsPdf } = require('../data/relatorioPdf');
    const pdf = await gerarBtsPdf(resultado, { solicitante });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="estudo-bts-${(resultado.bairro || 'anapolis').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[RelatBTS API] Erro:', err);
    res.status(500).json({ error: '⚠️ Erro ao gerar o PDF. Tente novamente.' });
  }
});

/** POST /api/relatorio-terreno — PDF do estudo de viabilidade do terreno. */
router.post('/relatorio-terreno', async (req, res) => {
  const { resultado, solicitante } = req.body || {};
  if (!resultado) return res.status(400).json({ error: 'Faça uma análise de terreno primeiro.' });
  try {
    const { gerarTerrenoPdf } = require('../data/relatorioPdf');
    const pdf = await gerarTerrenoPdf(resultado, { solicitante });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="estudo-terreno-${(resultado.bairro || 'anapolis').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[RelatTerreno API] Erro:', err);
    res.status(500).json({ error: '⚠️ Erro ao gerar o PDF. Tente novamente.' });
  }
});

/**
 * GET /api/uso — status de consumo das APIs (para monitorar custos).
 */
router.get('/uso', async (req, res) => {
  const axios = require('axios');
  const out = { scraperapi: null, google: null, alertas: [] };
  try {
    const k = process.env.SCRAPER_API_KEY;
    if (k) {
      const { data } = await axios.get(`http://api.scraperapi.com/account?api_key=${k}`, { timeout: 12000 });
      const usados = data.requestCount, limite = data.requestLimit, restam = data.creditsLeft;
      const pct = limite ? Math.round((usados / limite) * 100) : 0;
      out.scraperapi = { usados, limite, restam, pct };
      if (restam < limite * 0.1) out.alertas.push(`ScraperAPI: só ${restam} buscas restantes (${pct}% usado)`);
    }
  } catch (e) { out.scraperapi = { erro: e.message }; }
  try {
    const usados = await require('../data/database').obterUso('google_places');
    const cotaGratis = 6250; // US$200 / US$0,032 por busca
    out.google = { usados, cotaGratis, pct: Math.round((usados / cotaGratis) * 100) };
    if (usados >= cotaGratis * 0.85) out.alertas.push(`Google Maps: ${usados} buscas (${out.google.pct}% da cota grátis)`);
  } catch (e) { out.google = { erro: e.message }; }
  res.json(out);
});

/**
 * POST /api/relatorio
 * Gera o PDF do Parecer de Avaliação Mercadológica (PTAM por amostragem).
 * Body: { dados, resultado, versao: 'tecnica'|'cliente', solicitante }
 */
router.post('/relatorio', async (req, res) => {
  const { dados, resultado, versao, solicitante } = req.body || {};
  if (!dados || !resultado) return res.status(400).json({ error: 'Faça uma avaliação primeiro.' });
  try {
    const { gerarRelatorioPdf } = require('../data/relatorioPdf');
    const pdf = await gerarRelatorioPdf(dados, resultado, { versao, solicitante });
    const slug = String(dados.bairro || 'imovel').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
    const nome = `parecer-${slug}-${versao === 'cliente' ? 'cliente' : 'tecnico'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.send(pdf);
  } catch (err) {
    console.error('[Relatorio API] Erro:', err);
    res.status(500).json({ error: '⚠️ Erro ao gerar o PDF. Tente novamente.' });
  }
});

/**
 * POST /api/relatorio-comercial — PDF do Estudo de Viabilidade Comercial.
 * Body: { analise (de /api/ponto-comercial), solicitante }
 */
router.post('/relatorio-comercial', async (req, res) => {
  const { analise, solicitante } = req.body || {};
  if (!analise) return res.status(400).json({ error: 'Faça uma análise de ponto comercial primeiro.' });
  try {
    const { gerarDossiePdf } = require('../data/relatorioPdf');
    const pdf = await gerarDossiePdf(analise, { solicitante });
    const slug = String(analise.ramo || 'ponto').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="viabilidade-${slug}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[RelatComercial API] Erro:', err);
    res.status(500).json({ error: '⚠️ Erro ao gerar o PDF. Tente novamente.' });
  }
});

/**
 * GET /api/laudos — lista o histórico de avaliações (recentes primeiro).
 * GET /api/laudos/:id — abre uma avaliação, re-gerando o laudo com as normas atuais.
 */
router.get('/laudos', async (req, res) => {
  try { res.json(await require('../data/database').listarLaudos(60)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
// DELETE /api/laudos — limpa o histórico (tudo, ou só uma pasta via ?kind=)
router.delete('/laudos', async (req, res) => {
  try {
    const kind = req.query.kind ? String(req.query.kind) : null;
    const n = await require('../data/database').limparLaudos(kind);
    res.json({ ok: true, removidos: n, kind });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// DELETE /api/laudos/:id — apaga um item do histórico
router.delete('/laudos/:id', async (req, res) => {
  try {
    const n = await require('../data/database').apagarLaudo(req.params.id);
    res.json({ ok: true, removidos: n });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.get('/laudos/:id', async (req, res) => {
  try {
    const l = await require('../data/database').buscarLaudo(req.params.id);
    if (!l) return res.status(404).json({ error: 'Avaliação não encontrada.' });
    // Re-gera o relatório com o motor ATUAL (normas/fontes mais recentes), por tipo
    let response;
    if (l.kind === 'comercial') response = require('../data/pontoComercial').formatarRelatorioComercial(l.resultado);
    else if (l.kind === 'empresa') response = require('../data/valuationEmpresa').formatarEmpresa(l.resultado);
    else if (l.kind === 'terreno') response = require('../data/terreno').formatarTerreno(l.resultado);
    else if (l.kind === 'bts') response = require('../data/bts').formatarBTS(l.resultado);
    else if (l.kind === 'predio') response = require('../data/fichaPredio').formatarBuscaPredio((l.resultado || {}).ficha, { comparativos: (l.resultado || {}).unidades || [] }, (l.resultado || {}).evolutivo);
    else if (l.kind === 'fazenda') {
      const view = l.resultado && l.resultado.view;
      const fz = require('../data/fazenda');
      response = view ? (view.modo === 'recreio' ? fz.formatarChacara(view) : fz.formatarFazenda(view)) : ((l.resultado || {}).texto || 'Laudo indisponível.');
    }
    else response = gerarLaudo(l.dados, l.resultado);
    res.json({ id: l.id, criado_em: l.criado_em, kind: l.kind, dados: l.dados, resultado: l.resultado, response });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Salva uma avaliação de imóvel no histórico (best-effort, todos os fluxos). */
function salvarLaudoImovel(dados, resultado) {
  try {
    require('../data/database').salvarLaudo({
      kind: 'imovel',
      tipo: dados.tipo, finalidade: dados.finalidade, cidade: dados.cidade,
      bairro: dados.bairro, endereco: dados.endereco, condominio: dados.condominio,
      valor: resultado.precoRecomendado, dados, resultado,
    });
  } catch (e) { console.warn('[salvarLaudo] erro:', e.message); }
}

function gerarLaudo(dados, resultado) {
  const { tipo, finalidade, cidade, bairro, endereco, metragem, quartos, vagas } = dados;
  const {
    precoMinimo, precoRecomendado, precoMaximo, geoInfo, perfilGuru,
    precoM2Mercado, precoM2Imovel,
    comparativosEncontrados, tempoEstimadoDias,
    indiceLiquidez, ajustesAplicados,
    fontesConsultadas, analiseIA
  } = resultado;

  const tipoLabel = tipo.charAt(0).toUpperCase() + tipo.slice(1);
  const finalidadeLabel = finalidade === 'aluguel' ? 'Aluguel' : 'Venda';

  let laudo = `📊 *LAUDO DE PRECIFICAÇÃO*\n`;
  laudo += `━━━━━━━━━━━━━━━━━━━━━\n`;
  laudo += `🏠 ${tipoLabel} • ${finalidadeLabel}\n`;
  laudo += endereco ? `📍 ${endereco}, ${bairro} - ${cidade}/GO\n` : `📍 ${bairro}, ${cidade} - GO\n`;
  laudo += `📐 ${metragem}m² • ${quartos} quartos • ${vagas} vaga(s)\n\n`;
  laudo += `💰 *Faixa de Preço Sugerida:*\n`;
  laudo += `• Mínimo: *${formatarReais(precoMinimo)}*\n`;
  laudo += `• Recomendado: *${formatarReais(precoRecomendado)}*\n`;
  laudo += `• Máximo: *${formatarReais(precoMaximo)}*\n\n`;
  laudo += `📊 *Preço por m²:*\n`;
  laudo += `• Referência de mercado: ${formatarReais(precoM2Mercado)}/m²\n`;
  laudo += `• Este imóvel (ajustado): ${formatarReais(precoM2Imovel)}/m²\n\n`;
  laudo += `⚡ *Liquidez:*\n`;
  laudo += `• ${indiceLiquidez}\n`;
  laudo += `• Tempo estimado: ${tempoEstimadoDias} dias\n\n`;

  if (analiseIA) {
    laudo += `🔎 *Comparativos de mercado:*\n`;
    if (analiseIA.comparativos && analiseIA.comparativos.length > 0) {
      analiseIA.comparativos.slice(0, 12).forEach((c, i) => {
        const extra = [c.quartos ? `${c.quartos}q` : '', c.vagas ? `${c.vagas} vaga(s)` : '', c.bairro && c.bairro !== bairro ? c.bairro : ''].filter(Boolean).join(' · ');
        laudo += `  ${i + 1}. ${c.area}m² • ${formatarReais(c.preco)} (${formatarReais(c.precoM2)}/m²)${extra ? ` • ${extra}` : ''}\n`;
        if (c.detalhe) laudo += `     ${c.detalhe}\n`;
        const rodape = [c.fonte ? `Fonte: ${c.fonte}` : ''].filter(Boolean).join(' · ');
        if (rodape) laudo += `     _${rodape}_\n`;
        if (c.url) laudo += `     🔗 ${c.url}\n`;
      });
      laudo += `\n📊 *Resultado da pesquisa:*\n`;
      laudo += `• Média: *${formatarReais(analiseIA.precoMedioM2)}/m²*\n`;
      laudo += `• Faixa: ${analiseIA.faixaM2}\n`;
      laudo += `• ${analiseIA.anunciosAnalisados} anúncios comparáveis\n`;
      laudo += `• Confiança: ${analiseIA.confianca}\n`;
      if (analiseIA.raciocinio) laudo += `• ${analiseIA.raciocinio}\n`;
      laudo += '\n';
    } else {
      laudo += `• ${analiseIA.raciocinio}\n`;
      laudo += `• Faixa: ${analiseIA.faixaM2}\n\n`;
    }
  }

  if (ajustesAplicados?.length > 0) {
    laudo += `🔧 *Ajustes aplicados:*\n`;
    ajustesAplicados.forEach(a => laudo += `• ${a}\n`);
    laudo += '\n';
  }

  if (comparativosEncontrados > 0) laudo += `🔍 Comparativos analisados: ${comparativosEncontrados} imóveis\n`;

  if (perfilGuru?.infraestrutura) {
    const i = perfilGuru.infraestrutura;
    laudo += `🏘️ *Perfil do bairro:*\n`;
    laudo += `• ${i.resumo}\n`;
    if (i.vocacoes?.length) laudo += `• Vocação: ${i.vocacoes.join(', ')}\n`;
    if (i.exemplosComercios?.length) laudo += `• Comércios: ${i.exemplosComercios.slice(0, 3).join(', ')}\n`;
    if (i.exemplosAlimentacao?.length) laudo += `• Alimentação: ${i.exemplosAlimentacao.slice(0, 3).join(', ')}\n`;
    if (i.exemplosSaude?.length) laudo += `• Saúde: ${i.exemplosSaude.slice(0, 3).join(', ')}\n`;
    laudo += '\n';
  }

  if (perfilGuru?.municipio) {
    const m = perfilGuru.municipio;
    laudo += `📊 *Dados do município (IBGE):*\n`;
    if (m.populacao) laudo += `• População: ${m.populacao.toLocaleString()}\n`;
    if (m.pibPerCapita) laudo += `• PIB per capita: R$ ${m.pibPerCapita.toLocaleString()}\n`;
    laudo += '\n';
  }

  if (geoInfo) {
    laudo += `🗺️ *Localização (Google Maps):*\n`;
    if (geoInfo.enderecoValidado) laudo += `• Endereço: ${geoInfo.enderecoValidado}\n`;
    if (geoInfo.bairrosVizinhos?.length) laudo += `• Bairros vizinhos: ${geoInfo.bairrosVizinhos.join(', ')}\n`;
    if (geoInfo.distanciaCentroKm != null) laudo += `• Distância ao centro: ${geoInfo.distanciaCentroKm} km\n`;
    if (geoInfo.viasProximas?.length) laudo += `• Vias próximas: ${geoInfo.viasProximas.join(', ')}\n`;
    laudo += '\n';
  }

  // Enriquecimento: dados extras (rentabilidade, infra, tendência, financiamento)
  const enr = resultado.enriquecimento;
  if (enr) {
    if (enr.rentabilidade) {
      const r = enr.rentabilidade;
      laudo += `💸 *Rentabilidade (venda × aluguel):*\n`;
      laudo += `• Aluguel estimado: R$ ${r.aluguelMensal.toLocaleString('pt-BR')}/mês\n`;
      laudo += `• Rentabilidade: ${r.yieldAnual.toLocaleString('pt-BR')}% ao ano\n`;
      laudo += `• Payback: o aluguel paga o imóvel em ~${r.paybackAnos} anos\n\n`;
    }
    if (enr.infraestrutura && enr.infraestrutura.some(i => i.qtd > 0)) {
      laudo += `🏗️ *Infraestrutura por perto (até 1,5 km):*\n`;
      enr.infraestrutura.forEach(i => {
        if (i.qtd > 0) laudo += `• ${i.categoria}: ${i.qtd}${i.maisProximoM ? ` (mais perto ~${i.maisProximoM} m)` : ''}\n`;
      });
      laudo += '\n';
    }
    if (enr.tendencia) laudo += `📈 *Tendência do bairro:*\n• ${enr.tendencia}\n\n`;
    if (enr.financiamento) {
      const f = enr.financiamento;
      laudo += `🏦 *Financiamento estimado:*\n`;
      laudo += `• Entrada (${f.entradaPct}%): R$ ${f.entrada.toLocaleString('pt-BR')}\n`;
      laudo += `• Parcela: ~R$ ${f.parcela.toLocaleString('pt-BR')}/mês (${Math.round(f.prazoMeses / 12)} anos · ${f.taxaAnual}% a.a.)\n`;
      laudo += `• Renda necessária: ~R$ ${f.rendaNecessaria.toLocaleString('pt-BR')}/mês\n\n`;
    }
  }

  // FIPE da região (referência de R$/m² venda + aluguel do bairro)
  try {
    const { getAncora } = require('../data/baseAnapolis');
    const fv = getAncora(tipo, 'venda', cidade, bairro);
    const fa = getAncora(tipo, 'aluguel', cidade, bairro);
    laudo += `\n📊 *FIPE da região (${bairro}):*\n`;
    laudo += `• Referência de venda: R$ ${fv.m2.toLocaleString('pt-BR')}/m² (${fv.fonte})\n`;
    laudo += `• Referência de aluguel: R$ ${fa.m2.toLocaleString('pt-BR')}/m²·mês\n\n`;
  } catch {}

  if (resultado.fichaPredioTexto) laudo += `\n${resultado.fichaPredioTexto}`;

  // Bloco padronizado de credibilidade (método, amostra, data, links, bases)
  try { laudo += textoFontes(fontesAvaliacao(dados, resultado)); } catch {}

  laudo += `_Avaliação gerada por Precifica Aí (Bens Imóveis Corporativos)_\n\n`;
  laudo += `⚠️ _Parecer de avaliação mercadológica por amostragem. Apoio à decisão — não substitui laudo de engenharia (ABNT NBR 14653) para fins judiciais ou fiscais._`;
  return laudo;
}

module.exports = router;
