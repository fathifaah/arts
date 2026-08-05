/*
 * Minimal CSV reader/writer.
 *
 * Schools hand over teacher lists and timetables as spreadsheet exports, so
 * import has to survive quoted fields, embedded commas and CRLF endings.
 * Kept dependency-free so the app still works from a USB stick with no
 * network.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.CSV = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Split CSV text into rows of raw string cells. */
  function parseRows(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var i = 0;
    var src = String(text || '').replace(/^﻿/, '');

    function endField() { row.push(field); field = ''; }
    function endRow() {
      endField();
      // Skip the blank row a trailing newline produces.
      if (row.length > 1 || row[0] !== '') { rows.push(row); }
      row = [];
    }

    while (i < src.length) {
      var ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { endField(); i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { endRow(); i++; continue; }
      field += ch; i++;
    }
    if (field !== '' || row.length) { endRow(); }
    return rows;
  }

  /**
   * Parse into objects keyed by header. Headers are matched loosely
   * (case and spacing insensitive) so "Teacher Code" and "teachercode" agree.
   */
  function parse(text) {
    var rows = parseRows(text);
    if (!rows.length) { return { headers: [], rows: [] }; }
    var headers = rows[0].map(function (h) { return String(h).trim(); });
    var records = rows.slice(1).map(function (cells) {
      var obj = {};
      headers.forEach(function (h, idx) {
        obj[normalise(h)] = (cells[idx] === undefined ? '' : String(cells[idx]).trim());
      });
      return obj;
    });
    return { headers: headers, rows: records };
  }

  function normalise(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function escapeCell(value) {
    var s = value === undefined || value === null ? '' : String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** Build CSV text from objects. `columns` is [{key, label}]. */
  function stringify(records, columns) {
    var lines = [columns.map(function (c) { return escapeCell(c.label); }).join(',')];
    records.forEach(function (rec) {
      lines.push(columns.map(function (c) {
        var value = typeof c.value === 'function' ? c.value(rec) : rec[c.key];
        return escapeCell(value);
      }).join(','));
    });
    return lines.join('\r\n');
  }

  return { parse: parse, parseRows: parseRows, stringify: stringify, normalise: normalise };
});
