/*
 * Sample school used on first run, so the app is usable the moment it opens.
 *
 * The timetable is generated rather than typed out: a greedy allocator walks
 * every slot and gives each class the next subject from its rotation whose
 * teacher is free, which produces a clash-free timetable with realistic
 * scattered free periods. Deterministic — the same school every time.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.SeedData = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var PERIODS_PER_DAY = 8;

  var TEACHERS = [
    { code: 'T01', name: 'Ayesha Rahman', subjects: ['Mathematics'] },
    { code: 'T02', name: 'Suresh Nair', subjects: ['Physics', 'Mathematics'] },
    { code: 'T03', name: 'Meera Joseph', subjects: ['Chemistry', 'Biology'] },
    { code: 'T04', name: 'Rakesh Varma', subjects: ['Biology', 'Chemistry'] },
    { code: 'T05', name: 'Fathima Basheer', subjects: ['English'] },
    { code: 'T06', name: 'Anil Kumar', subjects: ['English', 'Social Science'] },
    { code: 'T07', name: 'Divya Menon', subjects: ['Hindi'] },
    { code: 'T08', name: 'Shafi Muhammed', subjects: ['Malayalam'] },
    { code: 'T09', name: 'Priya Thomas', subjects: ['Social Science'] },
    { code: 'T10', name: 'George Mathew', subjects: ['Computer Science', 'Mathematics'] },
    { code: 'T11', name: 'Neha Sharma', subjects: ['Physical Education'], isReserve: true },
    { code: 'T12', name: 'Ibrahim Khan', subjects: ['General', 'Social Science'], isReserve: true }
  ];

  var CLASSES = ['8 A', '8 B', '9 A', '9 B', '10 A', '10 B'];

  // Subject -> teacher for each class, in the order they rotate through the week.
  var ALLOCATION = {
    '8 A': [['Mathematics', 'T01'], ['English', 'T05'], ['Physics', 'T02'], ['Biology', 'T04'],
            ['Social Science', 'T09'], ['Hindi', 'T07'], ['Chemistry', 'T03'], ['Computer Science', 'T10'],
            ['Physical Education', 'T11']],
    '8 B': [['Mathematics', 'T10'], ['English', 'T06'], ['Physics', 'T02'], ['Biology', 'T03'],
            ['Social Science', 'T09'], ['Malayalam', 'T08'], ['Chemistry', 'T04'], ['Computer Science', 'T10'],
            ['Physical Education', 'T11']],
    '9 A': [['Mathematics', 'T01'], ['Physics', 'T02'], ['Chemistry', 'T03'], ['Biology', 'T04'],
            ['English', 'T05'], ['Hindi', 'T07'], ['Social Science', 'T09'], ['Computer Science', 'T10'],
            ['Physical Education', 'T11']],
    '9 B': [['Mathematics', 'T02'], ['Physics', 'T02'], ['Chemistry', 'T04'], ['Biology', 'T03'],
            ['English', 'T06'], ['Malayalam', 'T08'], ['Social Science', 'T12'], ['Computer Science', 'T10'],
            ['Physical Education', 'T11']],
    '10 A': [['Mathematics', 'T01'], ['Physics', 'T02'], ['Chemistry', 'T03'], ['Biology', 'T04'],
             ['English', 'T05'], ['Hindi', 'T07'], ['Social Science', 'T09'], ['Computer Science', 'T10'],
             ['Physical Education', 'T11']],
    '10 B': [['Mathematics', 'T01'], ['Physics', 'T02'], ['Chemistry', 'T04'], ['Biology', 'T03'],
             ['English', 'T06'], ['Malayalam', 'T08'], ['Social Science', 'T09'], ['Computer Science', 'T10'],
             ['Physical Education', 'T11']]
  };

  function buildTimetable() {
    var rows = [];
    var cursor = {};  // class -> position in its rotation
    CLASSES.forEach(function (c) { cursor[c] = 0; });

    DAYS.forEach(function (day) {
      for (var period = 1; period <= PERIODS_PER_DAY; period++) {
        var busy = {};
        CLASSES.forEach(function (className) {
          var plan = ALLOCATION[className];
          // Try each subject in rotation order until one has a free teacher.
          for (var attempt = 0; attempt < plan.length; attempt++) {
            var idx = (cursor[className] + attempt) % plan.length;
            var subject = plan[idx][0];
            var teacher = plan[idx][1];
            if (busy[teacher]) { continue; }
            busy[teacher] = true;
            cursor[className] = idx + 1;
            rows.push({ day: day, period: period, classId: className, subject: subject, teacherId: teacher });
            return;
          }
          // Every teacher for this class is engaged elsewhere: free period.
          cursor[className] += 1;
        });
      }
    });
    return rows;
  }

  function build() {
    return {
      version: 1,
      settings: {
        schoolName: 'Greenfield Higher Secondary School',
        periodsPerDay: PERIODS_PER_DAY,
        days: DAYS.slice(),
        maxSubstitutionsPerDay: 2,
        maxSubstitutionsPerWeek: 6,
        relaxCapsIfNeeded: true
      },
      teachers: TEACHERS.map(function (t) {
        return {
          id: t.code,
          code: t.code,
          name: t.name,
          subjects: t.subjects.slice(),
          isReserve: !!t.isReserve,
          active: true,
          unavailable: []
        };
      }),
      classes: CLASSES.map(function (c) { return { id: c, name: c }; }),
      timetable: buildTimetable(),
      absences: [],
      plans: {}
    };
  }

  return { build: build, DAYS: DAYS, CLASSES: CLASSES, TEACHERS: TEACHERS };
});
