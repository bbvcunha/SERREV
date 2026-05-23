# Controle do Carro — KPIs

Aplicativo simples no navegador para registrar abastecimentos, ver indicadores em tabela e gráficos, e configurar alarmes de manutenção por quilometragem.

## Abas

1. **Abastecimento** — Data/hora, quilometragem, litros e valor (R$), logo após encher o tanque.
2. **Dados** — Tabela com R$/L, km/L e campo **OBS** (clique para anotar).
3. **KPIs** — Gráficos de consumo, preço/L, distância acumulada e gasto com combustível.
4. **Alarmes** — Criar, editar e excluir lembretes (óleo, pneus, correia, etc.) por intervalo em km.

Os dados ficam no navegador (`localStorage`). Não precisa de servidor.

## Executar

```bash
cd /Users/brunobennheim/SERREV
python3 -m http.server 8080
```

Abra [http://localhost:8080](http://localhost:8080).

## Versão online (celular)

**https://bbvcunha.github.io/SERREV/**

No iPhone/Android: abra o link no navegador → menu **Compartilhar** / **⋮** → **Adicionar à tela inicial** (atalho como app).

Os dados ficam salvos no navegador do celular (não sincronizam automaticamente com o computador).

## Cálculos

- **R$/L** = valor pago ÷ litros  
- **km/L** = (quilometragem atual − anterior) ÷ litros (a partir do 2º abastecimento)  
- **Alarme vencido** quando quilometragem atual − última manutenção ≥ intervalo

## Alarmes

Na aba **Alarmes**, use **+ Novo alarme** para cadastrar. **Editar** altera nome e intervalos; **Marcar como feito** atualiza a km da última manutenção para a do último abastecimento.
