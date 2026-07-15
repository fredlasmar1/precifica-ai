const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

/**
 * Inicializa as tabelas do banco.
 * Chamado uma vez no boot do servidor.
 */
async function inicializar() {
  const client = await pool.connect();
  try {
    await client.query(`

      -- Mapeamento da cidade: bairros, perfil, vizinhanças
      CREATE TABLE IF NOT EXISTS bairros (
        id SERIAL PRIMARY KEY,
        cidade VARCHAR(100) NOT NULL,
        bairro VARCHAR(100) NOT NULL,
        zona VARCHAR(50),                    -- norte, sul, leste, oeste, centro
        perfil VARCHAR(50),                  -- alto padrão, médio, popular, comercial, industrial
        descricao TEXT,                      -- o que o sistema aprendeu sobre o bairro
        aptidao_comercial TEXT,              -- que tipo de comércio/serviço funciona bem ali
        vizinhos TEXT[],                     -- bairros que fazem divisa
        ruas_valorizadas TEXT[],             -- ruas/avenidas que valem mais
        pontos_referencia TEXT[],            -- shoppings, praças, escolas famosas
        fatores_positivos TEXT[],
        fatores_negativos TEXT[],
        fonte VARCHAR(50) DEFAULT 'pesquisa',-- 'pesquisa' ou 'corretor'
        atualizado_em TIMESTAMP DEFAULT NOW(),
        UNIQUE(cidade, bairro)
      );

      -- Preços de mercado por bairro/tipo (sempre da Perplexity/portais)
      CREATE TABLE IF NOT EXISTS precos_mercado (
        id SERIAL PRIMARY KEY,
        cidade VARCHAR(100) NOT NULL,
        bairro VARCHAR(100) NOT NULL,
        tipo VARCHAR(50) NOT NULL,           -- terreno, casa, apartamento, comercial
        finalidade VARCHAR(20) NOT NULL,     -- venda, aluguel
        preco_m2 NUMERIC NOT NULL,
        faixa_min NUMERIC,
        faixa_max NUMERIC,
        amostras INT DEFAULT 0,
        confianca VARCHAR(20),               -- alta, media, baixa
        fonte VARCHAR(100),
        condominio VARCHAR(200) DEFAULT '',                  -- Perplexity, OLX, etc.
        comparativos JSONB,                  -- lista de anúncios encontrados
        pesquisado_em TIMESTAMP DEFAULT NOW(),
        UNIQUE(cidade, bairro, tipo, finalidade, condominio)
      );

      -- Histórico de todas as avaliações feitas
      CREATE TABLE IF NOT EXISTS avaliacoes (
        id SERIAL PRIMARY KEY,
        cidade VARCHAR(100),
        bairro VARCHAR(100),
        endereco TEXT,
        tipo VARCHAR(50),
        finalidade VARCHAR(20),
        metragem NUMERIC,
        quartos INT,
        vagas INT,
        conservacao VARCHAR(30),
        diferenciais TEXT[],
        preco_m2_mercado NUMERIC,
        preco_m2_ajustado NUMERIC,
        preco_recomendado NUMERIC,
        preco_minimo NUMERIC,
        preco_maximo NUMERIC,
        fontes TEXT[],
        confianca VARCHAR(20),
        analise_rua JSONB,
        laudo TEXT,
        canal VARCHAR(20),                   -- web, telegram, whatsapp
        criado_em TIMESTAMP DEFAULT NOW()
      );

      -- Feedbacks do corretor (para aprendizado)
      CREATE TABLE IF NOT EXISTS feedbacks (
        id SERIAL PRIMARY KEY,
        avaliacao_id INT REFERENCES avaliacoes(id),
        cidade VARCHAR(100),
        bairro VARCHAR(100),
        tipo VARCHAR(50),
        finalidade VARCHAR(20),
        preco_sistema NUMERIC,               -- o que o sistema sugeriu
        preco_corretor NUMERIC,              -- o que o corretor disse que é certo
        comentario TEXT,                     -- observação do corretor
        criado_em TIMESTAMP DEFAULT NOW()
      );

      -- Conhecimento geral da cidade (pesquisado pela Perplexity)
      CREATE TABLE IF NOT EXISTS conhecimento_cidade (
        id SERIAL PRIMARY KEY,
        cidade VARCHAR(100) NOT NULL UNIQUE,
        perfil_geral TEXT,                   -- pesquisa de perfil da Perplexity
        fonte TEXT,
        citacoes TEXT[],
        pesquisado_em TIMESTAMP DEFAULT NOW()
      );

    `);
    // Tabela de histórico de laudos por usuário
    await pool.query(`
      CREATE TABLE IF NOT EXISTS historico_laudos (
        id SERIAL PRIMARY KEY,
        telegram_id VARCHAR(50) NOT NULL,
        tipo VARCHAR(50),
        finalidade VARCHAR(20),
        cidade VARCHAR(100),
        bairro VARCHAR(150),
        metragem DECIMAL,
        quartos INTEGER,
        preco_recomendado DECIMAL,
        preco_m2 DECIMAL,
        confianca VARCHAR(20),
        laudo_texto TEXT,
        gerado_em TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_historico_telegram ON historico_laudos(telegram_id, gerado_em DESC)`);

    // Contador de uso de APIs externas (custo) por mês
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_uso (
        mes TEXT NOT NULL,
        servico TEXT NOT NULL,
        chamadas INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (mes, servico)
      )
    `);

    // Histórico de avaliações (laudos salvos para consulta)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS laudos (
        id SERIAL PRIMARY KEY,
        criado_em TIMESTAMP DEFAULT NOW(),
        tipo TEXT, finalidade TEXT, cidade TEXT, bairro TEXT, endereco TEXT, condominio TEXT,
        valor BIGINT,
        dados JSONB, resultado JSONB
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_laudos_data ON laudos(criado_em DESC)`);
    await pool.query(`ALTER TABLE laudos ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'imovel'`);
    await pool.query(`ALTER TABLE laudos ADD COLUMN IF NOT EXISTS titulo TEXT`);

    // ─── precos_mercado: coluna `condominio` (correção de schema) ─────────────
    // A coluna foi adicionada ao CREATE TABLE acima DEPOIS que a tabela já
    // existia em produção — e CREATE TABLE IF NOT EXISTS não altera tabela
    // existente. Resultado: a coluna nunca chegou ao banco, e como
    // salvarPreco/buscarPreco a referenciam, o CACHE DE PREÇOS estava MORTO em
    // produção (todo salvar/buscar estourava "column condominio does not
    // exist", silenciado pelo try/catch). Efeito: toda avaliação re-raspava os
    // portais e queimava crédito de ScraperAPI à toa.
    await pool.query(`ALTER TABLE precos_mercado ADD COLUMN IF NOT EXISTS condominio VARCHAR(200) DEFAULT ''`);
    await pool.query(`UPDATE precos_mercado SET condominio='' WHERE condominio IS NULL`);
    // A UNIQUE antiga não inclui condominio, então o ON CONFLICT de salvarPreco
    // (que usa as 5 colunas) não acha constraint. Troca por índice equivalente
    // com condominio — com todos os valores atuais em '', não gera duplicata.
    await pool.query(`ALTER TABLE precos_mercado DROP CONSTRAINT IF EXISTS precos_mercado_cidade_bairro_tipo_finalidade_key`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS precos_mercado_uniq ON precos_mercado (cidade, bairro, tipo, finalidade, condominio)`);

    // ─── predios: memória do que já sabemos de cada edifício ───────────────────
    // Sem isto, cada busca reconstruía a ficha do zero via LLM (não determinístico)
    // → ano e padrão MUDAVAM entre duas buscas do MESMO prédio. E padrão é o
    // driver mais forte do valor (2x), então a estimativa balançava junto.
    // Guarda também a correção do corretor: `*_fonte='informado'` é verdade e
    // NUNCA é sobrescrita pela IA (ver salvarPredio). O que o dono corrige uma
    // vez, fica — e vira ponto de calibração acumulado.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS predios (
        id SERIAL PRIMARY KEY,
        cidade VARCHAR(100) NOT NULL,
        bairro VARCHAR(100) NOT NULL,
        condominio VARCHAR(200) NOT NULL,
        endereco TEXT,
        cnpj VARCHAR(20),
        ano_construcao INT,
        ano_fonte VARCHAR(20),          -- informado | dossiê | busca focada
        padrao VARCHAR(40),
        padrao_fonte VARCHAR(20),       -- informado | dossiê
        condominio_mensal TEXT,
        lazer JSONB,
        perfil_unidades TEXT,
        perfil_confirmado BOOLEAN DEFAULT FALSE,
        atualizado_em TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS predios_uniq ON predios (LOWER(cidade), LOWER(bairro), LOWER(condominio))`);
    console.log('[DB] Tabelas inicializadas com sucesso');
  } catch (err) {
    console.error('[DB] Erro ao inicializar:', err.message);
  } finally {
    client.release();
  }
}

// ─── Operações de Bairros ────────────────────────────────────────

async function salvarBairro(dados) {
  const { cidade, bairro, zona, perfil, descricao, aptidao_comercial, vizinhos, ruas_valorizadas, pontos_referencia, fatores_positivos, fatores_negativos, fonte } = dados;
  const result = await pool.query(`
    INSERT INTO bairros (cidade, bairro, zona, perfil, descricao, aptidao_comercial, vizinhos, ruas_valorizadas, pontos_referencia, fatores_positivos, fatores_negativos, fonte, atualizado_em)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
    ON CONFLICT (cidade, bairro) DO UPDATE SET
      zona=COALESCE($3, bairros.zona),
      perfil=COALESCE($4, bairros.perfil),
      descricao=COALESCE($5, bairros.descricao),
      aptidao_comercial=COALESCE($6, bairros.aptidao_comercial),
      vizinhos=COALESCE($7, bairros.vizinhos),
      ruas_valorizadas=COALESCE($8, bairros.ruas_valorizadas),
      pontos_referencia=COALESCE($9, bairros.pontos_referencia),
      fatores_positivos=COALESCE($10, bairros.fatores_positivos),
      fatores_negativos=COALESCE($11, bairros.fatores_negativos),
      fonte=COALESCE($12, bairros.fonte),
      atualizado_em=NOW()
    RETURNING *
  `, [cidade, bairro, zona, perfil, descricao, aptidao_comercial, vizinhos, ruas_valorizadas, pontos_referencia, fatores_positivos, fatores_negativos, fonte]);
  return result.rows[0];
}

async function buscarBairro(cidade, bairro) {
  const result = await pool.query(
    'SELECT * FROM bairros WHERE LOWER(cidade)=LOWER($1) AND LOWER(bairro)=LOWER($2)',
    [cidade, bairro]
  );
  return result.rows[0] || null;
}

async function listarBairros(cidade) {
  const result = await pool.query(
    'SELECT * FROM bairros WHERE LOWER(cidade)=LOWER($1) ORDER BY perfil, bairro',
    [cidade]
  );
  return result.rows;
}

// ─── Operações de Preços ─────────────────────────────────────────

async function salvarPreco(dados) {
  const { cidade, bairro, tipo, finalidade, condominio, preco_m2, faixa_min, faixa_max, amostras, confianca, fonte, comparativos } = dados;
  const result = await pool.query(`
    INSERT INTO precos_mercado (cidade, bairro, tipo, finalidade, condominio, preco_m2, faixa_min, faixa_max, amostras, confianca, fonte, comparativos, pesquisado_em)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
    ON CONFLICT (cidade, bairro, tipo, finalidade, condominio) DO UPDATE SET
      preco_m2=$6, faixa_min=$7, faixa_max=$8, amostras=$9,
      confianca=$10, fonte=$11, comparativos=$12, pesquisado_em=NOW()
    RETURNING *
  `, [cidade, bairro, tipo, finalidade, condominio || '', preco_m2, faixa_min, faixa_max, amostras, confianca, fonte, JSON.stringify(comparativos || [])]);
  return result.rows[0];
}

/** Ficha conhecida do prédio (memória), com a idade do registro em dias. */
async function buscarPredio(cidade, bairro, condominio) {
  const r = await pool.query(
    `SELECT *, EXTRACT(DAY FROM NOW() - atualizado_em) AS dias_desde
     FROM predios
     WHERE LOWER(cidade)=LOWER($1) AND LOWER(bairro)=LOWER($2) AND LOWER(condominio)=LOWER($3)`,
    [cidade, bairro, condominio]
  );
  return r.rows[0] || null;
}

/**
 * Grava a ficha do prédio. REGRA CENTRAL: o que veio como 'informado' (o corretor
 * conhece o prédio) é verdade e NUNCA é sobrescrito por palpite de IA — só por
 * outro 'informado'. O CASE abaixo é o que garante isso mesmo quando uma busca
 * posterior da IA devolver ano/padrão diferentes.
 */
async function salvarPredio(d) {
  const r = await pool.query(`
    INSERT INTO predios (cidade,bairro,condominio,endereco,cnpj,ano_construcao,ano_fonte,padrao,padrao_fonte,condominio_mensal,lazer,perfil_unidades,perfil_confirmado,atualizado_em)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
    ON CONFLICT (LOWER(cidade), LOWER(bairro), LOWER(condominio)) DO UPDATE SET
      endereco = COALESCE(EXCLUDED.endereco, predios.endereco),
      cnpj = COALESCE(EXCLUDED.cnpj, predios.cnpj),
      ano_construcao = CASE WHEN predios.ano_fonte='informado' AND EXCLUDED.ano_fonte IS DISTINCT FROM 'informado'
                            THEN predios.ano_construcao ELSE COALESCE(EXCLUDED.ano_construcao, predios.ano_construcao) END,
      ano_fonte = CASE WHEN predios.ano_fonte='informado' AND EXCLUDED.ano_fonte IS DISTINCT FROM 'informado'
                       THEN predios.ano_fonte ELSE COALESCE(EXCLUDED.ano_fonte, predios.ano_fonte) END,
      padrao = CASE WHEN predios.padrao_fonte='informado' AND EXCLUDED.padrao_fonte IS DISTINCT FROM 'informado'
                    THEN predios.padrao ELSE COALESCE(EXCLUDED.padrao, predios.padrao) END,
      padrao_fonte = CASE WHEN predios.padrao_fonte='informado' AND EXCLUDED.padrao_fonte IS DISTINCT FROM 'informado'
                          THEN predios.padrao_fonte ELSE COALESCE(EXCLUDED.padrao_fonte, predios.padrao_fonte) END,
      condominio_mensal = COALESCE(EXCLUDED.condominio_mensal, predios.condominio_mensal),
      lazer = COALESCE(EXCLUDED.lazer, predios.lazer),
      perfil_unidades = COALESCE(EXCLUDED.perfil_unidades, predios.perfil_unidades),
      perfil_confirmado = EXCLUDED.perfil_confirmado,
      atualizado_em = NOW()
    RETURNING *
  `, [
    d.cidade, d.bairro, d.condominio, d.endereco || null, d.cnpj || null,
    d.ano_construcao || null, d.ano_fonte || null,
    d.padrao || null, d.padrao_fonte || null,
    d.condominio_mensal || null,
    d.lazer ? JSON.stringify(d.lazer) : null,
    d.perfil_unidades || null, d.perfil_confirmado === true,
  ]);
  return r.rows[0];
}

async function buscarPreco(cidade, bairro, tipo, finalidade, condominio) {
  const result = await pool.query(
    `SELECT *, EXTRACT(DAY FROM NOW() - pesquisado_em) as dias_desde
     FROM precos_mercado
     WHERE LOWER(cidade)=LOWER($1) AND LOWER(bairro)=LOWER($2)
       AND LOWER(tipo)=LOWER($3) AND LOWER(finalidade)=LOWER($4)
       AND LOWER(COALESCE(condominio,''))=LOWER($5)`,
    [cidade, bairro, tipo, finalidade, condominio || '']
  );
  return result.rows[0] || null;
}

async function invalidarPreco(cidade, bairro, tipo, finalidade, condominio) {
  await pool.query(
    `DELETE FROM precos_mercado
     WHERE LOWER(cidade)=LOWER($1) AND LOWER(bairro)=LOWER($2)
       AND LOWER(tipo)=LOWER($3) AND LOWER(finalidade)=LOWER($4)
       AND LOWER(COALESCE(condominio,''))=LOWER($5)`,
    [cidade, bairro, tipo, finalidade, condominio || '']
  );
  console.log(`[DB] Cache invalidado: ${tipo}/${finalidade} em ${bairro}, ${cidade}${condominio ? ' (' + condominio + ')' : ''}`);
}

async function salvarHistorico(telegramId, dados, resultado, laudoTexto) {
  const { tipo, finalidade, cidade, bairro, metragem, quartos } = dados;
  const { precoRecomendado, precoM2Imovel, confiancaFonte } = resultado;
  await pool.query(
    `INSERT INTO historico_laudos
      (telegram_id, tipo, finalidade, cidade, bairro, metragem, quartos,
       preco_recomendado, preco_m2, confianca, laudo_texto)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [telegramId, tipo, finalidade, cidade, bairro, metragem, quartos || 0,
     precoRecomendado, precoM2Imovel, confiancaFonte || 'baixa', laudoTexto]
  );
}

async function buscarHistorico(telegramId, limite = 5) {
  const result = await pool.query(
    `SELECT tipo, finalidade, cidade, bairro, metragem, quartos,
            preco_recomendado, preco_m2, confianca, gerado_em
     FROM historico_laudos
     WHERE telegram_id = $1
     ORDER BY gerado_em DESC
     LIMIT $2`,
    [telegramId, limite]
  );
  return result.rows;
}

// ─── Operações de Avaliações ─────────────────────────────────────

async function salvarAvaliacao(dados) {
  const result = await pool.query(`
    INSERT INTO avaliacoes (cidade, bairro, endereco, tipo, finalidade, metragem, quartos, vagas, conservacao, diferenciais,
      preco_m2_mercado, preco_m2_ajustado, preco_recomendado, preco_minimo, preco_maximo, fontes, confianca, analise_rua, laudo, canal)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    RETURNING id
  `, [dados.cidade, dados.bairro, dados.endereco, dados.tipo, dados.finalidade, dados.metragem,
      dados.quartos, dados.vagas, dados.conservacao, dados.diferenciais,
      dados.preco_m2_mercado, dados.preco_m2_ajustado, dados.preco_recomendado, dados.preco_minimo, dados.preco_maximo,
      dados.fontes, dados.confianca, JSON.stringify(dados.analise_rua), dados.laudo, dados.canal]);
  return result.rows[0];
}

// ─── Operações de Feedback ───────────────────────────────────────

async function salvarFeedback(dados) {
  const result = await pool.query(`
    INSERT INTO feedbacks (avaliacao_id, cidade, bairro, tipo, finalidade, preco_sistema, preco_corretor, comentario)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
  `, [dados.avaliacao_id, dados.cidade, dados.bairro, dados.tipo, dados.finalidade, dados.preco_sistema, dados.preco_corretor, dados.comentario]);
  return result.rows[0];
}

// ─── Operações de Conhecimento ───────────────────────────────────

async function salvarConhecimentoCidade(cidade, perfil, fonte, citacoes) {
  const result = await pool.query(`
    INSERT INTO conhecimento_cidade (cidade, perfil_geral, fonte, citacoes, pesquisado_em)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (cidade) DO UPDATE SET perfil_geral=$2, fonte=$3, citacoes=$4, pesquisado_em=NOW()
    RETURNING *
  `, [cidade, perfil, fonte, citacoes]);
  return result.rows[0];
}

async function buscarConhecimentoCidade(cidade) {
  const result = await pool.query(
    `SELECT *, EXTRACT(DAY FROM NOW() - pesquisado_em) as dias_desde
     FROM conhecimento_cidade WHERE LOWER(cidade)=LOWER($1)`,
    [cidade]
  );
  return result.rows[0] || null;
}

// ─── Stats ───────────────────────────────────────────────────────

async function stats() {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM bairros) as total_bairros,
      (SELECT COUNT(*) FROM precos_mercado) as total_precos,
      (SELECT COUNT(*) FROM avaliacoes) as total_avaliacoes,
      (SELECT COUNT(*) FROM feedbacks) as total_feedbacks,
      (SELECT COUNT(DISTINCT cidade) FROM bairros) as total_cidades
  `);
  return result.rows[0];
}

// ─── Contador de uso de APIs (custo) ─────────────────────────────
function mesAtual() { return new Date().toISOString().slice(0, 7); } // 'YYYY-MM'

async function registrarUso(servico, n = 1) {
  try {
    await pool.query(
      `INSERT INTO api_uso (mes, servico, chamadas) VALUES ($1, $2, $3)
       ON CONFLICT (mes, servico) DO UPDATE SET chamadas = api_uso.chamadas + $3`,
      [mesAtual(), servico, n]
    );
  } catch (err) { /* uso é best-effort, nunca quebra o fluxo */ }
}

async function obterUso(servico) {
  try {
    const r = await pool.query(`SELECT chamadas FROM api_uso WHERE mes = $1 AND servico = $2`, [mesAtual(), servico]);
    return r.rows[0]?.chamadas || 0;
  } catch (err) { return 0; }
}

// ─── Histórico de laudos (consulta) ─────────────────────────────
async function salvarLaudo(p) {
  const r = await pool.query(
    `INSERT INTO laudos (kind, titulo, tipo, finalidade, cidade, bairro, endereco, condominio, valor, dados, resultado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, criado_em`,
    [p.kind || 'imovel', p.titulo || null, p.tipo || null, p.finalidade || null, p.cidade || null,
     p.bairro || null, p.endereco || null, p.condominio || null, p.valor || 0,
     JSON.stringify(p.dados || {}), JSON.stringify(p.resultado || {})]
  );
  return r.rows[0];
}
async function listarLaudos(limit = 60) {
  const r = await pool.query(
    `SELECT id, criado_em, kind, titulo, tipo, finalidade, cidade, bairro, endereco, valor
     FROM laudos ORDER BY criado_em DESC LIMIT $1`, [limit]);
  return r.rows;
}
async function buscarLaudo(id) {
  const r = await pool.query(`SELECT * FROM laudos WHERE id = $1`, [id]);
  return r.rows[0] || null;
}
async function limparLaudos(kind) {
  const r = kind
    ? await pool.query(`DELETE FROM laudos WHERE kind = $1`, [kind])
    : await pool.query(`DELETE FROM laudos`);
  return r.rowCount || 0;
}
async function apagarLaudo(id) {
  const r = await pool.query(`DELETE FROM laudos WHERE id = $1`, [id]);
  return r.rowCount || 0;
}

module.exports = {
  pool, inicializar,
  salvarBairro, buscarBairro, listarBairros,
  salvarPreco, buscarPreco, invalidarPreco, salvarHistorico, buscarHistorico,
  buscarPredio, salvarPredio,
  salvarAvaliacao, salvarFeedback,
  salvarConhecimentoCidade, buscarConhecimentoCidade,
  stats, registrarUso, obterUso,
  salvarLaudo, listarLaudos, buscarLaudo, limparLaudos, apagarLaudo
};
