// Futtatás: npm test   (Node 20+ beépített tesztfuttatóval)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  occursOn, occurrencesInRange, isDoneOn, prepRemindersOn, isPrepStartDay,
  eventDateInYear, nextEventOccurrence, buildDigest, digestLines, digestIsEmpty, addDays, diffDays,
} from '../js/logic.js';

const weekly = { id: 'w', title: 'Úszás', due_date: '2026-11-02', recurrence: 'weekly', done_dates: [], skip_dates: [] };

test('dátum aritmetika DST-n át', () => {
  assert.equal(addDays('2026-03-28', 2), '2026-03-30');
  assert.equal(diffDays('2026-10-24', '2026-10-26'), 2);
});

test('heti ismétlődés', () => {
  assert.ok(occursOn(weekly, '2026-11-02'));
  assert.ok(occursOn(weekly, '2026-11-23'));
  assert.ok(!occursOn(weekly, '2026-11-24'));
  assert.ok(!occursOn(weekly, '2026-10-26'));
  assert.ok(!occursOn({ ...weekly, skip_dates: ['2026-11-09'] }, '2026-11-09'));
  assert.ok(!occursOn({ ...weekly, recurrence_end: '2026-11-15' }, '2026-11-16'));
  assert.deepEqual(occurrencesInRange(weekly, '2026-11-10', '2026-11-30'), ['2026-11-16', '2026-11-23', '2026-11-30']);
  assert.ok(isDoneOn({ ...weekly, done_dates: ['2026-11-09'] }, '2026-11-09'));
  assert.ok(!isDoneOn({ ...weekly, done_dates: ['2026-11-09'] }, '2026-11-16'));
});

test('vásárlós előrejelzés', () => {
  const fruit = { id: 'f', title: 'Gyümölcs az oviba', due_date: '2026-11-30', needs_prep: true, prep_days: 7, recurrence: 'none', done: false };
  assert.equal(prepRemindersOn([fruit], '2026-11-22').length, 0); // 8 nap – még nem
  assert.equal(prepRemindersOn([fruit], '2026-11-23')[0].daysLeft, 7);
  assert.equal(prepRemindersOn([fruit], '2026-11-29')[0].daysLeft, 1);
  assert.equal(prepRemindersOn([fruit], '2026-11-30').length, 0); // aznap már „mai” teendő
  assert.equal(prepRemindersOn([{ ...fruit, done: true }], '2026-11-25').length, 0);
  assert.ok(isPrepStartDay([fruit], '2026-11-23'));
  assert.ok(isPrepStartDay([{ ...fruit, prep_days: 3 }], '2026-11-27'));
});

test('családi események, szökőnap', () => {
  const leap = { month: 2, day: 29, remind_days: 3 };
  assert.equal(eventDateInYear(leap, 2027), '2027-02-28');
  assert.equal(eventDateInYear(leap, 2028), '2028-02-29');
  assert.equal(nextEventOccurrence({ month: 1, day: 5 }, '2026-11-22'), '2027-01-05');
  assert.equal(nextEventOccurrence({ month: 11, day: 22 }, '2026-11-22'), '2026-11-22');
});

test('napi összefoglaló', () => {
  const events = [
    { name: 'Erzsébet', event_type: 'nevnap', month: 11, day: 19, remind_days: 3 },
    { name: 'Bence', event_type: 'szuletesnap', month: 11, day: 25, remind_days: 3 },
    { name: 'Nagyi', event_type: 'szuletesnap', month: 11, day: 22, remind_days: 0 },
    { name: 'Távoli', event_type: 'evfordulo', month: 12, day: 24, remind_days: 3 },
  ];
  const todos = [
    { title: 'Ma ez', due_date: '2026-11-22', recurrence: 'none', done: false },
    { title: 'Kész', due_date: '2026-11-22', recurrence: 'none', done: true },
    { title: 'Ovi gyümölcs', due_date: '2026-11-27', needs_prep: true, prep_days: 5, recurrence: 'none', done: false },
  ];
  const d = buildDigest(todos, events, '2026-11-22');
  assert.deepEqual(d.today.map((x) => x.todo.title), ['Ma ez']);
  assert.deepEqual(d.prep.map((x) => x.todo.title), ['Ovi gyümölcs']);
  assert.deepEqual(d.events.map((x) => x.event.name), ['Nagyi', 'Bence']);
  const lines = digestLines(d);
  assert.match(lines[0], /MA van Nagyi születésnapja/);
  assert.match(lines[1], /Bence születésnapja 3 nap múlva/);
});

test('időrend: időponttal elöl, idő nélküliek a végén', async () => {
  const { compareByTime, formatTime } = await import('../js/logic.js');
  const todos = [
    { title: 'Idő nélkül A', due_date: '2026-11-23', recurrence: 'none', done: false, created_at: '2026-11-20T10:00:00Z' },
    { title: 'Délután', due_date: '2026-11-23', due_time: '16:30:00', recurrence: 'none', done: false },
    { title: 'Reggel', due_date: '2026-11-23', due_time: '07:45:00', recurrence: 'none', done: false },
    { title: 'Idő nélkül B', due_date: '2026-11-23', recurrence: 'none', done: false, created_at: '2026-11-21T10:00:00Z' },
  ];
  assert.deepEqual([...todos].sort(compareByTime).map((t) => t.title), ['Reggel', 'Délután', 'Idő nélkül A', 'Idő nélkül B']);
  assert.equal(formatTime('07:45:00'), '07:45');
  const d = buildDigest(todos, [], '2026-11-23');
  assert.deepEqual(d.today.map((x) => x.todo.title), ['Reggel', 'Délután', 'Idő nélkül A', 'Idő nélkül B']);
  assert.match(digestLines(d)[0], /Ma 07:45: Reggel/);
});

test('napi jegyzet a reggeli összefoglalóban', () => {
  const notes = [{ day: '2026-11-24', note: 'Gyógyszert hozni' }, { day: '2026-11-25', note: 'más nap' }];
  const d = buildDigest([], [], '2026-11-24', notes);
  assert.equal(d.note, 'Gyógyszert hozni');
  assert.ok(!digestIsEmpty(d));
  assert.equal(digestLines(d)[0], '📝 Gyógyszert hozni');
  assert.ok(digestIsEmpty(buildDigest([], [], '2026-11-26', notes)));
});
