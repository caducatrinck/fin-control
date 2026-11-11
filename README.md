# Fin Control

Controle financeiro pessoal que lê seus bancos via **Open Finance**, usando a [Pluggy](https://pluggy.ai) e o [MeuPluggy](https://meu.pluggy.ai).
Ele mostra saldos, transações, cartão, contas recorrentes e investimentos, com tags e regras que você define.

- **Somente leitura:** o app não faz pagamentos nem transferências.
- **Tudo fica no seu computador:** suas credenciais e seus dados (tags, ajustes) ficam salvos localmente. Não há servidor nosso no meio: o app conversa direto com a API da Pluggy.
- **Cada pessoa usa a própria conta Pluggy.** O app não vem com credenciais.

---

## 1. Baixar e abrir (Windows)

1. Abra a página **Releases** deste repositório e baixe o `Fin-Control-<versão>-portable.exe` mais recente.
2. Dê dois cliques no `.exe`. Não precisa instalar.
3. O executável não tem assinatura digital, então o Windows pode mostrar **"O Windows protegeu o computador"**. Clique em **Mais informações → Executar assim mesmo**.

> Seus dados ficam em `%APPDATA%\Fin Control\` (arquivo `.env` com as credenciais e a pasta `data\`). Para começar do zero, apague essa pasta ou use **Configurações → Remover tudo**.

## 2. Criar as credenciais da Pluggy (uma vez)

1. Crie uma conta gratuita em **https://dashboard.pluggy.ai**. O botão **Entrar na Pluggy ↗** do app abre essa página.
2. No Dashboard, abra **Applications** e crie uma aplicação (ou escolha uma que já exista).
3. Copie o **Client ID** (no formato `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) e o **Client Secret**.
4. No Fin Control, na tela **Credenciais da Pluggy**, cole os dois valores e clique em **Validar e salvar**.
   O app testa as credenciais com a Pluggy antes de salvar. Se der erro, confira se copiou os valores certos.

> O **Client Secret** é como uma senha: não envie para ninguém e não publique em lugar nenhum.

## 3. Conectar seus bancos (uma vez)

1. Clique em **Abrir MeuPluggy ↗** e crie sua conta no **MeuPluggy** (https://meu.pluggy.ai).
2. No MeuPluggy, conecte seus bancos pelo Open Finance. A autorização acontece no app do seu banco.
3. Volte ao Fin Control e clique em **Já conectei meus bancos**.
4. Clique em **Conectar conta bancária**, faça login no MeuPluggy na janela que abrir e confirme o acesso.
5. Pronto: suas contas aparecem na tela principal.

> O MeuPluggy sincroniza com os bancos mais ou menos a cada 24 horas. O botão **Atualizar** busca de novo o que a Pluggy já tem. Ele não força uma nova leitura no banco.

## 4. Usar no dia a dia

- **Período:** escolha as datas para ver entradas, saídas e totais.
- **Tags e regras:** marque um pagador ou recebedor com uma tag. As próximas transações dele recebem a mesma tag sozinhas. Os filtros também podem usar valor e/ou texto.
- **Contas recorrentes:** cadastre suas contas fixas e acompanhe quais já foram pagas em cada mês.
- **Cartão:** veja a fatura atual e as próximas, com as parcelas.
- **Patrimônio:** veja investimentos e rendimentos, e faça ajustes manuais quando precisar.
- **Configurações:** troque as credenciais, troque ou desconecte a conta bancária, ou remova tudo.

---

## Rodar a partir do código (desenvolvedores)

Pré-requisito: **Node.js 22.13 ou mais novo** (veja `.nvmrc`).

```bash
npm ci
npm start          # abre http://localhost:3000 no navegador
npm run desktop    # mesma coisa, numa janela Electron
npm test           # testes
npm run typecheck
```

Na primeira execução, a própria interface pede as credenciais e grava o `.env` na raiz do projeto (veja `.env.example`). O `.env` e a pasta `data/` estão no `.gitignore`. **Nunca faça commit deles.**

### Gerar o executável

```bash
npm run dist:win   # gera release/Fin-Control-<versão>-portable.exe
```

### Pipeline (GitHub Actions)

A cada push na branch principal, o workflow [.github/workflows/release.yml](.github/workflows/release.yml):

1. roda o typecheck e os testes;
2. gera o `.exe` portátil no Windows;
3. publica a Release **`v<version do package.json>`** com o `.exe` anexado.

Se a release daquela versão já existe, o passo 3 é pulado. Para lançar uma nova versão, aumente o campo `version` no `package.json` e faça push.

### Segurança

- O servidor local escuta só em `127.0.0.1` e recusa requisições com `Host` ou `Origin` que não sejam locais. Isso protege contra sites maliciosos tentando ler seus dados (DNS rebinding/CSRF).
- As credenciais ficam em texto puro no `.env` local. Qualquer programa rodando com o seu usuário consegue lê-las, como acontece com qualquer arquivo de configuração.
