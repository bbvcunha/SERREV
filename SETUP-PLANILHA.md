# Banco de dados na Google Planilha (seu Drive)

Os abastecimentos e alarmes ficam em **abas na sua planilha**. Só você (e quem você compartilhar no Drive) vê e edita os dados.

## Visão geral

1. Criar uma planilha no Google Drive  
2. Colar o script `google-apps-script/Code.gs`  
3. Publicar como **aplicativo da web**  
4. Colar a URL no arquivo `sheets-config.js` e publicar no GitHub  

Tempo estimado: **10–15 minutos** (uma vez).

---

## Passo 1 — Criar a planilha

1. [Google Drive](https://drive.google.com) → **Novo** → **Google Planilhas**  
2. Nome: `Controle Carro KPI`  
3. **Compartilhar** apenas com quem você autorizar (ou deixe só você)

---

## Passo 2 — Instalar o script

1. Na planilha: **Extensões** → **Apps Script**  
2. Apague o código padrão  
3. Copie **todo** o conteúdo de `google-apps-script/Code.gs` deste repositório e cole  
4. Salve (Ctrl+S)  
5. No menu do editor: selecione a função **`instalarPlanilha`** → **Executar**  
6. Autorize o Google (sua conta) quando pedir  
7. Volte à planilha: devem aparecer as abas **Abastecimentos**, **Alarmes**, **Manutencoes** e **Config**

> **Planilha antiga?** Execute a função **`atualizarPlanilha`** (em vez de só `instalarPlanilha`) para criar a aba **Manutencoes** e atualizar **Alarmes** com colunas de data.

---

## Passo 3 — Chave de segurança (recomendado)

1. No Apps Script: **Projeto** (ícone engrenagem) → **Propriedades do projeto**  
2. Aba **Propriedades do script** → **Adicionar propriedade**  
   - Nome: `API_SECRET`  
   - Valor: invente uma senha longa (ex.: `MinhaSenhaCarro2026!XyZ`)  
3. Anote essa senha — vai no `sheets-config.js`

---

## Passo 4 — Publicar aplicativo da web

1. Apps Script → **Implantar** → **Nova implantação**  
2. Tipo: **Aplicativo da web**  
3. Configuração:  
   - **Executar como:** Eu (sua conta)  
   - **Quem pode acessar:** Qualquer pessoa  
4. **Implantar** → copie a **URL do aplicativo da web** (termina em `/exec`)

> “Qualquer pessoa” só pode chamar a API com a **URL + senha API_SECRET + código de sync**. A planilha em si continua privada no seu Drive.

5. Se alterar o script depois: **Implantar** → **Gerenciar implantações** → editar → **Nova versão** → Implantar

---

## Passo 5 — Configurar o site

1. Copie `sheets-config.example.js` → `sheets-config.js`  
2. Preencha:

```javascript
window.SHEETS_CONFIG = {
  webAppUrl: 'https://script.google.com/macros/s/SEU_ID/exec',
  apiSecret: 'MinhaSenhaCarro2026!XyZ',
  spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/SEU_ID/edit',
};
```

3. Envie ao GitHub:

```bash
git add sheets-config.js
git commit -m "Ativar Google Sheets"
git push
```

Em ~1 minuto: https://bbvcunha.github.io/SERREV/

---

## Passo 6 — Celular e computador

1. **Celular:** app → **Conta** → **Copiar** código  
2. **PC:** mesmo site → **Conta** → colar código → **Conectar**  
3. Status no topo: **Planilha ativa**  
4. **Abrir minha planilha** na aba Conta

---

## Editar na planilha

Você pode alterar células manualmente. Na próxima **Sincronizar agora** no app, os dados da planilha prevalecem.

Colunas **Abastecimentos:** `id` | `data_hora` | `km_total` | `litros` | `valor_rs` | `obs`

Colunas **Alarmes:** `id` | `nome` | `intervalo_km` | `intervalo_meses` | `ultima_manutencao_km` | `ultima_manutencao_data` | `observacoes`

Colunas **Manutencoes:** `id` | `data` | `local` | `km` | `comentarios` | `realizada` (sim/nao)

---

## Autorizar outra pessoa

- **Ver/editar planilha:** compartilhe o arquivo no Drive (Leitor ou Editor)  
- **Usar o app:** a pessoa precisa do mesmo `sheets-config.js` (URL + apiSecret) e do **mesmo código de sync** na aba Conta
