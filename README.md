# PrecificaAI 🏠

Agente de precificação imobiliária via WhatsApp para o mercado de Goiás.

## Stack
- **Backend:** Node.js + Express
- **IA:** OpenAI GPT-4o
- **Dados:** FipeZAP + ZAP Imóveis
- **WhatsApp:** Evolution API
- **Deploy:** Railway

## Variáveis de ambiente

Copie `.env.example` para `.env` e preencha:

```bash
cp .env.example .env
```

| Variável | Descrição |
|---|---|
| `OPENAI_API_KEY` | Chave da OpenAI (sk-...) |
| `EVOLUTION_API_URL` | URL da sua instância Evolution API |
| `EVOLUTION_API_KEY` | Chave de autenticação da Evolution API |
| `EVOLUTION_INSTANCE` | Nome da instância (ex: precifica) |
| `PORT` | Porta do servidor (padrão: 3000) |

## Rodando local

```bash
npm install
cp .env.example .env
# Preencha o .env com suas chaves
npm run dev
```

## Deploy no Railway

1. Suba o código no GitHub
2. No Railway: **New Project → Deploy from GitHub Repo**
3. Adicione as variáveis de ambiente nas **Settings → Variables**
4. Railway faz deploy automático a cada push

## Configurar webhook na Evolution API

Após o deploy, configure o webhook na Evolution API:

```
URL: https://seu-app.railway.app/webhook
Eventos: messages.upsert
```

## Fluxo do agente

```
Corretor manda mensagem
        ↓
Agente GPT-4o coleta 7 dados (um por vez)
        ↓
Motor consulta FipeZAP + ZAP Imóveis
        ↓
Laudo de precificação no WhatsApp
```
