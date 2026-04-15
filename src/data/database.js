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
        fonte VARCHAR(100),                  -- Perplexity, OLX, etc.
        comparativos JSONB,                  -- lista de anúncios encontrados
        pesquisado_em TIMESTAMP DEFAULT NOW(),
        UNIQUE(cidade, bairro, tipo, finalidade)
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
  const { cidade, bairro, tipo, finalidade, preco_m2, faixa_min, faixa_max, amostras, confianca, fonte, comparativos } = dados;
  const result = await pool.query(`
    INSERT INTO precos_mercado (cidade, bairro, tipo, finalidade, preco_m2, faixa_min, faixa_max, amostras, confianca, fonte, comparativos, pesquisado_em)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
    ON CONFLICT (cidade, bairro, tipo, finalidade) DO UPDATE SET
      preco_m2=$5, faixa_min=$6, faixa_max=$7, amostras=$8,
      confianca=$9, fonte=$10, comparativos=$11, pesquisado_em=NOW()
    RETURNING *
  `, [cidade, bairro, tipo, finalidade, preco_m2, faixa_min, faixa_max, amostras, confianca, fonte, JSON.stringify(comparativos || [])]);
  return result.rows[0];
}

async function buscarPreco(cidade, bairro, tipo, finalidade) {
  const result = await pool.query(
    `SELECT *, EXTRACT(DAY FROM NOW() - pesquisado_em) as dias_desde
     FROM precos_mercado
     WHERE LOWER(cidade)=LOWER($1) AND LOWER(bairro)=LOWER($2)
       AND LOWER(tipo)=LOWER($3) AND LOWER(finalidade)=LOWER($4)`,
    [cidade, bairro, tipo, finalidade]
  );
  return result.rows[0] || null;
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

module.exports = {
  pool, inicializar,
  salvarBairro, buscarBairro, listarBairros,
  salvarPreco, buscarPreco,
  salvarAvaliacao, salvarFeedback,
  salvarConhecimentoCidade, buscarConhecimentoCidade,
  stats
};
