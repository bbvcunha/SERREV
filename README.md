# Controle do Carro — KPIs

App no navegador para abastecimentos, KPIs e alarmes de manutenção.

**Online:** https://bbvcunha.github.io/SERREV/

## Banco de dados: Google Planilha (recomendado)

Os dados ficam em **abas no seu Google Drive** — você vê e edita como planilha, controla quem acessa pelo compartilhamento do Drive.

Guia completo: **[SETUP-PLANILHA.md](SETUP-PLANILHA.md)**

Resumo:
1. Criar planilha no Drive  
2. Colar `google-apps-script/Code.gs` em Extensões → Apps Script  
3. Executar `instalarPlanilha` → publicar como **aplicativo da web**  
4. Preencher `sheets-config.js` e dar `git push`  

## Abas do app

| Aba | Função |
|-----|--------|
| Abastecimento | Registrar após encher o tanque |
| Dados | Tabela, histórico, editar, OBS |
| KPIs | Gráficos |
| Alarmes | Manutenção por km |
| Conta | Código de sync, planilha, backup |

## Sincronizar celular e PC

Mesmo código na aba **Conta** nos dois aparelhos (com planilha configurada).

## Backup sem planilha

**Conta** → Exportar / Importar JSON.

## Desenvolvimento local

```bash
python3 -m http.server 8080
```

Abra http://localhost:8080
