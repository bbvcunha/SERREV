const LOCALE = 'pt-BR';

const DEFAULT_MAINTENANCE = [
  { id: 'oil', label: 'Óleo do motor', intervalKm: 10000, lastServiceKm: 0 },
  { id: 'tires', label: 'Pneus', intervalKm: 40000, lastServiceKm: 0 },
  { id: 'belt', label: 'Correia (dentada / alternador)', intervalKm: 80000, lastServiceKm: 0 },
  { id: 'filters', label: 'Filtros de ar e cabine', intervalKm: 20000, lastServiceKm: 0 },
  { id: 'brakes', label: 'Freios (fluido / pastilhas)', intervalKm: 30000, lastServiceKm: 0 },
];

let chartInstances = {};
let editingObsId = null;
let editingAlarmId = null;
let editingFillId = null;
let currentScreen = 'entry';
let currentSettingsPanel = 'alarms';

function getFills() {
  return DataStore.fills;
}

function getMaintenance() {
  return DataStore.maintenance.length ? DataStore.maintenance : structuredClone(DEFAULT_MAINTENANCE);
}

async function persistMaintenance(items) {
  DataStore.maintenance = items;
  await DataStore.persist();
}

function formatNumber(n, decimals = 0) {
  return n.toLocaleString(LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString(LOCALE, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatMoney(value) {
  return formatNumber(value, 2);
}

function sortFills(fills) {
  return [...fills].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

function enrichFills(fills) {
  const sorted = sortFills(fills);
  return sorted.map((fill, index) => {
    const pricePerLiter = fill.liters > 0 ? fill.amount / fill.liters : null;
    let consumption = null;
    let distanceKm = null;
    let costPerKm = null;
    let daysSincePrev = null;

    if (index > 0) {
      const prev = sorted[index - 1];
      distanceKm = fill.mileage - prev.mileage;
      const ms = new Date(fill.datetime) - new Date(prev.datetime);
      daysSincePrev = ms / (1000 * 60 * 60 * 24);
      if (distanceKm > 0 && fill.liters > 0) consumption = distanceKm / fill.liters;
      if (distanceKm > 0) costPerKm = fill.amount / distanceKm;
    }

    return { ...fill, pricePerLiter, consumption, distanceKm, costPerKm, daysSincePrev };
  });
}

function computeKpiSummary(enriched) {
  const periods = enriched.filter((r) => r.distanceKm != null && r.distanceKm > 0);
  const intervals = enriched.filter((r) => r.daysSincePrev != null && r.daysSincePrev >= 0);

  const totalKm = periods.reduce((s, r) => s + r.distanceKm, 0);
  const totalLitersPeriods = periods.reduce((s, r) => s + r.liters, 0);
  const periodSpent = periods.reduce((s, r) => s + r.amount, 0);

  const allFills = enriched.filter((r) => r.liters > 0);
  const totalLitersAll = allFills.reduce((s, r) => s + r.liters, 0);
  const totalSpentAll = allFills.reduce((s, r) => s + r.amount, 0);

  const avgConsumption = totalLitersPeriods > 0 ? totalKm / totalLitersPeriods : null;
  const avgCostPerKm = totalKm > 0 ? periodSpent / totalKm : null;
  const avgDaysBetween =
    intervals.length > 0
      ? intervals.reduce((s, r) => s + r.daysSincePrev, 0) / intervals.length
      : null;
  const avgKmBetween = periods.length > 0 ? totalKm / periods.length : null;

  const avgPricePerLiter =
    allFills.length > 0
      ? allFills.reduce((s, r) => s + r.pricePerLiter, 0) / allFills.length
      : null;
  const costPerLiter = totalLitersAll > 0 ? totalSpentAll / totalLitersAll : null;

  return {
    avgConsumption,
    avgCostPerKm,
    avgPricePerLiter,
    costPerLiter,
    avgDaysBetween,
    avgKmBetween,
    fillCount: enriched.length,
    periodCount: periods.length,
  };
}

function renderKpiSummary(summary) {
  const el = document.getElementById('kpi-summary');
  if (!summary.fillCount) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = `
    <div class="kpi-card">
      <span class="kpi-label">Consumo médio</span>
      <strong class="kpi-value">${summary.avgConsumption != null ? formatNumber(summary.avgConsumption, 2) + ' km/L' : '—'}</strong>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Custo por km</span>
      <strong class="kpi-value">${summary.avgCostPerKm != null ? 'R$ ' + formatNumber(summary.avgCostPerKm, 3) + '/km' : '—'}</strong>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Preço médio</span>
      <strong class="kpi-value">${summary.avgPricePerLiter != null ? 'R$ ' + formatNumber(summary.avgPricePerLiter, 3) + '/L' : '—'}</strong>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Custo / litro</span>
      <strong class="kpi-value">${summary.costPerLiter != null ? 'R$ ' + formatNumber(summary.costPerLiter, 3) + '/L' : '—'}</strong>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Intervalo médio</span>
      <strong class="kpi-value">${
        summary.avgDaysBetween != null
          ? formatNumber(summary.avgDaysBetween, 1) + ' dias · ' + formatNumber(summary.avgKmBetween) + ' km'
          : '—'
      }</strong>
    </div>`;
}

function latestMileage(fills) {
  if (!fills.length) return 0;
  return sortFills(fills).at(-1).mileage;
}

function initDatetimeInput(input) {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  input.value = now.toISOString().slice(0, 16);
}

function updateSyncStatus() {
  const el = document.getElementById('sync-status');
  const { cloudEnabled, cloudReady, syncing, lastSyncedAt } = DataStore;

  if (syncing) {
    el.textContent = 'Sincronizando…';
    el.className = 'sync-status syncing';
    return;
  }
  if (cloudEnabled && cloudReady) {
    const t = lastSyncedAt
      ? lastSyncedAt.toLocaleString(LOCALE, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
      : 'agora';
    el.textContent = `Planilha ativa · ${getFills().length} registros · ${t}`;
    el.className = 'sync-status ok';
    return;
  }
  if (cloudEnabled && !cloudReady) {
    el.textContent = 'Conectando à planilha…';
    el.className = 'sync-status warn';
    return;
  }
  el.textContent = `Salvo neste aparelho · ${getFills().length} registros · configure a planilha em Conta`;
  el.className = 'sync-status local';
}

function updateCloudBanner() {
  const banner = document.getElementById('cloud-banner');
  if (DataStore.cloudEnabled && DataStore.cloudReady) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  if (!DataStore.isSheetsConfigured()) {
    banner.innerHTML =
      '<strong>Planilha não configurada.</strong> Siga <code>SETUP-PLANILHA.md</code> (Google Sheets no seu Drive, ~10 min). Enquanto isso, use <strong>Exportar/Importar backup</strong>.';
  } else {
    banner.textContent = 'Conectando à planilha… Verifique a URL do script e sua internet.';
  }

  const linkWrap = document.getElementById('sheet-link-wrap');
  const link = document.getElementById('sheet-link');
  const url = DataStore.spreadsheetUrl || DataStore.getSheetsConfig().spreadsheetUrl;
  if (url && DataStore.cloudReady) {
    link.href = url;
    linkWrap.classList.remove('hidden');
  } else {
    linkWrap.classList.add('hidden');
  }
}

function refreshUI() {
  updateSyncStatus();
  updateCloudBanner();
  document.getElementById('sync-code-display').value = DataStore.syncId || '';

  if (currentScreen === 'entry') renderEntryAlerts();
  if (currentScreen === 'table') renderTable();
  if (currentScreen === 'charts') renderCharts();
  if (currentScreen === 'settings' && currentSettingsPanel === 'alarms') renderAlarmsScreen();
  if (currentScreen === 'settings' && currentSettingsPanel === 'account') updateCloudBanner();
}

function switchSettingsPanel(panel) {
  currentSettingsPanel = panel;
  document.querySelectorAll('.subnav-btn').forEach((btn) => {
    const on = btn.dataset.settingsPanel === panel;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.settings-panel').forEach((el) => {
    el.classList.toggle('active', el.id === `settings-panel-${panel}`);
  });
  if (panel === 'alarms') renderAlarmsScreen();
  if (panel === 'account') updateCloudBanner();
}

function switchScreen(name, settingsPanel) {
  currentScreen = name;
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.screen === name);
    el.setAttribute('aria-selected', el.dataset.screen === name ? 'true' : 'false');
  });
  document.getElementById(`screen-${name}`).classList.add('active');
  if (name === 'settings') switchSettingsPanel(settingsPanel || currentSettingsPanel);
  refreshUI();
}

function computeAlarmStatus(item, currentKm) {
  const kmSince = currentKm - (item.lastServiceKm || 0);
  const remaining = (item.intervalKm || 0) - kmSince;
  return {
    ...item,
    kmSince,
    remaining,
    kmOver: remaining < 0 ? Math.abs(remaining) : 0,
    due: item.intervalKm > 0 && currentKm > 0 && remaining <= 0,
  };
}

function getDueMaintenance(maintenance, currentKm) {
  return maintenance.map((item) => computeAlarmStatus(item, currentKm)).filter((i) => i.due);
}

function renderEntryAlerts() {
  const fills = getFills();
  const maintenance = getMaintenance();
  const mileage = latestMileage(fills);
  const panel = document.getElementById('entry-alerts');
  const due = getDueMaintenance(maintenance, mileage);

  if (!due.length) {
    panel.innerHTML = '';
    return;
  }

  panel.innerHTML =
    '<p class="hint" style="margin-bottom:0.5rem">Manutenções em atraso:</p>' +
    due
      .map(
        (d) =>
          `<div class="alert warning"><span>⚠</span><span><strong>${escapeHtml(d.label)}</strong> — vencido (${formatNumber(d.kmOver)} km). <a href="#" class="link-alarms" data-goto-alarms>Config → Alarmes</a></span></div>`
      )
      .join('');
}

function renderTable() {
  const fills = enrichFills(getFills());
  const tbody = document.getElementById('data-tbody');
  const empty = document.getElementById('table-empty');

  if (!fills.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  tbody.innerHTML = fills
    .map((row) => {
      const price = row.pricePerLiter != null ? `R$ ${formatNumber(row.pricePerLiter, 3)}` : '—';
      const cons = row.consumption != null ? formatNumber(row.consumption, 2) : '—';
      const costKm = row.costPerKm != null ? `R$ ${formatNumber(row.costPerKm, 3)}` : '—';
      const obsLabel = row.obs?.trim() ? row.obs.trim() : 'Adicionar…';
      const obsClass = row.obs?.trim() ? 'has-note' : '';

      return `<tr data-id="${row.id}">
        <td>${formatDateTime(row.datetime)}</td>
        <td>${formatNumber(row.mileage)}</td>
        <td>${formatNumber(row.liters, 2)}</td>
        <td>R$ ${formatMoney(row.amount)}</td>
        <td>${price}</td>
        <td>${cons}</td>
        <td>${costKm}</td>
        <td class="obs-cell col-end">
          <button type="button" class="btn obs ${obsClass}" data-obs-id="${row.id}" title="Editar observação">${escapeHtml(obsLabel)}</button>
        </td>
        <td class="col-end row-actions">
          <button type="button" class="btn-icon" data-edit-fill="${row.id}" title="Editar">✎</button>
          <button type="button" class="btn-icon" data-delete-id="${row.id}" title="Excluir">×</button>
        </td>
      </tr>`;
    })
    .join('');
}

function renderAlarmsScreen() {
  const maintenance = getMaintenance();
  const mileage = latestMileage(getFills());
  const summaryEl = document.getElementById('alarms-summary');
  const mileageEl = document.getElementById('alarms-mileage');
  const listEl = document.getElementById('alarms-list');
  const emptyEl = document.getElementById('alarms-empty');
  const due = getDueMaintenance(maintenance, mileage);

  mileageEl.textContent =
    mileage > 0
      ? `Quilometragem atual (último abastecimento): ${formatNumber(mileage)} km`
      : 'Cadastre um abastecimento para calcular os alarmes pela quilometragem.';

  if (!maintenance.length) {
    summaryEl.innerHTML = '';
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');

  if (!mileage) {
    summaryEl.innerHTML =
      '<div class="alert ok">Configure os alarmes abaixo. Eles serão comparados à quilometragem do último abastecimento.</div>';
  } else if (!due.length) {
    summaryEl.innerHTML = `<div class="alert ok">Nenhum alarme vencido na quilometragem atual (${formatNumber(mileage)} km).</div>`;
  } else {
    summaryEl.innerHTML = due
      .map(
        (d) =>
          `<div class="alert warning"><strong>${escapeHtml(d.label)}</strong> está vencido (${formatNumber(d.kmOver)} km além do intervalo programado).</div>`
      )
      .join('');
  }

  listEl.innerHTML = maintenance
    .map((item) => {
      const status = computeAlarmStatus(item, mileage);
      const statusClass = status.due ? 'due' : '';
      let statusText;
      if (!mileage) statusText = 'Aguardando abastecimento para calcular.';
      else if (status.due) statusText = `Vencido — ${formatNumber(status.kmOver)} km além do intervalo`;
      else statusText = `Faltam ${formatNumber(status.remaining)} km para a próxima manutenção`;

      return `
        <article class="card alarm-card ${status.due ? 'alarm-due' : ''}" data-alarm-id="${item.id}">
          <div class="alarm-card-head">
            <h3>${escapeHtml(item.label)}</h3>
            <div class="alarm-actions">
              <button type="button" class="btn secondary btn-sm" data-edit-alarm="${item.id}">Editar</button>
              <button type="button" class="btn danger-outline btn-sm" data-delete-alarm="${item.id}">Excluir</button>
            </div>
          </div>
          <dl class="alarm-details">
            <div><dt>Intervalo</dt><dd>${formatNumber(item.intervalKm)} km</dd></div>
            <div><dt>Última manutenção</dt><dd>${formatNumber(item.lastServiceKm)} km</dd></div>
          </dl>
          <p class="maint-status ${statusClass}">${statusText}</p>
          <button type="button" class="btn secondary btn-sm btn-mark-done" data-mark-done="${item.id}" ${!mileage ? 'disabled' : ''}>
            Marcar como feito agora (${mileage ? formatNumber(mileage) : '—'} km)
          </button>
        </article>`;
    })
    .join('');
}

function destroyCharts() {
  Object.values(chartInstances).forEach((c) => c.destroy());
  chartInstances = {};
}

function renderCharts() {
  const enriched = enrichFills(getFills());
  const emptyEl = document.getElementById('charts-empty');
  const periods = enriched.filter((r) => r.distanceKm != null && r.distanceKm > 0);

  destroyCharts();
  renderKpiSummary(computeKpiSummary(enriched));

  if (enriched.length < 2 || !periods.length) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  const periodLabels = periods.map((r) => formatDateTime(r.datetime));
  let cumulativeSpent = 0;
  const spentCumulative = enriched.map((r) => {
    cumulativeSpent += r.amount;
    return cumulativeSpent;
  });
  const spentLabels = enriched.map((r) => formatDateTime(r.datetime));
  const intervals = periods.filter((r) => r.daysSincePrev != null);

  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: true,
    plugins: { legend: { display: true, labels: { color: '#8b9cb3', boxWidth: 12 } } },
    scales: {
      x: { ticks: { color: '#8b9cb3', maxRotation: 45, font: { size: 10 } }, grid: { color: 'rgba(45,58,79,0.5)' } },
      y: { ticks: { color: '#8b9cb3' }, grid: { color: 'rgba(45,58,79,0.5)' } },
    },
  };

  const avgConsumption = computeKpiSummary(enriched).avgConsumption;

  chartInstances.consumption = new Chart(document.getElementById('chart-consumption'), {
    type: 'line',
    data: {
      labels: periodLabels,
      datasets: [
        {
          label: 'Consumo (km/L)',
          data: periods.map((r) => r.consumption),
          borderColor: '#3d9eff',
          backgroundColor: 'rgba(61,158,255,0.15)',
          fill: true,
          tension: 0.2,
        },
        ...(avgConsumption != null
          ? [{
              label: 'Média geral',
              data: periods.map(() => avgConsumption),
              borderColor: '#8b9cb3',
              borderDash: [6, 4],
              pointRadius: 0,
              fill: false,
            }]
          : []),
      ],
    },
    options: {
      ...chartDefaults,
      plugins: { ...chartDefaults.plugins, legend: { display: avgConsumption != null } },
      scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, title: { display: true, text: 'km/L', color: '#8b9cb3' } } },
    },
  });

  chartInstances.costKm = new Chart(document.getElementById('chart-cost-km'), {
    type: 'line',
    data: {
      labels: periodLabels,
      datasets: [{
        label: 'R$/km',
        data: periods.map((r) => r.costPerKm),
        borderColor: '#f5b942',
        backgroundColor: 'rgba(245,185,66,0.12)',
        fill: true,
        tension: 0.2,
      }],
    },
    options: {
      ...chartDefaults,
      plugins: { legend: { display: false } },
      scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, title: { display: true, text: 'R$/km', color: '#8b9cb3' } } },
    },
  });

  chartInstances.distance = new Chart(document.getElementById('chart-distance'), {
    type: 'bar',
    data: {
      labels: periodLabels,
      datasets: [{
        label: 'Km no período',
        data: periods.map((r) => r.distanceKm),
        backgroundColor: 'rgba(61,214,140,0.55)',
        borderColor: '#3dd68c',
        borderWidth: 1,
      }],
    },
    options: {
      ...chartDefaults,
      plugins: { legend: { display: false } },
      scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, title: { display: true, text: 'km', color: '#8b9cb3' } } },
    },
  });

  chartInstances.spent = new Chart(document.getElementById('chart-spent'), {
    type: 'line',
    data: {
      labels: spentLabels,
      datasets: [{
        label: 'Gasto acumulado',
        data: spentCumulative,
        borderColor: '#f07178',
        backgroundColor: 'rgba(240,113,120,0.2)',
        fill: true,
        tension: 0.2,
      }],
    },
    options: {
      ...chartDefaults,
      plugins: { legend: { display: false } },
      scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, title: { display: true, text: 'R$', color: '#8b9cb3' } } },
    },
  });

  chartInstances.interval = new Chart(document.getElementById('chart-interval'), {
    type: 'bar',
    data: {
      labels: intervals.map((r) => formatDateTime(r.datetime)),
      datasets: [
        {
          label: 'Dias',
          data: intervals.map((r) => r.daysSincePrev),
          backgroundColor: 'rgba(61,158,255,0.5)',
          borderColor: '#3d9eff',
          borderWidth: 1,
          yAxisID: 'y',
        },
        {
          label: 'Km',
          data: intervals.map((r) => r.distanceKm),
          backgroundColor: 'rgba(61,214,140,0.45)',
          borderColor: '#3dd68c',
          borderWidth: 1,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: { legend: { labels: { color: '#8b9cb3' } } },
      scales: {
        x: { ticks: { color: '#8b9cb3', maxRotation: 45, font: { size: 10 } }, grid: { color: 'rgba(45,58,79,0.5)' } },
        y: {
          type: 'linear',
          position: 'left',
          title: { display: true, text: 'dias', color: '#8b9cb3' },
          ticks: { color: '#8b9cb3' },
          grid: { color: 'rgba(45,58,79,0.5)' },
        },
        y1: {
          type: 'linear',
          position: 'right',
          title: { display: true, text: 'km', color: '#8b9cb3' },
          ticks: { color: '#8b9cb3' },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const OBS_TAGS = [
  { id: 'trip', emoji: '🚙', label: 'Viagem longa' },
  { id: 'maint', emoji: '🛠️', label: 'Manutenção' },
  { id: 'warn', emoji: '⚠️', label: 'Atenção' },
];

function parseObs(obs) {
  let text = (obs || '').trim();
  const selected = new Set();
  for (const tag of OBS_TAGS) {
    if (text.includes(tag.emoji)) {
      selected.add(tag.id);
      text = text.split(tag.emoji).join(' ');
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return { selected, text };
}

function buildObs(selectedIds, freeText) {
  const emojis = OBS_TAGS.filter((t) => selectedIds.has(t.id)).map((t) => t.emoji);
  const note = (freeText || '').trim();
  return [...emojis, note].filter(Boolean).join(' ');
}

function setObsTagSelection(selected) {
  document.querySelectorAll('.obs-tag').forEach((btn) => {
    const on = selected.has(btn.dataset.obsTag);
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function getObsTagSelection() {
  const selected = new Set();
  document.querySelectorAll('.obs-tag.active').forEach((btn) => {
    selected.add(btn.dataset.obsTag);
  });
  return selected;
}

function resetObsDialog() {
  setObsTagSelection(new Set());
  document.getElementById('obs-text').value = '';
}

function openObsDialog(id) {
  const fill = getFills().find((f) => f.id === id);
  if (!fill) return;
  editingObsId = id;
  const parsed = parseObs(fill.obs);
  document.getElementById('obs-meta').textContent = `${formatDateTime(fill.datetime)} — ${formatNumber(fill.mileage)} km`;
  setObsTagSelection(parsed.selected);
  document.getElementById('obs-text').value = parsed.text;
  document.getElementById('obs-dialog').showModal();
}

async function saveObs() {
  if (!editingObsId) return;
  const idx = DataStore.fills.findIndex((f) => f.id === editingObsId);
  if (idx === -1) return;
  const obs = buildObs(getObsTagSelection(), document.getElementById('obs-text').value);
  DataStore.fills[idx].obs = obs;
  await DataStore.persist();
  editingObsId = null;
  renderTable();
}

function openFillDialog(id = null) {
  editingFillId = id;
  const title = document.getElementById('fill-dialog-title');
  const dt = document.getElementById('fill-datetime');
  const km = document.getElementById('fill-mileage');
  const L = document.getElementById('fill-liters');
  const amt = document.getElementById('fill-amount');

  if (id) {
    const fill = getFills().find((f) => f.id === id);
    if (!fill) return;
    title.textContent = 'Editar abastecimento';
    const d = new Date(fill.datetime);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    dt.value = d.toISOString().slice(0, 16);
    km.value = fill.mileage;
    L.value = fill.liters;
    amt.value = fill.amount;
  } else {
    title.textContent = 'Adicionar ao histórico';
    initDatetimeInput(dt);
    km.value = '';
    L.value = '';
    amt.value = '';
  }

  document.getElementById('fill-dialog').showModal();
}

async function saveFillFromDialog() {
  const datetime = document.getElementById('fill-datetime').value;
  const mileage = parseFloat(document.getElementById('fill-mileage').value);
  const liters = parseFloat(document.getElementById('fill-liters').value);
  const amount = parseFloat(document.getElementById('fill-amount').value);

  if (mileage < 0 || liters <= 0 || amount <= 0) {
    alert('Verifique a quilometragem, os litros e o valor pago.');
    return false;
  }

  const record = {
    id: editingFillId || crypto.randomUUID(),
    datetime: new Date(datetime).toISOString(),
    mileage,
    liters,
    amount,
    obs: editingFillId ? getFills().find((f) => f.id === editingFillId)?.obs || '' : '',
  };

  if (editingFillId) {
    const idx = DataStore.fills.findIndex((f) => f.id === editingFillId);
    if (idx !== -1) DataStore.fills[idx] = record;
  } else {
    DataStore.fills.push(record);
  }

  try {
    await DataStore.persist();
    editingFillId = null;
    refreshUI();
    return true;
  } catch (e) {
    alert(e.message || 'Erro ao salvar.');
    return false;
  }
}

function openAlarmDialog(id = null) {
  editingAlarmId = id;
  const title = document.getElementById('alarm-dialog-title');
  const labelInput = document.getElementById('alarm-label');
  const intervalInput = document.getElementById('alarm-interval');
  const lastInput = document.getElementById('alarm-last-service');

  if (id) {
    const item = getMaintenance().find((a) => a.id === id);
    if (!item) return;
    title.textContent = 'Editar alarme';
    labelInput.value = item.label;
    intervalInput.value = item.intervalKm;
    lastInput.value = item.lastServiceKm;
  } else {
    title.textContent = 'Novo alarme';
    labelInput.value = '';
    intervalInput.value = '';
    lastInput.value = '0';
  }

  document.getElementById('alarm-dialog').showModal();
  labelInput.focus();
}

async function saveAlarmFromForm() {
  const label = document.getElementById('alarm-label').value.trim();
  const intervalKm = parseFloat(document.getElementById('alarm-interval').value);
  const lastServiceKm = parseFloat(document.getElementById('alarm-last-service').value);

  if (!label) { alert('Informe o nome do alarme.'); return false; }
  if (!intervalKm || intervalKm < 100) { alert('O intervalo deve ser de pelo menos 100 km.'); return false; }
  if (lastServiceKm < 0 || Number.isNaN(lastServiceKm)) { alert('Informe a quilometragem da última manutenção.'); return false; }

  const items = [...getMaintenance()];

  if (editingAlarmId) {
    const idx = items.findIndex((a) => a.id === editingAlarmId);
    if (idx === -1) return false;
    items[idx] = { ...items[idx], label, intervalKm, lastServiceKm };
  } else {
    items.push({ id: crypto.randomUUID(), label, intervalKm, lastServiceKm });
  }

  await persistMaintenance(items);
  editingAlarmId = null;
  refreshUI();
  return true;
}

async function deleteAlarm(id) {
  await persistMaintenance(getMaintenance().filter((a) => a.id !== id));
  refreshUI();
}

async function markAlarmDone(id) {
  const mileage = latestMileage(getFills());
  if (!mileage) {
    alert('Cadastre um abastecimento primeiro para obter a quilometragem atual.');
    return;
  }
  const items = [...getMaintenance()];
  const idx = items.findIndex((a) => a.id === id);
  if (idx === -1) return;
  items[idx].lastServiceKm = mileage;
  await persistMaintenance(items);
  refreshUI();
}

async function saveFillEntry(formEl, isQuickEntry) {
  const datetime = document.getElementById('field-datetime').value;
  const mileage = parseFloat(document.getElementById('field-mileage').value);
  const liters = parseFloat(document.getElementById('field-liters').value);
  const amount = parseFloat(document.getElementById('field-amount').value);

  if (mileage < 0 || liters <= 0 || amount <= 0) {
    alert('Verifique a quilometragem, os litros e o valor pago.');
    return;
  }

  const sorted = sortFills(getFills());
  const last = sorted.at(-1);
  if (last && mileage < last.mileage) {
    if (!confirm('A quilometragem é menor que o registro anterior. Salvar mesmo assim?')) return;
  }

  DataStore.fills.push({
    id: crypto.randomUUID(),
    datetime: new Date(datetime).toISOString(),
    mileage,
    liters,
    amount,
    obs: '',
  });

  try {
    await DataStore.persist();
    formEl.reset();
    initDatetimeInput(document.getElementById('field-datetime'));
    refreshUI();

    const btn = formEl.querySelector('button[type="submit"]');
    const orig = btn.textContent;
    btn.textContent = 'Salvo ✓';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch (e) {
    alert(e.message || 'Erro ao salvar. Tente a aba Conta → Exportar backup.');
  }
}

function exportBackup() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    syncId: DataStore.syncId,
    fills: getFills(),
    maintenance: getMaintenance(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `carro-kpi-backup-${DataStore.syncId || 'local'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importBackup(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (!data.fills || !Array.isArray(data.fills)) throw new Error('Arquivo inválido');

  if (
    getFills().length &&
    !confirm('Importar vai mesclar com os dados atuais. Continuar?')
  ) return;

  DataStore.fills = DataStore.mergeById(getFills(), data.fills);
  if (data.maintenance?.length) {
    DataStore.maintenance = DataStore.mergeById(getMaintenance(), data.maintenance);
  }
  if (data.syncId) DataStore.setSyncId(data.syncId);

  await DataStore.persist();
  refreshUI();
  alert('Backup importado com sucesso.');
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchScreen(tab.dataset.screen));
});

document.querySelectorAll('.subnav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchSettingsPanel(btn.dataset.settingsPanel));
});

document.getElementById('entry-form').addEventListener('submit', (e) => {
  e.preventDefault();
  saveFillEntry(e.target);
});

document.getElementById('btn-add-history').addEventListener('click', () => openFillDialog());

document.getElementById('data-tbody').addEventListener('click', async (e) => {
  const obsBtn = e.target.closest('[data-obs-id]');
  if (obsBtn) { openObsDialog(obsBtn.dataset.obsId); return; }

  const editBtn = e.target.closest('[data-edit-fill]');
  if (editBtn) { openFillDialog(editBtn.dataset.editFill); return; }

  const delBtn = e.target.closest('[data-delete-id]');
  if (delBtn && confirm('Excluir este abastecimento?')) {
    DataStore.fills = getFills().filter((f) => f.id !== delBtn.dataset.deleteId);
    try {
      await DataStore.persist();
      refreshUI();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('obs-tags').addEventListener('click', (e) => {
  const btn = e.target.closest('.obs-tag');
  if (!btn) return;
  btn.classList.toggle('active');
  btn.setAttribute('aria-pressed', btn.classList.contains('active') ? 'true' : 'false');
});

document.getElementById('obs-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveObs();
  document.getElementById('obs-dialog').close();
});

document.getElementById('obs-cancel').addEventListener('click', () => {
  editingObsId = null;
  resetObsDialog();
  document.getElementById('obs-dialog').close();
});

document.getElementById('fill-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await saveFillFromDialog()) document.getElementById('fill-dialog').close();
});

document.getElementById('fill-cancel').addEventListener('click', () => {
  editingFillId = null;
  document.getElementById('fill-dialog').close();
});

document.getElementById('btn-add-alarm').addEventListener('click', () => openAlarmDialog());

document.getElementById('alarm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await saveAlarmFromForm()) document.getElementById('alarm-dialog').close();
});

document.getElementById('alarm-cancel').addEventListener('click', () => {
  editingAlarmId = null;
  document.getElementById('alarm-dialog').close();
});

document.getElementById('alarms-list').addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-edit-alarm]');
  if (editBtn) { openAlarmDialog(editBtn.dataset.editAlarm); return; }
  const delBtn = e.target.closest('[data-delete-alarm]');
  if (delBtn && confirm('Excluir este alarme?')) deleteAlarm(delBtn.dataset.deleteAlarm);
  const markBtn = e.target.closest('[data-mark-done]');
  if (markBtn) markAlarmDone(markBtn.dataset.markDone);
});

document.getElementById('entry-alerts').addEventListener('click', (e) => {
  const link = e.target.closest('[data-goto-alarms]');
  if (link) { e.preventDefault(); switchScreen('settings', 'alarms'); }
});

document.getElementById('btn-copy-sync').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(DataStore.syncId);
    alert('Código copiado!');
  } catch {
    alert(`Seu código: ${DataStore.syncId}`);
  }
});

document.getElementById('btn-connect-sync').addEventListener('click', async () => {
  try {
    const code = document.getElementById('sync-code-input').value;
    if (!confirm('Trocar o código substitui os dados locais pelos da nuvem deste código. Continuar?')) return;
    await DataStore.switchAccount(code);
    document.getElementById('sync-code-input').value = '';
    refreshUI();
    alert('Conectado! Seus dados devem aparecer em instantes.');
  } catch (e) {
    alert(e.message);
  }
});

document.getElementById('btn-sync-now').addEventListener('click', async () => {
  try {
    if (!DataStore.cloudEnabled) {
      alert('Configure a Google Planilha primeiro (veja SETUP-PLANILHA.md).');
      return;
    }
    await DataStore.pullFromCloud();
    refreshUI();
    alert('Sincronizado com a planilha!');
  } catch (e) {
    alert('Falha na sincronização: ' + (e.message || e));
  }
});

document.getElementById('btn-export-data').addEventListener('click', exportBackup);

document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    await importBackup(file);
  } catch (err) {
    alert('Erro ao importar: ' + err.message);
  }
  e.target.value = '';
});

async function bootstrap() {
  DataStore.onChange(() => refreshUI());

  try {
    await DataStore.init();
  } catch (e) {
    console.error(e);
    alert('Erro ao conectar à planilha. Os dados continuam salvos neste aparelho.');
  }

  if (!DataStore.maintenance.length) {
    DataStore.maintenance = structuredClone(DEFAULT_MAINTENANCE);
    try {
      await DataStore.persist();
    } catch { /* ignore */ }
  }

  initDatetimeInput(document.getElementById('field-datetime'));
  refreshUI();
}

bootstrap();
