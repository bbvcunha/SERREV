const STORAGE_SYNC_ID = 'carKpi_syncId';
const STORAGE_FILLS = 'carKpi_fills';
const STORAGE_MAINT = 'carKpi_maintenance';
const STORAGE_SERVICE_LOGS = 'carKpi_serviceLogs';
const STORAGE_LEGACY_MIGRATED = 'carKpi_cloudMigrated';
const STORAGE_SHEET_URL = 'carKpi_spreadsheetUrl';

const DataStore = {
  fills: [],
  maintenance: [],
  serviceLogs: [],
  syncId: null,
  cloudEnabled: false,
  cloudReady: false,
  cloudProvider: null,
  syncing: false,
  lastSyncedAt: null,
  spreadsheetUrl: null,
  listeners: new Set(),

  notify() {
    this.listeners.forEach((fn) => fn(this.getState()));
  },

  getState() {
    return {
      fills: [...this.fills],
      maintenance: [...this.maintenance],
      serviceLogs: [...this.serviceLogs],
      syncId: this.syncId,
      cloudEnabled: this.cloudEnabled,
      cloudReady: this.cloudReady,
      cloudProvider: this.cloudProvider,
      syncing: this.syncing,
      lastSyncedAt: this.lastSyncedAt,
      spreadsheetUrl: this.spreadsheetUrl,
    };
  },

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },

  isSheetsConfigured() {
    const c = window.SHEETS_CONFIG;
    return !!(c && c.webAppUrl && String(c.webAppUrl).includes('script.google.com'));
  },

  isCloudConfigured() {
    return this.isSheetsConfigured();
  },

  isFirebaseConfigured() {
    return false;
  },

  getSheetsConfig() {
    return window.SHEETS_CONFIG || {};
  },

  localSave() {
    try {
      localStorage.setItem(STORAGE_FILLS, JSON.stringify(this.fills));
      localStorage.setItem(STORAGE_MAINT, JSON.stringify(this.maintenance));
      localStorage.setItem(STORAGE_SERVICE_LOGS, JSON.stringify(this.serviceLogs));
      if (this.syncId) localStorage.setItem(STORAGE_SYNC_ID, this.syncId);
      if (this.spreadsheetUrl) localStorage.setItem(STORAGE_SHEET_URL, this.spreadsheetUrl);
      return true;
    } catch (e) {
      console.error('localStorage', e);
      return false;
    }
  },

  localLoad() {
    try {
      const fillsRaw = localStorage.getItem(STORAGE_FILLS);
      const maintRaw = localStorage.getItem(STORAGE_MAINT);
      const logsRaw = localStorage.getItem(STORAGE_SERVICE_LOGS);
      const syncRaw = localStorage.getItem(STORAGE_SYNC_ID);
      const sheetUrl = localStorage.getItem(STORAGE_SHEET_URL);
      if (fillsRaw) this.fills = JSON.parse(fillsRaw);
      if (maintRaw) this.maintenance = JSON.parse(maintRaw);
      if (logsRaw) this.serviceLogs = JSON.parse(logsRaw);
      if (syncRaw) this.syncId = syncRaw;
      if (sheetUrl) this.spreadsheetUrl = sheetUrl;
      const cfg = this.getSheetsConfig();
      if (cfg.spreadsheetUrl) this.spreadsheetUrl = cfg.spreadsheetUrl;
    } catch (e) {
      console.error('localLoad', e);
    }
  },

  ensureSyncId() {
    if (!this.syncId) {
      this.syncId = this.generateSyncId();
      localStorage.setItem(STORAGE_SYNC_ID, this.syncId);
    }
    return this.syncId;
  },

  generateSyncId() {
    const part = () => Math.random().toString(36).slice(2, 6).toUpperCase();
    return `${part()}-${part()}-${part()}`;
  },

  setSyncId(code) {
    const normalized = (code || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) {
      throw new Error('Código inválido. Use o formato XXXX-XXXX-XXXX');
    }
    this.syncId = normalized;
    localStorage.setItem(STORAGE_SYNC_ID, this.syncId);
    return this.syncId;
  },

  async callSheets(action, extra = {}) {
    const cfg = this.getSheetsConfig();
    const params = new URLSearchParams({
      action,
      syncId: this.syncId,
      secret: cfg.apiSecret || '',
    });

    const url = `${cfg.webAppUrl}${cfg.webAppUrl.includes('?') ? '&' : '?'}${params}`;

    const options = { method: action === 'save' ? 'POST' : 'GET', redirect: 'follow' };

    if (action === 'save') {
      options.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
      options.body = JSON.stringify({
        action: 'save',
        syncId: this.syncId,
        secret: cfg.apiSecret || '',
        fills: JSON.stringify(this.fills),
        maintenance: JSON.stringify(this.maintenance),
        serviceLogs: JSON.stringify(this.serviceLogs),
      });
    }

    const res = await fetch(url, options);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Resposta inválida da planilha. Verifique a URL do Apps Script.');
    }
    if (!data.ok) throw new Error(data.error || 'Erro na planilha');
    return data;
  },

  async init() {
    this.localLoad();
    this.ensureSyncId();

    if (!this.isSheetsConfigured()) {
      this.cloudEnabled = false;
      this.cloudProvider = null;
      this.notify();
      return;
    }

    this.cloudEnabled = true;
    this.cloudProvider = 'sheets';

    try {
      await this.pullFromCloud();
      this.cloudReady = true;
    } catch (e) {
      console.error('Sheets init', e);
      this.cloudReady = false;
    }
    this.notify();
  },

  applyRemoteData(data) {
    const remoteFills = data.fills || [];
    const remoteMaint = data.maintenance || [];
    const remoteLogs = data.serviceLogs || [];
    const localHasData =
      this.fills.length > 0 || this.maintenance.length > 0 || this.serviceLogs.length > 0;
    const remoteHasData =
      remoteFills.length > 0 || remoteMaint.length > 0 || remoteLogs.length > 0;

    if (!localHasData && remoteHasData) {
      this.fills = remoteFills;
      this.maintenance = remoteMaint;
      this.serviceLogs = remoteLogs;
    } else if (localHasData && !remoteHasData) {
      return 'push';
    } else if (localHasData && remoteHasData) {
      const merged = !localStorage.getItem(STORAGE_LEGACY_MIGRATED);
      if (merged) {
        this.fills = this.mergeById(this.fills, remoteFills);
        this.maintenance = this.mergeById(this.maintenance, remoteMaint);
        this.serviceLogs = this.mergeById(this.serviceLogs, remoteLogs);
        localStorage.setItem(STORAGE_LEGACY_MIGRATED, '1');
        return 'push';
      }
      this.fills = remoteFills;
      this.maintenance = remoteMaint;
      this.serviceLogs = remoteLogs;
    }

    if (data.spreadsheetUrl) this.spreadsheetUrl = data.spreadsheetUrl;
    if (data.updatedAt) this.lastSyncedAt = new Date(data.updatedAt);
    return 'done';
  },

  async pullFromCloud() {
    if (!this.cloudEnabled) return;

    const data = await this.callSheets('get');
    const result = this.applyRemoteData(data);

    if (result === 'push') await this.pushToCloud();
    else this.localSave();

    if (data.spreadsheetUrl) {
      this.spreadsheetUrl = data.spreadsheetUrl;
      localStorage.setItem(STORAGE_SHEET_URL, data.spreadsheetUrl);
    }
  },

  mergeById(local, remote) {
    const map = new Map();
    [...remote, ...local].forEach((item) => map.set(item.id, item));
    return [...map.values()];
  },

  async pushToCloud() {
    if (!this.cloudEnabled) return false;

    this.syncing = true;
    this.notify();

    try {
      const data = await this.callSheets('save');
      this.lastSyncedAt = new Date(data.updatedAt || Date.now());
      if (data.spreadsheetUrl) {
        this.spreadsheetUrl = data.spreadsheetUrl;
        localStorage.setItem(STORAGE_SHEET_URL, data.spreadsheetUrl);
      }
      this.localSave();
      return true;
    } finally {
      this.syncing = false;
      this.notify();
    }
  },

  async persist() {
    const ok = this.localSave();
    if (!ok) {
      throw new Error(
        'Não foi possível salvar no dispositivo. Verifique espaço e modo privado do navegador.'
      );
    }

    if (this.cloudEnabled) {
      await this.pushToCloud();
    }
    this.notify();
  },

  async switchAccount(newSyncId) {
    this.setSyncId(newSyncId);
    this.cloudReady = false;
    localStorage.removeItem(STORAGE_LEGACY_MIGRATED);
    await this.init();
  },
};
