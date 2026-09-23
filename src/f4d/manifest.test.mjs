import assert from 'node:assert/strict';
import test from 'node:test';
import {
  F4DManifestError,
  canonicalJson,
  compileF4DRoute,
  createF4DManifest,
} from './manifest.js';

const fixture = () => ({
  version: 1,
  id: 'f4d-lee-25-ca-005977-v1',
  dealId: 'lee:25-ca-005977',
  approvalId: 'route-approval-1',
  checkpoints: [
    { id: 'subject', kind: 'subject', label: 'Subject', position: { lat: 26.6, lon: -81.8 }, evidenceIds: ['parcel-1'] },
    { id: 'comp-1', kind: 'comp', label: 'Comp 1', position: { lat: 26.61, lon: -81.79 }, evidenceIds: ['comp-record-1'] },
    { id: 'comp-2', kind: 'comp', label: 'Comp 2', position: { lat: 26.62, lon: -81.78 }, evidenceIds: [] },
  ],
  roadLegs: [
    { from: 'subject', to: 'comp-1', provider: 'fixture-osrm', providerVersion: 'fixture-1', geometry: [{ lat: 26.6, lon: -81.8 }, { lat: 26.605, lon: -81.795 }, { lat: 26.61, lon: -81.79 }] },
    { from: 'comp-1', to: 'comp-2', provider: 'fixture-osrm', providerVersion: 'fixture-1', geometry: [{ lat: 26.61, lon: -81.79 }, { lat: 26.62, lon: -81.78 }] },
  ],
  fallback: { mode: '2d-satellite' },
});

test('normalizes an immutable subject+comps manifest', () => {
  const manifest = createF4DManifest(fixture());
  assert.equal(manifest.checkpoints[0].kind, 'subject');
  assert.equal(manifest.roadLegs.length, 2);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.checkpoints), true);
});

test('road mode preserves approved routed geometry', () => {
  const plan = compileF4DRoute(fixture(), 'road');
  assert.equal(plan.mode, 'road');
  assert.equal(plan.legs[0].geometry.length, 3);
  assert.equal(plan.legs[0].camera.behavior, 'route-dolly');
  assert.equal(plan.legs[0].arrival.orbitDegrees, 360);
});

test('aerial mode connects the same approved checkpoints directly', () => {
  const plan = compileF4DRoute(fixture(), 'aerial');
  assert.equal(plan.legs[0].geometry.length, 2);
  assert.deepEqual(plan.legs[0].geometry[0], plan.checkpoints[0].position);
  assert.deepEqual(plan.legs[0].geometry[1], plan.checkpoints[1].position);
  assert.equal(plan.legs[0].camera.behavior, 'controlled-aerial-leg');
});

test('compilation is deterministic', () => {
  assert.equal(canonicalJson(compileF4DRoute(fixture(), 'road')), canonicalJson(compileF4DRoute(fixture(), 'road')));
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
});

test('rejects checkpoint reordering and v2 kinds', () => {
  const reordered = fixture();
  [reordered.checkpoints[1], reordered.checkpoints[2]] = [reordered.checkpoints[2], reordered.checkpoints[1]];
  assert.throws(() => createF4DManifest(reordered), F4DManifestError);
  const expanded = fixture();
  expanded.checkpoints[1].kind = 'lien';
  assert.throws(() => createF4DManifest(expanded), /v1 permits only subject or comp/);
});

test('rejects duplicate IDs, invalid coordinates and missing fallback', () => {
  const duplicate = fixture(); duplicate.checkpoints[1].id = 'subject';
  assert.throws(() => createF4DManifest(duplicate), /duplicate id/);
  const badCoordinate = fixture(); badCoordinate.checkpoints[0].position.lat = 100;
  assert.throws(() => createF4DManifest(badCoordinate), /-90 to 90/);
  const noFallback = fixture(); delete noFallback.fallback;
  assert.throws(() => createF4DManifest(noFallback), /2d-satellite/);
});

test('rejects unsupported modes', () => {
  assert.throws(() => compileF4DRoute(fixture(), 'free-flight'), /road, aerial/);
});
