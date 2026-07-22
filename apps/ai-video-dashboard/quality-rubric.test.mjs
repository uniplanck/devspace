import assert from 'node:assert/strict';
import { categoriesForProfile, getQualityLabData, profiles, scoreAssessment } from './quality-rubric.mjs';

const data = getQualityLabData('explainer');
assert.equal(data.categoryCount, 12);
assert.equal(data.criterionCount, 82);
assert.equal(data.categories.reduce((sum, category) => sum + category.weight, 0), 100);
assert.equal(data.releases.filter((row) => row.kind === 'editing-test' && Number.isFinite(row.humanScore)).map((row) => row.humanScore).join(','), '10,15,20,20');
const editingReleases = data.releases.filter((row) => row.kind === 'editing-test');
const rejectedV4 = editingReleases.find((row) => row.id === 'edit-v0.4');
const latestEditing = editingReleases.at(-1);
assert.equal(rejectedV4.humanScore, 20);
assert.equal(rejectedV4.deprecatedMachineScore, 47.51);
assert.equal(latestEditing.id, 'edit-v0.5');
assert.equal(latestEditing.humanScore, null);
assert.equal(latestEditing.craftScore, null);
assert.equal(data.releases.filter((row) => row.deprecatedMachineScore).length, 3);
assert.ok(data.sources.length >= 12);

for (const profile of Object.values(profiles)) {
  const categories = categoriesForProfile(profile.id);
  assert.equal(categories.reduce((sum, category) => sum + category.weight, 0), 100);
  assert.ok(categories.every((category) => category.criteria.length >= 5));
  assert.ok(categories.every((category) => category.criteria.every((criterion) => criterion.levels.length === 5)));
}

const allExcellent = Object.fromEntries(data.categories.flatMap((category) => category.criteria.map((criterion) => [criterion.id, 4])));
const perfect = scoreAssessment({ profileId: 'explainer', levels: allExcellent });
assert.equal(perfect.rawScore, 100);
assert.equal(perfect.finalScore, 100);
assert.equal(perfect.band.label, '卓越');

const capped = scoreAssessment({ profileId: 'explainer', levels: allExcellent, activeGates: ['caption-desync', 'technical-failure'] });
assert.equal(capped.rawScore, 100);
assert.equal(capped.cap, 39);
assert.equal(capped.finalScore, 39);
assert.equal(capped.band.label, '試作');

const humanReviewCap = scoreAssessment({ profileId: 'explainer', levels: allExcellent, activeGates: ['human-review-missing'] });
assert.equal(humanReviewCap.finalScore, 74);

console.log('quality rubric tests passed');
