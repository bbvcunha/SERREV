const STORAGE_SYNC_ID = 'carKpi_syncId';
const STORAGE_FILLS = 'carKpi_fills';
const STORAGE_MAINT = 'carKpi_maintenance';
const STORAGE_LEGACY_MIGRATED = 'carKpi_cloudMigrated';

const DataStore = {
  fills: [],
  maintenance: [],
  syncId: null,
  cloudEnabled: false,
  cloudReady: false,
  syncing: false,
  lastSyncedAt: null,
  listeners: new Set(),

  notify() {
    this.listeners.forEach((fn) => fn(this.getState()));
  },

  getState() {
    return {
      fills: [...this.fills],
      maintenance: [...this.maintenance],
      syncId: this.syncId,
      cloudEnabled: this.cloudEnabled,
      cloudReady: this.cloudReady,
      syncing: this.syncing,
      lastSyncedAt: this.lastSyncedAt,
    };
  },

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },

  localSave() {
    try {
      localStorage.setItem(STORAGE_FILLS, JSON.stringify(this.fills));
      localStorage.setItem(STORAGE_MAINT, JSON.stringify(this.maintenance));
      if (this.syncId) localStorage.setItem(STORAGE_SYNC_ID, this.syncId);
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
      const syncRaw = localStorage.getItem(STORAGE_SYNC_ID);
      if (fillsRaw) this.fills = JSON.parse(fillsRaw);
      if (maintRaw) this.maintenance = JSON.parse(maintRaw);
      if (syncRaw) this.syncId = syncRaw;
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

  isFirebaseConfigured() {
    const c = window.FIREBASE_CONFIG;
    return !!(c && c.apiKey && c.projectId && !c.apiKey.includes('SUA_'));
  },

  async init() {
    this.localLoad();
    this.ensureSyncId();

    if (!this.isFirebaseConfigured()) {
      this.cloudEnabled = false;
      this.notify();
      return;
    }

    this.cloudEnabled = true;

    if (!firebase.apps.length) {
      firebase.initializeApp(window.FIREBASE_CONFIG);
    }
    this.db = firebase.firestore();
    this.docRef = this.db.collection('cars').doc(this.syncId);

    this.unsubscribe = this.docRef.onSnapshot(
      (snap) => {
        if (!snap.exists) return;
        const data = snap.data();
        if (data.fills) this.fills = data.fills;
        if (data.maintenance) this.maintenance = data.maintenance;
        this.lastSyncedAt = data.updatedAt?.toDate?.() || new Date();
        this.localSave();
        this.cloudReady = true;
        this.syncing = false;
        this.notify();
      },
      (err) => {
        console.error('Firestore snapshot', err);
        this.cloudReady = false;
        this.syncing = false;
        this.notify();
      }
    );

    await this.pullFromCloud();
    this.cloudReady = true;
    this.notify();
  },

  async pullFromCloud() {
    if (!this.cloudEnabled || !this.docRef) return;

    const snap = await this.docRef.get();
    if (!snap.exists) {
      if (this.fills.length || this.maintenance.length) {
        await this.pushToCloud();
      }
      return;
    }

    const data = snap.data();
    const remoteFills = data.fills || [];
    const remoteMaint = data.maintenance || [];
    const localHasData = this.fills.length > 0 || this.maintenance.length > 0;
    const remoteHasData = remoteFills.length > 0 || remoteMaint.length > 0;

    if (!localHasData && remoteHasData) {
      this.fills = remoteFills;
      this.maintenance = remoteMaint;
    } else if (localHasData && !remoteHasData) {
      await this.pushToCloud();
    } else if (localHasData && remoteHasData) {
      const localUpdated = localStorage.getItem(STORAGE_LEGACY_MIGRATED);
      if (!localUpdated) {
        this.fills = this.mergeById(this.fills, remoteFills);
        this.maintenance = this.mergeById(this.maintenance, remoteMaint);
        localStorage.setItem(STORAGE_LEGACY_MIGRATED, '1');
        await this.pushToCloud();
      } else {
        this.fills = remoteFills;
        this.maintenance = remoteMaint;
      }
    }

    this.localSave();
    this.lastSyncedAt = data.updatedAt?.toDate?.() || new Date();
  },

  mergeById(local, remote) {
    const map = new Map();
    [...remote, ...local].forEach((item) => map.set(item.id, item));
    return [...map.values()];
  },

  async pushToCloud() {
    if (!this.cloudEnabled || !this.docRef) return false;

    this.syncing = true;
    this.notify();

    try {
      await this.docRef.set({
        fills: this.fills,
        maintenance: this.maintenance,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      this.lastSyncedAt = new Date();
      return true;
    } catch (e) {
      console.error('pushToCloud', e);
      throw e;
    } finally {
      this.syncing = false;
      this.notify();
    }
  },

  async persist() {
    const ok = this.localSave();
    if (!ok) throw new Error('Não foi possível salvar no dispositivo. Verifique espaço e modo privado do navegador.');

    if (this.cloudEnabled && this.docRef) {
      await this.pushToCloud();
    }
    this.notify();
  },

  async switchAccount(newSyncId) {
    if (this.unsubscribe) this.unsubscribe();
    this.setSyncId(newSyncId);
    this.cloudReady = false;
    await this.init();
  },

  async createNewAccount() {
    if (this.unsubscribe) this.unsubscribe();
    this.syncId = this.generateSyncId();
    localStorage.setItem(STORAGE_SYNC_ID, this.syncId);
    this.fills = [];
    this.maintenance = [];
    localStorage.removeItem(STORAGE_LEGACY_MIGRATED);
    await this.init();
    await this.persist();
  },
};
