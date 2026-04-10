require('dotenv').config();
const express = require('express');
const path = require('path');
const { handleWebhook } = require('./whatsapp/webhook');
const chatRoutes = require('./routes/chat');

const app = express();
app.use(express.json());

// Interface web (pasta public)
app.use(express.static(path.join(__dirname, '../public')));

// Rotas da API de chat (interface web)
app.use('/api', chatRoutes);

// Webhook do WhatsApp (Evolution API)
app.post('/webhook', handleWebhook);

// Health check para Railway
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Precifica AI', timestamp: new Date().toISOString() });
});

// Endpoint de diagnóstico para o scraping (não expõe dados sensíveis)
const axios = require('axios');
app.get('/debug/scraping', async (req, res) => {
  const cidade = (req.query.cidade || 'goiania').toLowerCase();
  const bairro = (req.query.bairro || 'setor-bueno').toLowerCase();
  const tipo = (req.query.tipo || 'apartamentos');
  const finalidade = (req.query.finalidade || 'venda');

  const zapUrl = `https://www.zapimoveis.com.br/${finalidade}/${tipo}/go+${cidade}+${bairro}/`;
  const fipeUrl = `https://fipezap.zapimoveis.com.br/api/v1/market/sale/city?citySlug=${cidade}`;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Upgrade-Insecure-Requests': '1'
  };

  async function probe(url, opts = {}) {
    const t0 = Date.now();
    try {
      const r = await axios.get(url, {
        timeout: 12000,
        validateStatus: () => true, // não joga em status >= 400
        headers,
        ...opts
      });
      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      const hasNextData = /<script id="__NEXT_DATA__"/.test(html);
      let nextDataPaths = null;
      if (hasNextData) {
        try {
          const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
          const data = JSON.parse(m[1]);
          nextDataPaths = {
            hasFetchListing: !!data?.props?.pageProps?.fetchListing,
            hasListings: Array.isArray(data?.props?.pageProps?.listings),
            hasSearchResult: !!data?.props?.pageProps?.searchResult,
            topLevelKeys: Object.keys(data?.props?.pageProps || {}).slice(0, 20)
          };
        } catch (e) {
          nextDataPaths = { parseError: e.message };
        }
      }
      return {
        ok: true,
        status: r.status,
        contentType: r.headers['content-type'],
        contentLength: html.length,
        elapsedMs: Date.now() - t0,
        hasNextData,
        nextDataPaths,
        bodyPreview: html.slice(0, 500),
        bodyTail: html.slice(-300)
      };
    } catch (err) {
      return {
        ok: false,
        elapsedMs: Date.now() - t0,
        error: err.message,
        code: err.code,
        status: err.response?.status || null
      };
    }
  }

  const [zap, fipe] = await Promise.all([probe(zapUrl), probe(fipeUrl, { headers: { ...headers, Accept: 'application/json' } })]);

  res.json({
    queriedAt: new Date().toISOString(),
    zap: { url: zapUrl, ...zap },
    fipezap: { url: fipeUrl, ...fipe }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Precifica AI rodando na porta ${PORT}`);
  console.log(`🌐 Interface web: http://localhost:${PORT}`);
});
