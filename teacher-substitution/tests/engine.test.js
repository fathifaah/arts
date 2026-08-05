/*
 * Tests for the substitution engine. No framework, no dependencies:
 *   node tests/engine.test.js
 */
'use strict';

var E = require('../js/engine.js');
var Seed = require('../js/seed.js');

var passed = 0;
var failures = [];
var currentTest = '';

function test(name, fn) {
  currentTest = name;
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name: name, message: err.message });
  }
}

function assert(condition, message) {
  if (!condition) { throw new Error(message || 'assertion failed'); }
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'values differ') +
      '\n      expected: ' + JSON.stringify(expected) +
      '\n      actual:   ' + JSON.stringify(actual));
  }
}

// ------------------------------------------------------------------ fixture

var WED = '2024-01-03';   // a Wednesday
var MON = '2024-01-01';   // the Monday of the same week

function teacher(id, subjects, extra) {
  return Object.assign({
    id: id, code: id, name: id, subjects: subjects || [], isReserve: false,
    active: true, unavailable: []
  }, extra || {});
}

function slot(day, period, classId, subject, teacherId) {
  return { day: day, period: period, classId: classId, subject: subject, teacherId: teacherId };
}

function data(overrides) {
  return Object.assign({
    settings: {
      schoolName: 'Test School',
      periodsPerDay: 3,
      days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      maxSubstitutionsPerDay: 2,
      maxSubstitutionsPerWeek: 6,
      relaxCapsIfNeeded: true
    },
    teachers: [],
    classes: [],
    timetable: [],
    absences: [],
    plans: {}
  }, overrides || {});
}

function assignmentFor(plan, period, classId) {
  return plan.assignments.find(function (a) {
    return a.period === period && a.classId === classId;
  }) || null;
}

// ------------------------------------------------------------------ dates

test('dayOf maps a date to its weekday', function () {
  equal(E.dayOf('2024-01-01'), 'Mon');
  equal(E.dayOf('2024-01-03'), 'Wed');
  equal(E.dayOf('2024-01-07'), 'Sun');
  equal(E.dayOf('not-a-date'), null);
});

test('dayOf rejects an impossible calendar date', function () {
  equal(E.dayOf('2024-02-31'), null);
});

test('weekStart returns the Monday of that week', function () {
  equal(E.weekStart('2024-01-03'), '2024-01-01');
  equal(E.weekStart('2024-01-01'), '2024-01-01');
  equal(E.weekStart('2024-01-07'), '2024-01-01', 'Sunday belongs to the week that began Monday');
});

test('Sunday is not a working day by default', function () {
  assert(!E.isWorkingDay('2024-01-07', E.settingsOf(data())));
});

// ------------------------------------------------------------------ vacancies

test('only periods the absent teacher actually teaches become vacancies', function () {
  var d = data({
    teachers: [teacher('A', ['Mathematics'])],
    timetable: [
      slot('Wed', 1, '10A', 'Mathematics', 'A'),
      slot('Wed', 3, '10B', 'Mathematics', 'A')
    ],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: 'all' }]
  });
  var vacancies = E.findVacancies(d, WED);
  equal(vacancies.length, 2, 'period 2 is a free period, nothing to cover');
  equal(vacancies[0].period, 1);
  equal(vacancies[1].period, 3);
});

test('a part-day absence only vacates the listed periods', function () {
  var d = data({
    teachers: [teacher('A', ['Mathematics'])],
    timetable: [
      slot('Wed', 1, '10A', 'Mathematics', 'A'),
      slot('Wed', 2, '10B', 'Mathematics', 'A')
    ],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: [2] }]
  });
  var vacancies = E.findVacancies(d, WED);
  equal(vacancies.length, 1);
  equal(vacancies[0].period, 2);
});

test('no vacancies on a non-working day', function () {
  var d = data({
    teachers: [teacher('A', ['Mathematics'])],
    timetable: [slot('Sun', 1, '10A', 'Mathematics', 'A')],
    absences: [{ id: 'x', date: '2024-01-07', teacherId: 'A', periods: 'all' }]
  });
  equal(E.findVacancies(d, '2024-01-07').length, 0);
});

// ------------------------------------------------------------------ choosing

test('a subject specialist is preferred over a free non-specialist', function () {
  var d = data({
    teachers: [
      teacher('A', ['Mathematics']),
      teacher('B', ['History']),
      teacher('C', ['Mathematics'])
    ],
    timetable: [slot('Wed', 1, '10A', 'Mathematics', 'A')],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: 'all' }]
  });
  var plan = E.generatePlan(d, WED);
  equal(plan.assignments.length, 1);
  equal(plan.assignments[0].substituteTeacherId, 'C', 'C teaches Mathematics, B does not');
});

test('a teacher who is teaching that period is never picked', function () {
  var d = data({
    teachers: [teacher('A', ['Mathematics']), teacher('B', ['Mathematics']), teacher('C', [])],
    timetable: [
      slot('Wed', 1, '10A', 'Mathematics', 'A'),
      slot('Wed', 1, '10B', 'Mathematics', 'B')   // B is busy in period 1
    ],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: [1] }]
  });
  var plan = E.generatePlan(d, WED);
  equal(plan.assignments[0].substituteTeacherId, 'C');
});

test('a teacher absent themselves is never picked as cover', function () {
  var d = data({
    teachers: [teacher('A', ['Mathematics']), teacher('B', ['Mathematics']), teacher('C', [])],
    timetable: [slot('Wed', 1, '10A', 'Mathematics', 'A')],
    absences: [
      { id: 'x', date: WED, teacherId: 'A', periods: 'all' },
      { id: 'y', date: WED, teacherId: 'B', periods: 'all' }
    ]
  });
  var plan = E.generatePlan(d, WED);
  equal(plan.assignments[0].substituteTeacherId, 'C');
});

test('nobody is booked into two classes in the same period', function () {
  var d = data({
    teachers: [
      teacher('A', ['Mathematics']), teacher('B', ['Mathematics']),
      teacher('C', ['Mathematics']), teacher('D', ['Mathematics'])
    ],
    timetable: [
      slot('Wed', 1, '10A', 'Mathematics', 'A'),
      slot('Wed', 1, '10B', 'Mathematics', 'B')
    ],
    absences: [
      { id: 'x', date: WED, teacherId: 'A', periods: [1] },
      { id: 'y', date: WED, teacherId: 'B', periods: [1] }
    ]
  });
  var plan = E.generatePlan(d, WED);
  equal(plan.assignments.length, 2);
  assert(plan.assignments[0].substituteTeacherId !== plan.assignments[1].substituteTeacherId,
    'C and D must take one class each');
});

test('an unavailable slot keeps a teacher out of that period only', function () {
  var d = data({
    teachers: [
      teacher('A', ['Mathematics']),
      teacher('B', ['Mathematics'], { unavailable: [{ day: 'Wed', period: 1 }] }),
      teacher('C', [])
    ],
    timetable: [
      slot('Wed', 1, '10A', 'Mathematics', 'A'),
      slot('Wed', 2, '10A', 'Mathematics', 'A')
    ],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: 'all' }]
  });
  var plan = E.generatePlan(d, WED);
  equal(assignmentFor(plan, 1, '10A').substituteTeacherId, 'C');
  equal(assignmentFor(plan, 2, '10A').substituteTeacherId, 'B');
});

test('a reserve teacher is favoured when neither candidate teaches the subject', function () {
  var d = data({
    teachers: [
      teacher('A', ['Mathematics']),
      teacher('B', ['History']),
      teacher('C', ['History'], { isReserve: true })
    ],
    timetable: [slot('Wed', 1, '10A', 'Mathematics', 'A')],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: 'all' }]
  });
  var plan = E.generatePlan(d, WED);
  equal(plan.assignments[0].substituteTeacherId, 'C');
});

// ------------------------------------------------------------------ fairness

test('work is spread rather than piled on one teacher', function () {
  var d = data({
    teachers: [
      teacher('A', ['Mathematics']), teacher('B', ['Mathematics']), teacher('C', ['Mathematics'])
    ],
    timetable: [
      slot('Wed', 1, '10A', 'Mathematics', 'A'),
      slot('Wed', 2, '10A', 'Mathematics', 'A')
    ],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: 'all' }]
  });
  var plan = E.generatePlan(d, WED);
  var used = plan.assignments.map(function (a) { return a.substituteTeacherId; });
  equal(new Set(used).size, 2, 'both free teachers should take one period each');
});

test('substitutions already done earlier in the week push a teacher down the list', function () {
  var d = data({
    teachers: [teacher('A', ['Mathematics']), teacher('B', ['Mathematics']), teacher('C', ['Mathematics'])],
    timetable: [slot('Wed', 1, '10A', 'Mathematics', 'A')],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: [1] }],
    plans: {
      '2024-01-01': {
        date: MON, day: 'Mon',
        assignments: [{ period: 1, classId: '9A', substituteTeacherId: 'B' }],
        uncovered: []
      }
    }
  });
  var plan = E.generatePlan(d, WED);
  equal(plan.assignments[0].substituteTeacherId, 'C', 'B already covered a period this week');
});

test('a heavier teaching day counts against a candidate', function () {
  var d = data({
    teachers: [teacher('A', ['Mathematics']), teacher('B', ['Mathematics']), teacher('C', ['Mathematics'])],
    timetable: [
      slot('Wed', 1, '10A', 'Mathematics', 'A'),
      slot('Wed', 2, '10B', 'Mathematics', 'B'),
      slot('Wed', 3, '10B', 'Mathematics', 'B')
    ],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: [1] }]
  });
  var plan = E.generatePlan(d, WED);
  equal(plan.assignments[0].substituteTeacherId, 'C', 'B already teaches twice on Wednesday');
});

test('the daily substitution cap is respected while somebody else is free', function () {
  var d = data({
    settings: Object.assign(E.settingsOf(data()), { periodsPerDay: 3, maxSubstitutionsPerDay: 1 }),
    teachers: [teacher('A', ['Mathematics']), teacher('B', ['Mathematics']), teacher('C', ['Mathematics'])],
    timetable: [
      slot('Wed', 1, '10A', 'Mathematics', 'A'),
      slot('Wed', 2, '10A', 'Mathematics', 'A')
    ],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: 'all' }]
  });
  var plan = E.generatePlan(d, WED);
  var counts = {};
  plan.assignments.forEach(function (a) {
    counts[a.substituteTeacherId] = (counts[a.substituteTeacherId] || 0) + 1;
  });
  Object.keys(counts).forEach(function (id) {
    equal(counts[id], 1, id + ' exceeded the one-per-day cap');
  });
});

test('caps give way rather than leave a class unsupervised', function () {
  var d = data({
    settings: Object.assign(E.settingsOf(data()), { periodsPerDay: 2, maxSubstitutionsPerDay: 1 }),
    teachers: [teacher('A', ['Mathematics']), teacher('B', ['Mathematics'])],
    timetable: [
      slot('Wed', 1, '10A', 'Mathematics', 'A'),
      slot('Wed', 2, '10A', 'Mathematics', 'A')
    ],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: 'all' }]
  });
  var plan = E.generatePlan(d, WED);
  equal(plan.assignments.length, 2, 'B has to take both, over the cap');
  equal(plan.uncovered.length, 0);
  assert(plan.assignments[1].overCap, 'the second period should be flagged as over the limit');
});

test('caps are honoured when relaxing them is switched off', function () {
  var base = E.settingsOf(data());
  var d = data({
    settings: Object.assign(base, { periodsPerDay: 2, maxSubstitutionsPerDay: 1, relaxCapsIfNeeded: false }),
    teachers: [teacher('A', ['Mathematics']), teacher('B', ['Mathematics'])],
    timetable: [
      slot('Wed', 1, '10A', 'Mathematics', 'A'),
      slot('Wed', 2, '10A', 'Mathematics', 'A')
    ],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: 'all' }]
  });
  var plan = E.generatePlan(d, WED);
  equal(plan.assignments.length, 1);
  equal(plan.uncovered.length, 1);
  equal(plan.uncovered[0].blockers[0].code, 'dailyCap');
});

// ------------------------------------------------------------------ gaps

test('a period nobody can take is reported with the reason', function () {
  var d = data({
    teachers: [teacher('A', ['Mathematics']), teacher('B', ['Mathematics'])],
    timetable: [
      slot('Wed', 1, '10A', 'Mathematics', 'A'),
      slot('Wed', 1, '10B', 'Mathematics', 'B')
    ],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: [1] }]
  });
  var plan = E.generatePlan(d, WED);
  equal(plan.assignments.length, 0);
  equal(plan.uncovered.length, 1);
  equal(plan.uncovered[0].blockers[0].code, 'teaching');
  equal(plan.uncovered[0].blockers[0].count, 1);
});

test('the scarcest period is settled first', function () {
  // B is the only teacher free in period 1; in period 2 both B and C are free.
  // Filling in period order would waste B on period 2 and strand period 1.
  var d = data({
    teachers: [
      teacher('A', []), teacher('B', []), teacher('C', [])
    ],
    timetable: [
      slot('Wed', 1, '10A', 'Art', 'A'),
      slot('Wed', 1, '10B', 'Art', 'C'),
      slot('Wed', 2, '10A', 'Art', 'A')
    ],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: 'all' }]
  });
  var plan = E.generatePlan(d, WED);
  equal(plan.uncovered.length, 0, 'both periods should find cover');
  equal(assignmentFor(plan, 1, '10A').substituteTeacherId, 'B');
  equal(assignmentFor(plan, 2, '10A').substituteTeacherId, 'C');
});

// ------------------------------------------------------------------ overrides

test('a locked assignment survives regeneration', function () {
  var d = data({
    teachers: [teacher('A', ['Mathematics']), teacher('B', ['History']), teacher('C', ['Mathematics'])],
    timetable: [slot('Wed', 1, '10A', 'Mathematics', 'A')],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: [1] }]
  });
  var first = E.generatePlan(d, WED);
  equal(first.assignments[0].substituteTeacherId, 'C');

  var locked = {};
  locked[first.assignments[0].vacancyId] = 'B';
  var second = E.generatePlan(d, WED, { locked: locked });
  equal(second.assignments[0].substituteTeacherId, 'B');
  assert(second.assignments[0].locked, 'the pinned row stays locked');
});

test('a locked teacher is not handed a second class in the same period', function () {
  var d = data({
    teachers: [teacher('A', []), teacher('B', []), teacher('C', []), teacher('D', [])],
    timetable: [
      slot('Wed', 1, '10A', 'Art', 'A'),
      slot('Wed', 1, '10B', 'Art', 'B')
    ],
    absences: [
      { id: 'x', date: WED, teacherId: 'A', periods: [1] },
      { id: 'y', date: WED, teacherId: 'B', periods: [1] }
    ]
  });
  var locked = {};
  locked[WED + '#1#10A'] = 'C';
  var plan = E.generatePlan(d, WED, { locked: locked });
  equal(assignmentFor(plan, 1, '10A').substituteTeacherId, 'C');
  equal(assignmentFor(plan, 1, '10B').substituteTeacherId, 'D');
});

test('excluded teachers are kept out of the run', function () {
  var d = data({
    teachers: [teacher('A', ['Mathematics']), teacher('B', ['Mathematics']), teacher('C', ['History'])],
    timetable: [slot('Wed', 1, '10A', 'Mathematics', 'A')],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: [1] }]
  });
  var plan = E.generatePlan(d, WED, { exclude: ['B'] });
  equal(plan.assignments[0].substituteTeacherId, 'C');
});

test('generating the same plan twice gives the same answer', function () {
  var d = data({
    teachers: [teacher('A', ['Mathematics']), teacher('B', ['Mathematics']), teacher('C', ['Mathematics'])],
    timetable: [
      slot('Wed', 1, '10A', 'Mathematics', 'A'),
      slot('Wed', 2, '10A', 'Mathematics', 'A')
    ],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: 'all' }]
  });
  var a = E.generatePlan(d, WED).assignments.map(function (x) { return x.substituteTeacherId; });
  var b = E.generatePlan(d, WED).assignments.map(function (x) { return x.substituteTeacherId; });
  equal(a.join(','), b.join(','));
});

// ------------------------------------------------------------------ reports

test('the workload report counts saved plans within the range', function () {
  var d = data({
    teachers: [teacher('A', []), teacher('B', [])],
    plans: {
      '2024-01-01': { date: MON, assignments: [{ substituteTeacherId: 'A' }, { substituteTeacherId: 'B' }] },
      '2024-01-03': { date: WED, assignments: [{ substituteTeacherId: 'A' }] },
      '2024-02-01': { date: '2024-02-01', assignments: [{ substituteTeacherId: 'B' }] }
    }
  });
  var report = E.workloadReport(d, { from: '2024-01-01', to: '2024-01-31' });
  equal(report[0].teacherId, 'A');
  equal(report[0].substitutions, 2);
  equal(report[1].substitutions, 1, 'February is outside the range');
});

test('duty slips group a teacher\'s periods together', function () {
  var d = data({
    teachers: [teacher('A', []), teacher('B', []), teacher('C', [])],
    timetable: [
      slot('Wed', 1, '10A', 'Art', 'A'),
      slot('Wed', 2, '10A', 'Art', 'A')
    ],
    absences: [{ id: 'x', date: WED, teacherId: 'A', periods: 'all' }]
  });
  var plan = E.generatePlan(d, WED);
  var notices = E.perTeacherNotices(plan, function (id) { return id; });
  equal(notices.length, 2);
  equal(notices[0].duties.length, 1);
});

// ------------------------------------------------------------------ sample data

test('the sample timetable never double-books a teacher', function () {
  var d = Seed.build();
  var seen = new Set();
  d.timetable.forEach(function (row) {
    var key = row.teacherId + '|' + row.day + '|' + row.period;
    assert(!seen.has(key), 'clash: ' + key);
    seen.add(key);
  });
  assert(d.timetable.length > 200, 'expected a full week of periods, got ' + d.timetable.length);
});

test('the sample school can cover a full-day absence', function () {
  var d = Seed.build();
  var date = '2024-01-03';
  d.absences = [{ id: 'x', date: date, teacherId: 'T01', periods: 'all' }];
  var plan = E.generatePlan(d, date);
  assert(plan.vacancyCount > 0, 'T01 should have periods on Wednesday');
  equal(plan.uncovered.length, 0, 'every period should find a substitute');
  plan.assignments.forEach(function (a) {
    assert(a.substituteTeacherId !== 'T01', 'the absent teacher covered their own class');
  });
});

// ------------------------------------------------------------------ results

if (failures.length) {
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed\n');
  failures.forEach(function (f) {
    console.log('  ✗ ' + f.name + '\n      ' + f.message + '\n');
  });
  process.exit(1);
}
console.log('\nAll ' + passed + ' tests passed.\n');
