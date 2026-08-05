/*
 * Data store: everything the school owns lives in one object, persisted to
 * localStorage. No server, no database — the office computer keeps its own
 * copy, and JSON backup/restore moves it between machines.
 */
(function (root, factory) {
  var api = factory(root.SeedData, root.CSV);
  root.Store = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SeedData, CSV) {
  'use strict';

  var KEY = 'teacher-substitution.v1';
  var data = null;
  var listeners = [];

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        data = migrate(JSON.parse(raw));
        return data;
      }
    } catch (err) {
      console.warn('Saved data could not be read, starting from the sample school.', err);
    }
    data = SeedData.build();
    save();
    return data;
  }

  function migrate(loaded) {
    var base = SeedData.build();
    var merged = Object.assign({}, base, loaded);
    merged.settings = Object.assign({}, base.settings, loaded.settings || {});
    ['teachers', 'classes', 'timetable', 'absences'].forEach(function (key) {
      if (!Array.isArray(merged[key])) { merged[key] = []; }
    });
    if (!merged.plans || typeof merged.plans !== 'object') { merged.plans = {}; }
    return merged;
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (err) {
      // Quota exhausted is the realistic failure here; the user needs to know
      // their edit did not stick rather than discovering it tomorrow.
      alert('Could not save to this browser\'s storage: ' + err.message +
        '\n\nExport a backup from Settings before closing the page.');
    }
    listeners.forEach(function (fn) { fn(data); });
  }

  function get() { return data || load(); }
  function onChange(fn) { listeners.push(fn); }

  function update(mutator) {
    mutator(get());
    save();
  }

  function reset() {
    data = SeedData.build();
    save();
  }

  function clearAll() {
    data = {
      version: 1,
      settings: Object.assign({}, SeedData.build().settings, { schoolName: 'My School' }),
      teachers: [], classes: [], timetable: [], absences: [], plans: {}
    };
    save();
  }

  // ---------------------------------------------------------------- lookups

  function teacher(id) {
    return get().teachers.find(function (t) { return t.id === id; }) || null;
  }

  function teacherName(id) {
    var t = teacher(id);
    return t ? t.name : (id || '—');
  }

  function teacherLabel(id) {
    var t = teacher(id);
    return t ? t.name + ' (' + t.code + ')' : (id || '—');
  }

  function teacherByCode(code) {
    var wanted = String(code || '').trim().toLowerCase();
    return get().teachers.find(function (t) {
      return String(t.code).toLowerCase() === wanted || String(t.id).toLowerCase() === wanted;
    }) || null;
  }

  function classNames() {
    return get().classes.map(function (c) { return c.name || c.id; });
  }

  function subjects() {
    var set = new Set();
    get().teachers.forEach(function (t) {
      (t.subjects || []).forEach(function (s) { set.add(s); });
    });
    get().timetable.forEach(function (r) { if (r.subject) { set.add(r.subject); } });
    return Array.from(set).sort();
  }

  // ---------------------------------------------------------------- teachers

  function saveTeacher(input) {
    update(function (d) {
      var existing = input.id && d.teachers.find(function (t) { return t.id === input.id; });
      var record = existing || { id: input.code || ('T' + (d.teachers.length + 1)), unavailable: [] };
      record.code = input.code || record.id;
      record.name = input.name;
      record.subjects = input.subjects || [];
      record.isReserve = !!input.isReserve;
      record.active = input.active !== false;
      record.maxSubstitutionsPerDay = input.maxSubstitutionsPerDay || null;
      record.maxSubstitutionsPerWeek = input.maxSubstitutionsPerWeek || null;
      if (!existing) { d.teachers.push(record); }
    });
  }

  function removeTeacher(id) {
    update(function (d) {
      d.teachers = d.teachers.filter(function (t) { return t.id !== id; });
      d.timetable = d.timetable.filter(function (r) { return r.teacherId !== id; });
      d.absences = d.absences.filter(function (a) { return a.teacherId !== id; });
    });
  }

  // ---------------------------------------------------------------- absences

  function addAbsence(input) {
    var id = 'A' + Date.now() + Math.floor(Math.random() * 1000);
    update(function (d) {
      d.absences.push({
        id: id,
        date: input.date,
        teacherId: input.teacherId,
        periods: input.periods && input.periods.length ? input.periods : 'all',
        reason: input.reason || ''
      });
    });
    return id;
  }

  function removeAbsence(id) {
    update(function (d) {
      d.absences = d.absences.filter(function (a) { return a.id !== id; });
    });
  }

  function absencesOn(date) {
    return get().absences.filter(function (a) { return a.date === date; });
  }

  // ---------------------------------------------------------------- plans

  function savePlan(plan) {
    update(function (d) { d.plans[plan.date] = plan; });
  }

  function planFor(date) {
    return get().plans[date] || null;
  }

  function deletePlan(date) {
    update(function (d) { delete d.plans[date]; });
  }

  // ---------------------------------------------------------------- import

  /**
   * Teachers CSV: Code, Name, Subjects (separated by ; or |), Reserve
   * Replaces the teacher list; timetable rows keep pointing at matching codes.
   */
  function importTeachersCSV(text) {
    var parsed = CSV.parse(text);
    var added = 0;
    var skipped = [];
    update(function (d) {
      var byCode = new Map(d.teachers.map(function (t) { return [String(t.code).toLowerCase(), t]; }));
      parsed.rows.forEach(function (row, i) {
        var code = row.code || row.teachercode || row.id;
        var name = row.name || row.teacher || row.teachername;
        if (!code || !name) {
          skipped.push('row ' + (i + 2) + ': needs both a code and a name');
          return;
        }
        var subjectList = String(row.subjects || row.subject || '')
          .split(/[;|]/).map(function (s) { return s.trim(); }).filter(Boolean);
        var reserve = /^(y|yes|true|1)$/i.test(String(row.reserve || row.isreserve || ''));
        var existing = byCode.get(String(code).toLowerCase());
        if (existing) {
          existing.name = name;
          existing.subjects = subjectList;
          existing.isReserve = reserve;
        } else {
          var record = {
            id: code, code: code, name: name, subjects: subjectList,
            isReserve: reserve, active: true, unavailable: []
          };
          d.teachers.push(record);
          byCode.set(String(code).toLowerCase(), record);
        }
        added++;
      });
    });
    return { imported: added, skipped: skipped };
  }

  /**
   * Timetable CSV: Day, Period, Class, Subject, Teacher Code
   * Replaces the whole timetable — a partial timetable would silently leave
   * stale periods behind and produce wrong vacancy lists.
   */
  function importTimetableCSV(text) {
    var parsed = CSV.parse(text);
    var rows = [];
    var skipped = [];
    var classSet = new Set();

    parsed.rows.forEach(function (row, i) {
      var line = i + 2;
      var day = titleDay(row.day);
      var period = Number(row.period);
      var className = row.class || row.classname || row.section;
      var code = row.teachercode || row.teacher || row.code;
      if (!day) { skipped.push('row ' + line + ': unknown day "' + row.day + '"'); return; }
      if (!period || period < 1) { skipped.push('row ' + line + ': bad period "' + row.period + '"'); return; }
      if (!className) { skipped.push('row ' + line + ': missing class'); return; }
      var t = teacherByCode(code);
      if (!t) { skipped.push('row ' + line + ': no teacher with code "' + code + '"'); return; }
      rows.push({
        day: day, period: period, classId: className.trim(),
        subject: (row.subject || '').trim(), teacherId: t.id
      });
      classSet.add(className.trim());
    });

    var clashes = findClashes(rows);
    if (clashes.length) {
      return { imported: 0, skipped: skipped, clashes: clashes };
    }

    update(function (d) {
      d.timetable = rows;
      d.classes = Array.from(classSet).sort().map(function (c) { return { id: c, name: c }; });
      var maxPeriod = rows.reduce(function (m, r) { return Math.max(m, r.period); }, 0);
      if (maxPeriod) { d.settings.periodsPerDay = maxPeriod; }
    });
    return { imported: rows.length, skipped: skipped, clashes: [] };
  }

  /** A teacher in two classrooms at once means the source timetable is wrong. */
  function findClashes(rows) {
    var seen = new Map();
    var clashes = [];
    rows.forEach(function (r) {
      var key = r.teacherId + '|' + r.day + '|' + r.period;
      if (seen.has(key)) {
        clashes.push(teacherLabel(r.teacherId) + ' is booked for both ' +
          seen.get(key) + ' and ' + r.classId + ' on ' + r.day + ' period ' + r.period);
      } else {
        seen.set(key, r.classId);
      }
    });
    return clashes;
  }

  function titleDay(value) {
    var v = String(value || '').trim().slice(0, 3).toLowerCase();
    var match = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].find(function (d) {
      return d.toLowerCase() === v;
    });
    return match || null;
  }

  // ---------------------------------------------------------------- backup

  function exportJSON() {
    return JSON.stringify(get(), null, 2);
  }

  function importJSON(text) {
    var parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.teachers)) {
      throw new Error('That file does not look like a substitution backup.');
    }
    data = migrate(parsed);
    save();
  }

  return {
    KEY: KEY,
    load: load, get: get, save: save, update: update, onChange: onChange,
    reset: reset, clearAll: clearAll,
    teacher: teacher, teacherName: teacherName, teacherLabel: teacherLabel,
    teacherByCode: teacherByCode, classNames: classNames, subjects: subjects,
    saveTeacher: saveTeacher, removeTeacher: removeTeacher,
    addAbsence: addAbsence, removeAbsence: removeAbsence, absencesOn: absencesOn,
    savePlan: savePlan, planFor: planFor, deletePlan: deletePlan,
    importTeachersCSV: importTeachersCSV, importTimetableCSV: importTimetableCSV,
    findClashes: findClashes,
    exportJSON: exportJSON, importJSON: importJSON
  };
});
