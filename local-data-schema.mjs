import path from 'node:path';

const MAX_LOCAL_VARIABLES = 100;
const MAX_NAME_LENGTH = 120;
const MAX_VALUE_LENGTH = 10000;
const MAX_RANDOM_LENGTH = 256;
const MAX_RANDOM_BOUND = 1e12;
const MAX_DATA_ROW = 100;
const MAX_PROFILE_ID_LENGTH = 80;
const MAX_FILE_PATH_LENGTH = 2000;
const MAX_FILE_NAME_LENGTH = 250;

const SOURCES = ['manual', 'random', 'database', 'file', 'global', 'environment'];
const RANDOM_KINDS = ['uuid', 'text', 'number', 'email', 'date'];
const ROW_SELECTIONS = ['fixed', 'random'];
const RESERVED_NAMES = ['__proto__', 'constructor', 'prototype'];

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function text(value, label, max = MAX_VALUE_LENGTH) {
  check(typeof value === 'string' && value.length <= max, `${label} must be text of at most ${max} characters`);
  return value;
}

function isVariableName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]{0,119}$/.test(name) && !RESERVED_NAMES.includes(name);
}

function randomConfig(config) {
  check(RANDOM_KINDS.includes(config.kind), 'Choose a random generator');
  const result = { kind: config.kind };
  if (config.kind === 'text' || config.kind === 'email') {
    const validLength = Number.isInteger(config.length) && config.length >= 1 && config.length <= MAX_RANDOM_LENGTH;
    check(validLength, 'Random length must be 1–256');
    result.length = config.length;
  }
  if (config.kind === 'number') {
    const validBounds =
      Number.isSafeInteger(config.min) &&
      Number.isSafeInteger(config.max) &&
      config.min <= config.max &&
      config.min >= -MAX_RANDOM_BOUND &&
      config.max <= MAX_RANDOM_BOUND;
    check(validBounds, 'Choose whole-number bounds between -1000000000000 and 1000000000000');
    result.min = config.min;
    result.max = config.max;
  }
  return result;
}

function tabularConfig(config) {
  const selection = config.selection || 'fixed';
  const row = config.row ?? 1;
  const result = { column: text(config.column ?? '', 'Column', MAX_NAME_LENGTH) };
  check(ROW_SELECTIONS.includes(selection), 'Choose a row selection method');
  result.selection = selection;
  check(Number.isInteger(row) && row >= 1 && row <= MAX_DATA_ROW, 'Data row must be 1–100');
  result.row = row;
  return result;
}

function databaseConfig(config) {
  const result = tabularConfig(config);
  result.profileId = text(config.profileId ?? '', 'Database connection', MAX_PROFILE_ID_LENGTH);
  result.query = text(config.query ?? '', 'SELECT query', MAX_VALUE_LENGTH);
  check(
    result.profileId && /^\s*SELECT\b/i.test(result.query) && !result.query.includes(';'),
    'Choose a database connection and one SELECT statement without a semicolon',
  );
  return result;
}

function fileConfig(config) {
  const result = tabularConfig(config);
  result.sheet = text(config.sheet ?? '', 'Worksheet', MAX_NAME_LENGTH);
  if (config.fileId) {
    check(/^[a-f0-9-]{36}$/.test(config.fileId), 'Invalid uploaded file');
    result.fileId = config.fileId;
  } else {
    result.filePath = text(config.filePath ?? '', 'File path', MAX_FILE_PATH_LENGTH);
    check(path.isAbsolute(result.filePath), 'Enter an absolute file path or upload a file');
  }
  result.fileName = text(config.fileName ?? '', 'File name', MAX_FILE_NAME_LENGTH);
  return result;
}

function variableConfig(config) {
  const variable = text(config.variable ?? '', 'Source variable', MAX_NAME_LENGTH);
  check(isVariableName(variable), 'Select an existing source variable');
  return { variable };
}

function configForSource(source, config) {
  switch (source) {
    case 'random':
      return randomConfig(config);
    case 'database':
      return databaseConfig(config);
    case 'file':
      return fileConfig(config);
    case 'global':
    case 'environment':
      return variableConfig(config);
    default:
      return {};
  }
}

export function normalizeLocalData(input = []) {
  check(Array.isArray(input) && input.length <= MAX_LOCAL_VARIABLES, 'Maximum 100 local test variables');
  const names = new Set();
  return input.map((entry) => {
    check(entry && typeof entry === 'object', 'Invalid local test variable');
    const name = text(entry.name, 'Variable name', MAX_NAME_LENGTH);
    check(
      isVariableName(name),
      'Use a variable name beginning with a letter or underscore, followed by letters, numbers or underscores',
    );
    check(!names.has(name), `Duplicate local variable: ${name}`);
    names.add(name);

    const source = entry.source || 'manual';
    check(SOURCES.includes(source), 'Unsupported local data source');
    return {
      name,
      value: text(entry.value ?? '', 'Value'),
      keepGlobal: entry.keepGlobal === true,
      source,
      config: configForSource(source, entry.config || {}),
    };
  });
}
