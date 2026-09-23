/**
 * F4D v1 manifest primitives.
 *
 * BidDeed owns checkpoint identity and order. This module only validates that
 * approved input and compiles deterministic camera paths. It performs no
 * geocoding, routing, provider calls, billing, or publication.
 */

export const F4D_MANIFEST_VERSION = 1;
export const F4D_ROUTE_MODES = Object.freeze(['road', 'aerial']);
export const F4D_CHECKPOINT_KINDS = Object.freeze(['subject', 'comp']);

export class F4DManifestError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'F4DManifestError';
    this.path = path;
  }
}

function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new F4DManifestError(path, 'must be an object');
  }
  return value;
}

function text(value, path, max = 256) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new F4DManifestError(path, 'must be a non-empty string');
  }
  if (value.length > max)
    throw new F4DManifestError(path, `must be <= ${max} characters`);
  return value;
}

function finite(value, path, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new F4DManifestError(
      path,
      `must be a finite number from ${min} to ${max}`,
    );
  }
  return value;
}

function coordinate(value, path) {
  const item = record(value, path);
  return Object.freeze({
    lat: finite(item.lat, `${path}.lat`, -90, 90),
    lon: finite(item.lon, `${path}.lon`, -180, 180),
  });
}

function checkpoint(value, index) {
  const path = `checkpoints[${index}]`;
  const item = record(value, path);
  const kind = text(item.kind, `${path}.kind`);
  if (!F4D_CHECKPOINT_KINDS.includes(kind)) {
    throw new F4DManifestError(
      `${path}.kind`,
      'v1 permits only subject or comp',
    );
  }
  return Object.freeze({
    id: text(item.id, `${path}.id`),
    kind,
    label: text(item.label, `${path}.label`, 512),
    position: coordinate(item.position, `${path}.position`),
    evidenceIds: Object.freeze(
      (item.evidenceIds || []).map((id, i) =>
        text(id, `${path}.evidenceIds[${i}]`),
      ),
    ),
  });
}

function routePoint(value, path) {
  return coordinate(value, path);
}

function roadLeg(value, index, checkpointIds) {
  const path = `roadLegs[${index}]`;
  const item = record(value, path);
  const from = text(item.from, `${path}.from`);
  const to = text(item.to, `${path}.to`);
  if (!checkpointIds.has(from))
    throw new F4DManifestError(`${path}.from`, 'unknown checkpoint');
  if (!checkpointIds.has(to))
    throw new F4DManifestError(`${path}.to`, 'unknown checkpoint');
  if (!Array.isArray(item.geometry) || item.geometry.length < 2) {
    throw new F4DManifestError(
      `${path}.geometry`,
      'must contain at least two points',
    );
  }
  return Object.freeze({
    from,
    to,
    geometry: Object.freeze(
      item.geometry.map((point, i) =>
        routePoint(point, `${path}.geometry[${i}]`),
      ),
    ),
    provider: text(item.provider, `${path}.provider`),
    providerVersion: text(item.providerVersion, `${path}.providerVersion`),
  });
}

/** JSON serialization with recursively sorted object keys. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Validate and normalize one immutable F4D v1 source manifest. */
export function createF4DManifest(input) {
  const value = record(input, 'manifest');
  if (value.version !== F4D_MANIFEST_VERSION) {
    throw new F4DManifestError(
      'manifest.version',
      `must equal ${F4D_MANIFEST_VERSION}`,
    );
  }
  const checkpoints = Object.freeze((value.checkpoints || []).map(checkpoint));
  if (checkpoints.length < 2) {
    throw new F4DManifestError(
      'manifest.checkpoints',
      'requires one subject and at least one comp',
    );
  }
  const ids = new Set();
  let subjects = 0;
  for (const item of checkpoints) {
    if (ids.has(item.id))
      throw new F4DManifestError(
        'manifest.checkpoints',
        `duplicate id ${item.id}`,
      );
    ids.add(item.id);
    if (item.kind === 'subject') subjects += 1;
  }
  if (subjects !== 1 || checkpoints[0].kind !== 'subject') {
    throw new F4DManifestError(
      'manifest.checkpoints',
      'must start with exactly one subject',
    );
  }
  const roadLegs = Object.freeze(
    (value.roadLegs || []).map((leg, i) => roadLeg(leg, i, ids)),
  );
  const expectedLegs = checkpoints.length - 1;
  if (roadLegs.length !== expectedLegs) {
    throw new F4DManifestError(
      'manifest.roadLegs',
      `requires ${expectedLegs} ordered legs`,
    );
  }
  roadLegs.forEach((leg, index) => {
    if (
      leg.from !== checkpoints[index].id ||
      leg.to !== checkpoints[index + 1].id
    ) {
      throw new F4DManifestError(
        `manifest.roadLegs[${index}]`,
        'must follow approved checkpoint order',
      );
    }
  });
  const manifest = {
    version: F4D_MANIFEST_VERSION,
    id: text(value.id, 'manifest.id'),
    dealId: text(value.dealId, 'manifest.dealId'),
    approvalId: text(value.approvalId, 'manifest.approvalId'),
    checkpoints,
    roadLegs,
    fallback: Object.freeze({
      mode:
        value.fallback?.mode === '2d-satellite'
          ? '2d-satellite'
          : (() => {
              throw new F4DManifestError(
                'manifest.fallback.mode',
                'must equal 2d-satellite',
              );
            })(),
    }),
  };
  const canonical = canonicalJson(manifest);
  return Object.freeze({
    ...manifest,
    canonical,
    idempotencyKey: `${manifest.id}:${canonical}`,
  });
}

/** Compile the approved manifest into one deterministic camera path. */
export function compileF4DRoute(manifest, mode) {
  if (!F4D_ROUTE_MODES.includes(mode)) {
    throw new F4DManifestError(
      'mode',
      `must be one of ${F4D_ROUTE_MODES.join(', ')}`,
    );
  }
  const source = createF4DManifest(manifest);
  const legs = source.roadLegs.map((roadLegValue, index) => {
    const from = source.checkpoints[index];
    const to = source.checkpoints[index + 1];
    const geometry =
      mode === 'road'
        ? roadLegValue.geometry
        : Object.freeze([from.position, to.position]);
    return Object.freeze({
      id: `${source.id}:${mode}:${index}`,
      from: from.id,
      to: to.id,
      geometry,
      camera: Object.freeze({
        behavior: mode === 'road' ? 'route-dolly' : 'controlled-aerial-leg',
        terrainWarmup: true,
        minimumClearanceM: 90,
      }),
      arrival: Object.freeze({
        behavior: 'hold-then-orbit',
        orbitDegrees: 360,
      }),
    });
  });
  return Object.freeze({
    version: F4D_MANIFEST_VERSION,
    manifestId: source.id,
    approvalId: source.approvalId,
    mode,
    checkpoints: source.checkpoints,
    legs: Object.freeze(legs),
    fallback: source.fallback,
    idempotencyKey: `${source.id}:${mode}:${source.canonical}`,
  });
}
