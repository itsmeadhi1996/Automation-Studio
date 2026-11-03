import { randomInt, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { queryDatabase } from './database.mjs';
import { parseCsv } from './datasets.mjs';
import { normalizeLocalData } from './local-data-schema.mjs';

export { normalizeLocalData } from './local-data-schema.mjs';

export const fileLimit = 1024 * 1024;

const MAX_CELL_LENGTH = 10000;
const MAX_EXCEL_ROWS = 101;
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 100;
const MAX_HEADER_LENGTH = 120;
const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const RANDOM_DATE_START = Date.UTC(2000, 0, 1);
const RANDOM_DATE_SPAN_DAYS = 36525;
const DAY_MS = 86400000;
const TRUNCATED_QUERY_MESSAGE =
  'Query result is too large. Select fewer rows/columns or shorter values (maximum 25 rows, 40 columns, 128 characters per cell).';

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function text(value, label, max = MAX_CELL_LENGTH) {
  check(typeof value === 'string' && value.length <= max, `${label} must be text of at most ${max} characters`);
  return value;
}

function stringCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  check(
    ['string', 'number', 'boolean'].includes(typeof value),
    'Data cells must contain text, numbers, booleans or dates',
  );
  return text(String(value), 'Cell value');
}

function excelCellText(cell) {
  if (cell.type === ExcelJS.ValueType.Formula) {
    check(cell.result !== undefined, 'Save formula results in Excel before importing');
    return stringCell(cell.result);
  }
  if (cell.value instanceof Date) {
    return cell.value.toISOString();
  }
  return text(cell.text, 'Cell value');
}

async function readExcelTable(bytes, sheet) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes);
  } catch {
    throw new Error('Cannot read this Excel workbook. Use a valid, unencrypted .xlsx file.');
  }

  const worksheet = sheet ? workbook.getWorksheet(sheet) : workbook.worksheets[0];
  check(worksheet, 'Worksheet not found');
  check(
    worksheet.rowCount <= MAX_EXCEL_ROWS && worksheet.columnCount <= MAX_TABLE_COLUMNS,
    'Excel supports a header and up to 100 data rows / 100 columns',
  );

  const columns = [];
  for (let column = 1; column <= worksheet.columnCount; column += 1) {
    columns.push(excelCellText(worksheet.getRow(1).getCell(column)));
  }
  const rows = [];
  for (let row = 2; row <= worksheet.rowCount; row += 1) {
    rows.push(columns.map((_, column) => excelCellText(worksheet.getRow(row).getCell(column + 1))));
  }
  return { columns, rows, sheets: workbook.worksheets.map((item) => item.name) };
}

function parseJsonRecords(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
  } catch {
    throw new Error('Invalid JSON data file');
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

function tableFromRecords(records) {
  const isRecord = (item) => item && typeof item === 'object' && !Array.isArray(item);
  check(
    records.length >= 1 && records.length <= MAX_TABLE_ROWS && records.every(isRecord),
    'Use 1–100 data rows as JSON objects or CSV records',
  );

  const columns = Object.keys(records[0]);
  const hasSameColumns = (record) =>
    Object.keys(record).length === columns.length && columns.every((column) => Object.hasOwn(record, column));
  check(records.every(hasSameColumns), 'All data rows must contain the same columns');

  const rows = records.map((record) => columns.map((column) => stringCell(record[column])));
  return { columns, rows, sheets: [] };
}

export async function readDataTable(name, bytes, sheet = '') {
  check(bytes.length <= fileLimit, 'Test data files must be 1 MB or smaller');

  const extension = path.extname(name).toLowerCase();
  let table;
  if (extension === '.xlsx') {
    table = await readExcelTable(bytes, sheet);
  } else if (extension === '.csv') {
    table = tableFromRecords(parseCsv(bytes.toString('utf8')));
  } else if (extension === '.json') {
    table = tableFromRecords(parseJsonRecords(bytes));
  } else {
    throw new Error('Choose .xlsx, .csv or .json; save legacy .xls files as .xlsx first');
  }

  const { columns, rows } = table;
  const headersAreValid =
    columns.length >= 1 &&
    columns.length <= MAX_TABLE_COLUMNS &&
    columns.every((column) => column.trim() && column.length <= MAX_HEADER_LENGTH) &&
    new Set(columns).size === columns.length;
  check(headersAreValid, 'Use 1–100 unique, nonempty column headers (up to 120 characters)');
  check(rows.length > 0, 'The data source has no data rows');
  return table;
}

export async function loadDataFile(config, readUpload) {
  if (config.fileId) {
    check(readUpload, 'Uploaded file storage is unavailable');
    const file = await readUpload(config.fileId);
    return readDataTable(file.name, Buffer.from(file.content, 'base64'), config.sheet);
  }
  check(path.isAbsolute(config.filePath || ''), 'Choose a test data file');
  const info = await stat(config.filePath);
  check(info.isFile() && info.size <= fileLimit, 'Test data files must be regular files of 1 MB or smaller');
  return readDataTable(config.filePath, await readFile(config.filePath), config.sheet);
}

function randomToken(length) {
  let token = '';
  for (let index = 0; index < length; index += 1) {
    token += RANDOM_ALPHABET[randomInt(RANDOM_ALPHABET.length)];
  }
  return token;
}

function randomValue(config) {
  switch (config.kind) {
    case 'uuid':
      return randomUUID();
    case 'number':
      return String(randomInt(config.min, config.max + 1));
    case 'date': {
      const day = RANDOM_DATE_START + randomInt(RANDOM_DATE_SPAN_DAYS) * DAY_MS;
      return new Date(day).toISOString().slice(0, 10);
    }
    case 'email':
      return `${randomToken(config.length)}@example.test`;
    default:
      return randomToken(config.length);
  }
}

async function loadDatabaseTable(config, context, query) {
  const profile = context.profiles?.find((item) => item.id === config.profileId);
  check(profile, 'Local test data database connection was removed');
  const table = await query(profile, config.query);
  check(!table.truncated && !table.valueTruncated, TRUNCATED_QUERY_MESSAGE);
  return table;
}

function selectTableCell(table, config) {
  check(table.rows.length, 'The data source returned no rows');

  const column = config.column ? table.columns.indexOf(config.column) : 0;
  check(column >= 0, `Column not found: ${config.column}`);
  const columnName = table.columns[column];
  const occurrences = table.columns.filter((name) => name === columnName).length;
  check(occurrences === 1, 'Column name is ambiguous; use unique column names');

  const row = config.selection === 'random' ? randomInt(table.rows.length) : config.row - 1;
  check(row < table.rows.length, `Data row ${config.row} is unavailable`);
  return { value: stringCell(table.rows[row][column]), table, row: row + 1, column: columnName };
}

export async function resolveLocalValue(entry, context, { readUpload, query = queryDatabase } = {}) {
  const { config } = entry;
  switch (entry.source) {
    case 'manual':
      return { value: entry.value };
    case 'global':
    case 'environment': {
      const values = (entry.source === 'global' ? context.globals : context.environment) || {};
      check(Object.hasOwn(values, config.variable), `Source variable not found: ${config.variable}`);
      return { value: values[config.variable] };
    }
    case 'random':
      return { value: randomValue(config) };
    case 'database':
      return selectTableCell(await loadDatabaseTable(config, context, query), config);
    default:
      return selectTableCell(await loadDataFile(config, readUpload), config);
  }
}

export async function collectLocalData(entries, context, options = {}) {
  const local = {};
  const globals = {};
  for (const entry of normalizeLocalData(entries)) {
    if (options.signal?.aborted) {
      throw new Error('Run cancelled');
    }
    let result;
    try {
      result = await resolveLocalValue(entry, context, options);
    } catch (error) {
      throw new Error(`Local Test Data ${entry.name}: ${error.message}`);
    }
    local[entry.name] = text(result.value, 'Collected value');
    if (entry.keepGlobal) {
      globals[entry.name] = result.value;
    }
  }
  return { local, globals };
}
