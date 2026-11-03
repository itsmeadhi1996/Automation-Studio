const MAX_CSV_LENGTH = 1024 * 1024;
const MAX_DATA_ROWS = 100;
const MAX_COLUMNS = 500;
const MAX_CELL_LENGTH = 10000;
const VARIABLE_NAME = /^[_a-zA-Z][_a-zA-Z0-9]*$/;

function splitCsvRecords(source) {
  const records = [];
  let record = [];
  let cell = '';
  let insideQuotes = false;
  let afterClosingQuote = false;

  const endCell = () => {
    record.push(cell);
    cell = '';
    afterClosingQuote = false;
  };
  const endRecord = () => {
    endCell();
    if (record.some((value) => value !== '')) {
      records.push(record);
    }
    record = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (insideQuotes) {
      if (character !== '"') {
        cell += character;
      } else if (source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        insideQuotes = false;
        afterClosingQuote = true;
      }
      continue;
    }

    if (character === '"' && !cell && !afterClosingQuote) {
      insideQuotes = true;
    } else if (character === ',') {
      endCell();
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') {
        index += 1;
      }
      endRecord();
    } else if (afterClosingQuote || character === '"') {
      throw new Error('Invalid CSV quoting');
    } else {
      cell += character;
    }
  }

  if (insideQuotes) {
    throw new Error('CSV contains an unclosed quoted cell');
  }
  if (cell || record.length || afterClosingQuote) {
    endRecord();
  }
  return records;
}

export function parseCsv(text) {
  if (typeof text !== 'string' || text.length > MAX_CSV_LENGTH) {
    throw new Error('CSV must be text under 1 MB');
  }
  const [headers, ...rows] = splitCsvRecords(text.replace(/^﻿/, ''));

  const headersAreValid =
    headers?.length && new Set(headers).size === headers.length && headers.every((name) => VARIABLE_NAME.test(name));
  if (!headersAreValid) {
    throw new Error('CSV headers must be unique variable names, such as NAME or EMAIL');
  }
  if (rows.length > MAX_DATA_ROWS || headers.length > MAX_COLUMNS) {
    throw new Error('Maximum 100 data rows and 500 columns');
  }

  return rows.map((cells, rowIndex) => {
    if (cells.length !== headers.length || cells.some((cell) => cell.length > MAX_CELL_LENGTH)) {
      throw new Error(`CSV row ${rowIndex + 2} has an invalid number or size of cells`);
    }
    return Object.fromEntries(headers.map((header, columnIndex) => [header, cells[columnIndex]]));
  });
}
