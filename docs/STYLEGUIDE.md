# Style guide — fin-control

Minimalista, funcional e objetivo: pouca cor, hierarquia pela tipografia, um componente para cada propósito.

- Fonte única de verdade: `src/web/styles.css`
- Referência visual (claro e escuro): `npm start` e abra http://localhost:3000/styleguide.html

## Princípios

1. **Monocromático com significado.** A cor só aparece quando comunica algo: verde para entrada, vermelho para saída ou erro, amarelo para atenção, azul para links e foco.
2. **Tipografia faz a hierarquia.** Títulos, rótulos e botões em uppercase; texto corrido em caixa normal.
3. **Números em fonte mono.** Valores, datas e IDs usam fonte monoespaçada com algarismos tabulares, para alinhar colunas.
4. **Sem estilo inline.** Tudo sai de tokens e classes do `styles.css`. Se faltar algo, crie a classe lá e documente aqui.
5. **Claro e escuro desde o início.** Nunca use cor fixa (`#fff`, `black`); use sempre um token.

## Tema

- Preferência salva em `localStorage` (`fin-control:theme`): `system` (padrão), `light` ou `dark`.
- `src/web/theme.ts` (servido como `/theme.js`) aplica `data-theme="light|dark"` no `<html>` antes da renderização. Carregue no `<head>`, sem `defer`.
- Qualquer botão com o atributo `data-theme-toggle` alterna entre automático, claro e escuro.

## Tokens

### Tipografia

| Token | Uso |
| --- | --- |
| `--font-display` (Space Grotesk) | Títulos, rótulos, botões, cabeçalhos de tabela, badges — sempre uppercase |
| `--font-body` (Inter) | Texto corrido, descrições, instruções |
| `--font-mono` (JetBrains Mono) | Valores, datas, IDs, código |

Escala: `--text-xs` 12px, `--text-sm` 14px, `--text-md` 16px, `--text-lg` 20px, `--text-xl` 28px.

### Cores

| Token | Uso |
| --- | --- |
| `--bg` | Fundo da página |
| `--surface` / `--surface-muted` | Cards / inputs e áreas de destaque sutil |
| `--border` | Bordas e divisores |
| `--text` / `--text-muted` | Texto principal / secundário |
| `--primary` / `--primary-contrast` | Botão primário e seu texto |
| `--accent` | Links |
| `--focus` | Anel de foco |
| `--positive` / `--negative` / `--warning` | Entrada / saída ou erro / atenção |

### Espaçamento e forma

Escala de 4px: `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 24 · `--space-6` 32 · `--space-7` 48.
Raios: `--radius-sm` 4px (botões, inputs, badges) e `--radius-md` 8px (cards).

## Componentes

| Classe | Uso |
| --- | --- |
| `.container` | Coluna central da página |
| `.app-header` + `.brand` | Cabeçalho com título, subtítulo e ações |
| `.stack` / `.stack-tight` | Empilhamento vertical com espaço padrão / curto |
| `.row` / `.row-between` | Linha horizontal / com itens nas pontas |
| `.card` | Agrupador de conteúdo |
| `.btn` + `.btn-primary` | Ação principal (no máximo uma por card) |
| `.btn` + `.btn-secondary` | Ações secundárias |
| `.btn` + `.btn-ghost` | Navegação e ações discretas |
| `.btn` + `.btn-danger` | Ações destrutivas (sempre com confirmação) |
| `.field` + `.label` + `.input` | Campo de formulário |
| `.checkbox` | Checkbox com rótulo |
| `.alert` + `.alert-error` / `.alert-info` | Mensagens; some sozinho quando vazio |
| `.badge` (+ `-positive`, `-warning`, `-negative`) | Status curto |
| `.steps` | Lista numerada de passos |
| `.definition` | Pares chave e valor (`<dl>`) |
| `.table` + `.col-date` / `.col-amount` | Tabelas de dados |
| `.amount` / `.amount-lg` + `.is-positive` / `.is-negative` | Valores monetários |
| `.tabs` + `.tab[aria-selected]` | Abas principais do app |
| `.chips` + `.chip[aria-selected]` | Seleção rápida (ex.: meses) |
| `.segmented` + `button[aria-pressed]` | Filtros mutuamente exclusivos |
| `.stat-grid` + `.stat` + `.amount-xl` | Cards de totais |
| `.bar-row` + `.bar` | Proporção de um valor sobre o total |
| `.chart` + `.chart-series.chart-<id>` / `.chart-legend` + `.legend-<id>` | Gráfico de linhas em SVG; a cor de cada série vem de `--series-color` |
| `.chart-bar` (+ `.is-estimated`, `.is-selected`) + `.chart-bar-hit` | Gráfico de barras em SVG; barra clara = valor previsto, cheia = selecionada; `.chart-bar-hit` amplia a área clicável |
| `.card-grid` | Cards lado a lado que quebram em telas estreitas |
| `.bar-label` | Texto à esquerda de um `.bar-row`, cortado com reticências |
| `[data-color="<cor>"]` | Define `--tag-color` (cores em `TAG_COLORS`, `src/shared/api.ts`) |
| `.tag-badge` (+ `.is-empty`) | Nome da tag com bolinha de cor |
| `.swatches` + `.swatch` | Seletor de cor (radio) |
| `.dropzone` (+ `.is-over`) | Área que aceita arrastar e soltar |
| `.counterparty-list` + `.counterparty` | Itens arrastáveis (pagador/recebedor) |
| `.dialog` (+ `.dialog-wide`) | Janela modal (`<dialog>`); a larga serve para listas |
| `details.accordion` + `summary.accordion-summary` | Seção expansível: título, legenda, valor e seta |
| `.context-menu` + `.menu-header` / `.menu-item` (`-accent`, `-danger`) / `.menu-separator` | Menu do botão direito; seções separadas por `.menu-separator`, cada uma com seu `.menu-header` |
| `.btn.is-loading` (+ `disabled`) | Botão com spinner enquanto a ação carrega |
| `.btn-sm` | Botão compacto, para ações dentro de linhas e listas |
| `.value-btn` | Valor clicável e editável numa tabela (valor + `.subtext`) |
| `.match-prompt` | Pergunta curta dentro de uma linha, com botões Sim/Não (`.btn-sm`) |
| `.link-results` / `.link-picked` | Busca com resultados clicáveis / item escolhido com botão "Trocar" |
| `.suggestion-list` + `.suggestion` | Lista de sugestões com texto à esquerda e ações à direita |
| `.subtext` | Segunda linha discreta dentro de uma célula |
| `.cell-name` + `.reveal-btn[aria-pressed]` | Nome exibido com botão de olho que revela o `.subtext` oculto (nome original) |
| `.eyebrow` | Legenda curta uppercase acima ou abaixo de títulos |
| `.muted`, `.text-sm`, `.mono` | Utilitários de texto |
| `.push-end` | Empurra o item para o fim da linha (ex.: "Atualizar" quando os chips de período estão ocultos) |

## Padrões de interface

- **Visibilidade:** use o atributo `hidden` (ou `el.hidden = true` no JS), não classes próprias.
- **Erros:** cada formulário ou seção tem seu `.alert.alert-error`. Preencha `textContent`; limpe antes de cada ação.
- **Conteúdo vindo da API:** sempre via `textContent`, nunca `innerHTML`.
- **Links externos:** `target="_blank" rel="noopener"`, com `↗` no rótulo.
- **Valores monetários:** `Intl.NumberFormat("pt-BR", { style: "currency" })`; negativo com `.is-negative`.
- **Texto da interface:** português, frases curtas e diretas.
