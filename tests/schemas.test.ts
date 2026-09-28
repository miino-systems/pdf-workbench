/**
 * Validates the JSON Schemas in `public/schemas/` against the actual
 * default configs / built-in data the app produces, and checks that saved
 * `.pdf-workbench/*.json` files carry a `$schema` first key that loading
 * strips back out.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { WORKBENCH_FILES } from '@/core/types';
import type { StampsConfig } from '@/core/types';
import { PREFLIGHT_PRESETS, applyPreflightPreset } from '@/preflight';
import { BUILTIN_STAMP_TEMPLATES, createInstanceFromDefinition } from '@/stamps';
import {
  createDefaultJobsConfig,
  createDefaultPreflightConfig,
  createDefaultSequenceConfig,
  createDefaultStampsConfig,
  createDefaultWorkspaceConfig,
  initializeWorkspace,
  JOBS_SCHEMA_URL,
  loadWorkspace,
  PREFLIGHT_SCHEMA_URL,
  SEQUENCE_SCHEMA_URL,
  STAMPS_SCHEMA_URL,
  WorkspaceFS,
  WORKSPACE_SCHEMA_URL,
} from '@/workspace';
import { createMemoryDirectory } from './helpers/memfs';

const SCHEMAS_DIR = path.resolve(__dirname, '../public/schemas');

function readSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(SCHEMAS_DIR, name), 'utf8')) as Record<string, unknown>;
}

/** One Ajv instance with all 5 schemas registered, so cross-file `$ref`s resolve. */
function makeAjv(): Ajv2020 {
  // `validateFormats: false`: no `ajv-formats` is installed, so `format:
  // "date-time"` is documentation only here, not runtime-checked.
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  for (const name of ['stamps.schema.json', 'workspace.schema.json', 'preflight.schema.json', 'jobs.schema.json', 'sequence.schema.json']) {
    ajv.addSchema(readSchema(name));
  }
  return ajv;
}

function validateAgainst(ajv: Ajv2020, schemaId: string, data: unknown): void {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`schema not registered: ${schemaId}`);
  const ok = validate(data);
  expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
}

describe('JSON Schemas (public/schemas/) are valid draft 2020-12 schemas', () => {
  const ajv = makeAjv();

  for (const name of ['stamps.schema.json', 'workspace.schema.json', 'preflight.schema.json', 'jobs.schema.json', 'sequence.schema.json']) {
    it(`${name} compiles`, () => {
      const id = (readSchema(name) as { $id: string }).$id;
      expect(ajv.getSchema(id)).toBeTruthy();
    });
  }
});

describe('default configs validate against their schema', () => {
  const ajv = makeAjv();

  it('createDefaultWorkspaceConfig()', () => {
    validateAgainst(ajv, WORKSPACE_SCHEMA_URL, createDefaultWorkspaceConfig('My Workspace'));
  });

  it('createDefaultStampsConfig() (empty)', () => {
    validateAgainst(ajv, STAMPS_SCHEMA_URL, createDefaultStampsConfig());
  });

  it('BUILTIN_STAMP_TEMPLATES wrapped as a StampsConfig, one instance per template', () => {
    const cfg: StampsConfig = {
      version: 1,
      definitions: BUILTIN_STAMP_TEMPLATES,
      instances: BUILTIN_STAMP_TEMPLATES.map((def) => createInstanceFromDefinition(def)),
    };
    validateAgainst(ajv, STAMPS_SCHEMA_URL, cfg);
  });

  it('createDefaultPreflightConfig()', () => {
    validateAgainst(ajv, PREFLIGHT_SCHEMA_URL, createDefaultPreflightConfig());
  });

  it('every PREFLIGHT_PRESETS entry', () => {
    for (const preset of PREFLIGHT_PRESETS) {
      validateAgainst(ajv, PREFLIGHT_SCHEMA_URL, applyPreflightPreset(preset, createDefaultPreflightConfig()));
    }
  });

  it('createDefaultJobsConfig() (empty)', () => {
    validateAgainst(ajv, JOBS_SCHEMA_URL, createDefaultJobsConfig());
  });

  it('createDefaultSequenceConfig()', () => {
    validateAgainst(ajv, SEQUENCE_SCHEMA_URL, createDefaultSequenceConfig());
  });
});

describe('saved config files carry $schema; loading strips it', () => {
  it('every file written by initializeWorkspace starts with the $schema line, and loadWorkspace strips it', async () => {
    const handle = new WorkspaceFS(createMemoryDirectory('ws'));
    await initializeWorkspace(handle);

    const expected: Record<string, string> = {
      [WORKBENCH_FILES.workspace]: WORKSPACE_SCHEMA_URL,
      [WORKBENCH_FILES.stamps]: STAMPS_SCHEMA_URL,
      [WORKBENCH_FILES.preflight]: PREFLIGHT_SCHEMA_URL,
      [WORKBENCH_FILES.jobs]: JOBS_SCHEMA_URL,
      [WORKBENCH_FILES.sequence]: SEQUENCE_SCHEMA_URL,
    };
    for (const [file, url] of Object.entries(expected)) {
      const text = await handle.readText(file);
      expect(text.split('\n')[0]).toBe(`{`);
      expect(text.split('\n')[1]).toBe(`  "$schema": "${url}",`);
      expect(JSON.parse(text).$schema).toBe(url);
    }

    const state = await loadWorkspace(handle);
    expect((state.config as unknown as { $schema?: string }).$schema).toBeUndefined();
    expect((state.stamps as unknown as { $schema?: string }).$schema).toBeUndefined();
    expect((state.preflight as unknown as { $schema?: string }).$schema).toBeUndefined();
    expect((state.jobs as unknown as { $schema?: string }).$schema).toBeUndefined();
    expect((state.sequence as unknown as { $schema?: string }).$schema).toBeUndefined();
    expect(state.warnings).toEqual([]);
  });
});
