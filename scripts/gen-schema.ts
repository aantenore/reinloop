// Writes the editor-facing JSON Schema of the config file from the runtime schema.
import { writeFileSync } from 'node:fs';
import { CONFIG_SCHEMA } from '../src/config/schema.ts';

const schema = { $schema: 'http://json-schema.org/draft-07/schema#', title: 'reinloop configuration', ...CONFIG_SCHEMA };
writeFileSync(new URL('../schema/reinloop.schema.json', import.meta.url), `${JSON.stringify(schema, null, 2)}\n`);
