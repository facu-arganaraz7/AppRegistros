"use strict";

// Se conserva la clave anterior para mantener los registros existentes.
const STORAGE_KEY = "libro_matriz_v1";
const ROWS_PER_SHEET = 33;

const $ = id => document.getElementById(id);

const FIELDS = [
  "entryDate",
  "expediente",
  "sigla",
  "observations",
  "exitDate",
  "office",
  "libreta",
  "foliatura"
];

const EXIT_FIELDS = [
  "exitDate",
  "office",
  "libreta",
  "foliatura"
];

let records = [];
let currentSheet = 1;
let availableSheets = [1];
let currentStatus = "all";
let formMode = "new";
let storageBlocked = false;
let toastTimer;

// ==================== UTILIDADES ====================

function today() {
  const date = new Date();

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function formatDate(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function sheetOf(record) {
  return Math.floor((record.position - 1) / ROWS_PER_SHEET) + 1;
}

function rowOf(record) {
  return ((record.position - 1) % ROWS_PER_SHEET) + 1;
}

function nextPosition() {
  return records.reduce(
    (maximum, record) => Math.max(maximum, record.position),
    0
  ) + 1;
}

function makeId() {
  return globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : `registro-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function notify(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.add("visible");

  toastTimer = setTimeout(() => {
    $("toast").classList.remove("visible");
  }, 4000);
}

function download(filename, content, type) {
  const blob = content instanceof Blob
    ? content
    : new Blob([content], { type });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ==================== ALMACENAMIENTO ====================

function validateRecords(list) {
  if (!Array.isArray(list)) {
    throw new Error("La lista de expedientes no es válida.");
  }

  const ids = new Set();
  const positions = new Set();

  const limits = {
    expediente: 150,
    sigla: 80,
    observations: 3000,
    office: 200,
    libreta: 100,
    foliatura: 100
  };

  return list.map(item => {
    if (!item || typeof item !== "object") {
      throw new Error("Hay registros inválidos.");
    }

    if (
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      !Number.isSafeInteger(item.position) ||
      item.position < 1 ||
      positions.has(item.position)
    ) {
      throw new Error("Hay identificadores o renglones inválidos.");
    }

    const record = {
      id: item.id,
      position: item.position
    };

    for (const field of FIELDS) {
      if (typeof item[field] !== "string") {
        throw new Error(`El campo ${field} no es válido.`);
      }

      record[field] = item[field];

      if (limits[field] && item[field].length > limits[field]) {
        throw new Error(`El campo ${field} es demasiado extenso.`);
      }
    }

    if (!validDate(record.entryDate) || !record.expediente.trim()) {
      throw new Error("Hay entradas incompletas o fechas inválidas.");
    }

    const hasExitData = EXIT_FIELDS.some(field => record[field]);

    if (hasExitData) {
      if (!validDate(record.exitDate) || !record.office.trim()) {
        throw new Error("Hay salidas sin fecha u oficina destino.");
      }

      if (record.exitDate < record.entryDate) {
        throw new Error("Hay salidas anteriores a la entrada.");
      }
    }

    record.createdAt =
      typeof item.createdAt === "string" ? item.createdAt : "";

    record.updatedAt =
      typeof item.updatedAt === "string" ? item.updatedAt : "";

    ids.add(record.id);
    positions.add(record.position);

    return record;
  }).sort((a, b) => a.position - b.position);
}

function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      records = [];
      storageBlocked = false;
      return;
    }

    const data = JSON.parse(raw);

    if (data.version !== 1) {
      throw new Error("Versión de datos no reconocida.");
    }

    records = validateRecords(data.records);
    storageBlocked = false;
  } catch (error) {
    storageBlocked = true;

    alert(
      "No se pudieron leer los datos guardados. " +
      "Importá un respaldo válido para recuperar el libro.\n\n" +
      error.message
    );
  }
}

function persist(nextRecords, recovery = false) {
  if (storageBlocked && !recovery) {
    alert("Recuperá el libro mediante un respaldo antes de continuar.");
    return false;
  }

  try {
    const validated = validateRecords(nextRecords);

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        records: validated
      })
    );

    records = validated;
    storageBlocked = false;
    return true;
  } catch (error) {
    alert(
      "No se pudo guardar la información. " +
      "Revisá el almacenamiento del navegador.\n\n" +
      error.message
    );

    return false;
  }
}

// ==================== NAVEGACIÓN Y CONSULTA ====================

function statusLabel() {
  return {
    all: "Todos",
    pending: "En oficina",
    out: "Salidos"
  }[currentStatus];
}

function filteredRecords() {
  const query = normalize($("searchInput").value.trim());
  const date = $("dateFilter").value;
  const filterByDate = $("periodFilter").value === "day";

  return records.filter(record => {
    if (currentStatus === "pending" && record.exitDate) return false;
    if (currentStatus === "out" && !record.exitDate) return false;

    if (
      filterByDate &&
      date &&
      record.entryDate !== date &&
      record.exitDate !== date
    ) {
      return false;
    }

    if (query) {
      const text = normalize([
        record.expediente,
        record.sigla,
        record.observations,
        record.office,
        record.libreta,
        record.foliatura
      ].join(" "));

      if (!text.includes(query)) return false;
    }

    return true;
  });
}

function queryDescription() {
  const parts = [statusLabel()];

  if ($("periodFilter").value === "day") {
    parts.push(`Movimientos del ${formatDate($("dateFilter").value)}`);
  }

  if ($("searchInput").value.trim()) {
    parts.push(`Búsqueda: ${$("searchInput").value.trim()}`);
  }

  return parts.join(" · ");
}

function render() {
  const filtered = filteredRecords();
  const pending = records.filter(record => !record.exitDate).length;
  const out = records.length - pending;

  const sheetCount = records.reduce(
    (maximum, record) => Math.max(maximum, sheetOf(record)),
    0
  );

  $("todayLabel").textContent = `Hoy: ${formatDate(today())}`;

  $("totalCount").textContent = records.length;
  $("pendingCount").textContent = pending;
  $("outCount").textContent = out;
  $("sheetCount").textContent = sheetCount;

  $("allBadge").textContent = records.length;
  $("pendingBadge").textContent = pending;
  $("outBadge").textContent = out;

  document.querySelectorAll(".nav-button").forEach(button => {
    const active = button.dataset.status === currentStatus;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  $("dateFilterLabel").hidden = $("periodFilter").value !== "day";

  availableSheets = [...new Set(filtered.map(sheetOf))]
    .sort((a, b) => a - b);

  if (!availableSheets.length) availableSheets = [1];

  if (!availableSheets.includes(currentSheet)) {
    currentSheet = availableSheets[0];
  }

  $("pageSelect").innerHTML = availableSheets.map(sheet => `
    <option value="${sheet}" ${sheet === currentSheet ? "selected" : ""}>
      ${sheet}
    </option>
  `).join("");

  const visible = filtered.filter(
    record => sheetOf(record) === currentSheet
  );

  const sheetTotal = records.filter(
    record => sheetOf(record) === currentSheet
  ).length;

  $("querySummary").textContent =
    `${filtered.length} expediente${filtered.length === 1 ? "" : "s"} · ` +
    queryDescription();

  $("sheetTitle").textContent = `Hoja ${currentSheet}`;

  $("sheetInfo").textContent =
    `${sheetTotal} de 33 renglones ocupados · ` +
    `${visible.length} visibles con esta consulta`;

  $("tableBody").innerHTML = visible.length
    ? visible.map(record => `
      <tr>
        <td>${rowOf(record)}</td>
        <td class="date">${formatDate(record.entryDate)}</td>
        <td class="observations">${escapeHTML(record.observations)}</td>
        <td class="expediente">${escapeHTML(record.expediente)}</td>
        <td>${escapeHTML(record.sigla)}</td>
        <td class="date">${formatDate(record.exitDate) || "—"}</td>
        <td>${escapeHTML(record.office) || "—"}</td>
        <td>${escapeHTML(record.libreta) || "—"}</td>
        <td>${escapeHTML(record.foliatura) || "—"}</td>
        <td>
          <span class="badge ${record.exitDate ? "out" : "pending"}">
            ${record.exitDate ? "Salido" : "En oficina"}
          </span>
        </td>
        <td>
          <div class="row-actions">
            ${!record.exitDate ? `
              <button
                class="button primary"
                data-action="exit"
                data-id="${escapeHTML(record.id)}"
              >Dar salida</button>
            ` : ""}

            <button
              class="button"
              data-action="edit"
              data-id="${escapeHTML(record.id)}"
            >Editar</button>
          </div>
        </td>
      </tr>
    `).join("")
    : `
      <tr>
        <td colspan="11" class="empty">
          <strong>No hay expedientes para mostrar</strong>
          Registrá una nueva entrada o cambiá los filtros de búsqueda.
        </td>
      </tr>
    `;

  const index = availableSheets.indexOf(currentSheet);

  $("previousPage").disabled = index <= 0;
  $("nextPage").disabled = index >= availableSheets.length - 1;
  $("printSheetButton").disabled = sheetTotal === 0;
  $("excelButton").disabled = filtered.length === 0;
  $("reportButton").disabled = filtered.length === 0;
}

function resetFilters() {
  $("searchInput").value = "";
  $("periodFilter").value = "all";
  $("dateFilter").value = today();
  currentSheet = 1;
  render();
}

function changeSheet(offset) {
  const index = availableSheets.indexOf(currentSheet);
  const next = availableSheets[index + offset];

  if (next !== undefined) {
    currentSheet = next;
    render();
  }
}

// ==================== CONTROL DE FECHAS ====================

function configureDates(record) {
  const currentDate = today();

  $("entryDate").min = currentDate;
  $("entryDate").readOnly = Boolean(
    record && record.entryDate < currentDate
  );

  $("entryDateHelp").textContent = $("entryDate").readOnly
    ? "Fecha histórica conservada. Podés corregir los demás datos."
    : "Se permite la fecha actual o una fecha posterior.";

  updateExitMinimum();

  $("exitDate").readOnly = Boolean(
    record?.exitDate && record.exitDate < currentDate
  );

  $("exitDateHelp").textContent = $("exitDate").readOnly
    ? "Fecha histórica conservada. Podés corregir los demás datos."
    : "Debe ser hoy o después, y no puede ser anterior a la entrada.";
}

function updateExitMinimum() {
  const currentDate = today();
  const entry = $("entryDate").value;

  $("exitDate").min = entry > currentDate ? entry : currentDate;
}

function validateMovementDates(values, original) {
  const currentDate = today();

  if (!validDate(values.entryDate)) {
    return "Ingresá una fecha de entrada válida.";
  }

  if (original && original.entryDate < currentDate) {
    if (values.entryDate !== original.entryDate) {
      return "La fecha histórica de entrada debe conservarse.";
    }
  } else if (values.entryDate < currentDate) {
    return "No se permiten nuevas entradas en fechas anteriores a hoy.";
  }

  if (values.exitDate) {
    if (!validDate(values.exitDate)) {
      return "Ingresá una fecha de salida válida.";
    }

    if (original?.exitDate && original.exitDate < currentDate) {
      if (values.exitDate !== original.exitDate) {
        return "La fecha histórica de salida debe conservarse.";
      }
    } else if (values.exitDate < currentDate) {
      return "No se permiten nuevas salidas en fechas anteriores a hoy.";
    }

    if (values.exitDate < values.entryDate) {
      return "La salida no puede ser anterior a la entrada.";
    }
  }

  return "";
}

// ==================== FORMULARIOS ====================

function openRecord(mode = "new", id = "") {
  if (storageBlocked) {
    alert("Recuperá el libro antes de registrar o corregir expedientes.");
    return;
  }

  const record = records.find(item => item.id === id);

  if (mode !== "new" && !record) {
    notify("El expediente ya no está disponible.");
    return;
  }

  if (mode === "exit" && record.exitDate) {
    notify("Este expediente ya tiene una salida registrada.");
    return;
  }

  formMode = mode;

  $("recordForm").reset();
  $("formError").textContent = "";
  $("recordId").value = record?.id || "";

  for (const field of FIELDS) {
    $(field).disabled = false;
    $(field).readOnly = false;
    $(field).value = record?.[field] || "";
  }

  $("entrySection").hidden = mode === "exit";

  const showExit = mode === "exit" || Boolean(record?.exitDate);

  $("exitSection").hidden = !showExit;
  $("exitSummary").hidden = mode !== "exit";
  $("clearExit").hidden = !(mode === "edit" && record?.exitDate);

  $("entryDate").required = mode !== "exit";
  $("expediente").required = mode !== "exit";
  $("exitDate").required = showExit;
  $("office").required = showExit;

  // Los campos ocultos no participan en la validación nativa.
  for (const field of ["entryDate", "expediente", "sigla", "observations"]) {
    $(field).disabled = mode === "exit";
  }

  for (const field of EXIT_FIELDS) {
    $(field).disabled = !showExit;
  }

  if (mode === "new") {
    $("entryDate").value = today();
    $("dialogTitle").textContent = "Nueva entrada";
    $("dialogDescription").textContent =
      "Completá los datos del expediente que recibe la oficina.";
    $("saveButton").textContent = "Guardar entrada";
  }

  if (mode === "edit") {
    $("dialogTitle").textContent = "Corregir expediente";
    $("dialogDescription").textContent =
      "Actualizá los datos necesarios y guardá los cambios.";
    $("saveButton").textContent = "Guardar cambios";
  }

  if (mode === "exit") {
    $("exitDate").value =
      record.entryDate > today() ? record.entryDate : today();

    $("dialogTitle").textContent = "Dar salida";
    $("dialogDescription").textContent =
      "Indicá cuándo sale el expediente y qué oficina lo recibe.";
    $("saveButton").textContent = "Confirmar salida";

    $("exitSummary").innerHTML = `
      <strong>Expediente ${escapeHTML(record.expediente)}</strong>
      <span>
        Sigla: ${escapeHTML(record.sigla) || "Sin sigla"} ·
        Entrada: ${formatDate(record.entryDate)}
      </span>
    `;
  }

  configureDates(record);

  const position = record?.position || nextPosition();

  $("recordLocation").textContent =
    `Hoja ${sheetOf({ position })} · Renglón ${rowOf({ position })}`;

  $("recordDialog").showModal();

  setTimeout(() => {
    $(mode === "exit" ? "office" : "expediente").focus();
  }, 0);
}

function closeRecord() {
  $("recordDialog").close();
}

function saveRecord(event) {
  event.preventDefault();

  const id = $("recordId").value;
  const original = records.find(record => record.id === id);

  if (formMode !== "new" && !original) {
    $("formError").textContent =
      "El expediente cambió. Cerrá el formulario y volvé a abrirlo.";
    return;
  }

  const values = {};

  for (const field of FIELDS) {
    values[field] = $(field).disabled
      ? original?.[field] || ""
      : $(field).value.trim();
  }

  if (!values.expediente) {
    $("formError").textContent = "Ingresá el número de expediente.";
    return;
  }

  const dateError = validateMovementDates(values, original);

  if (dateError) {
    $("formError").textContent = dateError;
    return;
  }

  const hasExitData = EXIT_FIELDS.some(field => values[field]);

  if (hasExitData && (!values.exitDate || !values.office)) {
    $("formError").textContent =
      "Completá la fecha de salida y la oficina destino.";
    return;
  }

  if (formMode === "exit" && !values.exitDate) {
    $("formError").textContent = "Completá los datos de salida.";
    return;
  }

  const duplicate = records.find(record =>
    record.id !== id &&
    !record.exitDate &&
    normalize(record.expediente.trim()) === normalize(values.expediente) &&
    normalize(record.sigla.trim()) === normalize(values.sigla)
  );

  if (
    formMode !== "exit" &&
    duplicate &&
    !confirm(
      "Ya existe un expediente con ese número y sigla en oficina.\n" +
      `Hoja ${sheetOf(duplicate)}, renglón ${rowOf(duplicate)}.\n\n` +
      "¿Querés guardar igualmente?"
    )
  ) {
    return;
  }

  const timestamp = new Date().toISOString();

  const saved = {
    ...values,
    id: original?.id || makeId(),
    position: original?.position || nextPosition(),
    createdAt: original?.createdAt || timestamp,
    updatedAt: timestamp
  };

  const nextRecords = original
    ? records.map(record => record.id === id ? saved : record)
    : [...records, saved];

  if (!persist(nextRecords)) return;

  const message = {
    new: "Entrada registrada correctamente.",
    edit: "Cambios guardados.",
    exit: "Salida registrada correctamente."
  }[formMode];

  // Mostrar el registro guardado sin que los filtros lo oculten.
  currentStatus = saved.exitDate ? "out" : "pending";
  $("searchInput").value = "";
  $("periodFilter").value = "all";
  currentSheet = sheetOf(saved);

  closeRecord();
  render();
  notify(message);
}

function cancelExit() {
  if (
    !confirm(
      "¿Querés anular la salida?\n\n" +
      "Al guardar, el expediente volverá a figurar en oficina."
    )
  ) {
    return;
  }

  for (const field of EXIT_FIELDS) {
    $(field).value = "";
    $(field).required = false;
  }

  $("exitSection").hidden = true;
  $("clearExit").hidden = true;

  // Se mantienen habilitados para guardar los valores vacíos.
  notify("Salida quitada del formulario. Guardá para confirmar.");
}

// ==================== RESPALDOS ====================

function exportBackup() {
  if (storageBlocked) {
    alert("Primero recuperá el libro con un respaldo válido.");
    return;
  }

  download(
    `respaldo-libro-matriz-${today()}.json`,
    JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      records
    }, null, 2),
    "application/json;charset=utf-8"
  );

  notify("Respaldo descargado.");
}

async function importBackup(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const data = JSON.parse(await file.text());

    if (data.version !== 1) {
      throw new Error("Versión de respaldo no compatible.");
    }

    // Los respaldos pueden contener fechas históricas.
    const imported = validateRecords(data.records);

    if (
      !confirm(
        `Se importarán ${imported.length} expedientes.\n\n` +
        "Esto reemplazará el libro actual de este navegador. " +
        "Descargá un respaldo del libro actual si necesitás conservarlo.\n\n" +
        "¿Querés continuar?"
      )
    ) {
      return;
    }

    if (!persist(imported, true)) return;

    currentStatus = "all";
    resetFilters();
    notify("Libro recuperado correctamente.");
  } catch (error) {
    alert(`No se pudo importar el respaldo:\n${error.message}`);
  } finally {
    event.target.value = "";
  }
}

// ==================== IMPRESIÓN Y PDF ====================

function printRow(record, reference) {
  return `
    <tr>
      <td>${escapeHTML(reference)}</td>
      <td>${record ? formatDate(record.entryDate) : ""}</td>
      <td class="observations">
        ${record ? escapeHTML(record.observations) : ""}
      </td>
      <td>${record ? escapeHTML(record.expediente) : ""}</td>
      <td>${record ? escapeHTML(record.sigla) : ""}</td>
      <td>${record ? formatDate(record.exitDate) : ""}</td>
      <td>${record ? escapeHTML(record.office) : ""}</td>
      <td>${record ? escapeHTML(record.libreta) : ""}</td>
      <td>${record ? escapeHTML(record.foliatura) : ""}</td>
    </tr>
  `;
}

function printTable(rows, referenceTitle) {
  return `
    <table>
      <thead>
        <tr>
          <th>${referenceTitle}</th>
          <th>Fecha entrada</th>
          <th>Observaciones</th>
          <th>Expediente</th>
          <th>Sigla</th>
          <th>Fecha salida</th>
          <th>Oficina destino</th>
          <th>Libreta</th>
          <th>Foliatura</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function showPrintDocument(title, pages) {
  const popup = window.open("", "_blank");

  if (!popup) {
    alert("Permití las ventanas emergentes para abrir el reporte.");
    return;
  }

  popup.document.open();

  popup.document.write(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>${escapeHTML(title)}</title>

      <style>
        @page {
          size: A4 landscape;
          margin: 8mm;
        }

        * { box-sizing: border-box; }

        body {
          margin: 0;
          color: #111;
          font-family: Arial, sans-serif;
        }

        .controls {
          padding: 16px;
          background: #edf3ff;
          font-size: 13px;
          line-height: 1.6;
        }

        button {
          padding: 10px 16px;
          margin-right: 12px;
          cursor: pointer;
        }

        .page {
          padding: 8mm;
          break-after: page;
        }

        .page:last-child { break-after: auto; }

        h1 {
          margin: 0 0 5px;
          font-size: 16px;
        }

        p {
          margin: 0 0 8px;
          font-size: 10px;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
        }

        th, td {
          border: 1px solid #555;
          padding: 3px;
          font-size: 9px;
          vertical-align: middle;
          overflow-wrap: anywhere;
        }

        th {
          background: #edf0f5;
          height: 9mm;
        }

        td { height: 4.6mm; }

        th:nth-child(1) { width: 6%; }
        th:nth-child(2) { width: 9%; }
        th:nth-child(3) { width: 23%; }
        th:nth-child(4) { width: 13%; }
        th:nth-child(5) { width: 6%; }
        th:nth-child(6) { width: 9%; }
        th:nth-child(7) { width: 17%; }
        th:nth-child(8) { width: 8%; }
        th:nth-child(9) { width: 9%; }

        .observations { white-space: pre-wrap; }

        tr { break-inside: avoid; }

        .signature {
          margin-top: 8px;
          font-size: 9px;
        }

        @media print {
          .controls { display: none; }
          .page { padding: 0; }

          th {
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
        }
      </style>
    </head>

    <body>
      <div class="controls">
        <button onclick="window.print()">Imprimir / Guardar PDF</button>
        Elegí “Guardar como PDF” como destino.
        Usá A4 horizontal y desactivá los encabezados y pies del navegador.
        Si hay textos extensos, revisá la escala en la vista previa.
      </div>

      ${pages.join("")}
    </body>
    </html>
  `);

  popup.document.close();
}

function printCurrentSheet() {
  const sheetRecords = records.filter(
    record => sheetOf(record) === currentSheet
  );

  const byRow = new Map(
    sheetRecords.map(record => [rowOf(record), record])
  );

  let rows = "";

  for (let row = 1; row <= ROWS_PER_SHEET; row++) {
    rows += printRow(byRow.get(row), row);
  }

  const page = `
    <section class="page">
      <h1>Libro matriz — Hoja ${currentSheet}</h1>

      <p>
        ${sheetRecords.length}/33 renglones ocupados.
        Hoja completa sin filtros.
        Emitida el ${formatDate(today())}.
      </p>

      ${printTable(rows, "Renglón")}

      <div class="signature">
        Responsable: ____________________ Firma: ____________________
      </div>
    </section>
  `;

  showPrintDocument(`Libro matriz - Hoja ${currentSheet}`, [page]);
}

function printReport() {
  const filtered = filteredRecords();
  if (!filtered.length) return;

  const pages = [];
  const totalPages = Math.ceil(filtered.length / ROWS_PER_SHEET);

  for (let start = 0; start < filtered.length; start += ROWS_PER_SHEET) {
    const group = filtered.slice(start, start + ROWS_PER_SHEET);
    const pageNumber = pages.length + 1;

    let rows = group.map(record => printRow(
      record,
      `${sheetOf(record)}/${rowOf(record)}`
    )).join("");

    for (let index = group.length; index < ROWS_PER_SHEET; index++) {
      rows += printRow(null, "");
    }

    pages.push(`
      <section class="page">
        <h1>
          Reporte del libro matriz — Página ${pageNumber}/${totalPages}
        </h1>

        <p>
          ${escapeHTML(queryDescription())}.
          Total: ${filtered.length} expedientes.
          Referencia: hoja/renglón.
          Emitido el ${formatDate(today())}.
        </p>

        ${printTable(rows, "Hoja / renglón")}

        <div class="signature">
          Responsable: ____________________ Firma: ____________________
        </div>
      </section>
    `);
  }

  showPrintDocument(`Reporte libro matriz ${today()}`, pages);
}

// ==================== EXCEL XLSX ====================
// Genera un XLSX real, sin dependencias externas.
// Las celdas son de texto para conservar ceros iniciales
// y evitar que un dato se interprete como una fórmula.

function escapeXML(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;"
    })[character]);
}

function columnName(index) {
  let result = "";

  for (index++; index > 0; index = Math.floor((index - 1) / 26)) {
    result = String.fromCharCode(65 + ((index - 1) % 26)) + result;
  }

  return result;
}

const crcTable = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index++) {
    let value = index;

    for (let bit = 0; bit < 8; bit++) {
      value = value & 1
        ? 0xEDB88320 ^ (value >>> 1)
        : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;

  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createZip(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const centralParts = [];

  let offset = 0;
  let centralSize = 0;

  for (const [filename, content] of Object.entries(files)) {
    const name = encoder.encode(filename);
    const bytes = encoder.encode(content);
    const checksum = crc32(bytes);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);

    localView.setUint32(0, 0x04034B50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(12, 33, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, bytes.length, true);
    localView.setUint32(22, bytes.length, true);
    localView.setUint16(26, name.length, true);

    local.set(name, 30);
    parts.push(local, bytes);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);

    centralView.setUint32(0, 0x02014B50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(14, 33, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, bytes.length, true);
    centralView.setUint32(24, bytes.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);

    central.set(name, 46);
    centralParts.push(central);

    centralSize += central.length;
    offset += local.length + bytes.length;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  const count = Object.keys(files).length;

  endView.setUint32(0, 0x06054B50, true);
  endView.setUint16(8, count, true);
  endView.setUint16(10, count, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return new Blob(
    [...parts, ...centralParts, end],
    {
      type:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }
  );
}

function exportExcel() {
  const filtered = filteredRecords();
  if (!filtered.length) return;

  const headers = [
    "Hoja",
    "Renglón",
    "Fecha entrada",
    "Observaciones",
    "Expediente",
    "Sigla",
    "Fecha salida",
    "Oficina destino",
    "Libreta",
    "Foliatura",
    "Estado"
  ];

  const data = [
    headers,
    ...filtered.map(record => [
      sheetOf(record),
      rowOf(record),
      formatDate(record.entryDate),
      record.observations,
      record.expediente,
      record.sigla,
      formatDate(record.exitDate),
      record.office,
      record.libreta,
      record.foliatura,
      record.exitDate ? "Salido" : "En oficina"
    ])
  ];

  const rowXML = data.map((row, rowIndex) => `
    <row r="${rowIndex + 1}">
      ${row.map((value, columnIndex) => `
        <c
          r="${columnName(columnIndex)}${rowIndex + 1}"
          t="inlineStr"
          s="${rowIndex === 0 ? 1 : 0}"
        >
          <is><t xml:space="preserve">${escapeXML(value)}</t></is>
        </c>
      `).join("")}
    </row>
  `).join("");

  const widths = [8, 10, 16, 45, 24, 14, 16, 30, 16, 18, 16];

  const columns = widths.map((width, index) =>
    `<col min="${index + 1}" max="${index + 1}" ` +
    `width="${width}" customWidth="1"/>`
  ).join("");

  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels"
          ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml"
          ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        <Override PartName="/xl/worksheets/sheet1.xml"
          ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
        <Override PartName="/xl/styles.xml"
          ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
      </Types>`,

    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1"
          Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
          Target="xl/workbook.xml"/>
      </Relationships>`,

    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <workbook
        xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="Libro matriz" sheetId="1" r:id="rId1"/>
        </sheets>
      </workbook>`,

    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1"
          Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
          Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2"
          Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
          Target="styles.xml"/>
      </Relationships>`,

    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <fonts count="2">
          <font><sz val="11"/><name val="Calibri"/></font>
          <font><b/><sz val="11"/><name val="Calibri"/></font>
        </fonts>
        <fills count="2">
          <fill><patternFill patternType="none"/></fill>
          <fill><patternFill patternType="gray125"/></fill>
        </fills>
        <borders count="1">
          <border><left/><right/><top/><bottom/><diagonal/></border>
        </borders>
        <cellStyleXfs count="1">
          <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
        </cellStyleXfs>
        <cellXfs count="2">
          <xf numFmtId="49" fontId="0" fillId="0" borderId="0"
            xfId="0" applyNumberFormat="1" applyAlignment="1">
            <alignment vertical="top" wrapText="1"/>
          </xf>
          <xf numFmtId="49" fontId="1" fillId="0" borderId="0"
            xfId="0" applyFont="1" applyAlignment="1">
            <alignment vertical="top" wrapText="1"/>
          </xf>
        </cellXfs>
        <cellStyles count="1">
          <cellStyle name="Normal" xfId="0" builtinId="0"/>
        </cellStyles>
      </styleSheet>`,

    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <dimension ref="A1:K${data.length}"/>
        <sheetViews>
          <sheetView workbookViewId="0">
            <pane ySplit="1" topLeftCell="A2"
              activePane="bottomLeft" state="frozen"/>
          </sheetView>
        </sheetViews>
        <sheetFormatPr defaultRowHeight="18"/>
        <cols>${columns}</cols>
        <sheetData>${rowXML}</sheetData>
        <autoFilter ref="A1:K${data.length}"/>
      </worksheet>`
  };

  const dateLabel = $("periodFilter").value === "day"
    ? $("dateFilter").value
    : today();

  download(
    `libro-matriz-${currentStatus}-${dateLabel}.xlsx`,
    createZip(files)
  );

  notify("Excel descargado.");
}

// ==================== EVENTOS ====================

$("newButton").addEventListener("click", () => openRecord("new"));

document.querySelector(".navigation").addEventListener("click", event => {
  const button = event.target.closest("button[data-status]");
  if (!button) return;

  currentStatus = button.dataset.status;
  currentSheet = 1;
  render();
});

$("tableBody").addEventListener("click", event => {
  const button = event.target.closest("button[data-id]");
  if (!button) return;

  openRecord(button.dataset.action, button.dataset.id);
});

$("searchInput").addEventListener("input", () => {
  currentSheet = 1;
  render();
});

$("periodFilter").addEventListener("change", () => {
  if (!$("dateFilter").value) {
    $("dateFilter").value = today();
  }

  currentSheet = 1;
  render();
});

$("dateFilter").addEventListener("change", () => {
  if (!$("dateFilter").value) {
    $("dateFilter").value = today();
  }

  currentSheet = 1;
  render();
});

$("resetFilters").addEventListener("click", resetFilters);

$("previousPage").addEventListener("click", () => changeSheet(-1));
$("nextPage").addEventListener("click", () => changeSheet(1));

$("pageSelect").addEventListener("change", event => {
  currentSheet = Number(event.target.value);
  render();
});

$("recordForm").addEventListener("submit", saveRecord);

$("closeDialog").addEventListener("click", closeRecord);
$("cancelDialog").addEventListener("click", closeRecord);
$("clearExit").addEventListener("click", cancelExit);

$("entryDate").addEventListener("change", updateExitMinimum);

$("excelButton").addEventListener("click", exportExcel);
$("reportButton").addEventListener("click", printReport);
$("printSheetButton").addEventListener("click", printCurrentSheet);

$("backupButton").addEventListener("click", exportBackup);

$("restoreButton").addEventListener("click", () => {
  $("restoreInput").click();
});

$("restoreInput").addEventListener("change", importBackup);

window.addEventListener("storage", event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;

  if ($("recordDialog").open) {
    closeRecord();
    notify("El libro cambió en otra pestaña. Volvé a abrir el expediente.");
  } else {
    notify("Libro actualizado desde otra pestaña.");
  }

  readStorage();
  render();
});

// Actualiza la fecha y la consulta al volver a la aplicación.
window.addEventListener("focus", () => {
  render();

  if ($("recordDialog").open) {
    const record = records.find(item => item.id === $("recordId").value);
    configureDates(record);
  }
});

// ==================== INICIO ====================

$("dateFilter").value = today();

readStorage();
render();