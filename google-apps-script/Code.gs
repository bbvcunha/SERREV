/**
 * SErreV — backend na planilha Google
 * Instalar: ver SETUP-PLANILHA.md
 */

const ABAS = {
  FILLS: 'Abastecimentos',
  ALARMS: 'Alarmes',
  LOGS: 'Manutencoes',
  CONFIG: 'Config',
};

const API_VERSION = 2;

function doGet(e) {
  return responder(handleRequest(e.parameter || {}));
}

function doPost(e) {
  try {
    const body = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    const params = Object.assign({}, e.parameter || {}, body);
    return responder(handleRequest(params));
  } catch (err) {
    return responder({ ok: false, error: err.message });
  }
}

function responder(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function handleRequest(params) {
  validarSegredo_(params.secret);
  const action = params.action || 'get';
  const syncId = (params.syncId || '').trim().toUpperCase();

  if (!syncId) throw new Error('Código de sincronização ausente.');

  if (action === 'get') {
    validarSyncId_(syncId, false);
    garantirAbas_();
    return {
      ok: true,
      apiVersion: API_VERSION,
      fills: lerAbastecimentos_(),
      maintenance: lerAlarmes_(),
      serviceLogs: lerManutencoes_(),
      updatedAt: lerConfig_('updatedAt') || '',
      spreadsheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    };
  }

  if (action === 'save') {
    validarSyncId_(syncId, true);
    const fills = parseJson_(params.fills, 'abastecimentos');
    const maintenance = parseJson_(params.maintenance, 'alarmes');
    const serviceLogs = parseJson_(params.serviceLogs, 'manutenções');
    garantirAbas_();
    escreverAbastecimentos_(fills);
    escreverAlarmes_(maintenance);
    escreverManutencoes_(serviceLogs);
    definirConfig_('syncId', syncId);
    definirConfig_('updatedAt', new Date().toISOString());
    return {
      ok: true,
      apiVersion: API_VERSION,
      saved: {
        fills: fills.length,
        maintenance: maintenance.length,
        serviceLogs: serviceLogs.length,
      },
      updatedAt: new Date().toISOString(),
      spreadsheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    };
  }

  throw new Error('Ação inválida: ' + action);
}

function parseJson_(raw, label) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('não é uma lista');
    return parsed;
  } catch (err) {
    throw new Error('Dados de ' + label + ' inválidos: ' + err.message);
  }
}

function validarSegredo_(enviado) {
  const esperado = PropertiesService.getScriptProperties().getProperty('API_SECRET');
  if (!esperado) return;
  const a = String(enviado || '').trim();
  const b = String(esperado).trim();
  if (a !== b) {
    throw new Error(
      'Chave de segurança inválida. Confira API_SECRET em Propriedades do script (deve ser igual ao sheets-config.js).'
    );
  }
}

/** Execute no editor para testar se API_SECRET está definida (não exibe o valor). */
function testarConfiguracao() {
  const ok = !!PropertiesService.getScriptProperties().getProperty('API_SECRET');
  Logger.log(ok ? 'API_SECRET: definida' : 'API_SECRET: AUSENTE — adicione nas Propriedades do script');
}

function validarSyncId_(syncId, aoSalvar) {
  const salvo = lerConfig_('syncId');
  if (!salvo) {
    if (aoSalvar) definirConfig_('syncId', syncId);
    return;
  }
  if (salvo !== syncId) {
    throw new Error('Código de sincronização não autorizado nesta planilha.');
  }
}

/**
 * Cria abas faltantes e migra colunas antigas.
 * Execute no editor (sem popup) ou pelo menu da planilha.
 * Não usa alert — no editor o alert bloqueia esperando OK na aba da planilha.
 */
function atualizarPlanilha() {
  instalarPlanilha();
  Logger.log(
    'Atualização concluída. Próximo passo: Implantar → Gerenciar implantações → Nova versão do aplicativo da web.'
  );
}

function CABECALHO_FILLS_() {
  return [
    'id',
    'data_hora',
    'km_total',
    'litros',
    'valor_rs',
    'obs',
    'marcador',
  ];
}

function instalarPlanilha() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error(
      'Abra a planilha no Google Sheets e execute de Extensões → Apps Script (projeto vinculado à planilha).'
    );
  }

  criarAbaSeNaoExiste_(ABAS.CONFIG, ['chave', 'valor']);
  criarAbaSeNaoExiste_(ABAS.FILLS, CABECALHO_FILLS_());
  criarAbaSeNaoExiste_(ABAS.ALARMS, CABECALHO_ALARMS_());
  criarAbaSeNaoExiste_(ABAS.LOGS, [
    'id',
    'data',
    'local',
    'km',
    'comentarios',
    'realizada',
  ]);

  const cfg = ss.getSheetByName(ABAS.CONFIG);
  cfg.getRange('A1:B1').setValues([['chave', 'valor']]);
  cfg.getRange('A2').setValue('syncId');
  cfg.getRange('A3').setValue('updatedAt');

  migrarAlarmesSeNecessario_();
  migrarAlarmesObservacoes_();
  migrarAbastecimentosMarcador_();

  Logger.log('OK: abas Abastecimentos, Alarmes, Manutencoes e Config criadas.');
}

function CABECALHO_ALARMS_() {
  return [
    'id',
    'nome',
    'intervalo_km',
    'intervalo_meses',
    'ultima_manutencao_km',
    'ultima_manutencao_data',
    'observacoes',
  ];
}

function garantirAbas_() {
  instalarPlanilha();
}

function migrarAlarmesSeNecessario_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ABAS.ALARMS);
  if (!sheet || sheet.getLastRow() < 1) return;

  const rows = sheet.getDataRange().getValues();
  const header = rows[0].map(String);
  if (header.indexOf('intervalo_meses') !== -1) return;

  const novoHeader = CABECALHO_ALARMS_();
  const novasLinhas = [novoHeader];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    novasLinhas.push([
      r[0],
      r[1],
      r[2] || 0,
      0,
      r[3] || 0,
      '',
      '',
    ]);
  }

  sheet.clear();
  escreverLinhas_(sheet, 1, novasLinhas, novoHeader.length);
  sheet.setFrozenRows(1);
  Logger.log('Alarmes migrados para o formato com intervalo_meses e ultima_manutencao_data.');
}

function migrarAlarmesObservacoes_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ABAS.ALARMS);
  if (!sheet || sheet.getLastRow() < 1) return;

  const rows = sheet.getDataRange().getValues();
  const header = rows[0].map(String);
  if (header.indexOf('observacoes') !== -1) return;
  if (header.indexOf('intervalo_meses') === -1) return;

  const novoHeader = CABECALHO_ALARMS_();
  const novasLinhas = [novoHeader];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    novasLinhas.push([
      r[0],
      r[1],
      r[2] || 0,
      r[3] || 0,
      r[4] || 0,
      r[5] || '',
      '',
    ]);
  }

  sheet.clear();
  escreverLinhas_(sheet, 1, novasLinhas, novoHeader.length);
  sheet.setFrozenRows(1);
  Logger.log('Alarmes migrados: coluna observacoes adicionada.');
}

/** Adds marcador (0–20) to Abastecimentos when the sheet was created before that column. */
function migrarAbastecimentosMarcador_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ABAS.FILLS);
  if (!sheet || sheet.getLastRow() < 1) return;

  const rows = sheet.getDataRange().getValues();
  const header = rows[0].map(String);
  if (header.indexOf('marcador') !== -1) return;

  const novoHeader = CABECALHO_FILLS_();
  const novasLinhas = [novoHeader];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    novasLinhas.push([
      r[0],
      r[1],
      r[2],
      r[3],
      r[4],
      r[5] || '',
      20,
    ]);
  }

  sheet.clear();
  escreverLinhas_(sheet, 1, novasLinhas, novoHeader.length);
  sheet.setFrozenRows(1);
  Logger.log('Abastecimentos migrados: coluna marcador adicionada (padrão 20).');
}

function criarAbaSeNaoExiste_(nome, cabecalho) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(nome);
  if (!sheet) {
    sheet = ss.insertSheet(nome);
    sheet.getRange(1, 1, 1, cabecalho.length).setValues([cabecalho]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function obterAba_(nome, cabecalho) {
  const sheet = criarAbaSeNaoExiste_(nome, cabecalho);
  // Ensure header matches when writing a full replace (e.g. empty sheet created earlier).
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, cabecalho.length).setValues([cabecalho]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function lerConfig_(chave) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ABAS.CONFIG);
  if (!sheet) return '';
  const dados = sheet.getDataRange().getValues();
  for (let i = 1; i < dados.length; i++) {
    if (dados[i][0] === chave) return String(dados[i][1] || '');
  }
  return '';
}

function definirConfig_(chave, valor) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ABAS.CONFIG);
  const dados = sheet.getDataRange().getValues();
  for (let i = 1; i < dados.length; i++) {
    if (dados[i][0] === chave) {
      sheet.getRange(i + 1, 2).setValue(valor);
      return;
    }
  }
  sheet.appendRow([chave, valor]);
}

function lerAbastecimentos_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ABAS.FILLS);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];
  const header = rows[0].map(String);
  const idxGauge = header.indexOf('marcador');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    const rawGauge = idxGauge >= 0 ? r[idxGauge] : '';
    out.push({
      id: String(r[0]),
      datetime: String(r[1]),
      mileage: Number(r[2]),
      liters: Number(r[3]),
      amount: Number(r[4]),
      obs: String(r[5] || ''),
      fuelGaugeLevel:
        rawGauge === '' || rawGauge == null ? 20 : Number(rawGauge),
    });
  }
  return out;
}

function escreverAbastecimentos_(fills) {
  const header = CABECALHO_FILLS_();
  const sheet = obterAba_(ABAS.FILLS, header);
  sheet.clear();
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  sheet.setFrozenRows(1);
  if (!fills.length) return;
  const rows = fills.map((f) => [
    f.id,
    f.datetime,
    f.mileage,
    f.liters,
    f.amount,
    f.obs || '',
    f.fuelGaugeLevel != null && f.fuelGaugeLevel !== '' ? Number(f.fuelGaugeLevel) : 20,
  ]);
  escreverLinhas_(sheet, 2, rows, header.length);
}

function lerAlarmes_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ABAS.ALARMS);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];
  const header = rows[0].map(String);
  const formatoNovo = header.indexOf('intervalo_meses') !== -1;
  const out = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;

    const idxObs = header.indexOf('observacoes');

    if (formatoNovo) {
      out.push({
        id: String(r[0]),
        label: String(r[1]),
        intervalKm: Number(r[2]) || 0,
        intervalMonths: Number(r[3]) || 0,
        lastServiceKm: Number(r[4]) || 0,
        lastServiceDate: formatarData_(r[5]),
        notes: idxObs >= 0 ? String(r[idxObs] || '') : '',
      });
    } else {
      out.push({
        id: String(r[0]),
        label: String(r[1]),
        intervalKm: Number(r[2]) || 0,
        intervalMonths: 0,
        lastServiceKm: Number(r[3]) || 0,
        lastServiceDate: '',
      });
    }
  }
  return out;
}

function escreverAlarmes_(items) {
  const header = CABECALHO_ALARMS_();
  const sheet = obterAba_(ABAS.ALARMS, header);
  sheet.clear();
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  sheet.setFrozenRows(1);
  if (!items.length) return;
  const rows = items.map((a) => [
    a.id,
    a.label,
    a.intervalKm || 0,
    a.intervalMonths || 0,
    a.lastServiceKm || 0,
    formatarData_(a.lastServiceDate),
    a.notes || '',
  ]);
  escreverLinhas_(sheet, 2, rows, header.length);
}

function lerManutencoes_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ABAS.LOGS);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    const realizada = r[5];
    out.push({
      id: String(r[0]),
      date: formatarData_(r[1]),
      location: String(r[2] || ''),
      mileage: Number(r[3]) || 0,
      notes: String(r[4] || ''),
      done: realizada === true || String(realizada).toLowerCase() === 'sim' || realizada === 1,
    });
  }
  return out;
}

function escreverManutencoes_(items) {
  const header = ['id', 'data', 'local', 'km', 'comentarios', 'realizada'];
  const sheet = obterAba_(ABAS.LOGS, header);
  sheet.clear();
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  sheet.setFrozenRows(1);
  if (!items.length) return;
  const rows = items.map((m) => [
    m.id,
    formatarData_(m.date),
    m.location || '',
    m.mileage || 0,
    m.notes || '',
    m.done ? 'sim' : 'nao',
  ]);
  escreverLinhas_(sheet, 2, rows, header.length);
}

/** getRange(linha, col, numLinhas, numCols) — 3º argumento é quantidade, não índice final. */
function escreverLinhas_(sheet, startRow, rows, numCols) {
  if (!rows.length) return;
  sheet.getRange(startRow, 1, rows.length, numCols).setValues(rows);
}

function formatarData_(valor) {
  if (!valor) return '';
  if (valor instanceof Date) {
    return Utilities.formatDate(valor, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(valor).slice(0, 10);
}
