import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_SECTIONS } from './settings';
import { settingsSectionIssues } from './settings-checks';

const scheduling = (patch: object) => SETTINGS_SECTIONS.scheduling.parse(patch);

test('scheduling blocked period and slots are validated', () => {
  assert.deepEqual(settingsSectionIssues('scheduling', scheduling({})), []);
  assert.deepEqual(settingsSectionIssues('scheduling', scheduling({ blockedFrom: '2026-12-24', blockedTo: '2026-12-24' })), []);
  assert.equal(settingsSectionIssues('scheduling', scheduling({ blockedFrom: '2026-12-25', blockedTo: '2026-12-24' })).length, 1);
  assert.equal(settingsSectionIssues('scheduling', scheduling({ blockedFrom: '2026-12-25' })).length, 1);
  assert.equal(settingsSectionIssues('scheduling', scheduling({ slots: [{ day: 1, start: '12:00', end: '12:00' }] })).length, 1);
});

test('weekly hours need start before end', () => {
  assert.deepEqual(settingsSectionIssues('hours', SETTINGS_SECTIONS.hours.parse({ weekly: [{ day: 1, start: '09:00', end: '18:00' }] })), []);
  assert.equal(settingsSectionIssues('hours', SETTINGS_SECTIONS.hours.parse({ weekly: [{ day: 1, start: '18:00', end: '09:00' }] })).length, 1);
});
