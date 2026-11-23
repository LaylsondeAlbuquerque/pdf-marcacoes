# PDF Marcações

Marque trechos em cinco cores no leitor de PDF do Obsidian e reúna as citações em uma nota Markdown ao lado de cada livro. A nota acompanha a ordem de leitura e inclui um link para a página de cada trecho.

## Como usar

1. Abra um PDF com texto selecionável. No computador, selecione o trecho e escolha uma cor na barra flutuante ou pelo botão direito. No celular, pressione uma palavra, ajuste as alças e toque na cor.
2. A primeira marcação cria a nota **Nome do livro — Marcações.md** na pasta do PDF. Use **Abrir nota** para consultá-la. Escreva seus comentários na seção **Minhas anotações**. O plugin atualiza o bloco **Trechos marcados**.
3. Para trocar a cor ou excluir uma marcação, clique com o botão direito sobre o trecho no computador ou dê um toque curto no celular. Em **Marcações salvas** também é possível remover um trecho ou recuperar a nota.

No computador, **Automático** aplica a cor atual ao selecionar texto. O número de página do link corresponde à página do arquivo PDF. Digitalizações precisam de uma camada de texto, como a produzida por OCR.

## Armazenamento e sincronização

O plugin desenha as cores sobre as páginas do leitor. As posições e os trechos ficam em arquivos JSON na pasta `Sistema/Marcações de PDF/Dados` dentro do cofre. Para ler as marcações em outro aparelho, sincronize o PDF, a nota, essa pasta de dados e os arquivos do plugin. Ao mover ou renomear o PDF, faça isso pelo Obsidian para que o plugin possa atualizar os caminhos.

## Tradução e privacidade

Marcar, copiar e consultar as notas funciona offline. A tradução para português usa o Google Tradutor pela internet. Com **Traduzir palavras ao selecionar** ativado, selecionar uma palavra envia essa palavra a `translate.googleapis.com`. Para frases, o envio ocorre ao tocar em **Traduzir**. Você pode desativar a tradução automática nas configurações do plugin e continuar consultando trechos pelo botão.

O serviço pode limitar consultas, inclusive na primeira tentativa no Android. Nesse caso, o plugin pausa as consultas e oferece **Abrir no Google Tradutor**. Esse link leva o texto selecionado a `translate.google.com`. As traduções recentes ficam na memória durante a sessão.

## Instalação manual

Na seção **Releases** do repositório, baixe os três anexos da mesma versão, `main.js`, `manifest.json` e `styles.css`. Coloque-os na pasta `.obsidian/plugins/pdf-marcacoes/` do cofre e habilite **PDF Marcações** em **Plugins da comunidade**.

## Desenvolvimento

Execute `node --test test.js` para testar e `node build.js` para gerar os três arquivos de distribuição em `dist/`. Depois do build, abra `runtime-touch-test.html` no Chromium para executar o teste de interação. O código do leitor está em `main.js` e a lógica de notas e posições em `core.js`.

## Licença

Copyright © 2026 Laylson. Distribuído sob a GNU General Public License, versão 3 (GPL-3.0-only). Consulte o arquivo [LICENSE](LICENSE).
