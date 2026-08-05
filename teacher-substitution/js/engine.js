/*
 * Substitution engine.
 *
 * Pure logic, no DOM: given the school data (teachers, timetable, absences,
 * previously saved plans) it works out which periods are left uncovered on a
 * given date and who should cover them.
 *
 * Loadable in the browser (window.SubEngine) and in Node (require) so the
 * same code the school runs is the code the tests exercise.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.SubEngine = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var WEEKDAY_INDEX = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DAY_LABELS = {
    Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday',
    Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday'
  };

  /*
   * Scoring weights. Positive factors describe a good fit for the class,
   * negative ones keep the load spread fairly across the staff room.
   * Tuned so that a subject match (+60) outranks familiarity (+20), but a
   * teacher who has already covered two periods today (-36) loses to a
   * non-specialist who is fresh.
   */
  var WEIGHTS = {
    subjectMatch: 60,
    reserveTeacher: 30,
    classFamiliarity: 20,
    periodTaughtToday: -8,
    substitutionToday: -18,
    substitutionThisWeek: -12
  };

  var BLOCKERS = {
    absent: 'On leave',
    teaching: 'Has a class',
    substituting: 'Already covering another class',
    unavailable: 'Marked unavailable',
    dailyCap: 'Daily substitution limit reached',
    weeklyCap: 'Weekly substitution limit reached'
  };

  var DEFAULT_SETTINGS = {
    schoolName: 'School',
    periodsPerDay: 8,
    days: DAYS.slice(),
    maxSubstitutionsPerDay: 2,
    maxSubstitutionsPerWeek: 6,
    relaxCapsIfNeeded: true
  };

  // ---------------------------------------------------------------- dates

  function parseDate(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!m) { return null; }
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1) { return null; }
    return d;
  }

  function formatDate(d) {
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  /** 'YYYY-MM-DD' -> 'Mon' | 'Tue' | ... | null when the date is unparseable. */
  function dayOf(date) {
    var d = parseDate(date);
    return d ? WEEKDAY_INDEX[d.getDay()] : null;
  }

  /** Monday of the week the date falls in, as 'YYYY-MM-DD'. */
  function weekStart(date) {
    var d = parseDate(date);
    if (!d) { return null; }
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return formatDate(d);
  }

  function longDate(date) {
    var d = parseDate(date);
    if (!d) { return date; }
    return DAY_LABELS[WEEKDAY_INDEX[d.getDay()]] + ', ' +
      d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // ---------------------------------------------------------------- helpers

  function settingsOf(data) {
    var s = Object.assign({}, DEFAULT_SETTINGS, (data && data.settings) || {});
    if (!Array.isArray(s.days) || !s.days.length) { s.days = DAYS.slice(); }
    s.periodsPerDay = Math.max(1, Number(s.periodsPerDay) || DEFAULT_SETTINGS.periodsPerDay);
    return s;
  }

  function periodList(settings) {
    var out = [];
    for (var p = 1; p <= settings.periodsPerDay; p++) { out.push(p); }
    return out;
  }

  function isWorkingDay(date, settings) {
    var day = dayOf(date);
    return !!day && settings.days.indexOf(day) !== -1;
  }

  function bump(map, key, by) {
    map.set(key, (map.get(key) || 0) + (by === undefined ? 1 : by));
  }

  function slotKey(a, b, c) { return a + '|' + b + '|' + c; }

  // ---------------------------------------------------------------- index

  /**
   * Pre-computes the timetable lookups the scorer needs, so scoring a
   * candidate stays O(1) instead of re-scanning every timetable row.
   */
  function buildIndex(data) {
    var rows = (data && data.timetable) || [];
    var teacherSlot = new Map();  // teacherId|day|period -> row
    var classSlot = new Map();    // classId|day|period   -> row
    var dayLoad = new Map();      // teacherId|day        -> periods taught
    var classCount = new Map();   // teacherId|classId    -> periods with that class

    rows.forEach(function (row) {
      if (!row || !row.teacherId) { return; }
      var period = Number(row.period);
      teacherSlot.set(slotKey(row.teacherId, row.day, period), row);
      classSlot.set(slotKey(row.classId, row.day, period), row);
      bump(dayLoad, row.teacherId + '|' + row.day);
      bump(classCount, row.teacherId + '|' + row.classId);
    });

    return {
      rows: rows,
      teachingAt: function (teacherId, day, period) {
        return teacherSlot.get(slotKey(teacherId, day, period)) || null;
      },
      classAt: function (classId, day, period) {
        return classSlot.get(slotKey(classId, day, period)) || null;
      },
      periodsTaughtOn: function (teacherId, day) {
        return dayLoad.get(teacherId + '|' + day) || 0;
      },
      periodsWithClass: function (teacherId, classId) {
        return classCount.get(teacherId + '|' + classId) || 0;
      }
    };
  }

  // ---------------------------------------------------------------- absences

  /** Periods a teacher is away for on a date; 'all' means the whole day. */
  function absentPeriods(absence, settings) {
    if (!absence) { return []; }
    if (absence.periods === 'all' || !Array.isArray(absence.periods) || !absence.periods.length) {
      return periodList(settings);
    }
    return absence.periods.map(Number).filter(function (p) {
      return p >= 1 && p <= settings.periodsPerDay;
    });
  }

  function absenceMap(data, date, settings) {
    var map = new Map(); // teacherId -> Set(period)
    ((data && data.absences) || []).forEach(function (ab) {
      if (!ab || ab.date !== date || !ab.teacherId) { return; }
      var set = map.get(ab.teacherId) || new Set();
      absentPeriods(ab, settings).forEach(function (p) { set.add(p); });
      map.set(ab.teacherId, set);
    });
    return map;
  }

  // ---------------------------------------------------------------- vacancies

  /**
   * Every scheduled period on `date` whose teacher is away.
   * A teacher's free periods produce no vacancy — nothing to cover.
   */
  function findVacancies(data, date) {
    var settings = settingsOf(data);
    if (!isWorkingDay(date, settings)) { return []; }

    var day = dayOf(date);
    var index = buildIndex(data);
    var vacancies = [];

    ((data && data.absences) || []).forEach(function (ab) {
      if (!ab || ab.date !== date || !ab.teacherId) { return; }
      absentPeriods(ab, settings).forEach(function (period) {
        var row = index.teachingAt(ab.teacherId, day, period);
        if (!row) { return; }
        vacancies.push({
          id: date + '#' + period + '#' + row.classId,
          date: date,
          day: day,
          period: period,
          classId: row.classId,
          subject: row.subject,
          absentTeacherId: ab.teacherId,
          absenceReason: ab.reason || ''
        });
      });
    });

    vacancies.sort(function (a, b) {
      return a.period - b.period || String(a.classId).localeCompare(String(b.classId));
    });
    return vacancies;
  }

  // ---------------------------------------------------------------- counters

  /**
   * Running tallies for one date: who is busy in which period, and how many
   * substitutions each teacher has picked up today and across the week.
   * Week totals seed from previously saved plans so fairness carries over.
   */
  function makeCounters(data, date) {
    var subsToday = new Map();
    var subsWeek = new Map();
    var busy = new Map(); // teacherId|period -> true (covering something today)
    var thisWeek = weekStart(date);

    var plans = (data && data.plans) || {};
    Object.keys(plans).forEach(function (d) {
      if (d === date || weekStart(d) !== thisWeek) { return; }
      ((plans[d] && plans[d].assignments) || []).forEach(function (a) {
        if (a && a.substituteTeacherId) { bump(subsWeek, a.substituteTeacherId); }
      });
    });

    return {
      subsToday: function (id) { return subsToday.get(id) || 0; },
      subsWeek: function (id) { return subsWeek.get(id) || 0; },
      isCovering: function (id, period) { return busy.has(id + '|' + period); },
      record: function (id, period) {
        busy.set(id + '|' + period, true);
        bump(subsToday, id);
        bump(subsWeek, id);
      }
    };
  }

  // ---------------------------------------------------------------- eligibility

  function capFor(teacher, key, settings) {
    var own = teacher && teacher[key];
    return own === undefined || own === null || own === '' ? settings[key] : Number(own);
  }

  /**
   * Can this teacher take this vacancy? Returns a blocker code, or null when
   * they are free to be considered.
   */
  function blockerFor(teacher, vacancy, ctx) {
    var away = ctx.absences.get(teacher.id);
    if (away && away.has(vacancy.period)) { return 'absent'; }
    if (ctx.index.teachingAt(teacher.id, vacancy.day, vacancy.period)) { return 'teaching'; }
    if (ctx.counters.isCovering(teacher.id, vacancy.period)) { return 'substituting'; }

    var unavailable = teacher.unavailable || [];
    var blocked = unavailable.some(function (u) {
      return u && u.day === vacancy.day && Number(u.period) === vacancy.period;
    });
    if (blocked) { return 'unavailable'; }

    if (!ctx.relaxCaps) {
      if (ctx.counters.subsToday(teacher.id) >= capFor(teacher, 'maxSubstitutionsPerDay', ctx.settings)) {
        return 'dailyCap';
      }
      if (ctx.counters.subsWeek(teacher.id) >= capFor(teacher, 'maxSubstitutionsPerWeek', ctx.settings)) {
        return 'weeklyCap';
      }
    }
    return null;
  }

  function teachesSubject(teacher, subject) {
    if (!subject) { return false; }
    var wanted = String(subject).trim().toLowerCase();
    return (teacher.subjects || []).some(function (s) {
      return String(s).trim().toLowerCase() === wanted;
    });
  }

  /** Score a free teacher against a vacancy, with a plain-English rationale. */
  function scoreCandidate(teacher, vacancy, ctx) {
    var score = 0;
    var reasons = [];

    if (teachesSubject(teacher, vacancy.subject)) {
      score += WEIGHTS.subjectMatch;
      reasons.push('teaches ' + vacancy.subject);
    }
    if (teacher.isReserve) {
      score += WEIGHTS.reserveTeacher;
      reasons.push('reserve teacher');
    }
    if (ctx.index.periodsWithClass(teacher.id, vacancy.classId) > 0) {
      score += WEIGHTS.classFamiliarity;
      reasons.push('takes this class regularly');
    }

    var taught = ctx.index.periodsTaughtOn(teacher.id, vacancy.day);
    if (taught) {
      score += WEIGHTS.periodTaughtToday * taught;
      reasons.push(taught + ' own ' + (taught === 1 ? 'period' : 'periods') + ' today');
    }
    var today = ctx.counters.subsToday(teacher.id);
    if (today) {
      score += WEIGHTS.substitutionToday * today;
      reasons.push(today + ' substitution' + (today === 1 ? '' : 's') + ' already today');
    }
    var week = ctx.counters.subsWeek(teacher.id);
    if (week) {
      score += WEIGHTS.substitutionThisWeek * week;
      reasons.push(week + ' substitution' + (week === 1 ? '' : 's') + ' this week');
    }

    return { teacherId: teacher.id, score: score, reasons: reasons };
  }

  /** All free teachers for a vacancy, best first, plus why the rest were skipped. */
  function rankCandidates(vacancy, ctx) {
    var candidates = [];
    var blocked = [];

    ctx.teachers.forEach(function (teacher) {
      if (teacher.id === vacancy.absentTeacherId || teacher.active === false) { return; }
      var blocker = blockerFor(teacher, vacancy, ctx);
      if (blocker) {
        blocked.push({ teacherId: teacher.id, blocker: blocker });
        return;
      }
      candidates.push(scoreCandidate(teacher, vacancy, ctx));
    });

    var nameOf = ctx.nameOf;
    candidates.sort(function (a, b) {
      return b.score - a.score || nameOf(a.teacherId).localeCompare(nameOf(b.teacherId));
    });
    return { candidates: candidates, blocked: blocked };
  }

  // ---------------------------------------------------------------- planning

  function makeContext(data, date, options) {
    var settings = settingsOf(data);
    var teachers = ((data && data.teachers) || []).slice();
    var names = new Map();
    teachers.forEach(function (t) { names.set(t.id, t.name || t.code || t.id); });

    return {
      settings: settings,
      teachers: teachers,
      index: buildIndex(data),
      absences: absenceMap(data, date, settings),
      counters: makeCounters(data, date),
      relaxCaps: !!(options && options.relaxCaps),
      knows: function (id) { return names.has(id); },
      nameOf: function (id) { return names.get(id) || id; }
    };
  }

  /**
   * Build the substitution plan for a date.
   *
   * Vacancies are filled most-constrained-first: a period with only one free
   * teacher is settled before a period with ten, so the scarce cover is not
   * spent on an easy slot. Assignments the office has locked are honoured
   * first and never reshuffled.
   *
   * options.locked  - { vacancyId: teacherId } pinned by hand
   * options.exclude - teacher ids to keep out of this run
   */
  function generatePlan(data, date, options) {
    options = options || {};
    var settings = settingsOf(data);
    var vacancies = findVacancies(data, date);
    var ctx = makeContext(data, date, { relaxCaps: false });
    var exclude = new Set(options.exclude || []);
    var locked = options.locked || {};

    var assignments = [];
    var uncovered = [];
    var pending = [];

    // Pass 1: honour locked assignments so later scoring sees the real load.
    vacancies.forEach(function (vacancy) {
      var pinned = locked[vacancy.id];
      if (pinned && ctx.knows(pinned)) {
        ctx.counters.record(pinned, vacancy.period);
        assignments.push(buildAssignment(vacancy, pinned, null, ['pinned by the office'], true, ctx));
      } else {
        pending.push(vacancy);
      }
    });

    // Pass 2: hardest vacancies first, measured on the pre-assignment state.
    var ranked = pending.map(function (vacancy) {
      var ranking = rankCandidates(vacancy, ctx);
      return { vacancy: vacancy, freeCount: ranking.candidates.length };
    });
    ranked.sort(function (a, b) {
      return a.freeCount - b.freeCount ||
        a.vacancy.period - b.vacancy.period ||
        String(a.vacancy.classId).localeCompare(String(b.vacancy.classId));
    });

    ranked.forEach(function (item) {
      var vacancy = item.vacancy;
      var ranking = rankCandidates(vacancy, ctx);
      var pick = firstAllowed(ranking.candidates, exclude);
      var relaxed = false;

      // Nobody within the fairness caps: an unsupervised class is worse than
      // an over-worked teacher, so try again ignoring the caps.
      if (!pick && settings.relaxCapsIfNeeded) {
        ctx.relaxCaps = true;
        var retry = rankCandidates(vacancy, ctx);
        ctx.relaxCaps = false;
        pick = firstAllowed(retry.candidates, exclude);
        if (pick) {
          relaxed = true;
          ranking = retry;
        }
      }

      if (!pick) {
        uncovered.push({
          vacancy: vacancy,
          blockers: summariseBlockers(ranking.blocked)
        });
        return;
      }

      ctx.counters.record(pick.teacherId, vacancy.period);
      var reasons = pick.reasons.slice();
      if (relaxed) { reasons.push('over the usual substitution limit'); }
      var runnersUp = ranking.candidates.filter(function (c) {
        return c.teacherId !== pick.teacherId;
      }).slice(0, 3).map(function (c) { return c.teacherId; });

      assignments.push(buildAssignment(vacancy, pick.teacherId, pick.score, reasons, false, ctx, runnersUp, relaxed));
    });

    assignments.sort(function (a, b) {
      return a.period - b.period || String(a.classId).localeCompare(String(b.classId));
    });
    uncovered.sort(function (a, b) { return a.vacancy.period - b.vacancy.period; });

    return {
      date: date,
      day: dayOf(date),
      generatedAt: new Date().toISOString(),
      assignments: assignments,
      uncovered: uncovered,
      vacancyCount: vacancies.length
    };
  }

  function firstAllowed(candidates, exclude) {
    for (var i = 0; i < candidates.length; i++) {
      if (!exclude.has(candidates[i].teacherId)) { return candidates[i]; }
    }
    return null;
  }

  function buildAssignment(vacancy, teacherId, score, reasons, isLocked, ctx, runnersUp, overCap) {
    return {
      vacancyId: vacancy.id,
      period: vacancy.period,
      classId: vacancy.classId,
      subject: vacancy.subject,
      absentTeacherId: vacancy.absentTeacherId,
      substituteTeacherId: teacherId,
      score: score,
      reasons: reasons || [],
      alternatives: runnersUp || [],
      locked: !!isLocked,
      overCap: !!overCap
    };
  }

  function summariseBlockers(blocked) {
    var counts = {};
    blocked.forEach(function (b) {
      counts[b.blocker] = (counts[b.blocker] || 0) + 1;
    });
    return Object.keys(counts).map(function (code) {
      return { code: code, label: BLOCKERS[code] || code, count: counts[code] };
    }).sort(function (a, b) { return b.count - a.count; });
  }

  // ---------------------------------------------------------------- reports

  /**
   * Free teachers for one vacancy, for the manual-override dropdown.
   * options.ignoreVacancyId - the slot being re-picked, so whoever currently
   *                           holds it is not counted as busy against themselves.
   * options.relaxCaps       - also include teachers who are free but already
   *                           over their fairness limits.
   */
  function optionsForVacancy(data, date, vacancy, plan, options) {
    options = options || {};
    var ctx = makeContext(data, date, { relaxCaps: !!options.relaxCaps });
    ((plan && plan.assignments) || []).forEach(function (a) {
      if (a.vacancyId === options.ignoreVacancyId || !a.substituteTeacherId) { return; }
      ctx.counters.record(a.substituteTeacherId, a.period);
    });
    return rankCandidates(vacancy, ctx).candidates;
  }

  /** Substitution tally per teacher across saved plans, for the fairness report. */
  function workloadReport(data, options) {
    options = options || {};
    var from = options.from || '0000-00-00';
    var to = options.to || '9999-99-99';
    var counts = new Map();
    var plans = (data && data.plans) || {};

    Object.keys(plans).forEach(function (date) {
      if (date < from || date > to) { return; }
      ((plans[date].assignments) || []).forEach(function (a) {
        if (a.substituteTeacherId) { bump(counts, a.substituteTeacherId); }
      });
    });

    return ((data && data.teachers) || []).map(function (t) {
      return { teacherId: t.id, name: t.name, code: t.code, substitutions: counts.get(t.id) || 0 };
    }).sort(function (a, b) {
      return b.substitutions - a.substitutions || String(a.name).localeCompare(String(b.name));
    });
  }

  /** Plan regrouped per substitute teacher — the slip each of them gets. */
  function perTeacherNotices(plan, teacherName, className) {
    var byTeacher = new Map();
    ((plan && plan.assignments) || []).forEach(function (a) {
      if (!a.substituteTeacherId) { return; }
      var list = byTeacher.get(a.substituteTeacherId) || [];
      list.push(a);
      byTeacher.set(a.substituteTeacherId, list);
    });
    return Array.from(byTeacher.entries()).map(function (pair) {
      pair[1].sort(function (a, b) { return a.period - b.period; });
      return { teacherId: pair[0], name: teacherName(pair[0]), duties: pair[1] };
    }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  }

  return {
    DAYS: DAYS,
    DAY_LABELS: DAY_LABELS,
    WEIGHTS: WEIGHTS,
    BLOCKERS: BLOCKERS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    parseDate: parseDate,
    formatDate: formatDate,
    dayOf: dayOf,
    weekStart: weekStart,
    longDate: longDate,
    settingsOf: settingsOf,
    periodList: periodList,
    isWorkingDay: isWorkingDay,
    buildIndex: buildIndex,
    absentPeriods: absentPeriods,
    findVacancies: findVacancies,
    rankCandidates: rankCandidates,
    makeContext: makeContext,
    generatePlan: generatePlan,
    optionsForVacancy: optionsForVacancy,
    workloadReport: workloadReport,
    perTeacherNotices: perTeacherNotices
  };
});
