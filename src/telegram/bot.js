const { completar: completarLLM } = require('../agent/llm');
const axios = require('axios');
const { getSession, addMessage, clearSession, isReadyToEvaluate } = require('../agent/session');
const { chat, extractPropertyData } = require('../agent/openai');
const { calcularPreco, formatarReais } = require('../data/precificador');
const db = require('../data/database');
const { formatarSecaoLocalizacao } = require('../data/googleplaces');

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const API = () => `https://api.telegram.org/bot${BOT_TOKEN()}`;

// Guarda o último laudo por sessão para uso no modo conversa
const { interpretarFechamento, textoConfirmacao, brl } = require('./fechou');
const { MODOS, tecladoMenu, extrairCampos, faltando, textoDoQueFalta } = require('./modos');
const laudoCache = new Map();

// Fechamento aguardando o "sim" do corretor. Nada entra no banco sem ele: com
// 3 fechamentos o bairro passa a ter o preco tirado dali, entao um digito a
// mais aqui vira preco errado no laudo de todo mundo.
const fechamentoPendente = new Map();

// Em que modo a pessoa está (avaliar venda, ponto comercial, fazenda...) e o
// que já foi coletado. Sem isso o bot só sabia fazer uma coisa.
const modoAtivo = new Map();

/**
 * Handler do webhook do Telegram
 */
async function handleTelegram(req, res) {
  res.status(200).json({ ok: true });

  try {
    const update = req.body;

    // ─── CLIQUE NO BOTAO DO MENU ──────────────────────────────────────────
    // O webhook so olhava `message` e descartava `callback_query`, entao
    // qualquer botao inline ficava mudo.
    if (update?.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      const sessionId = `tg_${chatId}`;
      // Tira o "reloginho" do botao — sem isso ele fica girando na tela.
      await axios.post(`${API()}/answerCallbackQuery`, { callback_query_id: cq.id }).catch(() => {});
      const escolha = String(cq.data || '');

      if (escolha === 'menu:abrir') {
        modoAtivo.delete(sessionId);
        await enviar(chatId, '*O que você precisa?*', tecladoMenu());
        return;
      }

      if (escolha === 'laudo:completo') {
        const guardado = laudoCache.get(sessionId);
        if (!guardado?.texto) {
          await enviar(chatId, 'Não tenho um laudo aberto. Faça uma avaliação primeiro.', tecladoMenu());
        } else {
          await enviar(chatId, guardado.texto, tecladoPosLaudo());
        }
        return;
      }

      if (escolha.startsWith('pdf:')) {
        const versao = escolha.slice(4) === 'tecnico' ? 'tecnico' : 'cliente';
        const guardado = laudoCache.get(sessionId);
        if (!guardado?.dados || !guardado?.resultado) {
          await enviar(chatId, 'Não tenho um laudo aberto para gerar o PDF. Faça uma avaliação primeiro.', tecladoMenu());
          return;
        }
        await enviar(chatId, '📄 Montando o parecer...');
        try {
          const porta = process.env.PORT || 8080;
          const r = await fetch(`http://127.0.0.1:${porta}/api/relatorio`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dados: guardado.dados, resultado: guardado.resultado, versao }),
          });
          if (!r.ok) throw new Error(`relatorio ${r.status}`);
          const pdf = Buffer.from(await r.arrayBuffer());
          const slug = String(guardado.dados.bairro || 'imovel').toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-');
          await enviarDocumento(chatId, pdf, `parecer-${slug}-${versao}.pdf`,
            versao === 'cliente'
              ? '📄 *Parecer para o cliente* — timbrado, com os comparáveis e o link de cada anúncio. Pode encaminhar.'
              : '📑 *Parecer técnico* — a versão completa, com metodologia e fontes.');
        } catch (err) {
          console.error('[PDF] erro:', err.message);
          await enviar(chatId, '⚠️ Não consegui gerar o PDF agora. Tenta de novo?');
        }
        return;
      }

      if (escolha.startsWith('modo:')) {
        const id = escolha.slice(5);
        clearSession(sessionId);
        laudoCache.delete(sessionId);
        fechamentoPendente.delete(sessionId);

        if (id === 'matricula') {
          modoAtivo.delete(sessionId);
          await enviar(chatId, '📜 *Ler matrícula*\n\nA leitura da certidão é pelo site — o Telegram comprime a foto e o texto do cartório fica ilegível.\n\nAbra https://precifica-ai-production.up.railway.app e use a aba *Matrícula*: eu transcrevo os atos, aponto ônus, penhora e se a construção está averbada.');
          return;
        }
        if (id === 'fechou') {
          modoAtivo.delete(sessionId);
          await enviar(chatId,
            '💰 *Registrar um negócio fechado*\n\n' +
            'Todo preço que eu mostro vem de anúncio — é preço PEDIDO. O que fechou de verdade só quem vendeu sabe, e é isso que faz o preço do bairro virar real.\n\n' +
            'Manda numa linha:\n`/fechou apto 90m2 Jundiaí 520 mil`');
          return;
        }
        const m = MODOS[id];
        if (!m) { await enviar(chatId, 'Não reconheci essa opção. Digite /menu.'); return; }
        modoAtivo.set(sessionId, { id, dados: { ...(m.fixos || {}) } });
        await enviar(chatId, `*${m.rotulo}*\n\n${m.pergunta}\n\nExemplo: _${m.exemplo}_`);
        return;
      }
      return;
    }

    const message = update?.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();
    const sessionId = `tg_${chatId}`;

    console.log(`[Telegram] ${chatId}: ${text.substring(0, 60)}`);

    // Comando /meuid — devolve o chat ID (para ativar alertas de uso)
    if (text === '/meuid' || text === '/id') {
      await enviar(chatId, `🆔 Seu chat ID é: \`${chatId}\`\n\nEnvie esse número para o administrador para ativar os alertas de uso só para você.`);
      return;
    }

    // Comando /start
    if (text === '/start') {
      clearSession(sessionId);
      laudoCache.delete(sessionId);
      // O /start convidava ao interrogatorio ("qual o tipo?") e ensinava o
      // caminho lento — 8 perguntas ate o laudo. Uma linha so ja resolve, mas
      // ninguem descobre isso sozinho. Entao o bot ENSINA o atalho.
      await enviar(chatId,
        '👋 Sou o *PrecificaAI* — inteligência imobiliária e comercial de Anápolis e região.\n\n' +
        '*Atalho:* me manda o imóvel numa linha só que eu já devolvo o laudo —\n' +
        '_apartamento 90m² no Jundiaí, Anápolis, venda, 3 quartos_\n\n' +
        'Ou escolha o que você precisa:',
        tecladoMenu()
      );
      return;
    }

    // Comando /completo — devolve o laudo inteiro que ficou guardado
    if (text === '/completo') {
      const guardado = laudoCache.get(sessionId);
      if (!guardado) {
        await enviar(chatId, 'Nenhum laudo recente. Me manda os dados do imóvel que eu avalio.');
      } else {
        await enviar(chatId, guardado.texto);
      }
      return;
    }

    // Comando /historico
    if (text === '/historico') {
      try {
        const laudos = await db.buscarHistorico(String(chatId), 5);
        if (!laudos || laudos.length === 0) {
          await enviar(chatId, '📋 Você ainda não tem laudos gerados. Faça sua primeira avaliação!');
        } else {
          let msg = '📋 *Seus últimos laudos:*\n━━━━━━━━━━━━━━━━━━━━━\n';
          laudos.forEach((l, i) => {
            const data = new Date(l.gerado_em).toLocaleDateString('pt-BR');
            const tipo = l.tipo.charAt(0).toUpperCase() + l.tipo.slice(1);
            const finalidade = l.finalidade === 'aluguel' ? 'Aluguel' : 'Venda';
            const preco = Number(l.preco_recomendado).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            const m2 = Number(l.preco_m2).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            const conf = l.confianca === 'alta' ? '🟢' : l.confianca === 'media' ? '🟡' : '🔴';
            const quartosStr = l.quartos > 0 ? ` • ${l.quartos}q` : '';
            msg += '\n*' + (i+1) + '. ' + tipo + ' • ' + finalidade + '*\n';
            msg += '📍 ' + l.bairro + ', ' + l.cidade + '\n';
            msg += '📐 ' + l.metragem + 'm²' + quartosStr + '\n';
            msg += '💰 ' + preco + ' (' + m2 + '/m²) ' + conf + '\n';
            msg += '📅 ' + data + '\n';
          });
          msg += '\n_Para nova avaliação, descreva o imóvel ou digite /novo_';
          await enviar(chatId, msg);
        }
      } catch (err) {
        console.error('[Historico] Erro completo:', err.message, err.code);
        // Tabela pode não existir ainda — mostra mensagem amigável
        if (err.code === '42P01') {
          await enviar(chatId, '📋 O histórico ainda está sendo configurado. Gere um laudo primeiro e tente novamente.');
        } else {
          await enviar(chatId, '❌ Erro ao buscar histórico: ' + err.message);
        }
      }
      return;
    }

    // ─── MENU ─────────────────────────────────────────────────────────────
    if (/^[/]?(menu|ajuda|help|op[cç][oõ]es|servi[cç]os)\b/i.test(text)) {
      modoAtivo.delete(sessionId);
      await enviar(chatId,
        '*O que você precisa hoje?*\n\nEscolha abaixo — ou me mande o imóvel numa linha só que eu já avalio.',
        tecladoMenu());
      return;
    }

    // ─── DENTRO DE UM MODO: coleta o que falta e chama a rota do site ─────
    const emModo = modoAtivo.get(sessionId);
    if (emModo && !/^[/]/.test(text)) {
      const novos = await extrairCampos(emModo.id, text);
      emModo.dados = { ...emModo.dados, ...novos };
      const faltas = faltando(emModo.id, emModo.dados);
      if (faltas.length) {
        modoAtivo.set(sessionId, emModo);
        await enviar(chatId, textoDoQueFalta(emModo.id, faltas));
        return;
      }
      modoAtivo.delete(sessionId);
      await executarModo(chatId, sessionId, emModo.id, emModo.dados);
      return;
    }

    // ─── POR QUANTO FECHOU ────────────────────────────────────────────────
    // A resposta ao pedido de confirmacao vem primeiro: e um "sim" solto, e se
    // cair no fluxo normal o bot responde sobre o laudo e o registro se perde.
    const pendente = fechamentoPendente.get(sessionId);
    if (pendente && /^(sim|s|isso|confirmo?|confirma|ok|pode|correto|certo)\b/i.test(text)) {
      fechamentoPendente.delete(sessionId);
      await gravarFechamento(chatId, pendente);
      return;
    }
    if (pendente && /^(n[aã]o|n|cancela|errado|deixa)\b/i.test(text)) {
      fechamentoPendente.delete(sessionId);
      await enviar(chatId, 'Cancelado, não gravei nada. Manda de novo quando quiser: `/fechou apto 90m2 Jundiaí 520 mil`');
      return;
    }

    if (/^[/]?fechou\b|^[/]?fechei\b|^[/]?fechamento\b/i.test(text)) {
      const corpo = text.replace(/^[/]?(fechou|fechei|fechamento)\b/i, '').trim();
      const guardado = laudoCache.get(sessionId);
      const doLaudo = guardado ? {
        cidade:   guardado.dados?.cidade,
        bairro:   guardado.dados?.bairro,
        tipo:     guardado.dados?.tipo,
        metragem: guardado.dados?.metragem,
        valorAvaliado: guardado.resultado?.precoRecomendado,
      } : null;

      if (!corpo) {
        await enviar(chatId,
          '💰 *Por quanto fechou?*\n\n' +
          'Todo preço que eu mostro vem de ANÚNCIO — é preço pedido. O que fechou de verdade só quem vendeu sabe, e é isso que faz o preço do bairro virar real.\n\n' +
          'Manda numa linha:\n' +
          '`/fechou apto 90m2 Jundiaí 520 mil`\n' +
          '`/fechou casa 150m2 Vila Jaiara 380 mil`\n\n' +
          (doLaudo?.bairro ? `_Se for o imóvel do último laudo (${doLaudo.tipo} em ${doLaudo.bairro}), basta \`/fechou 520 mil\`._` : '_Vale negócio antigo também — quanto mais, melhor o preço do bairro._'));
        return;
      }

      const d = interpretarFechamento(corpo, doLaudo);
      if (d.faltando.length) {
        await enviar(chatId, `Faltou ${d.faltando.join(' e ')}.\n\nExemplo completo: \`/fechou apto 90m2 Jundiaí 520 mil\``);
        return;
      }
      fechamentoPendente.set(sessionId, d);
      await enviar(chatId, textoConfirmacao(d));
      return;
    }

    // Comando /reiniciar ou /novo
    if (/^[/]?(reiniciar|novo|nova|reset)/i.test(text)) {
      clearSession(sessionId);
      laudoCache.delete(sessionId);
      modoAtivo.delete(sessionId);
      fechamentoPendente.delete(sessionId);
      await enviar(chatId, '🔄 Recomeçando. O que você precisa?', tecladoMenu());
      return;
    }

    await processarMensagem(chatId, sessionId, text);

  } catch (err) {
    console.error('[Telegram] Erro:', err.message);
  }
}

/**
 * Chama a MESMA rota que o site usa e devolve o texto pronto.
 *
 * O bot nao reimplementa regra nenhuma: se a precificacao melhora no site,
 * melhora aqui no mesmo deploy. E evita a armadilha de ter duas versoes da
 * mesma conta divergindo em silencio.
 */
async function executarModo(chatId, sessionId, id, dados) {
  const m = MODOS[id];
  await enviar(chatId, '⏳ Levantando os dados...');
  try {
    const porta = process.env.PORT || 8080;
    const { data } = await axios.post(`http://127.0.0.1:${porta}/api${m.rota}`, dados, {
      timeout: 300000, headers: { 'Content-Type': 'application/json' },
    });
    const texto = String(data?.response || data?.resposta || data?.texto || '').trim();
    if (!texto) {
      console.warn(`[Modo ${id}] rota respondeu sem texto:`, JSON.stringify(data).slice(0, 200));
      await enviar(chatId, 'Consegui os dados, mas não veio o relatório. Tenta de novo?', tecladoMenu());
      return;
    }
    // Guarda o laudo para as perguntas seguintes ("por que esse preço?"),
    // para o "ver completo" e para o PDF.
    if (data.dados && data.resultado) {
      laudoCache.set(sessionId, { texto, dados: data.dados, resultado: data.resultado });
      await enviar(chatId, resumoExecutivo(data.dados, data.resultado));
      await new Promise((r) => setTimeout(r, 400));
      await enviar(chatId, '_Pergunte o que quiser sobre este imóvel — ou:_', tecladoPosLaudo());
      return;
    }
    await enviar(chatId, texto);
    await new Promise((r) => setTimeout(r, 600));
    await enviar(chatId, '_Pergunte o que quiser sobre este resultado, ou escolha outra coisa:_', tecladoMenu());
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    console.error(`[Modo ${id}] erro:`, msg);
    await enviar(chatId, `⚠️ ${String(msg).slice(0, 300)}`, tecladoMenu());
  }
}

/**
 * Grava e devolve o que aquele registro MUDOU. O corretor precisa ver o proprio
 * dado virando preco — senao ele responde no vazio e nunca mais manda outro.
 */
async function gravarFechamento(chatId, d) {
  try {
    const salvo = await db.salvarFechamento({
      laudo_id: d.laudoId || null,
      cidade: d.cidade, bairro: d.bairro, tipo: d.tipo, finalidade: d.finalidade,
      metragem: d.metragem,
      valor_avaliado: d.valorAvaliado || null,
      valor_fechado: d.valorFechado,
      observacao: 'via Telegram',
    });

    const { sinalDeMercado, MINIMO_PARA_MANDAR } = require('../data/fechamentos');
    const rows = await db.buscarFechamentos(salvo.cidade, salvo.bairro, salvo.tipo, salvo.finalidade);
    const sinal = sinalDeMercado(rows);
    const n = sinal?.n || 1;

    let msg = `✅ *Registrado.*\n\n`;
    if (sinal && sinal.manda) {
      msg += `${salvo.bairro} tem *${n} negócios fechados*. A partir de agora o preço desse bairro sai do que foi PAGO (${brl(sinal.m2)}/m²), não do que é pedido.`;
    } else {
      const faltam = MINIMO_PARA_MANDAR - n;
      msg += `${salvo.bairro} tem *${n} negócio(s) fechado(s)* — ${faltam === 1 ? 'falta 1' : `faltam ${faltam}`} para o preço do bairro passar a sair de negócio fechado em vez de anúncio.`;
    }
    await enviar(chatId, msg);
  } catch (err) {
    console.error('[Fechou] erro:', err.message);
    await enviar(chatId, '❌ Não consegui gravar agora. Tenta de novo daqui a pouco.');
  }
}

async function processarMensagem(chatId, sessionId, texto) {
  // ─── MODO CONVERSA PÓS-LAUDO ─────────────────────────────────────────────
  // Se já existe um laudo gerado nesta sessão, responde perguntas sobre ele
  const laudoSessao = laudoCache.get(sessionId);
  if (laudoSessao) {
    // Detecta intenção de nova avaliação
    // Casos: palavra-chave explícita OU usuário descreve um novo imóvel (tipo + localização)
    const novaAvaliacaoExplicita = /\b(novo|nova|outro|outra|precificar|começar|comecar|reiniciar|nova avalia)\b/i.test(texto);
    const descreveImovel = /\b(terreno|casa|apart|apto|comercial|sala|galpão|lote)\b/i.test(texto) &&
      /\b(bairro|rua|av\.|avenida|setor|jardim|vila|parque|residencial|em [A-Z])/i.test(texto);
    if (novaAvaliacaoExplicita || descreveImovel) {
      clearSession(sessionId);
      laudoCache.delete(sessionId);
      if (descreveImovel && !novaAvaliacaoExplicita) {
        // Usuário começou nova avaliação sem avisar — processa direto
        await processarMensagem(chatId, sessionId, texto);
      } else {
        await enviar(chatId, '🔄 Certo! Vamos avaliar outro imóvel.\n\nQual o *tipo* do imóvel? (casa, apartamento, terreno ou comercial)');
      }
      return;
    }

    // Responde perguntas sobre o laudo com contexto completo
    try {
      const systemPostLaudo = `Você é o PrecificaAI, um especialista em precificação imobiliária. 
O usuário acabou de receber um laudo de precificação e pode ter dúvidas ou querer aprofundar a análise.

LAUDO GERADO:
${laudoSessao.texto}

DADOS DO IMÓVEL AVALIADO:
${JSON.stringify(laudoSessao.dados, null, 2)}

Responda de forma clara e direta, como um corretor experiente explicaria para o cliente.
Você pode:
- Explicar como chegamos ao preço sugerido
- Comparar com outros bairros ou tipos de imóvel
- Esclarecer o que significa cada indicador do laudo
- Sugerir como melhorar a precificação (ex: reformas, diferenciais)
- Simular cenários (ex: "e se fosse aluguel?", "e se tivesse piscina?")
Se o usuário quiser avaliar um novo imóvel, oriente-o a digitar /novo.`;

      const history = addMessage(sessionId, 'user', texto);

      const resposta = await completarLLM({ forte: true, maxTokens: 900, effort: 'low', messages: [
          { role: 'system', content: systemPostLaudo },
          ...history.slice(-10) // últimas 10 mensagens para contexto da conversa
        ] });

      const respostaTexto = String(resposta || '');
      addMessage(sessionId, 'assistant', respostaTexto);
      await enviar(chatId, respostaTexto);
      await new Promise(r => setTimeout(r, 800));
      await enviar(chatId, '_Para avaliar outro imóvel, digite /novo_');

    } catch (err) {
      console.error('[Telegram PostLaudo] Erro:', err.message);
      await enviar(chatId, '❌ Erro ao responder. Tente de novo ou digite /reiniciar');
    }
    return;
  }

  // ─── FLUXO NORMAL: COLETA DE DADOS ────────────────────────────────────────
  const history = addMessage(sessionId, 'user', texto);
  const jaColetouDados = isReadyToEvaluate(history.slice(0, -1));

  if (jaColetouDados) {
    await enviar(chatId, '⏳ Consultando mercado imobiliário...');

    try {
      const dadosImovel = await extractPropertyData(history);
      if (!dadosImovel) {
        await enviar(chatId, '⚠️ Não consegui organizar os dados. Pode me passar o resumo de novo? (tipo, finalidade, cidade, bairro, metragem, quartos, vagas e estado)');
        return;
      }

      const resultado = await calcularPreco(dadosImovel);
      if (resultado.erro) {
        await enviar(chatId, resultado.mensagem);
        return;
      }
      const laudo = gerarLaudo(dadosImovel, resultado);

      addMessage(sessionId, 'assistant', laudo);
      await enviar(chatId, laudo);

      // Salva laudo para modo conversa pós-laudo
      laudoCache.set(sessionId, { texto: laudo, dados: dadosImovel, resultado });
          // Salva no histórico do usuário
          try { await db.salvarHistorico(String(chatId), dadosImovel, resultado, laudo); } catch {}

      await new Promise(r => setTimeout(r, 1000));
      await enviar(chatId,
        '💬 *Posso te ajudar mais?*\n' +
        'Pergunte qualquer coisa sobre este laudo — por que esse preço, comparação com outros bairros, simulações, etc.\n\n' +
        '_Para avaliar outro imóvel, digite /novo_'
      );

    } catch (err) {
      console.error('[Telegram Precificação] Erro:', err);
      await enviar(chatId, '❌ Tive um problema ao consultar o mercado. Tente de novo ou digite /reiniciar');
    }
    return;
  }

  // Fluxo normal: agente conversa para coletar dados.
  //
  // ANTES de perguntar, checa se o que o usuario ja disse basta. Sem isto o bot
  // fazia a pergunta E entregava o laudo logo em seguida — respondia sozinho, e
  // a pergunta era sempre de campo OPCIONAL (condominio). Quem manda tudo de
  // uma vez merece o laudo, nao mais uma pergunta.
  let resposta = null;
  const jaDaParaAvaliar = isReadyToEvaluate(history);

  try {
    if (!jaDaParaAvaliar) {
      resposta = await chat(history);
      addMessage(sessionId, 'assistant', resposta);
      await enviar(chatId, resposta);
    }

    // Verifica se agora está pronto para precificar
    const historicoAtual = resposta
      ? [...history, { role: 'assistant', content: resposta }]
      : history;
    if (jaDaParaAvaliar || isReadyToEvaluate(historicoAtual)) {
      await new Promise(r => setTimeout(r, 1000));
      const dadosImovel = await extractPropertyData(historicoAtual);
      if (dadosImovel) {
        await enviar(chatId, '⏳ Consultando mercado imobiliário...');
        const resultado = await calcularPreco(dadosImovel);
        if (resultado.erro) {
          await enviar(chatId, resultado.mensagem);
        } else {
          const laudo = gerarLaudo(dadosImovel, resultado);
          addMessage(sessionId, 'assistant', laudo);
          await enviar(chatId, resumirLaudo(laudo));

          // Salva laudo para modo conversa pós-laudo
          laudoCache.set(sessionId, { texto: laudo, dados: dadosImovel, resultado });
          // Salva no histórico do usuário
          try { await db.salvarHistorico(String(chatId), dadosImovel, resultado, laudo); } catch {}

          await new Promise(r => setTimeout(r, 1000));
          await enviar(chatId,
            '💬 *Posso te ajudar mais?*\n' +
            'Pergunte qualquer coisa sobre este laudo — por que esse preço, comparação com outros bairros, simulações, etc.\n\n' +
            '_Para avaliar outro imóvel, digite /novo_'
          );
        }
      }
    }
  } catch (err) {
    console.error('[Telegram Chat] Erro:', err);
    await enviar(chatId, '❌ Erro ao processar. Tente de novo ou digite /reiniciar');
  }
}

/**
 * Envia mensagem via Telegram Bot API
 */
async function enviar(chatId, texto, teclado = null) {
  // Telegram tem limite de 4096 chars por mensagem
  const chunks = splitMessage(texto, 4000);
  for (let i = 0; i < chunks.length; i++) {
    const corpo = { chat_id: chatId, text: chunks[i], parse_mode: 'Markdown' };
    // O teclado vai só na ÚLTIMA parte: repetido em cada pedaço, o Telegram
    // mostra o menu várias vezes no meio do laudo.
    if (teclado && i === chunks.length - 1) corpo.reply_markup = teclado;
    await axios.post(`${API()}/sendMessage`, corpo).catch(async (err) => {
      // Se falhar com Markdown, tenta sem formatação
      if (err.response?.data?.description?.includes('parse')) {
        const cru = { chat_id: chatId, text: chunks[i] };
        if (corpo.reply_markup) cru.reply_markup = corpo.reply_markup;
        await axios.post(`${API()}/sendMessage`, cru);
      } else {
        throw err;
      }
    });
  }
}

/**
 * Manda um PDF. O sistema ja gerava o parecer timbrado da Bens — com a tabela
 * de comparaveis, o link de cada anuncio, a assinatura do corretor e as
 * ressalvas tecnicas — e o bot nunca usou. O corretor recebia uma parede de
 * texto que ele nao pode encaminhar para o cliente.
 */
async function enviarDocumento(chatId, buffer, nomeArquivo, legenda) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([buffer], { type: 'application/pdf' }), nomeArquivo);
  if (legenda) { form.append('caption', legenda); form.append('parse_mode', 'Markdown'); }
  const r = await fetch(`${API()}/sendDocument`, { method: 'POST', body: form });
  if (!r.ok) throw new Error(`sendDocument ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/** Ações que fazem sentido DEPOIS de um laudo pronto. */
function tecladoPosLaudo() {
  return { inline_keyboard: [
    [{ text: '📄 PDF para o cliente', callback_data: 'pdf:cliente' },
     { text: '📑 PDF técnico',        callback_data: 'pdf:tecnico' }],
    [{ text: '🔍 Ver laudo completo', callback_data: 'laudo:completo' }],
    [{ text: '💰 Fechou? registrar',  callback_data: 'modo:fechou' },
     { text: '📋 Menu',               callback_data: 'menu:abrir' }],
  ] };
}

const real = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });

/**
 * O QUE O CORRETOR LÊ EM TRÊS SEGUNDOS.
 *
 * O laudo inteiro tem ~5.000 caracteres e chega como duas paredes de texto no
 * celular — o número que decide fica soterrado entre infraestrutura, IBGE e
 * metodologia. Aqui vem só o que muda a conversa com o cliente; o resto está a
 * um toque, e o PDF timbrado a outro.
 */
function resumoExecutivo(dados, resultado) {
  const d = dados || {}, r = resultado || {};
  const tipo = String(d.tipo || 'imóvel');
  const titulo = tipo.charAt(0).toUpperCase() + tipo.slice(1);
  const area = Number(d.metragem) || Number(d.areaLote) || 0;

  let t = `*${titulo}${area ? ` · ${area}m²` : ''}*\n`;
  t += `📍 ${[d.bairro, d.cidade].filter(Boolean).join(', ')}\n\n`;
  t += `💰 *${real(r.precoRecomendado)}*`;
  if (d.finalidade === 'aluguel') t += '/mês';
  t += `\n`;
  if (r.precoMinimo && r.precoMaximo) {
    t += `_faixa de negociação: ${real(r.precoMinimo)} a ${real(r.precoMaximo)}_\n`;
  }

  // O veredito sobre o preço PEDIDO é o motivo de a pessoa ter perguntado.
  const pedido = Number(d.valorPedido) || 0;
  if (pedido > 0 && r.precoRecomendado > 0) {
    const dif = Math.round((pedido / r.precoRecomendado - 1) * 100);
    t += `\n🏷️ Pedem *${real(pedido)}* — ${dif >= 0 ? `${dif}% acima` : `${Math.abs(dif)}% abaixo`} da avaliação\n`;
    if (pedido > r.precoMaximo)      t += `🔴 *Acima do teto da faixa* (${real(pedido - r.precoMaximo)} a mais)\n`;
    else if (pedido < r.precoMinimo) t += `🟢 *Abaixo do piso* — confira matrícula e conservação\n`;
    else                             t += `✅ *Dentro da faixa* — o preço se sustenta\n`;
  }

  const n = r.analiseIA?.anunciosAnalisados || r.comparativosEncontrados || 0;
  const conf = r.analiseIA?.confianca;
  if (n) {
    const luz = conf === 'alta' ? '🟢' : conf === 'media' ? '🟡' : '🔴';
    t += `\n${luz} Base: *${n} anúncio(s)* comparáveis · confiança ${conf || 'baixa'}\n`;
  }
  // O indiceLiquidez ja vem com emoji proprio ("🔴 Liquidez baixa"); prefixar
  // outro deixa "⚡ 🔴" colado.
  if (r.indiceLiquidez) {
    const li = String(r.indiceLiquidez).trim();
    t += (/^[\p{Emoji}]/u.test(li) ? '' : '⚡ ') + li + '\n';
  }
  return t;
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let current = text;
  while (current.length > maxLen) {
    let split = current.lastIndexOf('\n', maxLen);
    if (split < maxLen * 0.5) split = maxLen;
    chunks.push(current.substring(0, split));
    current = current.substring(split);
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Gera laudo formatado para Telegram (Markdown)
 */
/**
 * LAUDO CURTO PARA O TELEGRAM.
 *
 * O laudo completo tem ~58 blocos de texto: no navegador cabe, no celular vira
 * rolagem infinita e o corretor perde o numero que importa. Aqui fica o
 * essencial — preco, faixa, R$/m², liquidez, 3 comparativos e a confianca — e o
 * resto continua a um comando de distancia (/completo), porque o texto inteiro
 * ja e guardado no laudoCache para o modo conversa.
 *
 * Corta por SECAO (as linhas comecam com emoji), nunca por numero de
 * caracteres: cortar no meio de um numero seria pior que a parede de texto.
 */
const SECOES_CURTAS = ['📊', '🏠', '🏡', '🌾', '🌿', '📍', '📐', '💰', '⚡', '🔍'];

function resumirLaudo(textoCompleto) {
  const linhas = String(textoCompleto || '').split('\n');
  const out = [];
  let dentro = true;
  let comparativos = 0;

  for (const l of linhas) {
    const t = l.trim();
    const abreSecao = /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t);
    if (abreSecao) dentro = SECOES_CURTAS.some((e) => t.startsWith(e));
    // Dentro dos comparativos, só os 3 primeiros (cada um ocupa 3 linhas).
    if (dentro && /^\d+\./.test(t)) {
      comparativos++;
      if (comparativos > 3) dentro = false;
    }
    if (dentro) out.push(l);
  }

  let curto = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  curto += '\n\n📄 */completo* — laudo inteiro (infraestrutura, financiamento, fontes)';
  curto += '\n💬 Ou pergunte: _por que esse preço?_ · _e se fosse aluguel?_';
  return curto;
}

function gerarLaudo(dados, resultado) {
  const { tipo, finalidade, cidade, bairro, endereco, metragem, areaLote, quartos, vagas } = dados;
  const {
    precoMinimo, precoRecomendado, precoMaximo, geoInfo, perfilGuru,
    precoM2Mercado, precoM2Imovel,
    comparativosEncontrados, tempoEstimadoDias,
    indiceLiquidez, ajustesAplicados,
    fontesConsultadas, analiseIA, localizacao
  } = resultado;

  const isRural = tipo === 'rural';
  const { subTipoRural, areaAlqueires, margemAsfalto, acessoAsfalto, temAgua, temEnergia, benfeitorias, rodoviaReferencia } = dados;

  // Label do tipo
  const subLabel = subTipoRural ? (subTipoRural.charAt(0).toUpperCase() + subTipoRural.slice(1)) : 'Rural';
  const tipoLabel = isRural ? subLabel : (tipo.charAt(0).toUpperCase() + tipo.slice(1));
  const finalidadeLabel = finalidade === 'aluguel' ? 'Aluguel' : 'Venda';

  // Área em alqueires e hectares para rural
  const areaAlq = areaAlqueires || (metragem / 48400);
  const areaHa = (areaAlq * 4.84).toFixed(1);
  const areaLabel = isRural
    ? `${areaAlq} alqueire${areaAlq !== 1 ? 's' : ''} goiano${areaAlq !== 1 ? 's' : ''} (${areaHa} ha)`
    : (areaLote && areaLote > 0 && (tipo === 'casa')
        ? `${metragem}m² construídos • Lote ${areaLote}m²`
        : `${metragem}m²`);

  // Emoji do tipo
  const emojiTipo = isRural
    ? (subTipoRural === 'fazenda' ? '🌾' : subTipoRural === 'sitio' ? '🌿' : '🏡')
    : '🏠';

  let laudo = `📊 *LAUDO DE PRECIFICAÇÃO*\n`;
  laudo += `━━━━━━━━━━━━━━━━━━━━━\n`;
  laudo += `${emojiTipo} ${tipoLabel} • ${finalidadeLabel}\n`;
  const bairroLabel = bairro && bairro !== 'null' && bairro !== null ? bairro : null;
  if (isRural) {
    const localRef = rodoviaReferencia || bairroLabel || cidade;
    laudo += `📍 ${localRef}, ${cidade} - GO\n`;
  } else {
    laudo += endereco ? `📍 ${endereco}, ${bairroLabel || cidade} - ${cidade}/GO\n` : `📍 ${bairroLabel || cidade}, ${cidade} - GO\n`;
  }

  if (isRural) {
    laudo += `📐 ${areaLabel}\n`;
    const acessoStr = margemAsfalto ? 'Beira de asfalto' : acessoAsfalto ? 'Acesso pelo asfalto' : 'Acesso por chão';
    if (rodoviaReferencia) laudo += `🛣️ ${rodoviaReferencia} • ${acessoStr}\n`;
    else laudo += `🛣️ ${acessoStr}\n`;
    const infraStr = [temAgua ? '💧 Água' : null, temEnergia ? '⚡ Energia' : null].filter(Boolean).join(' • ');
    if (infraStr) laudo += `${infraStr}\n`;
    if (Array.isArray(benfeitorias) && benfeitorias.length > 0) laudo += `🏗️ ${benfeitorias.join(', ')}\n`;
    laudo += '\n';
  } else {
    // Quarto e vaga sao opcionais. Concatenados sem checar, o laudo saia
    // "189m² • null quartos • null vaga(s)" — o cliente le isso como sistema
    // quebrado, no meio de um laudo que ele vai mostrar para o comprador.
    laudo += `📐 ` + [`${areaLabel}`,
      Number(quartos) > 0 ? `${quartos} quarto(s)` : null,
      Number(vagas) > 0 ? `${vagas} vaga(s)` : null,
    ].filter(Boolean).join(' • ') + `\n\n`;
  }

  laudo += `💰 *Faixa de Preço Sugerida:*\n`;
  laudo += `• Mínimo: *${formatarReais(precoMinimo)}*\n`;
  laudo += `• Recomendado: *${formatarReais(precoRecomendado)}*\n`;
  laudo += `• Máximo: *${formatarReais(precoMaximo)}*\n\n`;

  if (isRural) {
    // Usar precoAlq do precificador (já calculado em R$/alq corretamente)
    const precoAlqMercado = resultado.precoAlqMercado || Math.round(precoM2Mercado * 48400);
    const precoAlqImovel  = resultado.precoAlqImovel  || Math.round(precoM2Imovel  * 48400);
    laudo += `📊 *Preço por alqueire:*\n`;
    laudo += `• Referência de mercado: *${formatarReais(precoAlqMercado)}/alq*\n`;
    laudo += `• Esta propriedade (ajustada): *${formatarReais(precoAlqImovel)}/alq*\n\n`;
  } else {
    laudo += `📊 *Preço por m²:*\n`;
    laudo += `• Referência de mercado: ${formatarReais(precoM2Mercado)}/m²\n`;
    laudo += `• Este imóvel (ajustado): ${formatarReais(precoM2Imovel)}/m²\n\n`;
  }

  laudo += `⚡ *Liquidez:*\n`;
  laudo += `• ${indiceLiquidez}\n`;
  laudo += `• Tempo estimado: ${tempoEstimadoDias} dias\n\n`;

  if (analiseIA) {
    laudo += `🔎 *Comparativos de mercado:*\n`;
    if (analiseIA.comparativos && analiseIA.comparativos.length > 0) {
      analiseIA.comparativos.slice(0, 7).forEach((c, i) => {
        if (isRural && c.areaAlq) {
          const precoAlqComp = Math.round(c.precoAlq || (c.preco / c.areaAlq));
          laudo += `  ${i + 1}. ${c.areaAlq} alq (${(c.areaAlq * 4.84).toFixed(1)} ha) • ${formatarReais(c.preco)} (${formatarReais(precoAlqComp)}/alq)\n`;
        } else {
          laudo += `  ${i + 1}. ${c.area}m² • ${formatarReais(c.preco)} (${formatarReais(c.precoM2)}/m²)\n`;
        }
        if (c.detalhe) laudo += `     ${c.detalhe}\n`;
        if (c.fonte) {
          // Monta link clicável se for um domínio reconhecível
          const fonteStr = String(c.fonte).trim();
          const dominio = fonteStr.match(/^https?:\/\//i) ? fonteStr
            : fonteStr.match(/\.(com|com\.br|br|net|org)/) ? `https://${fonteStr}`
            : null;
          laudo += dominio
            ? `     Fonte: [${fonteStr}](${dominio})\n`
            : `     Fonte: ${fonteStr}\n`;
        }
      });
      laudo += `\n📊 *Resultado da pesquisa:*\n`;
      if (isRural && analiseIA.precoMedioAlq) {
        laudo += `• Média: *${formatarReais(analiseIA.precoMedioAlq)}/alq*\n`;
      } else {
        laudo += `• Média: *${formatarReais(analiseIA.precoMedioM2)}/m²*\n`;
      }
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

  if (localizacao) {
    laudo += formatarSecaoLocalizacao(localizacao);
    laudo += '\n';
  }

  if (ajustesAplicados && ajustesAplicados.length > 0) {
    laudo += `🔧 *Ajustes aplicados:*\n`;
    ajustesAplicados.forEach(a => laudo += `• ${a}\n`);
    laudo += '\n';
  }

  if (comparativosEncontrados > 0) {
    laudo += `🔍 Comparativos diretos: ${comparativosEncontrados} imóveis\n`;
  }

  if (perfilGuru?.infraestrutura) {
    const i = perfilGuru.infraestrutura;
    laudo += `🏘️ *Perfil do bairro:*\n`;
    laudo += `• ${i.resumo}\n`;
    if (i.vocacoes?.length) laudo += `• Vocação: ${i.vocacoes.join(', ')}\n`;
    laudo += '\n';
  }

  if (perfilGuru?.municipio?.populacao) {
    laudo += `📊 Pop: ${perfilGuru.municipio.populacao.toLocaleString()} | PIB/cap: R$ ${perfilGuru.municipio.pibPerCapita?.toLocaleString() || '?'}\n\n`;
  }

  if (geoInfo) {
    laudo += `🗺️ *Localização:*\n`;
    if (geoInfo.bairrosVizinhos?.length) laudo += `• Vizinhos: ${geoInfo.bairrosVizinhos.join(', ')}\n`;
    if (geoInfo.distanciaCentroKm != null) laudo += `• ${geoInfo.distanciaCentroKm} km do centro\n`;
    laudo += '\n';
  }

  // Indicador de confiança da fonte
  const amostrasCount = resultado.analiseIA?.anunciosAnalisados || 0;
  const confiancaLabel = resultado.confiancaFonte === 'alta'
    ? `🟢 Alta (${amostrasCount} comparativos reais dos portais)`
    : resultado.confiancaFonte === 'media'
    ? `🟡 Média (${amostrasCount} comparativo${amostrasCount !== 1 ? 's' : ''} — amostra pequena)`
    : resultado.confiancaFonte === 'baixa'
    ? `🔴 Baixa (${amostrasCount} comparativo${amostrasCount !== 1 ? 's' : ''} — estimativa ponderada com base calibrada)`
    : null;

  if (confiancaLabel) {
    laudo += `📡 *Confiança da pesquisa:* ${confiancaLabel}\n`;
  }

  laudo += `📋 *Fontes:* ${(fontesConsultadas || []).join(' | ')}\n`;
  laudo += `_Avaliação gerada por PrecificaAI_\n\n`;
  laudo += `⚠️ _Este laudo é por amostragem/aproximação, baseado na média dos valores publicados em sites e portais de imóveis. Válido somente para simples consulta e sem valor de documento oficial._`;

  return laudo;
}

module.exports = { handleTelegram };
