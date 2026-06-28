const LOCALE = 'pt-BR';

const DEFAULT_MAINTENANCE = [
  { id: 'oil', label: 'Óleo do motor', intervalKm: 10000, intervalMonths: 12, lastServiceKm: 0, lastServiceDate: '' },
  { id: 'tires', label: 'Pneus', intervalKm: 40000, intervalMonths: 0, lastServiceKm: 0, lastServiceDate: '' },
  { id: 'belt', label: 'Correia (dentada / alternador)', intervalKm: 80000, intervalMonths: 0, lastServiceKm: 0, lastServiceDate: '' },
  { id: 'filters', label: 'Filtros de ar e cabine', intervalKm: 20000, intervalMonths: 12, lastServiceKm: 0, lastServiceDate: '' },
  { id: 'brakes', label: 'Freios (fluido / pastilhas)', intervalKm: 30000, intervalMonths: 24, lastServiceKm: 0, lastServiceDate: '' },
];

let chartInstances = {};
let editingObsId = null;
let editingAlarmId = null;
let editingFillId = null;
let currentScreen = 'entry';
let editingServiceId = null;
let currentServiceFilter = 'pending';

function getFills() {
  return DataStore.fills;
}

function getMaintenance() {
  return DataStore.maintenance;
}

async function persistMaintenance(items) {
  DataStore.maintenance = items;
  await DataStore.persist();
}

function getServiceLogs() {
  return DataStore.serviceLogs || [];
}

async function persistServiceLogs(logs) {
  DataStore.serviceLogs = logs;
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

function monthKeyFromDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonthKey(key) {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(LOCALE, {
    month: 'short',
    year: '2-digit',
  });
}

function monthKeysBetween(fromKey, toKey) {
  const [fromYear, fromMonth] = fromKey.split('-').map(Number);
  const [toYear, toMonth] = toKey.split('-').map(Number);
  const keys = [];
  let year = fromYear;
  let month = fromMonth;
  while (year < toYear || (year === toYear && month <= toMonth)) {
    keys.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return keys;
}

// Rateia os km do intervalo entre abastecimentos proporcionalmente aos dias de cada mês.
function allocateDistanceKmToMonths(prevDatetime, fillDatetime, distanceKm) {
  const start = new Date(prevDatetime);
  const end = new Date(fillDatetime);
  if (distanceKm <= 0) return [];
  if (end <= start) return [{ key: monthKeyFromDate(end), km: distanceKm }];

  const totalMs = end - start;
  const allocations = [];
  let segmentStart = start;

  while (segmentStart < end) {
    const year = segmentStart.getFullYear();
    const month = segmentStart.getMonth();
    const nextMonth = new Date(year, month + 1, 1);
    const segmentEnd = nextMonth < end ? nextMonth : end;
    const segmentMs = segmentEnd - segmentStart;
    allocations.push({
      key: `${year}-${String(month + 1).padStart(2, '0')}`,
      km: distanceKm * (segmentMs / totalMs),
    });
    segmentStart = segmentEnd;
  }

  return allocations;
}

function buildMonthlyKmTotals(enriched) {
  const totals = new Map();

  enriched.forEach((fill, index) => {
    if (index === 0 || fill.distanceKm == null || fill.distanceKm <= 0) return;
    const prev = enriched[index - 1];
    for (const { key, km } of allocateDistanceKmToMonths(prev.datetime, fill.datetime, fill.distanceKm)) {
      totals.set(key, (totals.get(key) || 0) + km);
    }
  });

  if (totals.size === 0) return { labels: [], values: [] };

  const sortedKeys = [...totals.keys()].sort();
  const monthKeys = monthKeysBetween(sortedKeys[0], sortedKeys.at(-1));

  return {
    labels: monthKeys.map(formatMonthKey),
    values: monthKeys.map((key) => Math.round(totals.get(key) || 0)),
  };
}

function computeAlignedAxisLimit(maxValue) {
  if (maxValue <= 0) return { min: 0, max: 1000, stepSize: 250 };
  const padded = maxValue * 1.08;
  const exp = 10 ** Math.floor(Math.log10(padded));
  const fraction = padded / exp;
  let niceMax;
  if (fraction <= 1) niceMax = exp;
  else if (fraction <= 2) niceMax = 2 * exp;
  else if (fraction <= 5) niceMax = 5 * exp;
  else niceMax = 10 * exp;
  return { min: 0, max: niceMax, stepSize: niceMax / 4 };
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

  const lastFill = enriched.length ? enriched[enriched.length - 1] : null;
  const daysSinceLast = lastFill
    ? (Date.now() - new Date(lastFill.datetime)) / (1000 * 60 * 60 * 24)
    : null;

  return {
    avgConsumption,
    avgCostPerKm,
    avgPricePerLiter,
    costPerLiter,
    avgDaysBetween,
    avgKmBetween,
    daysSinceLast,
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
      <span class="kpi-label">Intervalo médio (dias)</span>
      <strong class="kpi-value">${summary.avgDaysBetween != null ? formatNumber(summary.avgDaysBetween, 1) + ' dias' : '—'}</strong>
      ${
        summary.daysSinceLast != null
          ? `<span class="kpi-sub">há ${formatNumber(summary.daysSinceLast, 0)} dia(s) desde o último</span>`
          : ''
      }
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Intervalo médio (km)</span>
      <strong class="kpi-value">${summary.avgKmBetween != null ? formatNumber(summary.avgKmBetween) + ' km' : '—'}</strong>
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
  if (currentScreen === 'services') renderServicesScreen();
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

function normalizeAlarm(item) {
  return {
    ...item,
    intervalKm: Number(item.intervalKm) || 0,
    intervalMonths: Number(item.intervalMonths) || 0,
    lastServiceKm: Number(item.lastServiceKm) || 0,
    lastServiceDate: item.lastServiceDate || '',
    notes: item.notes || '',
  };
}

function addMonthsToDate(iso, months) {
  const d = new Date(`${iso}T12:00:00`);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d;
}

function formatMonthsInterval(months) {
  if (!months) return '';
  if (months === 12) return '1 ano';
  if (months % 12 === 0) {
    const y = months / 12;
    return `${y} ${y === 1 ? 'ano' : 'anos'}`;
  }
  if (months > 12) {
    const y = Math.floor(months / 12);
    const m = months % 12;
    return m ? `${y} ${y === 1 ? 'ano' : 'anos'} e ${m} meses` : `${y} anos`;
  }
  return `${months} ${months === 1 ? 'mês' : 'meses'}`;
}

function formatDateShort(iso) {
  if (!iso) return '';
  return new Date(`${iso}T12:00:00`).toLocaleDateString(LOCALE);
}

function formatTimeRemaining(days) {
  const d = Math.max(0, Math.ceil(days));
  if (d >= 365) {
    const y = Math.floor(d / 365);
    const rest = Math.floor((d % 365) / 30);
    return rest ? `${y} ${y === 1 ? 'ano' : 'anos'} e ${rest} meses` : `${y} ${y === 1 ? 'ano' : 'anos'}`;
  }
  if (d >= 30) {
    const m = Math.round(d / 30);
    return `${m} ${m === 1 ? 'mês' : 'meses'}`;
  }
  return `${d} ${d === 1 ? 'dia' : 'dias'}`;
}

function formatAlarmInterval(item) {
  const a = normalizeAlarm(item);
  const parts = [];
  if (a.intervalKm > 0) parts.push(`${formatNumber(a.intervalKm)} km`);
  if (a.intervalMonths > 0) parts.push(formatMonthsInterval(a.intervalMonths));
  return parts.length ? parts.join(' ou ') : '—';
}

function formatLastServiceDisplay(item) {
  const a = normalizeAlarm(item);
  const parts = [];
  if (a.intervalKm > 0 || a.lastServiceKm) parts.push(`${formatNumber(a.lastServiceKm)} km`);
  if (a.lastServiceDate) parts.push(formatDateShort(a.lastServiceDate));
  return parts.length ? parts.join(' · ') : '—';
}

function computeAlarmStatus(item, currentKm, refDate = new Date()) {
  const a = normalizeAlarm(item);
  const hasKm = a.intervalKm > 0;
  const hasTime = a.intervalMonths > 0;

  let kmDue = false;
  let kmRemaining = null;
  let kmOver = 0;

  if (hasKm && currentKm > 0) {
    const kmSince = currentKm - a.lastServiceKm;
    kmRemaining = a.intervalKm - kmSince;
    kmDue = kmRemaining <= 0;
    kmOver = kmDue ? Math.abs(kmRemaining) : 0;
  }

  let timeDue = false;
  let daysRemaining = null;
  let daysOver = 0;
  let needsDate = hasTime && !a.lastServiceDate;

  if (hasTime && a.lastServiceDate) {
    const dueDate = addMonthsToDate(a.lastServiceDate, a.intervalMonths);
    const ref = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), 12);
    daysRemaining = Math.ceil((dueDate - ref) / 86400000);
    timeDue = daysRemaining <= 0;
    daysOver = timeDue ? Math.abs(daysRemaining) : 0;
  }

  const due =
    (hasKm && currentKm > 0 && kmDue) || (hasTime && a.lastServiceDate && timeDue);

  const remainingCandidates = [];
  if (hasKm && currentKm > 0 && kmRemaining != null && kmRemaining > 0) {
    remainingCandidates.push({
      kind: 'km',
      ratio: kmRemaining / a.intervalKm,
      text: `${formatNumber(kmRemaining)} km`,
    });
  }
  if (hasTime && a.lastServiceDate && daysRemaining != null && daysRemaining > 0) {
    remainingCandidates.push({
      kind: 'time',
      ratio: daysRemaining / (a.intervalMonths * 30.44),
      text: formatTimeRemaining(daysRemaining),
    });
  }
  remainingCandidates.sort((x, y) => x.ratio - y.ratio);
  const soonest = remainingCandidates[0] || null;

  return {
    ...a,
    hasKm,
    hasTime,
    kmDue,
    timeDue,
    due,
    kmRemaining,
    kmOver,
    daysRemaining,
    daysOver,
    needsDate,
    soonest,
    remainingCandidates,
  };
}

function formatAlarmDueReason(status) {
  const parts = [];
  if (status.kmDue) parts.push(`${formatNumber(status.kmOver)} km além`);
  if (status.timeDue) parts.push(`${formatTimeRemaining(status.daysOver)} além`);
  return parts.join(' · ');
}

function formatAlarmStatusText(status, mileage) {
  if (status.needsDate) return 'Informe a data da última manutenção (alarme por tempo).';
  if (!mileage && status.hasKm && !status.hasTime) {
    return 'Aguardando abastecimento para calcular por km.';
  }
  if (status.due) return `Vencido — ${formatAlarmDueReason(status)}`;
  if (!status.soonest) {
    if (status.hasKm && !mileage) return 'Cadastre abastecimento para calcular por km.';
    return 'Configure intervalo por km ou tempo.';
  }
  if (status.remainingCandidates.length > 1) {
    return `Faltam ${status.soonest.text} (vence primeiro — km ou tempo)`;
  }
  return `Faltam ${status.soonest.text}`;
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
          `<div class="alert warning"><span>⚠</span><span><strong>${escapeHtml(d.label)}</strong> — vencido (${formatAlarmDueReason(d)}). <a href="#" class="link-alarms" data-goto-alarms>Config → Alarmes</a></span></div>`
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
      ? `Referência: ${formatNumber(mileage)} km · ${new Date().toLocaleDateString(LOCALE)}`
      : 'Cadastre um abastecimento para alarmes por km. Alarmes por tempo usam a data de hoje.';

  if (!maintenance.length) {
    summaryEl.innerHTML = '';
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');

  if (!mileage) {
    summaryEl.innerHTML =
      '<div class="alert ok">Configure os alarmes abaixo. Vencimento por <strong>km</strong> ou <strong>tempo</strong> (o que ocorrer primeiro).</div>';
  } else if (!due.length) {
    summaryEl.innerHTML = `<div class="alert ok">Nenhum alarme vencido (${formatNumber(mileage)} km · ${new Date().toLocaleDateString(LOCALE)}).</div>`;
  } else {
    summaryEl.innerHTML = due
      .map(
        (d) =>
          `<div class="alert warning"><strong>${escapeHtml(d.label)}</strong> vencido (${formatAlarmDueReason(d)}).</div>`
      )
      .join('');
  }

  listEl.innerHTML = maintenance
    .map((item) => {
      const status = computeAlarmStatus(item, mileage);
      const statusClass = status.due || status.needsDate ? 'due' : '';
      const statusText = formatAlarmStatusText(status, mileage);
      const canMarkDone =
        (status.hasKm && mileage > 0) || status.hasTime || (!status.hasKm && !status.hasTime);
      const notes = item.notes?.trim()
        ? `<p class="alarm-notes">${escapeHtml(item.notes.trim())}</p>`
        : '';

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
            <div><dt>Intervalo</dt><dd>${formatAlarmInterval(item)}</dd></div>
            <div><dt>Última manutenção</dt><dd>${formatLastServiceDisplay(item)}</dd></div>
          </dl>
          ${notes}
          <p class="maint-status ${statusClass}">${statusText}</p>
          <button type="button" class="btn secondary btn-sm btn-mark-done" data-mark-done="${item.id}" ${!canMarkDone ? 'disabled' : ''}>
            Marcar como feito agora
          </button>
        </article>`;
    })
    .join('');
}

function sortServiceLogs(logs) {
  return [...logs].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return new Date(b.date) - new Date(a.date);
  });
}

function filterServiceLogs(logs, filter) {
  if (filter === 'done') return logs.filter((l) => l.done);
  if (filter === 'pending') return logs.filter((l) => !l.done);
  return logs;
}

function renderServicesScreen() {
  const listEl = document.getElementById('service-list');
  const emptyEl = document.getElementById('service-empty');
  const logs = sortServiceLogs(filterServiceLogs(getServiceLogs(), currentServiceFilter));

  if (!logs.length) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');
  listEl.innerHTML = logs
    .map((item) => {
      const statusClass = item.done ? 'service-done' : 'service-pending';
      const statusLabel = item.done ? 'Realizada' : 'A realizar';
      const notes = item.notes?.trim()
        ? `<p class="service-notes">${escapeHtml(item.notes.trim())}</p>`
        : '';

      return `
        <article class="card service-card ${statusClass}" data-service-id="${item.id}">
          <div class="service-card-head">
            <div>
              <time class="service-date">${formatDateShort(item.date)}</time>
              <span class="service-badge">${statusLabel}</span>
            </div>
            <div class="service-actions">
              <button type="button" class="btn secondary btn-sm" data-edit-service="${item.id}">Editar</button>
              <button type="button" class="btn danger-outline btn-sm" data-delete-service="${item.id}">×</button>
            </div>
          </div>
          <dl class="service-details">
            <div><dt>Local</dt><dd>${item.location ? escapeHtml(item.location) : '—'}</dd></div>
            <div><dt>Km</dt><dd>${formatNumber(item.mileage)}</dd></div>
          </dl>
          ${notes}
          <label class="toggle-row toggle-row-card">
            <span class="toggle-label">Realizada</span>
            <input type="checkbox" class="toggle-input service-toggle" data-toggle-service="${item.id}" ${item.done ? 'checked' : ''} />
            <span class="toggle-switch" aria-hidden="true"></span>
          </label>
        </article>`;
    })
    .join('');
}

function switchServiceFilter(filter) {
  currentServiceFilter = filter;
  document.querySelectorAll('[data-service-filter]').forEach((btn) => {
    const on = btn.dataset.serviceFilter === filter;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  renderServicesScreen();
}

function openServiceDialog(id = null) {
  editingServiceId = id;
  const title = document.getElementById('service-dialog-title');
  const dateInput = document.getElementById('service-date');
  const locInput = document.getElementById('service-location');
  const kmInput = document.getElementById('service-mileage');
  const notesInput = document.getElementById('service-notes');
  const doneInput = document.getElementById('service-done');

  if (id) {
    const item = getServiceLogs().find((s) => s.id === id);
    if (!item) return;
    title.textContent = 'Editar manutenção';
    dateInput.value = item.date || '';
    locInput.value = item.location || '';
    kmInput.value = item.mileage;
    notesInput.value = item.notes || '';
    doneInput.checked = !!item.done;
  } else {
    title.textContent = 'Nova manutenção';
    dateInput.value = new Date().toISOString().slice(0, 10);
    locInput.value = '';
    const mileage = latestMileage(getFills());
    kmInput.value = mileage > 0 ? mileage : '';
    notesInput.value = '';
    doneInput.checked = false;
  }

  document.getElementById('service-dialog').showModal();
  locInput.focus();
}

async function saveServiceFromForm() {
  const date = document.getElementById('service-date').value;
  const location = document.getElementById('service-location').value.trim();
  const mileage = parseFloat(document.getElementById('service-mileage').value);
  const notes = document.getElementById('service-notes').value.trim();
  const done = document.getElementById('service-done').checked;

  if (!date) {
    alert('Informe a data.');
    return false;
  }
  if (mileage < 0 || Number.isNaN(mileage)) {
    alert('Informe a quilometragem.');
    return false;
  }

  const record = { date, location, mileage, notes, done };
  const logs = [...getServiceLogs()];

  if (editingServiceId) {
    const idx = logs.findIndex((s) => s.id === editingServiceId);
    if (idx === -1) return false;
    logs[idx] = { ...logs[idx], ...record };
  } else {
    logs.push({ id: crypto.randomUUID(), ...record });
  }

  try {
    await persistServiceLogs(logs);
    editingServiceId = null;
    refreshUI();
    return true;
  } catch (e) {
    alert(e.message || 'Erro ao salvar.');
    return false;
  }
}

async function toggleServiceDone(id, done) {
  const logs = [...getServiceLogs()];
  const idx = logs.findIndex((s) => s.id === id);
  if (idx === -1) return;
  logs[idx].done = done;
  await persistServiceLogs(logs);
  refreshUI();
}

async function deleteService(id) {
  await persistServiceLogs(getServiceLogs().filter((s) => s.id !== id));
  refreshUI();
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
  const summary = computeKpiSummary(enriched);
  renderKpiSummary(summary);

  if (!enriched.length) {
    emptyEl.classList.remove('hidden');
    document.querySelectorAll('.charts-period').forEach((el) => el.classList.add('hidden'));
    return;
  }
  emptyEl.classList.add('hidden');

  const ts = (iso) => new Date(iso).getTime();
  const firstTs = ts(enriched[0].datetime);
  const lastFillTs = ts(enriched.at(-1).datetime);
  const nowTs = Date.now();

  // Eixo X temporal: escala de 1 dia (timeline proporcional).
  const timeAxis = (text, min = firstTs, max = nowTs) => ({
    type: 'time',
    min,
    max,
    time: {
      unit: 'day',
      stepSize: 1,
      round: 'day',
      tooltipFormat: 'dd/MM/yyyy HH:mm',
      displayFormats: { day: 'dd/MM' },
    },
    title: text ? { display: true, text, color: '#8b9cb3' } : undefined,
    ticks: { color: '#8b9cb3', maxRotation: 45, autoSkip: true, font: { size: 10 } },
    grid: { color: 'rgba(45,58,79,0.5)' },
  });

  const yAxis = (text) => ({
    ticks: { color: '#8b9cb3' },
    grid: { color: 'rgba(45,58,79,0.5)' },
    title: text ? { display: true, text, color: '#8b9cb3' } : undefined,
  });

  const categoryAxis = (text) => ({
    ticks: { color: '#8b9cb3', maxRotation: 45, autoSkip: true, font: { size: 10 } },
    grid: { color: 'rgba(45,58,79,0.5)' },
    title: text ? { display: true, text, color: '#8b9cb3' } : undefined,
  });

  const baseOptions = {
    responsive: true,
    maintainAspectRatio: true,
    plugins: { legend: { display: true, labels: { color: '#8b9cb3', boxWidth: 12 } } },
  };

  const avgLine = (label, value, minX = firstTs, maxX = nowTs) =>
    value != null
      ? [{
          label,
          data: [{ x: minX, y: value }, { x: maxX, y: value }],
          borderColor: '#8b9cb3',
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false,
        }]
      : [];

  chartInstances.priceLiter = new Chart(document.getElementById('chart-price-liter'), {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'R$/L',
          data: enriched.map((r) => ({ x: ts(r.datetime), y: r.pricePerLiter })),
          borderColor: '#f5b942',
          backgroundColor: 'rgba(245,185,66,0.15)',
          fill: true,
          tension: 0.2,
          pointRadius: 4,
        },
        ...avgLine('Preço médio', summary.avgPricePerLiter, firstTs, lastFillTs),
      ],
    },
    options: {
      ...baseOptions,
      plugins: { ...baseOptions.plugins, legend: { display: summary.avgPricePerLiter != null } },
      scales: { x: timeAxis(undefined, firstTs, lastFillTs), y: yAxis('R$/L') },
    },
  });

  if (enriched.length < 2 || !periods.length) {
    document.querySelectorAll('.charts-period').forEach((el) => el.classList.add('hidden'));
    return;
  }
  document.querySelectorAll('.charts-period').forEach((el) => el.classList.remove('hidden'));

  let cumulativeSpent = 0;
  let cumulativeKm = 0;
  const spentCumulative = enriched.map((r) => {
    cumulativeSpent += r.amount;
    cumulativeKm += r.distanceKm != null && r.distanceKm > 0 ? r.distanceKm : 0;
    return { x: ts(r.datetime), spent: cumulativeSpent, km: cumulativeKm };
  });
  const lastCumulative = spentCumulative.at(-1);
  if (lastCumulative && lastCumulative.x < nowTs) {
    spentCumulative.push({ x: nowTs, spent: lastCumulative.spent, km: lastCumulative.km });
  }
  const avgConsumption = summary.avgConsumption;
  // Gráficos 1 e 2: do 2º abastecimento (1º período com km) até o último abastecimento.
  const periodFirstTs = ts(periods[0].datetime);
  const periodLastTs = ts(periods.at(-1).datetime);
  const periodTimeAxis = (text) => timeAxis(text, periodFirstTs, periodLastTs);

  chartInstances.consumption = new Chart(document.getElementById('chart-consumption'), {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Consumo (km/L)',
          data: periods.map((r) => ({ x: ts(r.datetime), y: r.consumption })),
          borderColor: '#3d9eff',
          backgroundColor: 'rgba(61,158,255,0.15)',
          fill: true,
          tension: 0.2,
        },
        ...avgLine('Média geral', avgConsumption, periodFirstTs, periodLastTs),
      ],
    },
    options: {
      ...baseOptions,
      plugins: { ...baseOptions.plugins, legend: { display: avgConsumption != null } },
      scales: { x: periodTimeAxis(), y: yAxis('km/L') },
    },
  });

  chartInstances.costKm = new Chart(document.getElementById('chart-cost-km'), {
    type: 'line',
    data: {
      datasets: [{
        label: 'R$/km',
        data: periods.map((r) => ({ x: ts(r.datetime), y: r.costPerKm })),
        borderColor: '#f5b942',
        backgroundColor: 'rgba(245,185,66,0.12)',
        fill: true,
        tension: 0.2,
      }],
    },
    options: {
      ...baseOptions,
      plugins: { legend: { display: false } },
      scales: { x: periodTimeAxis(), y: yAxis('R$/km') },
    },
  });

  const monthlyKm = buildMonthlyKmTotals(enriched);

  chartInstances.distance = new Chart(document.getElementById('chart-distance'), {
    type: 'bar',
    data: {
      labels: monthlyKm.labels,
      datasets: [{
        label: 'Km no mês',
        data: monthlyKm.values,
        backgroundColor: 'rgba(61,214,140,0.65)',
        borderColor: '#3dd68c',
        borderWidth: 1,
      }],
    },
    options: {
      ...baseOptions,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${formatNumber(ctx.parsed.y)} km`,
          },
        },
      },
      scales: { x: categoryAxis('Mês'), y: yAxis('km') },
    },
  });

  chartInstances.spent = new Chart(document.getElementById('chart-spent'), {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Gasto acumulado (R$)',
          data: spentCumulative.map((r) => ({ x: r.x, y: r.spent })),
          borderColor: '#f07178',
          backgroundColor: 'rgba(240,113,120,0.2)',
          fill: true,
          tension: 0.2,
          yAxisID: 'y',
        },
        {
          label: 'Km acumulado',
          data: spentCumulative.map((r) => ({ x: r.x, y: r.km })),
          borderColor: '#3d9eff',
          backgroundColor: 'rgba(61,158,255,0.0)',
          fill: false,
          tension: 0.2,
          yAxisID: 'y1',
        },
      ],
    },
    options: (() => {
      const spentValues = spentCumulative.map((r) => r.spent);
      const kmValues = spentCumulative.map((r) => r.km);
      const axisLimit = computeAlignedAxisLimit(Math.max(...spentValues, ...kmValues, 0));
      const alignedTicks = {
        color: '#8b9cb3',
        stepSize: axisLimit.stepSize,
        callback: (value) => formatNumber(value, 0),
      };
      const alignedScale = {
        type: 'linear',
        min: axisLimit.min,
        max: axisLimit.max,
        ticks: alignedTicks,
      };

      return {
        ...baseOptions,
        plugins: { legend: { display: true, labels: { color: '#8b9cb3', boxWidth: 12 } } },
        scales: {
          x: timeAxis(),
          y: {
            ...alignedScale,
            position: 'left',
            grid: { color: 'rgba(45,58,79,0.5)' },
            title: { display: true, text: 'R$', color: '#8b9cb3' },
          },
          y1: {
            ...alignedScale,
            position: 'right',
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'km', color: '#8b9cb3' },
          },
        },
      };
    })(),
  });

  const fillPeriods = periods.filter((r) => r.consumption != null);
  const fillLabels = fillPeriods.map((r) =>
    new Date(r.datetime).toLocaleDateString(LOCALE, {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
    })
  );

  chartInstances.consumptionDistance = new Chart(document.getElementById('chart-consumption-distance'), {
    type: 'bar',
    data: {
      labels: fillLabels,
      datasets: [
        {
          label: 'Consumo (km/L)',
          data: fillPeriods.map((r) => r.consumption),
          backgroundColor: 'rgba(179, 136, 255, 0.75)',
          borderColor: '#b388ff',
          borderWidth: 1,
          yAxisID: 'y',
        },
        {
          label: 'Km rodados',
          data: fillPeriods.map((r) => r.distanceKm),
          backgroundColor: 'rgba(61, 214, 140, 0.65)',
          borderColor: '#3dd68c',
          borderWidth: 1,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      ...baseOptions,
      plugins: {
        legend: { display: true, labels: { color: '#8b9cb3', boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (items) =>
              fillPeriods[items[0]?.dataIndex]
                ? formatDateTime(fillPeriods[items[0].dataIndex].datetime)
                : '',
            label: (ctx) => {
              const value = ctx.parsed.y;
              if (value == null) return '';
              return ctx.datasetIndex === 0
                ? `${formatNumber(value, 2)} km/L`
                : `${formatNumber(value)} km`;
            },
          },
        },
      },
      scales: {
        x: categoryAxis('Abastecimento'),
        y: { ...yAxis('km/L'), position: 'left' },
        y1: {
          ...yAxis('km'),
          position: 'right',
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
  const intervalKmInput = document.getElementById('alarm-interval-km');
  const intervalMonthsInput = document.getElementById('alarm-interval-months');
  const lastKmInput = document.getElementById('alarm-last-service-km');
  const lastDateInput = document.getElementById('alarm-last-service-date');
  const notesInput = document.getElementById('alarm-notes');

  if (id) {
    const item = normalizeAlarm(getMaintenance().find((a) => a.id === id));
    if (!item) return;
    title.textContent = 'Editar alarme';
    labelInput.value = item.label;
    intervalKmInput.value = item.intervalKm || '';
    intervalMonthsInput.value = item.intervalMonths || '';
    lastKmInput.value = item.lastServiceKm;
    lastDateInput.value = item.lastServiceDate || '';
    notesInput.value = item.notes || '';
  } else {
    title.textContent = 'Novo alarme';
    labelInput.value = '';
    intervalKmInput.value = '';
    intervalMonthsInput.value = '';
    lastKmInput.value = '0';
    lastDateInput.value = '';
    notesInput.value = '';
  }

  document.getElementById('alarm-dialog').showModal();
  labelInput.focus();
}

async function saveAlarmFromForm() {
  const label = document.getElementById('alarm-label').value.trim();
  const intervalKm = parseFloat(document.getElementById('alarm-interval-km').value) || 0;
  const intervalMonths = parseInt(document.getElementById('alarm-interval-months').value, 10) || 0;
  const lastServiceKm = parseFloat(document.getElementById('alarm-last-service-km').value);
  const lastServiceDate = document.getElementById('alarm-last-service-date').value;
  const notes = document.getElementById('alarm-notes').value.trim();

  if (!label) { alert('Informe o nome do alarme.'); return false; }
  if (intervalKm <= 0 && intervalMonths <= 0) {
    alert('Informe intervalo por km, por tempo, ou ambos.');
    return false;
  }
  if (intervalKm < 0 || (intervalKm > 0 && intervalKm < 100)) {
    alert('Intervalo em km deve ser 0 (desligado) ou pelo menos 100 km.');
    return false;
  }
  if (intervalMonths < 0 || intervalMonths > 120) {
    alert('Intervalo em meses deve ser entre 0 e 120.');
    return false;
  }
  if (lastServiceKm < 0 || Number.isNaN(lastServiceKm)) {
    alert('Informe a quilometragem da última manutenção.');
    return false;
  }
  if (intervalMonths > 0 && !lastServiceDate) {
    alert('Para alarme por tempo, informe a data da última manutenção.');
    return false;
  }

  const record = {
    label,
    intervalKm,
    intervalMonths,
    lastServiceKm,
    lastServiceDate: intervalMonths > 0 ? lastServiceDate : '',
    notes,
  };

  const items = [...getMaintenance()];

  if (editingAlarmId) {
    const idx = items.findIndex((a) => a.id === editingAlarmId);
    if (idx === -1) return false;
    items[idx] = { ...items[idx], ...record };
  } else {
    items.push({ id: crypto.randomUUID(), ...record });
  }

  try {
    await persistMaintenance(items);
    editingAlarmId = null;
    refreshUI();
    return true;
  } catch (e) {
    alert(e.message || 'Erro ao salvar alarme.');
    return false;
  }
}

async function deleteAlarm(id) {
  await persistMaintenance(getMaintenance().filter((a) => a.id !== id));
  refreshUI();
}

async function markAlarmDone(id) {
  const mileage = latestMileage(getFills());
  const items = [...getMaintenance()];
  const idx = items.findIndex((a) => a.id === id);
  if (idx === -1) return;
  const item = normalizeAlarm(items[idx]);

  if (item.intervalKm > 0) {
    if (!mileage) {
      alert('Cadastre um abastecimento para registrar a quilometragem da manutenção.');
      return;
    }
    items[idx].lastServiceKm = mileage;
  }
  if (item.intervalMonths > 0) {
    items[idx].lastServiceDate = new Date().toISOString().slice(0, 10);
  }

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
    serviceLogs: getServiceLogs(),
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
  if (data.serviceLogs?.length) {
    DataStore.serviceLogs = DataStore.mergeById(getServiceLogs(), data.serviceLogs);
  }
  if (data.syncId) DataStore.setSyncId(data.syncId);

  await DataStore.persist();
  refreshUI();
  alert('Backup importado com sucesso.');
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchScreen(tab.dataset.screen));
});

document.querySelectorAll('[data-settings-panel]').forEach((btn) => {
  btn.addEventListener('click', () => switchSettingsPanel(btn.dataset.settingsPanel));
});

document.querySelectorAll('[data-service-filter]').forEach((btn) => {
  btn.addEventListener('click', () => switchServiceFilter(btn.dataset.serviceFilter));
});

document.getElementById('btn-add-service').addEventListener('click', () => openServiceDialog());

document.getElementById('service-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await saveServiceFromForm()) document.getElementById('service-dialog').close();
});

document.getElementById('service-cancel').addEventListener('click', () => {
  editingServiceId = null;
  document.getElementById('service-dialog').close();
});

document.getElementById('service-list').addEventListener('change', async (e) => {
  const toggle = e.target.closest('.service-toggle');
  if (!toggle) return;
  await toggleServiceDone(toggle.dataset.toggleService, toggle.checked);
});

document.getElementById('service-list').addEventListener('click', async (e) => {
  if (e.target.closest('.toggle-row-card')) return;

  const editBtn = e.target.closest('[data-edit-service]');
  if (editBtn) {
    openServiceDialog(editBtn.dataset.editService);
    return;
  }
  const delBtn = e.target.closest('[data-delete-service]');
  if (delBtn && confirm('Excluir esta manutenção?')) {
    await deleteService(delBtn.dataset.deleteService);
  }
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

  const hasSavedMaintenance = localStorage.getItem('carKpi_maintenance') !== null;
  if (!DataStore.maintenance.length && !hasSavedMaintenance) {
    DataStore.maintenance = structuredClone(DEFAULT_MAINTENANCE);
    try {
      await DataStore.persist();
    } catch { /* ignore */ }
  }

  initDatetimeInput(document.getElementById('field-datetime'));
  refreshUI();
}

bootstrap();
