const STORAGE_FILLS = 'carKpi_fills';
const STORAGE_MAINT = 'carKpi_maintenance';
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

function loadFills() {
  try {
    const raw = localStorage.getItem(STORAGE_FILLS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFills(fills) {
  localStorage.setItem(STORAGE_FILLS, JSON.stringify(fills));
}

function loadMaintenance() {
  try {
    const raw = localStorage.getItem(STORAGE_MAINT);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return structuredClone(DEFAULT_MAINTENANCE);
}

function saveMaintenance(items) {
  localStorage.setItem(STORAGE_MAINT, JSON.stringify(items));
}

function formatNumber(n, decimals = 0) {
  return n.toLocaleString(LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(LOCALE, {
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

    if (index > 0) {
      const prev = sorted[index - 1];
      distanceKm = fill.mileage - prev.mileage;
      if (distanceKm > 0 && fill.liters > 0) {
        consumption = distanceKm / fill.liters;
      }
    }

    return {
      ...fill,
      pricePerLiter,
      consumption,
      distanceKm,
    };
  });
}

function latestMileage(fills) {
  if (!fills.length) return 0;
  const sorted = sortFills(fills);
  return sorted[sorted.length - 1].mileage;
}

function initDatetimeDefault() {
  const input = document.getElementById('field-datetime');
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  input.value = now.toISOString().slice(0, 16);
}

function switchScreen(name) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.screen === name);
    el.setAttribute('aria-selected', el.dataset.screen === name ? 'true' : 'false');
  });
  document.getElementById(`screen-${name}`).classList.add('active');

  if (name === 'table') renderTable();
  if (name === 'charts') renderCharts();
  if (name === 'alarms') renderAlarmsScreen();
  if (name === 'entry') renderEntryAlerts();
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
  return maintenance
    .map((item) => computeAlarmStatus(item, currentKm))
    .filter((item) => item.due);
}

function renderEntryAlerts() {
  const fills = loadFills();
  const maintenance = loadMaintenance();
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
          `<div class="alert warning"><span>⚠</span><span><strong>${escapeHtml(d.label)}</strong> — vencido (${formatNumber(d.kmOver)} km além do intervalo). Última manutenção em ${formatNumber(d.lastServiceKm)} km. <a href="#" class="link-alarms" data-goto-alarms>Ver alarmes</a></span></div>`
      )
      .join('');
}

function renderTable() {
  const fills = enrichFills(loadFills());
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
      const price =
        row.pricePerLiter != null ? `R$ ${formatNumber(row.pricePerLiter, 3)}` : '—';
      const cons = row.consumption != null ? formatNumber(row.consumption, 2) : '—';
      const obsLabel = row.obs?.trim() ? row.obs.trim() : 'Adicionar…';
      const obsClass = row.obs?.trim() ? 'has-note' : '';

      return `<tr data-id="${row.id}">
        <td>${formatDateTime(row.datetime)}</td>
        <td>${formatNumber(row.mileage)}</td>
        <td>${formatNumber(row.liters, 2)}</td>
        <td>R$ ${formatMoney(row.amount)}</td>
        <td>${price}</td>
        <td>${cons}</td>
        <td class="obs-cell col-end">
          <button type="button" class="btn obs ${obsClass}" data-obs-id="${row.id}" title="Editar observação">${escapeHtml(obsLabel)}</button>
        </td>
        <td class="col-end"><button type="button" class="btn-icon" data-delete-id="${row.id}" title="Excluir linha">×</button></td>
      </tr>`;
    })
    .join('');
}

function renderAlarmsScreen() {
  const maintenance = loadMaintenance();
  const mileage = latestMileage(loadFills());
  const summaryEl = document.getElementById('alarms-summary');
  const mileageEl = document.getElementById('alarms-mileage');
  const listEl = document.getElementById('alarms-list');
  const emptyEl = document.getElementById('alarms-empty');
  const due = getDueMaintenance(maintenance, mileage);

  if (mileage > 0) {
    mileageEl.textContent = `Quilometragem atual (último abastecimento): ${formatNumber(mileage)} km`;
    mileageEl.classList.remove('hidden');
  } else {
    mileageEl.textContent = 'Cadastre um abastecimento para calcular os alarmes pela quilometragem.';
    mileageEl.classList.remove('hidden');
  }

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

      if (!mileage) {
        statusText = 'Aguardando abastecimento para calcular.';
      } else if (status.due) {
        statusText = `Vencido — ${formatNumber(status.kmOver)} km além do intervalo`;
      } else {
        statusText = `Faltam ${formatNumber(status.remaining)} km para a próxima manutenção`;
      }

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
  const enriched = enrichFills(loadFills());
  const emptyEl = document.getElementById('charts-empty');
  const withConsumption = enriched.filter((r) => r.consumption != null);

  destroyCharts();

  if (enriched.length < 2) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  const labels = enriched.map((r) => formatDateTime(r.datetime));

  let cumulativeSpent = 0;
  const spentSeries = enriched.map((r) => {
    cumulativeSpent += r.amount;
    return cumulativeSpent;
  });

  const baseMileage = enriched[0].mileage;
  const accumulatedDistance = enriched.map((r) => r.mileage - baseMileage);

  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: true,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { color: '#8b9cb3', maxRotation: 45 },
        grid: { color: 'rgba(45,58,79,0.5)' },
      },
      y: {
        ticks: { color: '#8b9cb3' },
        grid: { color: 'rgba(45,58,79,0.5)' },
      },
    },
  };

  if (withConsumption.length) {
    const consLabels = withConsumption.map((r) => formatDateTime(r.datetime));
    const consData = withConsumption.map((r) => r.consumption);

    chartInstances.consumption = new Chart(
      document.getElementById('chart-consumption'),
      {
        type: 'line',
        data: {
          labels: consLabels,
          datasets: [
            {
              data: consData,
              borderColor: '#3d9eff',
              backgroundColor: 'rgba(61,158,255,0.15)',
              fill: true,
              tension: 0.2,
            },
          ],
        },
        options: {
          ...chartDefaults,
          scales: {
            ...chartDefaults.scales,
            y: {
              ...chartDefaults.scales.y,
              title: { display: true, text: 'km/L', color: '#8b9cb3' },
            },
          },
        },
      }
    );
  }

  chartInstances.price = new Chart(document.getElementById('chart-price'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data: enriched.map((r) => r.pricePerLiter),
          borderColor: '#f5b942',
          backgroundColor: 'rgba(245,185,66,0.12)',
          fill: true,
          tension: 0.2,
        },
      ],
    },
    options: {
      ...chartDefaults,
      scales: {
        ...chartDefaults.scales,
        y: {
          ...chartDefaults.scales.y,
          title: { display: true, text: 'R$', color: '#8b9cb3' },
        },
      },
    },
  });

  chartInstances.distance = new Chart(document.getElementById('chart-distance'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data: accumulatedDistance,
          borderColor: '#3dd68c',
          backgroundColor: 'rgba(61,214,140,0.12)',
          fill: true,
          tension: 0.2,
        },
      ],
    },
    options: {
      ...chartDefaults,
      scales: {
        ...chartDefaults.scales,
        y: {
          ...chartDefaults.scales.y,
          title: { display: true, text: 'km', color: '#8b9cb3' },
        },
      },
    },
  });

  chartInstances.spent = new Chart(document.getElementById('chart-spent'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          data: spentSeries,
          backgroundColor: 'rgba(240,113,120,0.6)',
          borderColor: '#f07178',
          borderWidth: 1,
        },
      ],
    },
    options: {
      ...chartDefaults,
      scales: {
        ...chartDefaults.scales,
        y: {
          ...chartDefaults.scales.y,
          title: { display: true, text: 'R$', color: '#8b9cb3' },
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

function openObsDialog(id) {
  const fills = loadFills();
  const fill = fills.find((f) => f.id === id);
  if (!fill) return;

  editingObsId = id;
  document.getElementById('obs-meta').textContent = `${formatDateTime(fill.datetime)} — ${formatNumber(fill.mileage)} km`;
  document.getElementById('obs-text').value = fill.obs || '';
  document.getElementById('obs-dialog').showModal();
}

function saveObs(text) {
  if (!editingObsId) return;
  const fills = loadFills();
  const idx = fills.findIndex((f) => f.id === editingObsId);
  if (idx === -1) return;
  fills[idx].obs = text.trim();
  saveFills(fills);
  editingObsId = null;
  renderTable();
}

function openAlarmDialog(id = null) {
  editingAlarmId = id;
  const title = document.getElementById('alarm-dialog-title');
  const labelInput = document.getElementById('alarm-label');
  const intervalInput = document.getElementById('alarm-interval');
  const lastInput = document.getElementById('alarm-last-service');

  if (id) {
    const item = loadMaintenance().find((a) => a.id === id);
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

function saveAlarmFromForm() {
  const label = document.getElementById('alarm-label').value.trim();
  const intervalKm = parseFloat(document.getElementById('alarm-interval').value);
  const lastServiceKm = parseFloat(document.getElementById('alarm-last-service').value);

  if (!label) {
    alert('Informe o nome do alarme.');
    return false;
  }
  if (!intervalKm || intervalKm < 100) {
    alert('O intervalo deve ser de pelo menos 100 km.');
    return false;
  }
  if (lastServiceKm < 0 || Number.isNaN(lastServiceKm)) {
    alert('Informe a quilometragem da última manutenção.');
    return false;
  }

  const items = loadMaintenance();

  if (editingAlarmId) {
    const idx = items.findIndex((a) => a.id === editingAlarmId);
    if (idx === -1) return false;
    items[idx] = { ...items[idx], label, intervalKm, lastServiceKm };
  } else {
    items.push({
      id: crypto.randomUUID(),
      label,
      intervalKm,
      lastServiceKm,
    });
  }

  saveMaintenance(items);
  editingAlarmId = null;
  renderAlarmsScreen();
  renderEntryAlerts();
  return true;
}

function deleteAlarm(id) {
  saveMaintenance(loadMaintenance().filter((a) => a.id !== id));
  renderAlarmsScreen();
  renderEntryAlerts();
}

function markAlarmDone(id) {
  const mileage = latestMileage(loadFills());
  if (!mileage) {
    alert('Cadastre um abastecimento primeiro para obter a quilometragem atual.');
    return;
  }
  const items = loadMaintenance();
  const idx = items.findIndex((a) => a.id === id);
  if (idx === -1) return;
  items[idx].lastServiceKm = mileage;
  saveMaintenance(items);
  renderAlarmsScreen();
  renderEntryAlerts();
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchScreen(tab.dataset.screen));
});

document.getElementById('entry-form').addEventListener('submit', (e) => {
  e.preventDefault();

  const datetime = document.getElementById('field-datetime').value;
  const mileage = parseFloat(document.getElementById('field-mileage').value);
  const liters = parseFloat(document.getElementById('field-liters').value);
  const amount = parseFloat(document.getElementById('field-amount').value);

  if (mileage < 0 || liters <= 0 || amount <= 0) {
    alert('Verifique a quilometragem, os litros e o valor pago.');
    return;
  }

  const fills = loadFills();
  const last = sortFills(fills).at(-1);
  if (last && mileage < last.mileage) {
    if (!confirm('A quilometragem é menor que o registro anterior. Salvar mesmo assim?')) return;
  }

  fills.push({
    id: crypto.randomUUID(),
    datetime: new Date(datetime).toISOString(),
    mileage,
    liters,
    amount,
    obs: '',
  });

  saveFills(fills);
  e.target.reset();
  initDatetimeDefault();
  renderEntryAlerts();

  const btn = e.target.querySelector('button[type="submit"]');
  const orig = btn.textContent;
  btn.textContent = 'Salvo ✓';
  setTimeout(() => {
    btn.textContent = orig;
  }, 1500);
});

document.getElementById('data-tbody').addEventListener('click', (e) => {
  const obsBtn = e.target.closest('[data-obs-id]');
  if (obsBtn) {
    openObsDialog(obsBtn.dataset.obsId);
    return;
  }
  const delBtn = e.target.closest('[data-delete-id]');
  if (delBtn && confirm('Excluir este abastecimento?')) {
    const id = delBtn.dataset.deleteId;
    saveFills(loadFills().filter((f) => f.id !== id));
    renderTable();
    renderEntryAlerts();
  }
});

document.getElementById('obs-form').addEventListener('submit', (e) => {
  e.preventDefault();
  saveObs(document.getElementById('obs-text').value);
  document.getElementById('obs-dialog').close();
});

document.getElementById('obs-cancel').addEventListener('click', () => {
  editingObsId = null;
  document.getElementById('obs-dialog').close();
});

document.getElementById('btn-add-alarm').addEventListener('click', () => openAlarmDialog());

document.getElementById('alarm-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (saveAlarmFromForm()) {
    document.getElementById('alarm-dialog').close();
  }
});

document.getElementById('alarm-cancel').addEventListener('click', () => {
  editingAlarmId = null;
  document.getElementById('alarm-dialog').close();
});

document.getElementById('alarms-list').addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-edit-alarm]');
  if (editBtn) {
    openAlarmDialog(editBtn.dataset.editAlarm);
    return;
  }
  const delBtn = e.target.closest('[data-delete-alarm]');
  if (delBtn && confirm('Excluir este alarme?')) {
    deleteAlarm(delBtn.dataset.deleteAlarm);
    return;
  }
  const markBtn = e.target.closest('[data-mark-done]');
  if (markBtn) {
    markAlarmDone(markBtn.dataset.markDone);
  }
});

document.getElementById('entry-alerts').addEventListener('click', (e) => {
  const link = e.target.closest('[data-goto-alarms]');
  if (link) {
    e.preventDefault();
    switchScreen('alarms');
  }
});

initDatetimeDefault();
renderEntryAlerts();
