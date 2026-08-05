/*
 * UI layer. Reads from Store, asks SubEngine for the arrangement, renders it,
 * and lets the office override any single assignment by hand.
 */
(function () {
  'use strict';

  var E = window.SubEngine;
  var state = {
    view: 'plan',
    plan: null,        // plan currently on screen (not necessarily saved)
    planSaved: false,
    ttMode: 'class',
    ttTarget: null
  };

  // ---------------------------------------------------------------- helpers

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'class') { node.className = attrs[key]; }
      else if (key === 'text') { node.textContent = attrs[key]; }
      else if (key === 'html') { node.innerHTML = attrs[key]; }
      else if (key.slice(0, 2) === 'on') { node.addEventListener(key.slice(2), attrs[key]); }
      else if (attrs[key] === true) { node.setAttribute(key, ''); }
      else if (attrs[key] !== false && attrs[key] !== null && attrs[key] !== undefined) {
        node.setAttribute(key, attrs[key]);
      }
    });
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }

  function todayISO() {
    var d = new Date();
    return E.formatDate(d);
  }

  function download(filename, text, type) {
    var blob = new Blob([text], { type: type || 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function readFile(input, onText) {
    var file = input.files && input.files[0];
    if (!file) { return; }
    var reader = new FileReader();
    reader.onload = function () {
      onText(String(reader.result));
      input.value = '';
    };
    reader.readAsText(file);
  }

  function status(node, message, kind) {
    node.className = 'status' + (kind ? ' ' + kind : '');
    node.textContent = message || '';
  }

  // ---------------------------------------------------------------- tabs

  function showView(name) {
    state.view = name;
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) {
      v.classList.toggle('is-active', v.id === 'view-' + name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('is-active', t.dataset.view === name);
    });
    if (name === 'absences') { renderAbsences(); }
    if (name === 'teachers') { renderTeachers(); }
    if (name === 'timetable') { renderTimetableControls(); }
    if (name === 'reports') { renderReports(); }
    if (name === 'settings') { fillSettings(); }
  }

  // ---------------------------------------------------------------- plan

  function currentDate() { return $('planDate').value; }

  function lockedMap() {
    var out = {};
    if (!state.plan) { return out; }
    state.plan.assignments.forEach(function (a) {
      if (a.locked && a.substituteTeacherId) { out[a.vacancyId] = a.substituteTeacherId; }
    });
    return out;
  }

  function generate() {
    var date = currentDate();
    var data = Store.get();
    var settings = E.settingsOf(data);

    if (!date) {
      status($('planStatus'), 'Choose a date first.', 'error');
      return;
    }
    if (!E.isWorkingDay(date, settings)) {
      state.plan = null;
      renderPlan();
      status($('planStatus'), E.longDate(date) + ' is not a working day for this school.', 'error');
      return;
    }

    state.plan = E.generatePlan(data, date, { locked: lockedMap() });
    state.planSaved = false;
    renderPlan();

    var covered = state.plan.assignments.length;
    var missing = state.plan.uncovered.length;
    if (!state.plan.vacancyCount) {
      status($('planStatus'), 'No absences recorded for ' + E.longDate(date) + '.', 'ok');
    } else if (missing) {
      status($('planStatus'), covered + ' of ' + state.plan.vacancyCount +
        ' periods covered — ' + missing + ' still need attention.', 'error');
    } else {
      status($('planStatus'), 'All ' + covered + ' periods covered. Remember to save the plan.', 'ok');
    }
  }

  function renderPlan() {
    var data = Store.get();
    var plan = state.plan;
    var body = $('planBody');
    clear(body);

    $('printSchool').textContent = data.settings.schoolName || '';
    $('printDate').textContent = currentDate() ? E.longDate(currentDate()) : '';
    $('planDayLabel').textContent = currentDate()
      ? E.DAY_LABELS[E.dayOf(currentDate())] || ''
      : '';

    var hasRows = !!(plan && plan.assignments.length);
    $('planTable').hidden = !hasRows;
    $('planEmpty').hidden = hasRows || !!(plan && plan.uncovered.length);

    if (plan) {
      plan.assignments.forEach(function (assignment) {
        body.appendChild(planRow(assignment, plan, data));
      });
    }

    renderUncovered(plan);
    renderNotices(plan);
  }

  function planRow(assignment, plan, data) {
    var vacancy = vacancyOf(assignment, plan);
    var select = el('select', {
      onchange: function (ev) { overrideAssignment(assignment, ev.target.value); }
    });
    select.appendChild(el('option', { value: '', text: '— nobody —' }));

    var within = E.optionsForVacancy(data, plan.date, vacancy, plan, {
      ignoreVacancyId: assignment.vacancyId
    });
    var withinIds = new Set(within.map(function (c) { return c.teacherId; }));
    appendOptions(select, within, 'Free and within limits');

    var beyond = E.optionsForVacancy(data, plan.date, vacancy, plan, {
      ignoreVacancyId: assignment.vacancyId, relaxCaps: true
    }).filter(function (c) { return !withinIds.has(c.teacherId); });
    appendOptions(select, beyond, 'Free but over their limit');

    // A hand-picked teacher may sit outside both lists (say the timetable
    // changed since); keep them selectable so the row still shows the truth.
    if (assignment.substituteTeacherId && !select.querySelector('option[value="' + cssEscape(assignment.substituteTeacherId) + '"]')) {
      select.appendChild(el('option', {
        value: assignment.substituteTeacherId,
        text: Store.teacherLabel(assignment.substituteTeacherId) + ' (not free)'
      }));
    }
    select.value = assignment.substituteTeacherId || '';

    var why = el('td', { class: 'reasons no-print' });
    if (assignment.overCap) {
      why.appendChild(el('span', { class: 'badge warn', text: 'over limit' }));
      why.appendChild(document.createTextNode(' '));
    }
    why.appendChild(document.createTextNode(
      assignment.reasons.length ? assignment.reasons.join(', ') : 'free this period'
    ));

    var lock = el('input', { type: 'checkbox' });
    lock.checked = !!assignment.locked;
    lock.addEventListener('change', function () {
      assignment.locked = lock.checked;
      state.planSaved = false;
    });

    return el('tr', {}, [
      el('td', { text: String(assignment.period) }),
      el('td', { text: assignment.classId }),
      el('td', { text: assignment.subject || '—' }),
      el('td', { text: Store.teacherName(assignment.absentTeacherId) }),
      el('td', {}, [select]),
      why,
      el('td', { class: 'no-print' }, [lock])
    ]);
  }

  function appendOptions(select, candidates, label) {
    if (!candidates.length) { return; }
    var group = el('optgroup', { label: label });
    candidates.forEach(function (c) {
      group.appendChild(el('option', {
        value: c.teacherId,
        text: Store.teacherLabel(c.teacherId)
      }));
    });
    select.appendChild(group);
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function vacancyOf(assignment, plan) {
    return {
      id: assignment.vacancyId,
      date: plan.date,
      day: plan.day,
      period: assignment.period,
      classId: assignment.classId,
      subject: assignment.subject,
      absentTeacherId: assignment.absentTeacherId
    };
  }

  function overrideAssignment(assignment, teacherId) {
    assignment.substituteTeacherId = teacherId || null;
    assignment.locked = !!teacherId;
    assignment.reasons = teacherId ? ['chosen by the office'] : [];
    assignment.overCap = false;
    state.planSaved = false;
    renderPlan();
    status($('planStatus'), teacherId
      ? Store.teacherName(teacherId) + ' assigned to period ' + assignment.period +
        ', ' + assignment.classId + '. Save the plan to keep it.'
      : 'Period ' + assignment.period + ', ' + assignment.classId + ' left unassigned.', '');
  }

  function renderUncovered(plan) {
    var block = $('uncoveredBlock');
    var body = $('uncoveredBody');
    clear(body);
    var rows = (plan && plan.uncovered) || [];
    block.hidden = !rows.length;

    rows.forEach(function (item) {
      var reason = item.blockers.map(function (b) {
        return b.label + ' (' + b.count + ')';
      }).join(', ') || 'no other teacher on the roll';
      body.appendChild(el('tr', {}, [
        el('td', { text: String(item.vacancy.period) }),
        el('td', { text: item.vacancy.classId }),
        el('td', { text: item.vacancy.subject || '—' }),
        el('td', { text: Store.teacherName(item.vacancy.absentTeacherId) }),
        el('td', { class: 'reasons', text: 'Everyone else: ' + reason })
      ]));
    });
  }

  function renderNotices(plan) {
    var block = $('noticeBlock');
    var host = $('notices');
    clear(host);
    var notices = plan ? E.perTeacherNotices(plan, Store.teacherName) : [];
    block.hidden = !notices.length;

    notices.forEach(function (notice) {
      var list = el('ul', {}, notice.duties.map(function (d) {
        return el('li', {
          text: 'Period ' + d.period + ' — ' + d.classId +
            (d.subject ? ' (' + d.subject + ')' : '') +
            ' for ' + Store.teacherName(d.absentTeacherId)
        });
      }));
      host.appendChild(el('div', { class: 'notice' }, [
        el('h4', { text: notice.name }),
        list
      ]));
    });
  }

  function savePlan() {
    if (!state.plan) {
      status($('planStatus'), 'Nothing to save — generate a plan first.', 'error');
      return;
    }
    Store.savePlan(state.plan);
    state.planSaved = true;
    status($('planStatus'), 'Plan saved for ' + E.longDate(state.plan.date) +
      '. It now counts towards each teacher\'s workload.', 'ok');
  }

  function exportPlanCSV() {
    if (!state.plan || !state.plan.assignments.length) {
      status($('planStatus'), 'Generate a plan before exporting.', 'error');
      return;
    }
    var text = CSV.stringify(state.plan.assignments, [
      { label: 'Period', key: 'period' },
      { label: 'Class', key: 'classId' },
      { label: 'Subject', key: 'subject' },
      { label: 'Teacher on leave', value: function (a) { return Store.teacherName(a.absentTeacherId); } },
      { label: 'Substitute', value: function (a) { return Store.teacherName(a.substituteTeacherId); } },
      { label: 'Substitute code', value: function (a) { return a.substituteTeacherId || ''; } }
    ]);
    download('substitutions-' + state.plan.date + '.csv', text);
  }

  // ---------------------------------------------------------------- absences

  function renderAbsences() {
    var data = Store.get();
    var settings = E.settingsOf(data);
    var date = $('absDate').value || currentDate() || todayISO();
    $('absDate').value = date;
    $('absListDate').textContent = E.longDate(date);

    fillTeacherSelect($('absTeacher'));
    renderPeriodBoxes($('absPeriods'), settings, $('absFullDay').checked);

    var index = E.buildIndex(data);
    var day = E.dayOf(date);
    var body = $('absenceBody');
    clear(body);

    var list = Store.absencesOn(date);
    if (!list.length) {
      body.appendChild(el('tr', {}, [
        el('td', { colspan: '5', class: 'hint', text: 'Nobody marked absent on this date.' })
      ]));
      return;
    }

    list.forEach(function (absence) {
      var periods = E.absentPeriods(absence, settings);
      var toCover = periods.filter(function (p) {
        return !!index.teachingAt(absence.teacherId, day, p);
      });
      body.appendChild(el('tr', {}, [
        el('td', { text: Store.teacherLabel(absence.teacherId) }),
        el('td', { text: absence.periods === 'all' ? 'Full day' : periods.join(', ') }),
        el('td', { text: absence.reason || '—' }),
        el('td', { text: toCover.length ? toCover.join(', ') : 'none (all free periods)' }),
        el('td', {}, [el('button', {
          class: 'link',
          text: 'Remove',
          onclick: function () {
            Store.removeAbsence(absence.id);
            renderAbsences();
          }
        })])
      ]));
    });
  }

  function renderPeriodBoxes(host, settings, disabled) {
    var checked = new Set(Array.prototype.map.call(
      host.querySelectorAll('input:checked'), function (i) { return i.value; }
    ));
    clear(host);
    E.periodList(settings).forEach(function (p) {
      var box = el('input', { type: 'checkbox', value: String(p) });
      box.checked = checked.has(String(p));
      box.disabled = !!disabled;
      host.appendChild(el('label', {}, [box, ' ' + p]));
    });
  }

  function fillTeacherSelect(select, selectedId) {
    clear(select);
    select.appendChild(el('option', { value: '', text: 'Select teacher' }));
    Store.get().teachers.slice().sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name));
    }).forEach(function (t) {
      select.appendChild(el('option', { value: t.id, text: t.name + ' (' + t.code + ')' }));
    });
    if (selectedId) { select.value = selectedId; }
  }

  function submitAbsence(ev) {
    ev.preventDefault();
    var date = $('absDate').value;
    var teacherId = $('absTeacher').value;
    if (!date || !teacherId) { return; }

    var periods = $('absFullDay').checked ? [] : Array.prototype.map.call(
      $('absPeriods').querySelectorAll('input:checked'), function (i) { return Number(i.value); }
    );
    if (!$('absFullDay').checked && !periods.length) {
      alert('Tick the periods the teacher is away for, or choose Full day.');
      return;
    }

    Store.addAbsence({
      date: date, teacherId: teacherId, periods: periods, reason: $('absReason').value.trim()
    });
    $('absReason').value = '';
    renderAbsences();

    // Keep the plan honest: the arrangement on screen no longer matches the data.
    if (state.plan && state.plan.date === date) {
      status($('planStatus'), 'Absences changed — generate the plan again.', 'error');
    }
  }

  // ---------------------------------------------------------------- teachers

  function renderTeachers() {
    var data = Store.get();
    var index = E.buildIndex(data);
    var body = $('teacherBody');
    clear(body);

    data.teachers.slice().sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name));
    }).forEach(function (t) {
      var weekly = data.timetable.filter(function (r) { return r.teacherId === t.id; }).length;
      body.appendChild(el('tr', {}, [
        el('td', { text: t.code }),
        el('td', { text: t.name }),
        el('td', { text: (t.subjects || []).join(', ') || '—' }),
        el('td', {}, [t.isReserve ? el('span', { class: 'badge ok', text: 'reserve' })
          : document.createTextNode('—')]),
        el('td', { text: String(weekly) }),
        el('td', {}, [
          el('button', { class: 'link', text: 'Edit', onclick: function () { editTeacher(t); } }),
          el('button', {
            class: 'link', text: 'Delete',
            onclick: function () { confirmRemoveTeacher(t, index); }
          })
        ])
      ]));
    });
  }

  function editTeacher(t) {
    $('teacherId').value = t.id;
    $('teacherCode').value = t.code;
    $('teacherName').value = t.name;
    $('teacherSubjects').value = (t.subjects || []).join('; ');
    $('teacherReserve').checked = !!t.isReserve;
    $('teacherCode').focus();
  }

  function confirmRemoveTeacher(t, index) {
    var periods = index.periodsTaughtOn ? Store.get().timetable.filter(function (r) {
      return r.teacherId === t.id;
    }).length : 0;
    var warning = periods
      ? '\n\nThis also removes their ' + periods + ' timetable periods, which will then be blank.'
      : '';
    if (confirm('Remove ' + t.name + '?' + warning)) {
      Store.removeTeacher(t.id);
      resetTeacherForm();
      renderTeachers();
    }
  }

  function submitTeacher(ev) {
    ev.preventDefault();
    Store.saveTeacher({
      id: $('teacherId').value || null,
      code: $('teacherCode').value.trim(),
      name: $('teacherName').value.trim(),
      subjects: $('teacherSubjects').value.split(/[;|,]/).map(function (s) {
        return s.trim();
      }).filter(Boolean),
      isReserve: $('teacherReserve').checked
    });
    resetTeacherForm();
    renderTeachers();
  }

  function resetTeacherForm() {
    $('teacherId').value = '';
    $('teacherForm').reset();
  }

  // ---------------------------------------------------------------- timetable

  function renderTimetableControls() {
    var data = Store.get();
    var select = $('ttTarget');
    var previous = state.ttTarget;
    clear(select);

    var options = state.ttMode === 'class'
      ? data.classes.map(function (c) { return { value: c.id, label: c.name || c.id }; })
      : data.teachers.slice().sort(function (a, b) {
          return String(a.name).localeCompare(String(b.name));
        }).map(function (t) { return { value: t.id, label: t.name + ' (' + t.code + ')' }; });

    options.forEach(function (o) {
      select.appendChild(el('option', { value: o.value, text: o.label }));
    });
    if (previous && options.some(function (o) { return o.value === previous; })) {
      select.value = previous;
    }
    state.ttTarget = select.value || null;
    renderTimetable();
  }

  function renderTimetable() {
    var data = Store.get();
    var settings = E.settingsOf(data);
    var index = E.buildIndex(data);
    var table = $('ttTable');
    clear(table);

    if (!state.ttTarget) {
      status($('ttStatus'), 'No timetable loaded yet. Import one, or reload the sample school from Settings.', '');
      return;
    }
    status($('ttStatus'), '', '');

    var head = el('tr', {}, [el('th', { text: 'Day' })]);
    E.periodList(settings).forEach(function (p) {
      head.appendChild(el('th', { text: 'P' + p }));
    });
    table.appendChild(el('thead', {}, [head]));

    var tbody = el('tbody');
    settings.days.forEach(function (day) {
      var row = el('tr', {}, [el('th', { text: day })]);
      E.periodList(settings).forEach(function (period) {
        var entry = state.ttMode === 'class'
          ? index.classAt(state.ttTarget, day, period)
          : index.teachingAt(state.ttTarget, day, period);
        if (!entry) {
          row.appendChild(el('td', { class: 'free', text: 'free' }));
          return;
        }
        var second = state.ttMode === 'class'
          ? Store.teacherName(entry.teacherId)
          : entry.classId;
        row.appendChild(el('td', {}, [
          el('span', { class: 'subject', text: entry.subject || '—' }),
          el('span', { class: 'who', text: second })
        ]));
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
  }

  function exportTimetableCSV() {
    var text = CSV.stringify(Store.get().timetable, [
      { label: 'Day', key: 'day' },
      { label: 'Period', key: 'period' },
      { label: 'Class', key: 'classId' },
      { label: 'Subject', key: 'subject' },
      { label: 'Teacher Code', value: function (r) { return r.teacherId; } }
    ]);
    download('timetable.csv', text);
  }

  function exportTeachersCSV() {
    var text = CSV.stringify(Store.get().teachers, [
      { label: 'Code', key: 'code' },
      { label: 'Name', key: 'name' },
      { label: 'Subjects', value: function (t) { return (t.subjects || []).join('; '); } },
      { label: 'Reserve', value: function (t) { return t.isReserve ? 'Yes' : 'No'; } }
    ]);
    download('teachers.csv', text);
  }

  // ---------------------------------------------------------------- reports

  function renderReports() {
    if (!$('repFrom').value) {
      var monday = E.weekStart(todayISO());
      $('repFrom').value = monday;
      $('repTo').value = todayISO();
    }
    runReport();
    renderSavedPlans();
  }

  function runReport() {
    var rows = E.workloadReport(Store.get(), {
      from: $('repFrom').value || undefined,
      to: $('repTo').value || undefined
    });
    var body = $('reportBody');
    clear(body);
    var max = rows.reduce(function (m, r) { return Math.max(m, r.substitutions); }, 0);

    rows.forEach(function (r) {
      var bar = el('div', {
        style: 'height:8px;border-radius:4px;background:#1f6feb;width:' +
          (max ? Math.round((r.substitutions / max) * 100) : 0) + '%'
      });
      body.appendChild(el('tr', {}, [
        el('td', { text: r.name }),
        el('td', { text: r.code }),
        el('td', { text: String(r.substitutions) }),
        el('td', { style: 'width:40%' }, [bar])
      ]));
    });
  }

  function renderSavedPlans() {
    var plans = Store.get().plans;
    var body = $('savedPlansBody');
    clear(body);
    var dates = Object.keys(plans).sort().reverse();

    if (!dates.length) {
      body.appendChild(el('tr', {}, [
        el('td', { colspan: '5', class: 'hint', text: 'No saved plans yet.' })
      ]));
      return;
    }

    dates.forEach(function (date) {
      var plan = plans[date];
      body.appendChild(el('tr', {}, [
        el('td', { text: date }),
        el('td', { text: E.DAY_LABELS[plan.day] || plan.day || '' }),
        el('td', { text: String((plan.assignments || []).length) }),
        el('td', { text: String((plan.uncovered || []).length) }),
        el('td', {}, [
          el('button', {
            class: 'link', text: 'Open',
            onclick: function () {
              $('planDate').value = date;
              state.plan = plan;
              state.planSaved = true;
              showView('plan');
              renderPlan();
              status($('planStatus'), 'Showing the saved plan for ' + E.longDate(date) + '.', '');
            }
          }),
          el('button', {
            class: 'link', text: 'Delete',
            onclick: function () {
              if (!confirm('Delete the saved plan for ' + date + '?')) { return; }
              Store.deletePlan(date);
              renderReports();
            }
          })
        ])
      ]));
    });
  }

  function exportReportCSV() {
    var rows = E.workloadReport(Store.get(), {
      from: $('repFrom').value || undefined,
      to: $('repTo').value || undefined
    });
    download('substitution-workload.csv', CSV.stringify(rows, [
      { label: 'Teacher', key: 'name' },
      { label: 'Code', key: 'code' },
      { label: 'Substitutions', key: 'substitutions' }
    ]));
  }

  // ---------------------------------------------------------------- settings

  function fillSettings() {
    var s = E.settingsOf(Store.get());
    $('setSchool').value = s.schoolName;
    $('setPeriods').value = s.periodsPerDay;
    $('setMaxDay').value = s.maxSubstitutionsPerDay;
    $('setMaxWeek').value = s.maxSubstitutionsPerWeek;
    $('setRelax').checked = !!s.relaxCapsIfNeeded;

    var host = $('setDays');
    clear(host);
    E.DAYS.forEach(function (day) {
      var box = el('input', { type: 'checkbox', value: day });
      box.checked = s.days.indexOf(day) !== -1;
      host.appendChild(el('label', {}, [box, ' ' + day]));
    });
  }

  function submitSettings(ev) {
    ev.preventDefault();
    var days = Array.prototype.map.call(
      $('setDays').querySelectorAll('input:checked'), function (i) { return i.value; }
    );
    if (!days.length) {
      alert('Pick at least one working day.');
      return;
    }
    Store.update(function (d) {
      d.settings.schoolName = $('setSchool').value.trim() || 'School';
      d.settings.periodsPerDay = Number($('setPeriods').value) || 8;
      d.settings.maxSubstitutionsPerDay = Number($('setMaxDay').value) || 2;
      d.settings.maxSubstitutionsPerWeek = Number($('setMaxWeek').value) || 6;
      d.settings.relaxCapsIfNeeded = $('setRelax').checked;
      d.settings.days = days;
    });
    applySchoolName();
    alert('Settings saved.');
  }

  function applySchoolName() {
    var name = Store.get().settings.schoolName || 'School';
    $('schoolName').textContent = name;
    document.title = name + ' — Substitution planner';
  }

  // ---------------------------------------------------------------- wiring

  function bind() {
    $('tabs').addEventListener('click', function (ev) {
      if (ev.target.dataset.view) { showView(ev.target.dataset.view); }
    });

    $('planDate').addEventListener('change', function () {
      state.plan = Store.planFor(currentDate());
      state.planSaved = !!state.plan;
      renderPlan();
      status($('planStatus'), state.plan
        ? 'Saved plan loaded. Press Generate to rebuild it.'
        : '', state.plan ? 'ok' : '');
    });
    $('btnGenerate').addEventListener('click', generate);
    $('btnSavePlan').addEventListener('click', savePlan);
    $('btnPrint').addEventListener('click', function () { window.print(); });
    $('btnExportPlan').addEventListener('click', exportPlanCSV);

    $('absenceForm').addEventListener('submit', submitAbsence);
    $('absDate').addEventListener('change', renderAbsences);
    $('absFullDay').addEventListener('change', function () {
      renderPeriodBoxes($('absPeriods'), E.settingsOf(Store.get()), $('absFullDay').checked);
    });

    $('teacherForm').addEventListener('submit', submitTeacher);
    $('teacherFormReset').addEventListener('click', resetTeacherForm);
    $('exportTeachers').addEventListener('click', exportTeachersCSV);
    $('importTeachers').addEventListener('change', function (ev) {
      readFile(ev.target, function (text) {
        var result = Store.importTeachersCSV(text);
        renderTeachers();
        alert(result.imported + ' teacher(s) imported.' +
          (result.skipped.length ? '\n\nSkipped:\n' + result.skipped.join('\n') : ''));
      });
    });

    $('ttMode').addEventListener('change', function (ev) {
      state.ttMode = ev.target.value;
      state.ttTarget = null;
      renderTimetableControls();
    });
    $('ttTarget').addEventListener('change', function (ev) {
      state.ttTarget = ev.target.value;
      renderTimetable();
    });
    $('exportTimetable').addEventListener('click', exportTimetableCSV);
    $('importTimetable').addEventListener('change', function (ev) {
      readFile(ev.target, function (text) {
        var result = Store.importTimetableCSV(text);
        if (result.clashes && result.clashes.length) {
          status($('ttStatus'), 'Nothing imported — the file double-books teachers:', 'error');
          alert('The timetable was not imported because it double-books teachers:\n\n' +
            result.clashes.slice(0, 10).join('\n'));
          return;
        }
        state.ttTarget = null;
        renderTimetableControls();
        status($('ttStatus'), result.imported + ' periods imported.' +
          (result.skipped.length ? ' ' + result.skipped.length + ' row(s) skipped.' : ''), 'ok');
        if (result.skipped.length) {
          alert('Skipped rows:\n' + result.skipped.slice(0, 15).join('\n'));
        }
      });
    });

    $('btnRunReport').addEventListener('click', runReport);
    $('btnExportReport').addEventListener('click', exportReportCSV);

    $('settingsForm').addEventListener('submit', submitSettings);
    $('btnBackup').addEventListener('click', function () {
      download('substitution-backup-' + todayISO() + '.json', Store.exportJSON(), 'application/json');
    });
    $('restoreBackup').addEventListener('change', function (ev) {
      readFile(ev.target, function (text) {
        try {
          Store.importJSON(text);
          state.plan = null;
          applySchoolName();
          showView('settings');
          fillSettings();
          alert('Backup restored.');
        } catch (err) {
          alert('Could not restore that file: ' + err.message);
        }
      });
    });
    $('btnSeed').addEventListener('click', function () {
      if (!confirm('Replace all current data with the sample school?')) { return; }
      Store.reset();
      state.plan = null;
      applySchoolName();
      fillSettings();
      alert('Sample school loaded.');
    });
    $('btnClear').addEventListener('click', function () {
      if (!confirm('Erase every teacher, timetable period, absence and saved plan?')) { return; }
      if (!confirm('This cannot be undone. Take a backup first if you need one. Continue?')) { return; }
      Store.clearAll();
      state.plan = null;
      applySchoolName();
      fillSettings();
      renderPlan();
    });

    window.addEventListener('beforeunload', function (ev) {
      if (state.plan && !state.planSaved && state.plan.assignments.length) {
        ev.preventDefault();
        ev.returnValue = '';
      }
    });
  }

  function init() {
    Store.load();
    applySchoolName();
    bind();

    var today = todayISO();
    $('planDate').value = today;
    $('absDate').value = today;

    state.plan = Store.planFor(today);
    state.planSaved = !!state.plan;
    renderPlan();
    showView('plan');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
