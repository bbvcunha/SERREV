/**
 * Controle do Carro — backend na planilha Google
 * Instalar: ver SETUP-PLANILHA.md
 */

const ABAS = {
  FILLS: 'Abastecimentos',
  ALARMS: 'Alarmes',
  CONFIG: 'Config',
};

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
    return {
      ok: true,
      fills: lerAbastecimentos_(),
      maintenance: lerAlarmes_(),
      updatedAt: lerConfig_('updatedAt') || '',
      spreadsheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    };
  }

  if (action === 'save') {
    validarSyncId_(syncId, true);
    const fills = JSON.parse(params.fills || '[]');
    const maintenance = JSON.parse(params.maintenance || '[]');
    escreverAbastecimentos_(fills);
    escreverAlarmes_(maintenance);
    definirConfig_('syncId', syncId);
    definirConfig_('updatedAt', new Date().toISOString());
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      spreadsheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    };
  }

  throw new Error('Ação inválida: ' + action);
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

function instalarPlanilha() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error(
      'Abra a planilha no Google Sheets e execute de Extensões → Apps Script (projeto vinculado à planilha).'
    );
  }

  criarAbaSeNaoExiste_(ABAS.CONFIG, ['chave', 'valor']);
  criarAbaSeNaoExiste_(ABAS.FILLS, [
    'id',
    'data_hora',
    'km_total',
    'litros',
    'valor_rs',
    'obs',
  ]);
  criarAbaSeNaoExiste_(ABAS.ALARMS, [
    'id',
    'nome',
    'intervalo_km',
    'intervalo_meses',
    'ultima_manutencao_km',
    'ultima_manutencao_data',
  ]);

  const cfg = ss.getSheetByName(ABAS.CONFIG);
  cfg.getRange('A1:B1').setValues([['chave', 'valor']]);
  cfg.getRange('A2').setValue('syncId');
  cfg.getRange('A3').setValue('updatedAt');

  Logger.log('OK: abas Abastecimentos, Alarmes e Config criadas.');
  try {
    SpreadsheetApp.getUi().alert(
      'Planilha pronta!\n\nPróximo: API_SECRET → Implantar aplicativo da web.'
    );
  } catch (e) {
    Logger.log('Instalação concluída (sem popup de UI).');
  }
}

function criarAbaSeNaoExiste_(nome, cabecalho) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(nome);
  if (!sheet) {
    sheet = ss.insertSheet(nome);
  }
  sheet.getRange(1, 1, 1, cabecalho.length).setValues([cabecalho]);
  sheet.setFrozenRows(1);
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
  const rows = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    out.push({
      id: String(r[0]),
      datetime: String(r[1]),
      mileage: Number(r[2]),
      liters: Number(r[3]),
      amount: Number(r[4]),
      obs: String(r[5] || ''),
    });
  }
  return out;
}

function escreverAbastecimentos_(fills) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ABAS.FILLS);
  const header = [
    'id',
    'data_hora',
    'km_total',
    'litros',
    'valor_rs',
    'obs',
  ];
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
  ]);
  sheet.getRange(2, 1, rows.length + 1, header.length).setValues(rows);
}

function lerAlarmes_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ABAS.ALARMS);
  const rows = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    out.push({
      id: String(r[0]),
      label: String(r[1]),
      intervalKm: Number(r[2]) || 0,
      intervalMonths: Number(r[3]) || 0,
      lastServiceKm: Number(r[4]) || 0,
      lastServiceDate: r[5] ? String(r[5]).slice(0, 10) : '',
    });
  }
  return out;
}

function escreverAlarmes_(items) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ABAS.ALARMS);
  const header = [
    'id',
    'nome',
    'intervalo_km',
    'intervalo_meses',
    'ultima_manutencao_km',
    'ultima_manutencao_data',
  ];
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
    a.lastServiceDate || '',
  ]);
  sheet.getRange(2, 1, rows.length + 1, header.length).setValues(rows);
}
